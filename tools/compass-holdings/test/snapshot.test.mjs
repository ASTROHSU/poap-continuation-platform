import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { packageCompassHoldingsSnapshot } from "../backup.mjs";
import { d1LoaderInternals, loadContext } from "../d1-loader.mjs";
import { buildCompassHoldingsD1 } from "../d1.mjs";
import { verifyCompassHoldingsD1Locally } from "../local-verify.mjs";
import { captureReferencedDrops } from "../referenced-drops.mjs";
import { captureCompassHoldingsSnapshot, snapshotInternals } from "../snapshot.mjs";
import { buildUploadPlan } from "../upload-backup.mjs";

const ROWS = [
  {
    id: 1,
    drop_id: 10,
    minted_on: 100,
    collector_address: "0x1111111111111111111111111111111111111111",
    chain: "mainnet",
    transfer_count: 1,
    collected_at: "2019-01-01T00:00:00Z",
  },
  {
    id: 2,
    drop_id: 20,
    minted_on: 200,
    collector_address: "0x3333333333333333333333333333333333333333",
    chain: "mainnet",
    transfer_count: 1,
    collected_at: "2020-01-01T00:00:00Z",
  },
  {
    id: 2,
    drop_id: 20,
    minted_on: 201,
    collector_address: "0x2222222222222222222222222222222222222222",
    chain: "xdai",
    transfer_count: 2,
    collected_at: "2020-01-01T00:00:00Z",
  },
  {
    id: 4,
    drop_id: 40,
    minted_on: 400,
    collector_address: "0x4444444444444444444444444444444444444444",
    chain: "base",
    transfer_count: 1,
    collected_at: null,
  },
  {
    id: 5,
    drop_id: 50,
    minted_on: 500,
    collector_address: "0x5555555555555555555555555555555555555555",
    chain: "xdai",
    transfer_count: 1,
    collected_at: "2021-01-01T00:00:00Z",
  },
];
const LATE_ROW = {
  id: 4,
  drop_id: 40,
  minted_on: 401,
  collector_address: "0x4444444444444444444444444444444444444444",
  chain: "xdai",
  transfer_count: 0,
  collected_at: null,
};
const CAPTURE_ROWS = [...ROWS, LATE_ROW].sort(
  (left, right) => left.id - right.id || left.chain.localeCompare(right.chain, "en"),
);
const RECONCILIATION_ROW = {
  id: 5,
  drop_id: 50,
  minted_on: 501,
  collector_address: "0x5555555555555555555555555555555555555555",
  chain: "zora",
  transfer_count: 0,
  collected_at: null,
};
const RECONCILED_ROWS = [...CAPTURE_ROWS, RECONCILIATION_ROW].sort(
  (left, right) => left.id - right.id || left.chain.localeCompare(right.chain, "en"),
);

const DROPS = [10, 20, 40].map((id) => ({
  animation_url: null,
  channel: null,
  city: "Test City",
  country: "Test Country",
  created_date: "2020-01-01T00:00:00Z",
  description: `Drop ${id} description`,
  drop_url: `https://example.com/drops/${id}`,
  end_date: "2020-01-02T00:00:00Z",
  expiry_date: null,
  fancy_id: `drop-${id}`,
  id,
  image_url: `https://assets.poap.xyz/drop-${id}.png`,
  integrator_id: null,
  location_type: "in-person",
  name: `Drop ${id}`,
  platform: null,
  private: id === 40 ? "true" : "false",
  start_date: "2020-01-01T00:00:00Z",
  timezone: "UTC",
  virtual: false,
  year: 2020,
  hidden_drop: null,
  drop_image: null,
}));

test("shard ranges cover an upper bound without overlap", () => {
  assert.deepEqual(snapshotInternals.shardRanges(10, 3), [
    { shardId: 0, lowerExclusive: 0, upperInclusive: 3, expectedRows: 0 },
    { shardId: 1, lowerExclusive: 3, upperInclusive: 6, expectedRows: 0 },
    { shardId: 2, lowerExclusive: 6, upperInclusive: 10, expectedRows: 0 },
  ]);
});

test("page normalization preserves nullable source fields and rejects cursor regressions", () => {
  assert.deepEqual(
    snapshotInternals.normalizePage([ROWS[0]], {
      cursorId: 0,
      cursorChain: "",
      upper: 2,
    }),
    [
      {
        poapId: 1,
        dropId: 10,
        mintedOn: 100,
        ownerAddress: "0x1111111111111111111111111111111111111111",
        network: "mainnet",
        transferCount: 1,
        collectedAt: "2019-01-01T00:00:00Z",
      },
    ],
  );
  assert.throws(
    () =>
      snapshotInternals.normalizePage([ROWS[0]], {
        cursorId: 1,
        cursorChain: "mainnet",
        upper: 2,
      }),
    /cursor boundary/,
  );
});

test("capture writes a resumable, source-compatible SQLite with frozen counts", async () => {
  const root = await mkdtemp(join(tmpdir(), "poapin-compass-holdings-"));
  const packagePath = join(dirname(root), `${basename(root)}.tar.gz`);
  const localVerificationPath = join(dirname(root), `${basename(root)}-local.sqlite`);
  let captureStarted = false;
  let reconciliationVisible = false;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    let data;
    if (body.operationName === "POAPinCollectionsIntrospection") {
      data = {
        __schema: {
          queryType: { name: "query_root" },
          types: [
            {
              name: "query_root",
              fields: [{ name: "poaps" }, { name: "poaps_aggregate" }],
            },
            {
              name: "poaps",
              fields: [
                "chain",
                "collected_at",
                "collector_address",
                "drop_id",
                "id",
                "minted_on",
                "transfer_count",
              ].map((name) => ({ name })),
            },
          ],
        },
      };
    } else if (body.operationName === "POAPinCompassHoldingsUpperBound") {
      data = { poaps: [{ id: 5 }] };
    } else if (body.operationName === "POAPinCompassHoldingsShardCount") {
      const lower = Number(body.variables.lower);
      const upper = Number(body.variables.upper);
      if (captureStarted) reconciliationVisible = true;
      const rows = reconciliationVisible ? RECONCILED_ROWS : ROWS;
      data = {
        poaps_aggregate: {
          aggregate: { count: rows.filter((row) => row.id > lower && row.id <= upper).length },
        },
      };
    } else if (body.operationName === "POAPinCompassHoldingsNullChainCount") {
      data = {
        poaps_aggregate: {
          aggregate: {
            count: ROWS.filter(
              (row) => row.id <= Number(body.variables.upper) && row.chain === null,
            ).length,
          },
        },
      };
    } else if (body.operationName === "POAPinCompassHoldingsDistinctIdentityCount") {
      const identities = new Set(
        ROWS.filter((row) => row.id <= Number(body.variables.upper)).map(
          (row) => `${row.id}\u0000${row.chain}`,
        ),
      );
      data = { poaps_aggregate: { aggregate: { count: identities.size } } };
    } else if (body.operationName === "POAPinCompassHoldingsPage") {
      captureStarted = true;
      const afterId = Number(body.variables.afterId);
      const afterChain = body.variables.afterChain;
      const lower = Number(body.variables.lower);
      const upper = Number(body.variables.upper);
      data = {
        poaps: (reconciliationVisible ? RECONCILED_ROWS : CAPTURE_ROWS)
          .filter(
            (row) =>
              row.id > lower &&
              row.id <= upper &&
              (row.id > afterId || (row.id === afterId && row.chain > afterChain)),
          )
          .slice(0, 100),
      };
    } else if (body.operationName === "POAPinCompassReferencedDrops") {
      const ids = new Set(body.variables.dropIds);
      data = { drops: DROPS.filter((drop) => ids.has(drop.id)) };
    } else {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ errors: [{ message: "unexpected operation" }] }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ data }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    const manifest = await captureCompassHoldingsSnapshot({
      output: root,
      endpoint: `http://127.0.0.1:${address.port}/graphql`,
      snapshotId: "compass-holdings-test-v1",
      concurrency: 2,
      shards: 2,
      delayMs: 0,
    });
    assert.equal(manifest.counts.expected, 7);
    assert.equal(manifest.counts.initialExpected, 5);
    assert.equal(manifest.counts.captured, 7);
    assert.equal(manifest.counts.aggregateDrift, 2);
    assert.equal(manifest.counts.reconciliationAttempts, 1);
    assert.equal(manifest.counts.reconciledShards, 1);
    assert.equal(manifest.counts.shards, 2);
    assert.equal(manifest.pagination.upperPoapId, 5);
    assert.equal(manifest.database.sha256.length, 64);

    const database = new DatabaseSync(join(root, "compass-holdings.sqlite"), {
      readOnly: true,
    });
    assert.deepEqual(
      database
        .prepare(
          `SELECT source_uid, poap_id, drop_id, minted_on, owner_address, network, transfer_count
           FROM tokens
           ORDER BY poap_id, network`,
        )
        .all()
        .map((row) => ({ ...row })),
      RECONCILED_ROWS.map((row) => ({
        source_uid: `compass-poap:${row.id}:${row.chain}`,
        poap_id: row.id,
        drop_id: row.drop_id,
        minted_on: row.minted_on,
        owner_address: row.collector_address,
        network: row.chain,
        transfer_count: row.transfer_count,
      })),
    );
    assert.equal(
      database.prepare("SELECT value FROM snapshot_metadata WHERE key='tokens_count'").get().value,
      "7",
    );
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM capture_pages").get().count, 2);
    database.close();

    const source = JSON.parse(await readFile(join(root, "source.json"), "utf8"));
    assert.equal(source.snapshotId, "compass-holdings-test-v1");
    const resumed = await captureCompassHoldingsSnapshot({
      output: root,
      endpoint: `http://127.0.0.1:${address.port}/graphql`,
      snapshotId: "compass-holdings-test-v1",
      concurrency: 2,
      shards: 2,
      delayMs: 0,
      resume: true,
    });
    assert.equal(resumed.counts.captured, 7);

    const referencedDrops = await captureReferencedDrops({
      input: root,
      endpoint: `http://127.0.0.1:${address.port}/graphql`,
      delayMs: 0,
    });
    assert.deepEqual(referencedDrops.counts, {
      requested: 4,
      captured: 3,
      missing: 1,
      batches: 1,
    });
    assert.deepEqual(referencedDrops.missingDropIds, [50]);
    assert.equal(referencedDrops.database.sha256.length, 64);
    const resumedReferencedDrops = await captureReferencedDrops({
      input: root,
      endpoint: `http://127.0.0.1:${address.port}/graphql`,
      delayMs: 0,
      resume: true,
    });
    assert.equal(resumedReferencedDrops.database.sha256, referencedDrops.database.sha256);

    const d1 = await buildCompassHoldingsD1({ input: root });
    assert.deepEqual(d1.report.tables, {
      tokens: 7,
      owner_stats: 5,
      drop_collector_refs: 7,
      holding_drops: 3,
    });
    const target = new DatabaseSync(join(root, "holdings-target.sqlite"));
    for (const artifact of d1.report.artifacts) {
      target.exec(await readFile(join(root, "d1", artifact.path), "utf8"));
    }
    assert.equal(target.prepare("SELECT COUNT(*) AS count FROM tokens").get().count, 7);
    assert.equal(
      target.prepare("SELECT COUNT(*) AS count FROM drop_collector_refs").get().count,
      7,
    );
    assert.equal(target.prepare("SELECT COUNT(*) AS count FROM owner_stats").get().count, 5);
    assert.equal(target.prepare("SELECT COUNT(*) AS count FROM holding_drops").get().count, 3);
    assert.equal(
      target.prepare("SELECT token_count FROM holding_drops WHERE drop_id = 20").get().token_count,
      2,
    );
    assert.equal(
      target.prepare("SELECT value FROM archive_meta WHERE key='snapshot_id'").get().value,
      "compass-holdings-test-v1",
    );
    target.close();
    const localVerification = await verifyCompassHoldingsD1Locally({
      input: join(root, "d1"),
      output: localVerificationPath,
    });
    assert.equal(localVerification.report.counts.tokens, 7);
    assert.equal(localVerification.report.counts.collectors, 7);
    assert.equal(localVerification.report.counts.holdingDrops, 3);

    const staging = new DatabaseSync(join(root, "holdings-staging.sqlite"));
    const client = {
      async query(sql) {
        return staging
          .prepare(sql)
          .all()
          .map((row) => ({ ...row }));
      },
      async importFile(path) {
        staging.exec(await readFile(path, "utf8"));
      },
    };
    const context = await loadContext({
      input: join(root, "d1"),
      target: {
        name: "poapin-test-holdings",
        id: "11111111-1111-4111-8111-111111111111",
      },
      projectConfig: join(root, "unused-wrangler.jsonc"),
    });
    await d1LoaderInternals.preflight(context, client);
    await d1LoaderInternals.load(context, client);
    await d1LoaderInternals.verify(context, client);
    await d1LoaderInternals.activate(context, client);
    assert.equal(
      staging.prepare("SELECT value FROM archive_meta WHERE key='tokens_count'").get().value,
      "7",
    );
    staging.close();

    const packaged = await packageCompassHoldingsSnapshot({
      input: root,
      output: packagePath,
      partBytes: 5 * 1024 * 1024,
    });
    assert.equal(packaged.report.snapshotId, "compass-holdings-test-v1");
    assert.equal(packaged.report.parts.length, 1);
    assert.equal(packaged.report.parts[0].byteLength, packaged.report.archive.byteLength);
    const uploadPlan = await buildUploadPlan(packaged.reportPath, packaged.report);
    assert(uploadPlan.some((object) => object.key.endsWith("/d1/load/100001_tokens.sql")));
    assert(uploadPlan.some((object) => object.key.includes("/package/parts/")));
    assert(
      !uploadPlan.some((object) => object.key.endsWith(".sqlite")),
      "SQLite databases are stored inside bounded package parts, not as oversized R2 objects",
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
    await rm(packagePath, { force: true });
    await rm(`${packagePath}.parts`, { recursive: true, force: true });
    await rm(`${packagePath}.report.json`, { force: true });
    await rm(localVerificationPath, { force: true });
    await rm(`${localVerificationPath}.report.json`, { force: true });
  }
});
