#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { sqlLiteral } from "./lib/sql-shards.mjs";
import { sha256File, toErrorMessage } from "./lib/util.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_WRANGLER = resolve(PROJECT_ROOT, "node_modules/wrangler/bin/wrangler.js");
const DEFAULT_CONFIG = resolve(PROJECT_ROOT, "wrangler.jsonc");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ROLES = {
  catalog: {
    tables: ["archive_meta", "drops", "drop_stats", "import_shards"],
    indexes: [],
    triggers: [],
  },
  holdings: {
    tables: [
      "archive_meta",
      "tokens",
      "owner_stats",
      "import_shards",
      "drop_collector_refs",
      "drop_collector_backfill",
    ],
    indexes: [],
    triggers: ["tokens_drop_collector_ref_after_insert"],
  },
};

function parseWranglerJson(stdout) {
  const source = stdout.trim();
  const candidates = [0];
  for (const match of source.matchAll(/\n(?=[{[])/g)) candidates.push(match.index + 1);
  const parsed = [];
  for (const offset of candidates) {
    try {
      parsed.push(JSON.parse(source.slice(offset)));
    } catch {
      // Wrangler may print a human-readable upload prelude before its JSON document.
    }
  }
  if (parsed.length === 1) return parsed[0];
  throw new Error("Wrangler output does not contain a complete JSON document.");
}

function assertSuccessfulD1Response(response, targetName) {
  if (
    !Array.isArray(response) ||
    response.length === 0 ||
    response.some((item) => item?.success !== true)
  ) {
    throw new Error(`Wrangler reported an unsuccessful D1 operation for ${targetName}.`);
  }
  return response;
}

const HELP = `POAP.in fail-closed remote D1 loader

Usage:
  node tools/archive-import/d1-loader.mjs <preflight|load|verify|activate> \\
    --input <import-output> \\
    --catalog-name <name> --catalog-id <uuid> \\
    --holdings-name <name> --holdings-id <uuid>

activate additionally requires --r2-report <publishable-upload-report.json>
and --r2-bucket <expected-bucket-name>.

Safety overrides for targets already present in wrangler.jsonc:
  --allow-configured-empty-target
  --confirm-worker-not-activated

The second flag is an operator attestation. This tool can prove that D1 is empty,
but cannot prove that no deployed Worker is bound to it. Every target is placed in
an isolated temporary Wrangler config; repository binding names are never used.
`;

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const context = await loadContext(options);
  await enforceConfiguredTargetGate(context, options);
  const clients = await Promise.all(
    Object.entries(context.targets).map(async ([role, target]) => [
      role,
      await createWranglerClient(target, options, dependencies),
    ]),
  );
  const byRole = Object.fromEntries(clients);
  try {
    if (options.phase === "preflight") await preflight(context, byRole);
    else if (options.phase === "load") await load(context, byRole);
    else if (options.phase === "verify") await verify(context, byRole);
    else if (options.phase === "activate") {
      await activate(context, byRole, options.r2ReportPath, options.r2Bucket);
    }
    process.stdout.write(
      `${JSON.stringify({ ok: true, phase: options.phase, snapshotId: context.snapshotId })}\n`,
    );
    return 0;
  } finally {
    await Promise.all(clients.map(([, client]) => client.close()));
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
      "catalog-name": { type: "string" },
      "catalog-id": { type: "string" },
      "holdings-name": { type: "string" },
      "holdings-id": { type: "string" },
      "account-id": { type: "string" },
      "r2-report": { type: "string" },
      "r2-bucket": { type: "string" },
      "wrangler-bin": { type: "string", default: DEFAULT_WRANGLER },
      "project-config": { type: "string", default: DEFAULT_CONFIG },
      "allow-configured-empty-target": { type: "boolean", default: false },
      "confirm-worker-not-activated": { type: "boolean", default: false },
    },
  });
  for (const name of ["input", "catalog-name", "catalog-id", "holdings-name", "holdings-id"]) {
    if (!values[name]) throw new Error(`--${name} is required.`);
  }
  for (const name of ["catalog-id", "holdings-id"]) {
    if (!UUID.test(values[name])) throw new Error(`--${name} must be a D1 UUID.`);
  }
  if (values["catalog-id"] === values["holdings-id"]) {
    throw new Error("Catalog and holdings must use different D1 database IDs.");
  }
  if (phase === "activate" && (!values["r2-report"] || !values["r2-bucket"])) {
    throw new Error("activate requires --r2-report and --r2-bucket.");
  }
  return {
    help: false,
    phase,
    inputDirectory: resolve(values.input),
    targets: {
      catalog: { name: values["catalog-name"], id: values["catalog-id"] },
      holdings: { name: values["holdings-name"], id: values["holdings-id"] },
    },
    accountId: values["account-id"] ?? null,
    r2ReportPath: values["r2-report"] ? resolve(values["r2-report"]) : null,
    r2Bucket: values["r2-bucket"] ?? null,
    wranglerBin: resolve(values["wrangler-bin"]),
    projectConfig: resolve(values["project-config"]),
    allowConfiguredEmptyTarget: values["allow-configured-empty-target"],
    confirmWorkerNotActivated: values["confirm-worker-not-activated"],
  };
}

async function loadContext(options) {
  const reportPath = resolve(options.inputDirectory, "report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (report.formatVersion !== 2) {
    throw new Error(
      `Unsupported report format ${report.formatVersion}; regenerate with importer v2.`,
    );
  }
  if (!Array.isArray(report.quality?.blockingIssues) || report.quality.blockingIssues.length > 0) {
    throw new Error("Import report has publish-blocking quality issues.");
  }
  const artifacts = new Map();
  for (const artifact of report.artifacts ?? []) {
    if (!artifact?.path || artifacts.has(artifact.path)) {
      throw new Error(`Invalid or duplicate artifact path: ${artifact?.path ?? "<missing>"}`);
    }
    const absolutePath = resolve(options.inputDirectory, artifact.path);
    const relativePath = relative(options.inputDirectory, absolutePath);
    if (relativePath.startsWith(`..${sep}`) || relativePath === "..") {
      throw new Error(`Artifact escapes the import directory: ${artifact.path}`);
    }
    const fileStat = await stat(absolutePath);
    if (!fileStat.isFile() || fileStat.size !== artifact.byteLength) {
      throw new Error(`Artifact size mismatch: ${artifact.path}`);
    }
    const sha256 = await sha256File(absolutePath);
    if (sha256 !== artifact.sha256) throw new Error(`Artifact checksum mismatch: ${artifact.path}`);
    artifacts.set(artifact.path, { ...artifact, absolutePath });
  }
  const snapshotId = report.snapshot?.id;
  const sourceDatabaseSha256 = report.source?.database?.sha256;
  if (!snapshotId || !/^[0-9a-f]{64}$/.test(sourceDatabaseSha256 ?? "")) {
    throw new Error("Report snapshot/source identity is invalid.");
  }
  const targetArtifacts = {};
  for (const role of Object.keys(ROLES)) {
    const all = [...artifacts.values()].filter(
      (artifact) => artifact.kind === "d1-sql" && artifact.path.startsWith(`${role}/`),
    );
    const load = all.filter(
      (artifact) => artifact.phase === "prepare" || artifact.phase === "load",
    );
    const data = all.filter((artifact) => artifact.phase === "load");
    const finalize = all.filter((artifact) => artifact.phase === "finalize");
    if (
      data.length === 0 ||
      finalize.length !== 1 ||
      load.length + finalize.length !== all.length
    ) {
      throw new Error(`Report has an invalid ${role} D1 artifact plan.`);
    }
    for (const artifact of data) {
      if (
        artifact.database !== role ||
        !/^[0-9a-f]{64}$/.test(artifact.payloadSha256 ?? "") ||
        !Number.isSafeInteger(artifact.rowCount) ||
        !Number.isSafeInteger(artifact.statementCount)
      ) {
        throw new Error(`Data shard lacks journal metadata: ${artifact.path}`);
      }
    }
    targetArtifacts[role] = {
      load: load.sort((left, right) => left.path.localeCompare(right.path, "en")),
      data: data.sort((left, right) => left.path.localeCompare(right.path, "en")),
      finalize: finalize[0],
    };
  }
  return {
    report,
    reportSha256: await sha256File(reportPath),
    snapshotId,
    sourceDatabaseSha256,
    targets: options.targets,
    targetArtifacts,
    artifacts,
    projectConfig: options.projectConfig,
  };
}

async function configuredDatabaseIds(configPath) {
  let source;
  try {
    source = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new Set();
    throw error;
  }
  return new Set([...source.matchAll(/"database_id"\s*:\s*"([^"]+)"/g)].map((match) => match[1]));
}

async function enforceConfiguredTargetGate(context, options) {
  const configured = await configuredDatabaseIds(context.projectConfig);
  const matching = Object.entries(context.targets).filter(([, target]) =>
    configured.has(target.id),
  );
  if (matching.length === 0) return;
  if (!options.allowConfiguredEmptyTarget || !options.confirmWorkerNotActivated) {
    throw new Error(
      `Target ${matching.map(([role]) => role).join(", ")} is present in wrangler.jsonc. ` +
        "Pass both --allow-configured-empty-target and --confirm-worker-not-activated only after independently proving that no deployed Worker uses it.",
    );
  }
}

async function createWranglerClient(target, options, dependencies) {
  if (dependencies.createClient) return dependencies.createClient(target);
  const root = await mkdtemp(resolve(tmpdir(), "poapin-d1-loader-"));
  const configPath = resolve(root, "wrangler.json");
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        name: "poapin-d1-loader",
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
    try {
      return parseWranglerJson(stdout);
    } catch {
      throw new Error(`Wrangler returned invalid JSON for ${target.name}.`);
    }
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
    await rm(root, { recursive: true, force: true });
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
    target,
    async query(sql) {
      const response = await execute("--command", sql);
      return response.flatMap((item) => item.results ?? []);
    },
    async importFile(filePath) {
      return execute("--file", filePath);
    },
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function inspectTarget(role, client) {
  const names = await client.query(
    "SELECT name FROM sqlite_schema WHERE type IN ('table', 'view', 'index', 'trigger') ORDER BY name;",
  );
  const found = new Set(names.map((row) => row.name));
  const required = [...ROLES[role].tables, ...ROLES[role].indexes, ...ROLES[role].triggers];
  const missing = required.filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new Error(`${role} is missing required migration objects: ${missing.join(", ")}.`);
  }
  const dataTables =
    role === "catalog"
      ? ["drops", "drop_stats"]
      : ["tokens", "owner_stats", "drop_collector_refs", "drop_collector_backfill"];
  const [state] = await client.query(`SELECT
    EXISTS(SELECT 1 FROM archive_meta LIMIT 1) AS has_meta,
    EXISTS(SELECT 1 FROM import_shards LIMIT 1) AS has_journal,
    ${dataTables.map((table, index) => `EXISTS(SELECT 1 FROM ${table} LIMIT 1) AS has_data_${index}`).join(",\n    ")};`);
  return {
    hasMeta: Boolean(state?.has_meta),
    hasJournal: Boolean(state?.has_journal),
    hasData: dataTables.some((_, index) => Boolean(state?.[`has_data_${index}`])),
  };
}

async function preflight(context, clients) {
  for (const role of Object.keys(ROLES)) {
    const state = await inspectTarget(role, clients[role]);
    if (state.hasMeta || state.hasJournal || state.hasData) {
      throw new Error(`${role} target is not an empty staging database.`);
    }
  }
}

async function load(context, clients) {
  for (const role of ["catalog", "holdings"]) {
    const client = clients[role];
    const state = await inspectTarget(role, client);
    if (state.hasMeta) throw new Error(`${role} already has archive_meta and cannot be loaded.`);
    if (!state.hasJournal && state.hasData) {
      throw new Error(`${role} contains unjournaled data; use a fresh staging database.`);
    }
    const existing = await journalMap(client);
    assertKnownJournal(context, role, existing);
    const plan = context.targetArtifacts[role].load;
    for (const [index, artifact] of plan.entries()) {
      if (artifact.phase === "load" && existing.has(artifact.path)) {
        assertMarker(context, artifact, existing.get(artifact.path));
        process.stderr.write(
          `[archive-d1-loader] ${role} ${index + 1}/${plan.length} verified existing ${artifact.path}\n`,
        );
        continue;
      }
      process.stderr.write(
        `[archive-d1-loader] ${role} ${index + 1}/${plan.length} importing ${artifact.path}\n`,
      );
      await client.importFile(artifact.absolutePath);
      if (artifact.phase === "load") {
        const marker = await journalMarker(client, context.snapshotId, artifact.path);
        assertMarker(context, artifact, marker);
        existing.set(artifact.path, marker);
      }
    }
  }
}

async function verify(context, clients) {
  for (const role of ["catalog", "holdings"]) {
    await inspectTarget(role, clients[role]);
    const existing = await journalMap(clients[role]);
    assertKnownJournal(context, role, existing);
    for (const artifact of context.targetArtifacts[role].data) {
      assertMarker(context, artifact, existing.get(artifact.path));
    }
  }
}

async function activate(context, clients, r2ReportPath, r2Bucket) {
  await verify(context, clients);
  await validateR2Report(context, r2ReportPath, r2Bucket);
  for (const role of ["holdings", "catalog"]) {
    const meta = await archiveMeta(clients[role]);
    if (Object.keys(meta).length === 0) {
      await clients[role].importFile(context.targetArtifacts[role].finalize.absolutePath);
    }
    assertArchiveMeta(context, role, await archiveMeta(clients[role]));
  }
}

async function journalMap(client) {
  const rows = await client.query(
    "SELECT snapshot_id, source_database_sha256, shard_path, payload_sha256, table_name, row_count, statement_count FROM import_shards ORDER BY snapshot_id, shard_path;",
  );
  const markers = new Map();
  for (const row of rows) {
    if (markers.has(row.shard_path)) {
      throw new Error(`Remote journal repeats a shard path: ${row.shard_path}`);
    }
    markers.set(row.shard_path, row);
  }
  return markers;
}

async function journalMarker(client, snapshotId, path) {
  const rows = await client.query(
    `SELECT snapshot_id, source_database_sha256, shard_path, payload_sha256, table_name, row_count, statement_count FROM import_shards WHERE snapshot_id = ${sqlLiteral(snapshotId)} AND shard_path = ${sqlLiteral(path)};`,
  );
  return rows[0] ?? null;
}

function assertKnownJournal(context, role, existing) {
  const expected = new Set(context.targetArtifacts[role].data.map((artifact) => artifact.path));
  for (const [path, marker] of existing) {
    if (!expected.has(path)) throw new Error(`${role} has an unexpected import marker: ${path}`);
    if (marker.snapshot_id !== context.snapshotId) {
      throw new Error(`${role} marker belongs to another snapshot: ${path}`);
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
    throw new Error(`Remote journal marker mismatch: ${artifact.path}`);
  }
}

async function archiveMeta(client) {
  const rows = await client.query("SELECT key, value FROM archive_meta ORDER BY key;");
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function assertArchiveMeta(context, role, meta) {
  const expected = {
    snapshot_id: context.snapshotId,
    source_database_sha256: context.sourceDatabaseSha256,
    tokens_count: String(context.report.counts.accepted.tokens),
    owners_count: String(context.report.counts.accepted.owners),
    ...(role === "catalog"
      ? {
          drops_count: String(context.report.counts.accepted.drops),
          artworks_count: String(context.report.counts.accepted.artworks),
        }
      : {}),
  };
  for (const [key, value] of Object.entries(expected)) {
    if (meta[key] !== value) throw new Error(`${role} archive_meta mismatch for ${key}.`);
  }
}

async function validateR2Report(context, reportPath, expectedBucket) {
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const manifest = context.artifacts.get("r2/artwork-manifest.ndjson");
  const archiveIntegrity = context.report.source?.archiveIntegrity;
  const expectedArchiveSha256 =
    archiveIntegrity?.expectedSha256 ?? archiveIntegrity?.measuredSha256 ?? null;
  if (
    report.version !== 1 ||
    report.publishable !== true ||
    report.ok !== true ||
    report.complete !== true ||
    report.mode !== "upload" ||
    report.snapshotId !== context.snapshotId ||
    report.target?.snapshotId !== context.snapshotId ||
    !expectedBucket ||
    report.target?.bucket !== expectedBucket ||
    !expectedArchiveSha256 ||
    report.source?.sha256 !== expectedArchiveSha256 ||
    !manifest ||
    report.manifest?.sha256 !== manifest.sha256 ||
    report.manifest?.byteLength !== manifest.byteLength ||
    report.manifest?.rows !== manifest.rowCount ||
    report.manifest?.eligible !== context.report.counts.accepted.artworks ||
    report.counts?.failed !== 0 ||
    (report.failures?.length ?? 0) !== 0
  ) {
    throw new Error("R2 upload report is not publishable for this import report.");
  }
}

export {
  loadContext,
  preflight,
  load,
  verify,
  activate,
  enforceConfiguredTargetGate,
  parseWranglerJson,
  assertSuccessfulD1Response,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`[archive-d1-loader] ${toErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
