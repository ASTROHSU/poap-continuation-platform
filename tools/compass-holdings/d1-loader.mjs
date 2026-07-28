#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sqlLiteral } from "../archive-import/lib/sql-shards.mjs";
import { sha256File } from "../archive-import/lib/util.mjs";
import { assertSuccessfulD1Response, parseWranglerJson } from "../archive-import/d1-loader.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_WRANGLER = resolve(PROJECT_ROOT, "node_modules/wrangler/bin/wrangler.js");
const DEFAULT_CONFIG = resolve(PROJECT_ROOT, "wrangler.jsonc");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const REQUIRED_TABLES = [
  "archive_meta",
  "tokens",
  "owner_stats",
  "import_shards",
  "drop_collector_refs",
  "drop_collector_backfill",
  "holding_drops",
  "holding_drop_artwork",
];
const REQUIRED_TRIGGERS = ["tokens_drop_collector_ref_after_insert"];
const PREPARE_PATHS = [
  "prepare/000001_schema.sql",
  "prepare/000002_import_shards.sql",
  "prepare/000003_drop_collectors.sql",
  "prepare/000004_referenced_drops.sql",
  "prepare/000005_artwork.sql",
];

const HELP = `POAP.in Compass Holdings D1 staging loader

Usage:
  node tools/compass-holdings/d1-loader.mjs <preflight|load|verify|activate> \\
    --input <d1-build-directory> \\
    --database-name <name> --database-id <uuid>

The loader accepts only a complete generated report, checks every local SQL
artifact, targets an isolated Wrangler binding, and resumes from transaction-
bound import_shards markers. activate writes archive_meta last.

Safety overrides for a target already present in wrangler.jsonc:
  --allow-configured-empty-target
  --confirm-worker-not-activated
`;

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const context = await loadContext(options);
  await enforceConfiguredTargetGate(context, options);
  const client = await createWranglerClient(context.target, options, dependencies);
  try {
    if (options.phase === "preflight") await preflight(context, client);
    else if (options.phase === "load") await load(context, client);
    else if (options.phase === "verify") await verify(context, client);
    else await activate(context, client);
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        phase: options.phase,
        snapshotId: context.snapshotId,
        database: context.target,
      })}\n`,
    );
    return 0;
  } finally {
    await client.close();
  }
}

function parseOptions(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const phase = argv[0];
  if (!new Set(["preflight", "load", "verify", "activate"]).has(phase)) {
    throw new Error("First argument must be preflight, load, verify, or activate.");
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    strict: true,
    allowPositionals: false,
    options: {
      input: { type: "string" },
      "database-name": { type: "string" },
      "database-id": { type: "string" },
      "account-id": { type: "string" },
      "wrangler-bin": { type: "string", default: DEFAULT_WRANGLER },
      "project-config": { type: "string", default: DEFAULT_CONFIG },
      "allow-configured-empty-target": { type: "boolean", default: false },
      "confirm-worker-not-activated": { type: "boolean", default: false },
    },
  });
  for (const name of ["input", "database-name", "database-id"]) {
    if (!values[name]) throw new Error(`--${name} is required.`);
  }
  if (!UUID.test(values["database-id"])) throw new Error("--database-id must be a D1 UUID.");
  return {
    help: false,
    phase,
    input: resolve(values.input),
    target: { name: values["database-name"], id: values["database-id"] },
    accountId: values["account-id"] ?? null,
    wranglerBin: resolve(values["wrangler-bin"]),
    projectConfig: resolve(values["project-config"]),
    allowConfiguredEmptyTarget: values["allow-configured-empty-target"],
    confirmWorkerNotActivated: values["confirm-worker-not-activated"],
  };
}

export async function loadContext(options) {
  const root = await realpath(options.input);
  const reportPath = resolve(root, "report.json");
  const reportStat = await lstat(reportPath);
  if (!reportStat.isFile() || reportStat.isSymbolicLink()) {
    throw new Error("D1 report must be a regular file.");
  }
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (
    report?.version !== 1 ||
    report.dataset !== "poapin-compass-holdings-d1" ||
    !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(report.snapshotId ?? "") ||
    !SHA256.test(report.source?.database?.sha256 ?? "") ||
    !SHA256.test(report.source?.referencedDrops?.database?.sha256 ?? "") ||
    !SHA256.test(report.source?.referencedDrops?.manifest?.sha256 ?? "") ||
    !Number.isSafeInteger(report.source?.referencedDrops?.requested) ||
    !Number.isSafeInteger(report.source?.referencedDrops?.captured) ||
    !Number.isSafeInteger(report.source?.referencedDrops?.missing) ||
    report.source.referencedDrops.captured + report.source.referencedDrops.missing !==
      report.source.referencedDrops.requested
  ) {
    throw new Error("Compass Holdings D1 report identity is invalid.");
  }
  if (
    !Number.isSafeInteger(report.builder?.settings?.maxStatementBytes) ||
    report.builder.settings.maxStatementBytes <= 0 ||
    report.builder.settings.maxStatementBytes > 96 * 1024
  ) {
    throw new Error("Compass Holdings D1 report settings are invalid.");
  }
  const artifacts = new Map();
  for (const artifact of report.artifacts ?? []) {
    const checked = await validateArtifact(root, artifact, report);
    if (artifacts.has(checked.path)) throw new Error(`Duplicate artifact ${checked.path}.`);
    artifacts.set(checked.path, checked);
  }
  const prepare = PREPARE_PATHS.map((path) => artifacts.get(path));
  if (prepare.some((artifact) => !artifact)) {
    throw new Error("D1 report omits a canonical Holdings migration.");
  }
  const data = [...artifacts.values()]
    .filter((artifact) => artifact.phase === "load")
    .sort(comparePaths);
  const finalize = [...artifacts.values()].filter((artifact) => artifact.phase === "finalize");
  if (
    data.length === 0 ||
    finalize.length !== 1 ||
    finalize[0].path !== "finalize/999999_finalize.sql" ||
    artifacts.size !== prepare.length + data.length + finalize.length
  ) {
    throw new Error("D1 report has an invalid prepare/load/finalize plan.");
  }
  await assertCanonicalMigrations(prepare);
  assertTableTotals(report, data);
  return {
    root,
    report,
    reportSha256: await sha256File(reportPath),
    snapshotId: report.snapshotId,
    sourceDatabaseSha256: report.source.database.sha256,
    target: options.target,
    prepare,
    data,
    finalize: finalize[0],
    projectConfig: options.projectConfig,
  };
}

async function validateArtifact(root, artifact, report) {
  if (
    typeof artifact?.path !== "string" ||
    artifact.kind !== "d1-sql" ||
    artifact.database !== "holdings" ||
    !new Set(["prepare", "load", "finalize"]).has(artifact.phase) ||
    !SHA256.test(artifact.sha256 ?? "") ||
    !Number.isSafeInteger(artifact.byteLength) ||
    artifact.byteLength <= 0
  ) {
    throw new Error(`Invalid D1 artifact descriptor ${artifact?.path ?? "<missing>"}.`);
  }
  const absolutePath = resolve(root, artifact.path);
  const local = relative(root, absolutePath);
  if (local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error(`D1 artifact escapes its root: ${artifact.path}.`);
  }
  const fileStat = await lstat(absolutePath);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== artifact.byteLength) {
    throw new Error(`D1 artifact is not the expected regular file: ${artifact.path}.`);
  }
  if ((await sha256File(absolutePath)) !== artifact.sha256) {
    throw new Error(`D1 artifact checksum mismatch: ${artifact.path}.`);
  }
  if (artifact.phase === "load") {
    const maximum = report.builder?.settings?.maxStatementBytes;
    if (
      !SHA256.test(artifact.payloadSha256 ?? "") ||
      !["tokens", "owner_stats", "holding_drops"].includes(artifact.table) ||
      !Number.isSafeInteger(artifact.rowCount) ||
      artifact.rowCount <= 0 ||
      !Number.isSafeInteger(artifact.statementCount) ||
      artifact.statementCount <= 0 ||
      !Number.isSafeInteger(artifact.maxStatementByteLength) ||
      artifact.maxStatementByteLength <= 0 ||
      artifact.maxStatementByteLength > maximum
    ) {
      throw new Error(`D1 load artifact lacks valid journal metadata: ${artifact.path}.`);
    }
  }
  return { ...artifact, absolutePath };
}

async function assertCanonicalMigrations(artifacts) {
  const sources = [
    "migrations/holdings/0001_schema.sql",
    "migrations/holdings/0002_import_shards.sql",
    "migrations/holdings/0003_drop_collectors.sql",
    "migrations/holdings/0004_referenced_drops.sql",
    "migrations/holdings/0005_artwork.sql",
  ];
  for (let index = 0; index < sources.length; index += 1) {
    const expected = await readFile(resolve(PROJECT_ROOT, sources[index]));
    const actual = await readFile(artifacts[index].absolutePath);
    if (!actual.equals(expected)) {
      throw new Error(`D1 prepare artifact differs from ${sources[index]}.`);
    }
  }
}

function assertTableTotals(report, data) {
  const totals = { tokens: 0, owner_stats: 0, holding_drops: 0 };
  for (const artifact of data) totals[artifact.table] += artifact.rowCount;
  if (
    totals.tokens !== report.tables?.tokens ||
    totals.owner_stats !== report.tables?.owner_stats ||
    totals.holding_drops !== report.tables?.holding_drops ||
    report.tables?.drop_collector_refs !== report.tables?.tokens
  ) {
    throw new Error("D1 artifact row totals differ from the report.");
  }
}

async function enforceConfiguredTargetGate(context, options) {
  let source = "";
  try {
    source = await readFile(context.projectConfig, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const configured = [...source.matchAll(/"database_id"\s*:\s*"([^"]+)"/g)].some(
    (match) => match[1] === context.target.id,
  );
  if (configured && (!options.allowConfiguredEmptyTarget || !options.confirmWorkerNotActivated)) {
    throw new Error(
      "Target is present in wrangler.jsonc. Pass both configured-target safety attestations only for a proven empty, inactive target.",
    );
  }
}

async function createWranglerClient(target, options, dependencies) {
  if (dependencies.createClient) return dependencies.createClient(target);
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), "poapin-compass-d1-loader-"));
  const configPath = resolve(temporaryRoot, "wrangler.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        name: "poapin-compass-holdings-loader",
        compatibility_date: "2026-03-10",
        ...(options.accountId ? { account_id: options.accountId } : {}),
        d1_databases: [
          {
            binding: "POAP_IMPORT_DB",
            database_name: target.name,
            database_id: target.id,
          },
        ],
      },
      null,
      2,
    )}\n`,
    { flag: "wx", mode: 0o600 },
  );
  const runJson = async (args) => {
    const child = spawn(process.execPath, [options.wranglerBin, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const [code] = await once(child, "close");
    if (code !== 0) {
      throw new Error(
        `Wrangler failed for ${target.name}: ${stderr.trim() || stdout.trim() || `exit ${code}`}`,
      );
    }
    return parseWranglerJson(stdout);
  };
  try {
    const identity = await runJson([
      "d1",
      "info",
      "POAP_IMPORT_DB",
      "--config",
      configPath,
      "--json",
    ]);
    if (identity?.uuid !== target.id || identity?.name !== target.name) {
      throw new Error(`Wrangler resolved a different D1 identity for ${target.name}.`);
    }
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
  const execute = async (argument, value) => {
    const response = await runJson([
      "d1",
      "execute",
      "POAP_IMPORT_DB",
      "--config",
      configPath,
      "--remote",
      "--yes",
      "--json",
      argument,
      value,
    ]);
    return assertSuccessfulD1Response(response, target.name);
  };
  return {
    async query(sql) {
      return (await execute("--command", sql)).flatMap((item) => item.results ?? []);
    },
    async importFile(filePath) {
      return execute("--file", filePath);
    },
    async close() {
      await rm(temporaryRoot, { recursive: true, force: true });
    },
  };
}

async function schemaState(client) {
  const rows = await client.query(
    "SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'trigger') ORDER BY name;",
  );
  const names = new Set(rows.map((row) => row.name));
  const required = [...REQUIRED_TABLES, ...REQUIRED_TRIGGERS];
  const found = required.filter((name) => names.has(name));
  return {
    empty: found.length === 0,
    complete: found.length === required.length,
    missing: required.filter((name) => !names.has(name)),
  };
}

async function preflight(_context, client) {
  const schema = await schemaState(client);
  if (!schema.empty) throw new Error("Holdings staging target is not empty.");
}

async function load(context, client) {
  let schema = await schemaState(client);
  if (!schema.empty && !schema.complete) {
    throw new Error(`Holdings staging schema is partial: ${schema.missing.join(", ")}.`);
  }
  if (schema.empty) {
    for (const [index, artifact] of context.prepare.entries()) {
      process.stderr.write(
        `[compass-d1-loader] prepare ${index + 1}/${context.prepare.length} ${artifact.path}\n`,
      );
      await client.importFile(artifact.absolutePath);
    }
    schema = await schemaState(client);
    if (!schema.complete) throw new Error("Holdings schema migrations did not complete.");
  }
  const meta = await archiveMeta(client);
  if (Object.keys(meta).length > 0) throw new Error("Holdings target is already activated.");
  const journal = await journalMap(client);
  assertKnownJournal(context, journal);
  for (const [index, artifact] of context.data.entries()) {
    if (journal.has(artifact.path)) {
      assertMarker(context, artifact, journal.get(artifact.path));
      continue;
    }
    process.stderr.write(
      `[compass-d1-loader] load ${index + 1}/${context.data.length} ${artifact.path}\n`,
    );
    await client.importFile(artifact.absolutePath);
    const marker = await journalMarker(client, context.snapshotId, artifact.path);
    assertMarker(context, artifact, marker);
    journal.set(artifact.path, marker);
  }
}

async function verify(context, client) {
  const schema = await schemaState(client);
  if (!schema.complete)
    throw new Error(`Holdings schema is incomplete: ${schema.missing.join(", ")}.`);
  const journal = await journalMap(client);
  assertKnownJournal(context, journal);
  for (const artifact of context.data) {
    assertMarker(context, artifact, journal.get(artifact.path));
  }
  const [totals] = await client.query(
    `SELECT
      SUM(CASE WHEN table_name = 'tokens' THEN row_count ELSE 0 END) AS tokens,
      SUM(CASE WHEN table_name = 'owner_stats' THEN row_count ELSE 0 END) AS owners,
      SUM(CASE WHEN table_name = 'holding_drops' THEN row_count ELSE 0 END) AS holding_drops,
      COUNT(*) AS shards
     FROM import_shards
     WHERE snapshot_id = ${sqlLiteral(context.snapshotId)};`,
  );
  if (
    Number(totals?.tokens) !== context.report.tables.tokens ||
    Number(totals?.owners) !== context.report.tables.owner_stats ||
    Number(totals?.holding_drops) !== context.report.tables.holding_drops ||
    Number(totals?.shards) !== context.data.length
  ) {
    throw new Error("Remote D1 import journal totals differ from the build report.");
  }
  const [presence] = await client.query(
    `SELECT
      EXISTS(SELECT 1 FROM tokens LIMIT 1) AS tokens,
      EXISTS(SELECT 1 FROM owner_stats LIMIT 1) AS owners,
      EXISTS(SELECT 1 FROM drop_collector_refs LIMIT 1) AS collectors,
      EXISTS(SELECT 1 FROM holding_drops LIMIT 1) AS holding_drops;`,
  );
  if (!presence?.tokens || !presence?.owners || !presence?.collectors || !presence?.holding_drops) {
    throw new Error("Remote D1 Holdings tables are unexpectedly empty.");
  }
}

async function activate(context, client) {
  await verify(context, client);
  let meta = await archiveMeta(client);
  if (Object.keys(meta).length === 0) {
    await client.importFile(context.finalize.absolutePath);
    meta = await archiveMeta(client);
  }
  const expected = {
    snapshot_id: context.snapshotId,
    source_database_sha256: context.sourceDatabaseSha256,
    tokens_count: String(context.report.tables.tokens),
    owners_count: String(context.report.tables.owner_stats),
    referenced_drops_count: String(context.report.tables.holding_drops),
    referenced_drops_database_sha256: context.report.source.referencedDrops.database.sha256,
    referenced_drops_manifest_sha256: context.report.source.referencedDrops.manifest.sha256,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (meta[key] !== value) throw new Error(`Remote archive_meta mismatch for ${key}.`);
  }
}

async function journalMap(client) {
  const rows = await client.query(
    "SELECT snapshot_id, source_database_sha256, shard_path, payload_sha256, table_name, row_count, statement_count FROM import_shards ORDER BY shard_path;",
  );
  const result = new Map();
  for (const row of rows) {
    if (result.has(row.shard_path)) throw new Error(`Remote journal repeats ${row.shard_path}.`);
    result.set(row.shard_path, row);
  }
  return result;
}

async function journalMarker(client, snapshotId, path) {
  const rows = await client.query(
    `SELECT snapshot_id, source_database_sha256, shard_path, payload_sha256, table_name, row_count, statement_count
     FROM import_shards
     WHERE snapshot_id = ${sqlLiteral(snapshotId)}
       AND shard_path = ${sqlLiteral(path)};`,
  );
  return rows[0] ?? null;
}

function assertKnownJournal(context, journal) {
  const expected = new Set(context.data.map((artifact) => artifact.path));
  for (const [path, marker] of journal) {
    if (!expected.has(path) || marker.snapshot_id !== context.snapshotId) {
      throw new Error(`Remote journal has an unexpected marker: ${path}.`);
    }
  }
}

function assertMarker(context, artifact, marker) {
  if (
    !marker ||
    marker.snapshot_id !== context.snapshotId ||
    marker.source_database_sha256 !== context.sourceDatabaseSha256 ||
    marker.shard_path !== artifact.path ||
    marker.payload_sha256 !== artifact.payloadSha256 ||
    marker.table_name !== artifact.table ||
    Number(marker.row_count) !== artifact.rowCount ||
    Number(marker.statement_count) !== artifact.statementCount
  ) {
    throw new Error(`Remote journal marker mismatch: ${artifact.path}.`);
  }
}

async function archiveMeta(client) {
  const rows = await client.query("SELECT key, value FROM archive_meta ORDER BY key;");
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function comparePaths(left, right) {
  return left.path.localeCompare(right.path, "en");
}

export const d1LoaderInternals = {
  activate,
  assertMarker,
  assertTableTotals,
  load,
  preflight,
  schemaState,
  verify,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`[compass-d1-loader] ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
