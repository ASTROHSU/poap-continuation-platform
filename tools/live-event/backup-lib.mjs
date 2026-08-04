import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export async function createLiveDatabaseBackup({
  target,
  confirmRemote,
  outputDirectory = "build/backups",
  config,
  now = new Date(),
  runExport,
}) {
  if (!["local", "remote"].includes(target)) {
    throw new Error("--target must be local or remote.");
  }
  if (target === "remote" && confirmRemote !== "LIVE_DB") {
    throw new Error("Remote backup requires --confirm-remote LIVE_DB.");
  }
  if (typeof runExport !== "function") throw new Error("A D1 export runner is required.");

  const generatedAt = now.toISOString();
  const stamp = generatedAt.replaceAll(":", "-").replaceAll(".", "-");
  const directory = resolve(outputDirectory);
  const sqlPath = resolve(directory, `live-db-${target}-${stamp}.sql`);
  const partialPath = `${sqlPath}.partial`;
  const manifestPath = `${sqlPath}.manifest.json`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await assertMissing(sqlPath);
  await assertMissing(manifestPath);
  await assertMissing(partialPath);

  try {
    await runExport({ target, outputPath: partialPath, config });
    const sql = await readFile(partialPath);
    if (sql.byteLength === 0) throw new Error("D1 export created an empty file.");
    await chmod(partialPath, 0o600);
    await rename(partialPath, sqlPath);
    const manifest = {
      format: "association-live-d1-backup-v1",
      generatedAt,
      target,
      databaseBinding: "LIVE_DB",
      wranglerConfig: config ?? null,
      sqlFile: basename(sqlPath),
      bytes: sql.byteLength,
      sha256: createHash("sha256").update(sql).digest("hex"),
      containsSensitiveData: true,
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    return { sqlPath, manifestPath, manifest };
  } catch (error) {
    await unlink(partialPath).catch(() => undefined);
    throw error;
  }
}

async function assertMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite an existing backup artifact: ${path}`);
}
