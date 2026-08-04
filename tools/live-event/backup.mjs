import { spawnSync } from "node:child_process";
import process from "node:process";
import { createLiveDatabaseBackup } from "./backup-lib.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  const result = await createLiveDatabaseBackup({
    target: args.target,
    confirmRemote: args.confirmRemote,
    outputDirectory: args.out,
    config: args.config,
    runExport: exportD1,
  });
  console.log(`LIVE_DB backup created: ${result.sqlPath}`);
  console.log(`Integrity manifest created: ${result.manifestPath}`);
  console.log(`SHA-256: ${result.manifest.sha256}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function exportD1({ target, outputPath, config }) {
  const configArgs = config ? ["--config", config] : [];
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    [
      "--no-install",
      "wrangler",
      ...configArgs,
      "d1",
      "export",
      "LIVE_DB",
      `--${target}`,
      "--output",
      outputPath,
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`D1 export failed with exit code ${result.status}.`);
}

function parseArgs(values) {
  const parsed = { target: "local", out: "build/backups" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!["--target", "--confirm-remote", "--out", "--config"].includes(value)) {
      throw new Error(`Unknown argument: ${value}`);
    }
    const next = values[index + 1];
    if (!next) throw new Error(`${value} requires a value.`);
    parsed[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next;
    index += 1;
  }
  return parsed;
}
