import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { GraphqlClient, INTROSPECTION_QUERY } from "../collections-backup/lib/graphql.mjs";
import {
  exists,
  readJson,
  sha256,
  sha256File,
  writeJsonAtomic,
} from "../collections-backup/lib/files.mjs";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_DELAY_MS,
  DEFAULT_ENDPOINT,
  DEFAULT_SHARDS,
  DISTINCT_IDENTITY_COUNT_QUERY,
  NULL_CHAIN_COUNT_QUERY,
  PAGE_QUERY,
  PAGE_SIZE,
  REQUIRED_POAP_FIELDS,
  SHARD_COUNT_QUERY,
  SNAPSHOT_FORMAT_VERSION,
  SOURCE_UID_DERIVATION,
  UPPER_BOUND_QUERY,
} from "./config.mjs";
import { CREATE_CAPTURE_SCHEMA_SQL } from "./schema.mjs";

const DATASET = "poapin-compass-holdings";
const ADDRESS = /^0x[0-9a-f]{40}$/;

export async function captureCompassHoldingsSnapshot(options = {}) {
  const settings = normalizeOptions(options);
  const root = resolve(settings.output);
  const databasePath = resolve(root, "compass-holdings.sqlite");
  const source = await prepareOutput(root, settings);
  const controlClient = makeClient(settings);
  const schema = await captureSchema(root, controlClient, settings.endpoint);
  validateSchema(schema.body.data.__schema);
  await writeQueries(root);

  const database = new DatabaseSync(databasePath);
  try {
    const captureInitialized = hasTable(database, "capture_meta");
    if (!captureInitialized) {
      if (hasUserTables(database)) {
        throw new Error("Capture SQLite has partial schema without initialization metadata.");
      }
      const boundary = await initializeCapture(database, {
        client: controlClient,
        settings,
        schemaSha256: schema.sha256,
        source,
      });
      settings.onProgress({
        phase: "initialized",
        upperPoapId: boundary.upperPoapId,
        expectedRows: boundary.expectedRows,
      });
    } else {
      upgradeCaptureSchema(database);
      verifyResumeContext(database, {
        settings,
        schemaSha256: schema.sha256,
        source,
      });
    }

    for (let reconciliationAttempt = 0; ; reconciliationAttempt += 1) {
      await capturePendingShards(database, settings);
      const mismatches = await verifyFinalCounts(database, controlClient);
      if (mismatches.length === 0) break;
      if (reconciliationAttempt >= 2) {
        throw new Error(
          `Compass final aggregate counts remain unstable after reconciliation: ${JSON.stringify(mismatches)}.`,
        );
      }
      resetMismatchedShards(database, mismatches, reconciliationAttempt + 1);
      settings.onProgress({
        phase: "reconcile",
        attempt: reconciliationAttempt + 1,
        mismatches,
      });
    }
    const summary = finalizeCapture(database);
    database.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    database.exec("PRAGMA journal_mode = DELETE;");
    database.close();

    const databaseArtifact = await sha256File(databasePath);
    const finishedAt = new Date().toISOString();
    const manifest = {
      version: SNAPSHOT_FORMAT_VERSION,
      dataset: DATASET,
      snapshotId: source.snapshotId,
      endpoint: settings.endpoint,
      startedAt: source.initializedAt,
      finishedAt,
      captureWindow: {
        consistency: "application-level-bounded-keyset",
        note: "The public GraphQL endpoint does not expose a transactionally consistent database snapshot. Initial aggregate drift is retained separately; terminal empty pages and final aggregate reconciliation prove the completed bounded pass.",
      },
      pagination: {
        method: "id-range-bounded-keyset",
        pageSize: PAGE_SIZE,
        shards: settings.shards,
        concurrency: settings.concurrency,
        upperPoapId: summary.upperPoapId,
      },
      counts: {
        expected: summary.capturedRows,
        initialExpected: summary.expectedRows,
        captured: summary.capturedRows,
        aggregateDrift: summary.capturedRows - summary.expectedRows,
        pages: summary.pages,
        shards: summary.shards,
        reconciliationAttempts: summary.reconciliationAttempts,
        reconciledShards: summary.reconciledShards,
      },
      sourceUidDerivation: SOURCE_UID_DERIVATION,
      schema: {
        sha256: schema.sha256,
        byteLength: schema.byteLength,
        querySha256: sha256(INTROSPECTION_QUERY),
      },
      queries: {
        upperBoundSha256: sha256(UPPER_BOUND_QUERY),
        shardCountSha256: sha256(SHARD_COUNT_QUERY),
        nullChainCountSha256: sha256(NULL_CHAIN_COUNT_QUERY),
        distinctIdentityCountSha256: sha256(DISTINCT_IDENTITY_COUNT_QUERY),
        pageSha256: sha256(PAGE_QUERY),
      },
      database: {
        path: "compass-holdings.sqlite",
        ...databaseArtifact,
      },
      knownGaps: [
        {
          code: "NO_TRANSACTIONAL_SNAPSHOT",
          detail:
            "Rows are captured during a bounded time window; ownership may change while the crawl runs.",
        },
        {
          code: "NO_DELETION_FEED",
          detail: "The anonymous API does not expose deletion tombstones or a change stream.",
        },
      ],
    };
    await writeJsonAtomic(resolve(root, "manifest.json"), manifest);
    return manifest;
  } catch (error) {
    try {
      database.close();
    } catch {}
    throw error;
  }
}

async function prepareOutput(root, settings) {
  const markerPath = resolve(root, "source.json");
  if (await exists(markerPath)) {
    const marker = await readJson(markerPath);
    if (!settings.resume) {
      throw new Error(`Snapshot output already exists at ${root}; pass --resume to continue.`);
    }
    for (const [key, value] of Object.entries({
      version: SNAPSHOT_FORMAT_VERSION,
      dataset: DATASET,
      endpoint: settings.endpoint,
      snapshotId: settings.snapshotId,
      shards: settings.shards,
    })) {
      if (marker[key] !== value) throw new Error(`Resume source marker ${key} does not match.`);
    }
    return marker;
  }
  if (await exists(root)) {
    const entries = await readdir(root);
    if (entries.length > 0) {
      throw new Error(`Refusing to initialize non-empty output directory ${root}.`);
    }
  }
  await mkdir(root, { recursive: true });
  const marker = {
    version: SNAPSHOT_FORMAT_VERSION,
    dataset: DATASET,
    endpoint: settings.endpoint,
    snapshotId: settings.snapshotId,
    shards: settings.shards,
    initializedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(markerPath, marker);
  return marker;
}

async function captureSchema(root, client, endpoint) {
  const schemaPath = resolve(root, "schema/introspection.json");
  if (await exists(schemaPath)) {
    const body = await readJson(schemaPath);
    return { body, ...(await sha256File(schemaPath)) };
  }
  const response = await client.request({
    query: INTROSPECTION_QUERY,
    operationName: "POAPinCollectionsIntrospection",
  });
  await writeJsonAtomic(schemaPath, response.body);
  await writeJsonAtomic(resolve(root, "schema/response.json"), {
    endpoint,
    fetchedAt: new Date().toISOString(),
    status: response.status,
    headers: response.headers,
  });
  return { body: response.body, ...(await sha256File(schemaPath)) };
}

async function writeQueries(root) {
  const queries = {
    "upper-bound.graphql": UPPER_BOUND_QUERY,
    "shard-count.graphql": SHARD_COUNT_QUERY,
    "null-chain-count.graphql": NULL_CHAIN_COUNT_QUERY,
    "distinct-identity-count.graphql": DISTINCT_IDENTITY_COUNT_QUERY,
    "page.graphql": PAGE_QUERY,
  };
  for (const [name, query] of Object.entries(queries)) {
    const path = resolve(root, "queries", name);
    const contents = `${query.trim()}\n`;
    await mkdir(dirname(path), { recursive: true });
    if (await exists(path)) {
      const existing = await readFile(path, "utf8");
      if (existing !== contents) throw new Error(`Stored query ${name} does not match.`);
    } else {
      await writeFile(path, contents, { mode: 0o600 });
    }
  }
}

function validateSchema(schema) {
  if (!schema || !Array.isArray(schema.types)) throw new Error("GraphQL schema is invalid.");
  const poaps = schema.types.find((type) => type.name === "poaps");
  const queryRoot = schema.types.find((type) => type.name === schema.queryType?.name);
  const fields = new Set(poaps?.fields?.map((field) => field.name));
  const rootFields = new Set(queryRoot?.fields?.map((field) => field.name));
  for (const field of REQUIRED_POAP_FIELDS) {
    if (!fields.has(field)) throw new Error(`GraphQL poaps is missing required field ${field}.`);
  }
  for (const field of ["poaps", "poaps_aggregate"]) {
    if (!rootFields.has(field)) throw new Error(`GraphQL query root is missing ${field}.`);
  }
}

async function initializeCapture(database, { client, settings, schemaSha256, source }) {
  const upperResponse = await client.request({
    query: UPPER_BOUND_QUERY,
    operationName: "POAPinCompassHoldingsUpperBound",
  });
  const upperRows = upperResponse.body.data.poaps;
  if (!Array.isArray(upperRows) || upperRows.length > 1) {
    throw new Error("Compass upper-bound response is invalid.");
  }
  const upperPoapId = upperRows[0] ? positiveInteger(upperRows[0].id, "upper POAP id") : 0;
  const ranges = shardRanges(upperPoapId, settings.shards);
  let expectedRows = 0;
  for (const range of ranges) {
    const response = await client.request({
      query: SHARD_COUNT_QUERY,
      variables: {
        lower: String(range.lowerExclusive),
        upper: String(range.upperInclusive),
      },
      operationName: "POAPinCompassHoldingsShardCount",
    });
    const count = response.body.data.poaps_aggregate?.aggregate?.count;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Compass returned an invalid count for shard ${range.shardId}.`);
    }
    range.expectedRows = count;
    expectedRows += count;
  }
  const nullChainResponse = await client.request({
    query: NULL_CHAIN_COUNT_QUERY,
    variables: { upper: String(upperPoapId) },
    operationName: "POAPinCompassHoldingsNullChainCount",
  });
  const nullChainCount = nullChainResponse.body.data.poaps_aggregate?.aggregate?.count;
  if (!Number.isSafeInteger(nullChainCount) || nullChainCount !== 0) {
    throw new Error(`Compass identity requires non-null chain; observed ${nullChainCount}.`);
  }
  const distinctResponse = await client.request({
    query: DISTINCT_IDENTITY_COUNT_QUERY,
    variables: { upper: String(upperPoapId) },
    operationName: "POAPinCompassHoldingsDistinctIdentityCount",
  });
  const distinctIdentityCount = distinctResponse.body.data.poaps_aggregate?.aggregate?.count;
  if (!Number.isSafeInteger(distinctIdentityCount) || distinctIdentityCount !== expectedRows) {
    throw new Error(
      `Compass (id, chain) identity count ${distinctIdentityCount} differs from ${expectedRows}.`,
    );
  }

  database.exec(CREATE_CAPTURE_SCHEMA_SQL);
  const insertMeta = database.prepare("INSERT INTO capture_meta (key, value) VALUES (?, ?)");
  const insertShard = database.prepare(
    `INSERT INTO capture_shards (
      shard_id, lower_exclusive, upper_inclusive, cursor_id, cursor_chain,
      expected_rows, captured_rows, pages, started_at, finished_at
    ) VALUES (?, ?, ?, ?, '', ?, 0, 0, NULL, ?)`,
  );
  database.exec("BEGIN IMMEDIATE;");
  try {
    for (const [key, value] of Object.entries({
      version: SNAPSHOT_FORMAT_VERSION,
      dataset: DATASET,
      endpoint: settings.endpoint,
      snapshot_id: source.snapshotId,
      initialized_at: source.initializedAt,
      schema_sha256: schemaSha256,
      page_query_sha256: sha256(PAGE_QUERY),
      source_uid_derivation: SOURCE_UID_DERIVATION,
      upper_poap_id: upperPoapId,
      expected_rows: expectedRows,
      null_chain_rows: nullChainCount,
      distinct_identity_rows: distinctIdentityCount,
      shards: settings.shards,
    })) {
      insertMeta.run(key, String(value));
    }
    for (const range of ranges) {
      insertShard.run(
        range.shardId,
        range.lowerExclusive,
        range.upperInclusive,
        range.lowerExclusive,
        range.expectedRows,
        null,
      );
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  return { upperPoapId, expectedRows };
}

function verifyResumeContext(database, { settings, schemaSha256, source }) {
  const quickCheck = database.prepare("PRAGMA quick_check;").get();
  if (quickCheck?.quick_check !== "ok") throw new Error("Capture SQLite quick_check failed.");
  const rows = database.prepare("SELECT key, value FROM capture_meta").all();
  const meta = Object.fromEntries(rows.map((row) => [row.key, row.value]));
  const expected = {
    version: SNAPSHOT_FORMAT_VERSION,
    dataset: DATASET,
    endpoint: settings.endpoint,
    snapshot_id: source.snapshotId,
    schema_sha256: schemaSha256,
    page_query_sha256: sha256(PAGE_QUERY),
    source_uid_derivation: SOURCE_UID_DERIVATION,
    shards: settings.shards,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (meta[key] !== String(value)) throw new Error(`Capture SQLite ${key} does not match.`);
  }
}

async function capturePendingShards(database, settings) {
  const pending = database
    .prepare(
      `SELECT shard_id
       FROM capture_shards
       WHERE finished_at IS NULL
       ORDER BY shard_id`,
    )
    .all()
    .map((row) => Number(row.shard_id));
  let next = 0;
  const workers = Array.from(
    { length: Math.min(settings.concurrency, pending.length) },
    async (_, workerId) => {
      const client = makeClient(settings);
      while (next < pending.length) {
        const shardId = pending[next];
        next += 1;
        await captureShard(database, client, shardId, settings, workerId);
      }
    },
  );
  await Promise.all(workers);
}

async function captureShard(database, client, shardId, settings, workerId) {
  const readShard = database.prepare("SELECT * FROM capture_shards WHERE shard_id = ?");
  const insertToken = database.prepare(
    `INSERT INTO tokens (
      source_uid, poap_id, drop_id, minted_on, owner_address, network, transfer_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMetadata = database.prepare(
    `INSERT INTO compass_token_metadata (source_uid, collected_at, captured_at)
     VALUES (?, ?, ?)`,
  );
  const insertPage = database.prepare(
    `INSERT INTO capture_pages (
      shard_id, page_number, cursor_before_id, cursor_before_chain,
      cursor_after_id, cursor_after_chain, row_count, response_sha256, fetched_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const startShard = database.prepare(
    "UPDATE capture_shards SET started_at = COALESCE(started_at, ?) WHERE shard_id = ?",
  );
  const updateShard = database.prepare(
    `UPDATE capture_shards
     SET cursor_id = ?, cursor_chain = ?,
         captured_rows = captured_rows + ?, pages = pages + 1
     WHERE shard_id = ?`,
  );
  const finishShard = database.prepare(
    `UPDATE capture_shards
     SET expected_rows = captured_rows,
         finished_at = ?
     WHERE shard_id = ?`,
  );
  const insertTerminal = database.prepare(
    `INSERT INTO capture_terminal_pages (
      shard_id, cursor_id, cursor_chain, response_sha256, fetched_at,
      captured_rows, initial_expected_rows
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  startShard.run(new Date().toISOString(), shardId);

  while (true) {
    const shard = readShard.get(shardId);
    if (!shard || shard.finished_at) return;
    const response = await client.request({
      query: PAGE_QUERY,
      variables: {
        lower: String(shard.lower_exclusive),
        upper: String(shard.upper_inclusive),
        afterId: String(shard.cursor_id),
        afterChain: String(shard.cursor_chain),
        limit: PAGE_SIZE,
      },
      operationName: "POAPinCompassHoldingsPage",
    });
    const rows = response.body.data.poaps;
    if (!Array.isArray(rows) || rows.length > PAGE_SIZE) {
      throw new Error(
        `Shard ${shardId} returned ${Array.isArray(rows) ? rows.length : "invalid"} rows before completion.`,
      );
    }
    if (rows.length === 0) {
      const fetchedAt = new Date().toISOString();
      const responseSha256 = createHash("sha256").update(response.bodyText).digest("hex");
      database.exec("BEGIN IMMEDIATE;");
      try {
        insertTerminal.run(
          shardId,
          shard.cursor_id,
          shard.cursor_chain,
          responseSha256,
          fetchedAt,
          shard.captured_rows,
          shard.expected_rows,
        );
        finishShard.run(fetchedAt, shardId);
        database.exec("COMMIT;");
      } catch (error) {
        database.exec("ROLLBACK;");
        throw error;
      }
      settings.onProgress({
        phase: "capture",
        workerId,
        shardId,
        pages: Number(shard.pages),
        rows: Number(shard.captured_rows),
        expectedRows: Number(shard.expected_rows),
        terminal: true,
      });
      return;
    }
    const normalized = normalizePage(rows, {
      cursorId: Number(shard.cursor_id),
      cursorChain: String(shard.cursor_chain),
      upper: Number(shard.upper_inclusive),
    });
    const fetchedAt = new Date().toISOString();
    const responseSha256 = createHash("sha256").update(response.bodyText).digest("hex");
    const cursorAfter = normalized.at(-1);
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (const row of normalized) {
        const sourceUid = sourceUidFor(row.poapId, row.network);
        insertToken.run(
          sourceUid,
          row.poapId,
          row.dropId,
          row.mintedOn,
          row.ownerAddress,
          row.network,
          row.transferCount,
        );
        insertMetadata.run(sourceUid, row.collectedAt, fetchedAt);
      }
      insertPage.run(
        shardId,
        Number(shard.pages) + 1,
        shard.cursor_id,
        shard.cursor_chain,
        cursorAfter.poapId,
        cursorAfter.network,
        normalized.length,
        responseSha256,
        fetchedAt,
      );
      updateShard.run(cursorAfter.poapId, cursorAfter.network, normalized.length, shardId);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
    const captured = Number(shard.captured_rows) + normalized.length;
    if ((Number(shard.pages) + 1) % 100 === 0) {
      settings.onProgress({
        phase: "capture",
        workerId,
        shardId,
        pages: Number(shard.pages) + 1,
        rows: captured,
        expectedRows: Number(shard.expected_rows),
        cursor: [cursorAfter.poapId, cursorAfter.network],
      });
    }
  }
}

async function verifyFinalCounts(database, client) {
  const shards = database
    .prepare(
      `SELECT shard_id, lower_exclusive, upper_inclusive, captured_rows
       FROM capture_shards
       ORDER BY shard_id`,
    )
    .all();
  const insert = database.prepare(
    `INSERT OR REPLACE INTO capture_final_counts (
      shard_id, row_count, response_sha256, counted_at
    ) VALUES (?, ?, ?, ?)`,
  );
  const mismatches = [];
  for (const shard of shards) {
    const response = await client.request({
      query: SHARD_COUNT_QUERY,
      variables: {
        lower: String(shard.lower_exclusive),
        upper: String(shard.upper_inclusive),
      },
      operationName: "POAPinCompassHoldingsShardCount",
    });
    const count = response.body.data.poaps_aggregate?.aggregate?.count;
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Compass returned an invalid final count for shard ${shard.shard_id}.`);
    }
    insert.run(
      shard.shard_id,
      count,
      createHash("sha256").update(response.bodyText).digest("hex"),
      new Date().toISOString(),
    );
    if (count !== Number(shard.captured_rows)) {
      mismatches.push({
        shardId: Number(shard.shard_id),
        captured: Number(shard.captured_rows),
        finalAggregate: count,
      });
    }
  }
  return mismatches;
}

function resetMismatchedShards(database, mismatches, attempt) {
  const readShard = database.prepare(
    `SELECT lower_exclusive, upper_inclusive
     FROM capture_shards
     WHERE shard_id = ?`,
  );
  const readTerminal = database.prepare(
    `SELECT initial_expected_rows
     FROM capture_terminal_pages
     WHERE shard_id = ?`,
  );
  const record = database.prepare(
    `INSERT INTO capture_reconciliations (
      attempt, shard_id, prior_captured_rows, prior_initial_expected_rows,
      final_aggregate_rows, reset_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const deleteTokens = database.prepare("DELETE FROM tokens WHERE poap_id > ? AND poap_id <= ?");
  const deletePages = database.prepare("DELETE FROM capture_pages WHERE shard_id = ?");
  const deleteTerminal = database.prepare("DELETE FROM capture_terminal_pages WHERE shard_id = ?");
  const deleteFinalCount = database.prepare("DELETE FROM capture_final_counts WHERE shard_id = ?");
  const resetShard = database.prepare(
    `UPDATE capture_shards
     SET cursor_id = lower_exclusive,
         cursor_chain = '',
         expected_rows = ?,
         captured_rows = 0,
         pages = 0,
         started_at = NULL,
         finished_at = NULL
     WHERE shard_id = ?`,
  );

  for (const mismatch of mismatches) {
    database.exec("BEGIN IMMEDIATE;");
    try {
      const shard = readShard.get(mismatch.shardId);
      const terminal = readTerminal.get(mismatch.shardId);
      if (!shard || !terminal) {
        throw new Error(`Cannot reconcile incomplete shard ${mismatch.shardId}.`);
      }
      record.run(
        attempt,
        mismatch.shardId,
        mismatch.captured,
        terminal.initial_expected_rows,
        mismatch.finalAggregate,
        new Date().toISOString(),
      );
      deleteTokens.run(shard.lower_exclusive, shard.upper_inclusive);
      deletePages.run(mismatch.shardId);
      deleteTerminal.run(mismatch.shardId);
      deleteFinalCount.run(mismatch.shardId);
      resetShard.run(mismatch.finalAggregate, mismatch.shardId);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
}

function normalizePage(rows, { cursorId, cursorChain, upper }) {
  let previous = [cursorId, cursorChain];
  const seen = new Set();
  return rows.map((row) => {
    const poapId = positiveInteger(row.id, "poap.id");
    const ownerAddress = String(row.collector_address ?? "").toLowerCase();
    if (!ADDRESS.test(ownerAddress)) throw new Error(`POAP ${poapId} has an invalid owner.`);
    const dropId = nullablePositiveInteger(row.drop_id, `POAP ${poapId} drop_id`);
    const mintedOn = nullableNonNegativeInteger(row.minted_on, `POAP ${poapId} minted_on`);
    const transferCount = nonNegativeInteger(row.transfer_count, `POAP ${poapId} transfer_count`);
    const network = nonEmptyString(row.chain, `POAP ${poapId} chain`);
    const cursor = [poapId, network];
    if (compareIdentity(cursor, previous) <= 0 || poapId > upper) {
      throw new Error(`POAP identity (${poapId}, ${network}) crossed its shard cursor boundary.`);
    }
    const identity = `${poapId}\u0000${network}`;
    if (seen.has(identity)) {
      throw new Error(`POAP identity (${poapId}, ${network}) repeats within one page.`);
    }
    seen.add(identity);
    previous = cursor;
    const collectedAt =
      row.collected_at === null || row.collected_at === undefined ? null : String(row.collected_at);
    return {
      poapId,
      dropId,
      mintedOn,
      ownerAddress,
      network,
      transferCount,
      collectedAt,
    };
  });
}

function compareIdentity(left, right) {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] < right[1]) return -1;
  if (left[1] > right[1]) return 1;
  return 0;
}

function sourceUidFor(poapId, network) {
  return `compass-poap:${poapId}:${network}`;
}

function finalizeCapture(database) {
  const [summary] = database
    .prepare(
      `SELECT
        COUNT(*) AS shards,
        SUM(captured_rows) AS captured_rows,
        SUM(pages) AS pages,
        SUM(CASE WHEN finished_at IS NOT NULL THEN 1 ELSE 0 END) AS finished_shards,
        (SELECT COUNT(*) FROM capture_terminal_pages) AS terminal_shards,
        (SELECT COUNT(*) FROM capture_final_counts) AS final_count_shards,
        (SELECT COALESCE(MAX(attempt), 0) FROM capture_reconciliations)
          AS reconciliation_attempts,
        (SELECT COUNT(DISTINCT shard_id) FROM capture_reconciliations)
          AS reconciled_shards
       FROM capture_shards`,
    )
    .all();
  const meta = Object.fromEntries(
    database
      .prepare("SELECT key, value FROM capture_meta")
      .all()
      .map((row) => [row.key, row.value]),
  );
  const values = {
    shards: Number(summary.shards),
    expectedRows: Number(meta.expected_rows),
    capturedRows: Number(summary.captured_rows),
    pages: Number(summary.pages),
    finishedShards: Number(summary.finished_shards),
    terminalShards: Number(summary.terminal_shards),
    finalCountShards: Number(summary.final_count_shards),
    reconciliationAttempts: Number(summary.reconciliation_attempts),
    reconciledShards: Number(summary.reconciled_shards),
    upperPoapId: Number(meta.upper_poap_id),
  };
  if (
    values.finishedShards !== values.shards ||
    values.terminalShards !== values.shards ||
    values.finalCountShards !== values.shards
  ) {
    throw new Error("Compass Holdings capture is incomplete.");
  }
  const tokenCount = Number(database.prepare("SELECT COUNT(*) AS count FROM tokens").get().count);
  if (tokenCount !== values.capturedRows) throw new Error("Captured token count does not match.");
  const quickCheck = database.prepare("PRAGMA quick_check;").get();
  if (quickCheck?.quick_check !== "ok") throw new Error("Capture SQLite quick_check failed.");

  const insert = database.prepare(
    "INSERT OR REPLACE INTO snapshot_metadata (key, value) VALUES (?, ?)",
  );
  database.exec("BEGIN IMMEDIATE;");
  try {
    for (const [key, value] of Object.entries({
      schema_version: 1,
      snapshot_at: meta.initialized_at,
      generated_at: new Date().toISOString(),
      tokens_count: tokenCount,
      source: "poap-compass-public-graphql",
      endpoint: meta.endpoint,
      upper_poap_id: values.upperPoapId,
      source_uid_derivation: SOURCE_UID_DERIVATION,
    })) {
      insert.run(key, String(value));
    }
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
  return values;
}

function upgradeCaptureSchema(database) {
  if (!hasTable(database, "capture_terminal_pages")) {
    database.exec(`
      CREATE TABLE capture_terminal_pages (
        shard_id INTEGER PRIMARY KEY,
        cursor_id INTEGER NOT NULL,
        cursor_chain TEXT NOT NULL,
        response_sha256 TEXT NOT NULL CHECK (length(response_sha256) = 64),
        fetched_at TEXT NOT NULL,
        captured_rows INTEGER NOT NULL CHECK (captured_rows >= 0),
        initial_expected_rows INTEGER NOT NULL CHECK (initial_expected_rows >= 0),
        FOREIGN KEY (shard_id) REFERENCES capture_shards(shard_id) ON DELETE CASCADE
      ) WITHOUT ROWID;
    `);
  }
  if (!hasTable(database, "capture_final_counts")) {
    database.exec(`
      CREATE TABLE capture_final_counts (
        shard_id INTEGER PRIMARY KEY,
        row_count INTEGER NOT NULL CHECK (row_count >= 0),
        response_sha256 TEXT NOT NULL CHECK (length(response_sha256) = 64),
        counted_at TEXT NOT NULL,
        FOREIGN KEY (shard_id) REFERENCES capture_shards(shard_id) ON DELETE CASCADE
      ) WITHOUT ROWID;
    `);
  }
  if (!hasTable(database, "capture_reconciliations")) {
    database.exec(`
      CREATE TABLE capture_reconciliations (
        attempt INTEGER NOT NULL CHECK (attempt > 0),
        shard_id INTEGER NOT NULL,
        prior_captured_rows INTEGER NOT NULL CHECK (prior_captured_rows >= 0),
        prior_initial_expected_rows INTEGER NOT NULL CHECK (prior_initial_expected_rows >= 0),
        final_aggregate_rows INTEGER NOT NULL CHECK (final_aggregate_rows >= 0),
        reset_at TEXT NOT NULL,
        PRIMARY KEY (attempt, shard_id),
        FOREIGN KEY (shard_id) REFERENCES capture_shards(shard_id) ON DELETE CASCADE
      ) WITHOUT ROWID;
    `);
  }
  database.exec(`
    UPDATE capture_shards
    SET finished_at = NULL
    WHERE shard_id NOT IN (SELECT shard_id FROM capture_terminal_pages);
    DELETE FROM capture_final_counts;
  `);
}

function shardRanges(upperPoapId, shards) {
  const ranges = [];
  for (let shardId = 0; shardId < shards; shardId += 1) {
    const lowerExclusive = Math.floor((upperPoapId * shardId) / shards);
    const upperInclusive = Math.floor((upperPoapId * (shardId + 1)) / shards);
    ranges.push({ shardId, lowerExclusive, upperInclusive, expectedRows: 0 });
  }
  return ranges;
}

function hasTable(database, name) {
  return Boolean(
    database.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name),
  );
}

function hasUserTables(database) {
  return Boolean(
    database
      .prepare(
        `SELECT 1
         FROM sqlite_schema
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
         LIMIT 1`,
      )
      .get(),
  );
}

function makeClient(settings) {
  return new GraphqlClient({
    endpoint: settings.endpoint,
    delayMs: settings.delayMs,
    retries: settings.retries,
    timeoutMs: settings.timeoutMs,
    onRequest: settings.onRequest,
  });
}

function normalizeOptions(options) {
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const parsedEndpoint = new URL(endpoint);
  if (parsedEndpoint.protocol !== "https:" && parsedEndpoint.hostname !== "127.0.0.1") {
    throw new Error("Compass endpoint must use HTTPS.");
  }
  if (typeof options.output !== "string" || options.output.length === 0) {
    throw new Error("Snapshot output path is required.");
  }
  const snapshotId = options.snapshotId ?? defaultSnapshotId();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(snapshotId)) {
    throw new Error("Snapshot ID is invalid.");
  }
  const concurrency = boundedInteger(
    options.concurrency ?? DEFAULT_CONCURRENCY,
    1,
    8,
    "concurrency",
  );
  const shards = boundedInteger(options.shards ?? DEFAULT_SHARDS, concurrency, 64, "shards");
  return {
    endpoint,
    output: options.output,
    snapshotId,
    concurrency,
    shards,
    delayMs: boundedInteger(options.delayMs ?? DEFAULT_DELAY_MS, 0, 60_000, "delayMs"),
    retries: boundedInteger(options.retries ?? 5, 0, 10, "retries"),
    timeoutMs: boundedInteger(options.timeoutMs ?? 30_000, 1_000, 120_000, "timeoutMs"),
    resume: options.resume === true,
    onProgress: options.onProgress ?? (() => {}),
    onRequest: options.onRequest ?? (() => {}),
  };
}

function defaultSnapshotId() {
  return `compass-holdings-${new Date().toISOString().slice(0, 10)}-v1`;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} is invalid.`);
  return number;
}

function nullablePositiveInteger(value, label) {
  if (value === null || value === undefined) return null;
  return positiveInteger(value, label);
}

function nonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} is invalid.`);
  return number;
}

function nullableNonNegativeInteger(value, label) {
  if (value === null || value === undefined) return null;
  return nonNegativeInteger(value, label);
}

function nonEmptyString(value, label) {
  const string = String(value);
  if (string.length === 0 || string.length > 128) throw new Error(`${label} is invalid.`);
  return string;
}

function boundedInteger(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

export const snapshotInternals = {
  normalizePage,
  shardRanges,
  validateSchema,
};
