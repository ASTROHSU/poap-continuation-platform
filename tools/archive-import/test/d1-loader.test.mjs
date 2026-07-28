import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  activate,
  assertSuccessfulD1Response,
  enforceConfiguredTargetGate,
  load,
  loadContext,
  parseWranglerJson,
  verify,
} from "../d1-loader.mjs";

const SNAPSHOT = "2026-07-02-v1";
const SOURCE_SHA = "a".repeat(64);

test("parses Wrangler JSON after its file-upload status prelude", () => {
  const response = [{ results: [], success: true }];
  assert.deepEqual(parseWranglerJson(JSON.stringify(response)), response);
  assert.deepEqual(
    parseWranglerJson(`├ Checking if file needs uploading\n│\n${JSON.stringify(response)}\n`),
    response,
  );
  assert.throws(
    () => parseWranglerJson("├ Checking if file needs uploading\n│\nnot-json\n"),
    /complete JSON document/,
  );
  assert.throws(
    () => parseWranglerJson(`${JSON.stringify(response)}\ntrailing output\n`),
    /complete JSON document/,
  );
});

test("rejects empty, malformed, or unsuccessful D1 responses", () => {
  const response = [{ results: [], success: true }];
  assert.equal(assertSuccessfulD1Response(response, "fixture"), response);
  for (const rejected of [[], {}, [{ success: false }], [{ results: [] }]]) {
    assert.throws(
      () => assertSuccessfulD1Response(rejected, "fixture"),
      /unsuccessful D1 operation/,
    );
  }
});

test("stops on the first failed shard, resumes from remote markers, and activates last", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-d1-loader-test-"));
  try {
    const { context, r2ReportPath } = await fixtureContext(root);
    const activationOrder = [];
    const catalog = fakeClient("catalog", context, activationOrder);
    const holdings = fakeClient("holdings", context, activationOrder);
    const clients = { catalog, holdings };

    const failedPath = context.targetArtifacts.catalog.data[1].path;
    catalog.failOnce = failedPath;
    await assert.rejects(load(context, clients), /fixture import failure/);
    assert.equal(catalog.imports.includes(failedPath), true);
    assert.equal(holdings.imports.length, 0, "a catalog failure must stop before holdings");
    assert.equal(
      [...catalog.markers.keys()].some((path) => path.endsWith("999999_finalize.sql")),
      false,
    );

    const committedPath = context.targetArtifacts.catalog.data[0].path;
    const committedMarker = catalog.markers.get(committedPath);
    catalog.markers.set(committedPath, { ...committedMarker, payload_sha256: "f".repeat(64) });
    await assert.rejects(load(context, clients), /Remote journal marker mismatch/);
    catalog.markers.set(committedPath, committedMarker);

    await load(context, clients);
    await verify(context, clients);
    assert.equal(
      catalog.imports.filter((path) => path === context.targetArtifacts.catalog.data[0].path)
        .length,
      1,
      "a committed shard must be skipped on resume",
    );
    assert.equal(
      [...catalog.imports, ...holdings.imports].some((path) =>
        path.endsWith("999999_finalize.sql"),
      ),
      false,
      "load must never execute finalizers",
    );

    await activate(context, clients, r2ReportPath, "poapin-archive");
    assert.deepEqual(activationOrder, ["holdings", "catalog"]);
    assert.equal(holdings.meta.get("snapshot_id"), SNAPSHOT);
    assert.equal(catalog.meta.get("snapshot_id"), SNAPSHOT);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured targets require both explicit first-launch attestations", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "poapin-d1-gate-test-"));
  try {
    const configuredId = "68061691-83a2-45bb-b7e8-64e3bc903b9f";
    const config = resolve(root, "wrangler.jsonc");
    await writeFile(config, `{ "database_id": "${configuredId}" }\n`);
    const context = {
      projectConfig: config,
      targets: {
        catalog: { id: configuredId },
        holdings: { id: "1b085d43-c467-4daa-a3f8-8396677dc9ca" },
      },
    };
    await assert.rejects(
      enforceConfiguredTargetGate(context, {
        allowConfiguredEmptyTarget: true,
        confirmWorkerNotActivated: false,
      }),
      /both --allow-configured-empty-target and --confirm-worker-not-activated/,
    );
    await enforceConfiguredTargetGate(context, {
      allowConfiguredEmptyTarget: true,
      confirmWorkerNotActivated: true,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureContext(root) {
  const artifacts = [];
  const add = async (path, contents, metadata) => {
    const absolute = resolve(root, path);
    await mkdir(resolve(absolute, ".."), { recursive: true });
    await writeFile(absolute, contents);
    artifacts.push({
      path,
      byteLength: Buffer.byteLength(contents),
      sha256: digest(contents),
      ...metadata,
    });
  };
  for (const role of ["catalog", "holdings"]) {
    await add(`${role}/000000_prepare.sql`, "SELECT 1;\n", {
      kind: "d1-sql",
      phase: "prepare",
      database: role,
    });
    const tables = role === "catalog" ? ["drops", "drop_stats"] : ["tokens", "owner_stats"];
    for (const [index, table] of tables.entries()) {
      const path = `${role}/${100001 + index}_${table}.sql`;
      const payload = `INSERT INTO ${table} DEFAULT VALUES;\n`;
      await add(path, `${payload}-- journal\n`, {
        kind: "d1-sql",
        phase: "load",
        database: role,
        table,
        payloadSha256: digest(payload),
        rowCount: 1,
        statementCount: 1,
      });
    }
    await add(`${role}/999999_finalize.sql`, "-- finalize\n", {
      kind: "d1-sql",
      phase: "finalize",
      database: role,
    });
  }
  const manifest = '{"fixture":true}\n';
  await add("r2/artwork-manifest.ndjson", manifest, {
    kind: "r2-manifest",
    entity: "artwork",
    rowCount: 1,
  });
  const report = {
    formatVersion: 2,
    snapshot: { id: SNAPSHOT },
    source: {
      database: { sha256: SOURCE_SHA },
      archiveIntegrity: {
        expectedSha256: "b".repeat(64),
        measuredSha256: "b".repeat(64),
      },
    },
    quality: { blockingIssues: [] },
    counts: { accepted: { tokens: 2, owners: 1, drops: 1, artworks: 1 } },
    artifacts,
  };
  await writeFile(resolve(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  const r2ReportPath = resolve(root, "r2-report.json");
  const manifestArtifact = artifacts.find((artifact) => artifact.path.startsWith("r2/"));
  await writeFile(
    r2ReportPath,
    `${JSON.stringify({
      version: 1,
      ok: true,
      complete: true,
      publishable: true,
      mode: "upload",
      snapshotId: SNAPSHOT,
      source: { sha256: "b".repeat(64) },
      target: { bucket: "poapin-archive", snapshotId: SNAPSHOT },
      manifest: {
        sha256: manifestArtifact.sha256,
        byteLength: manifestArtifact.byteLength,
        rows: 1,
        eligible: 1,
      },
      counts: { failed: 0 },
      failures: [],
    })}\n`,
  );
  return {
    context: await loadContext({
      inputDirectory: root,
      targets: {
        catalog: { name: "catalog", id: "68061691-83a2-45bb-b7e8-64e3bc903b9f" },
        holdings: { name: "holdings", id: "1b085d43-c467-4daa-a3f8-8396677dc9ca" },
      },
      projectConfig: resolve(root, "not-configured.jsonc"),
    }),
    r2ReportPath,
  };
}

function fakeClient(role, context, activationOrder) {
  const client = {
    role,
    imports: [],
    markers: new Map(),
    meta: new Map(),
    failOnce: null,
    async query(sql) {
      if (sql.includes("sqlite_schema")) {
        return ROLES[role].map((name) => ({ name }));
      }
      if (sql.includes("EXISTS(SELECT 1 FROM archive_meta")) {
        return [
          {
            has_meta: Number(this.meta.size > 0),
            has_journal: Number(this.markers.size > 0),
            has_data_0: Number(this.markers.size > 0),
            has_data_1: Number(this.markers.size > 0),
          },
        ];
      }
      if (sql.includes("FROM import_shards ORDER BY")) return [...this.markers.values()];
      if (sql.includes("FROM import_shards WHERE")) return [...this.markers.values()].slice(-1);
      if (sql.includes("FROM archive_meta")) {
        return [...this.meta].map(([key, value]) => ({ key, value }));
      }
      throw new Error(`Unexpected fake query: ${sql}`);
    },
    async importFile(filePath) {
      const artifact = [...context.artifacts.values()].find(
        (candidate) => candidate.absolutePath === filePath,
      );
      this.imports.push(artifact.path);
      if (this.failOnce === artifact.path) {
        this.failOnce = null;
        throw new Error("fixture import failure");
      }
      if (artifact.phase === "load") {
        this.markers.set(artifact.path, {
          snapshot_id: SNAPSHOT,
          source_database_sha256: SOURCE_SHA,
          shard_path: artifact.path,
          payload_sha256: artifact.payloadSha256,
          table_name: artifact.table,
          row_count: artifact.rowCount,
          statement_count: artifact.statementCount,
        });
      }
      if (artifact.phase === "finalize") {
        activationOrder.push(role);
        const accepted = context.report.counts.accepted;
        this.meta.set("snapshot_id", SNAPSHOT);
        this.meta.set("source_database_sha256", SOURCE_SHA);
        this.meta.set("tokens_count", String(accepted.tokens));
        this.meta.set("owners_count", String(accepted.owners));
        if (role === "catalog") {
          this.meta.set("drops_count", String(accepted.drops));
          this.meta.set("artworks_count", String(accepted.artworks));
        }
      }
    },
  };
  return client;
}

const ROLES = {
  catalog: ["archive_meta", "drops", "drop_stats", "import_shards"],
  holdings: [
    "archive_meta",
    "tokens",
    "owner_stats",
    "import_shards",
    "idx_tokens_drop_collectors",
  ],
};

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
