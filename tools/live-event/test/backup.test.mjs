import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { createLiveDatabaseBackup } from "../backup-lib.mjs";

test("LIVE_DB backup is private, checksummed, and never overwritten", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "live-backup-test-"));
  const now = new Date("2026-07-31T12:34:56.789Z");
  const exportSql = "CREATE TABLE live_events (event_id TEXT PRIMARY KEY);\n";
  const create = () =>
    createLiveDatabaseBackup({
      target: "remote",
      confirmRemote: "LIVE_DB",
      outputDirectory: root,
      config: "wrangler.pilot.jsonc",
      now,
      async runExport({ target, outputPath, config }) {
        assert.equal(target, "remote");
        assert.equal(config, "wrangler.pilot.jsonc");
        await writeFile(outputPath, exportSql);
      },
    });

  const result = await create();
  assert.equal(await readFile(result.sqlPath, "utf8"), exportSql);
  assert.equal(result.manifest.bytes, Buffer.byteLength(exportSql));
  assert.match(result.manifest.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.manifest.containsSensitiveData, true);
  assert.equal(result.manifest.wranglerConfig, "wrangler.pilot.jsonc");
  assert.equal((await stat(result.sqlPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.manifestPath)).mode & 0o777, 0o600);
  await assert.rejects(create(), /refusing to overwrite/i);
  await assert.rejects(
    createLiveDatabaseBackup({
      target: "remote",
      outputDirectory: root,
      now: new Date("2026-07-31T12:35:00.000Z"),
      runExport() {},
    }),
    /confirm-remote LIVE_DB/,
  );
  await rm(root, { recursive: true, force: true });
});
