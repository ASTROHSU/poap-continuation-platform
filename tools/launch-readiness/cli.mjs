import process from "node:process";
import { inspectLaunchReadiness } from "./lib.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  const result = await inspectLaunchReadiness({
    configPath: args.config ?? "wrangler.pilot.jsonc",
    eventPath: args.event ?? "events/pilot-template.json",
    secretsPath: args.secrets ?? "build/secrets/worker-secrets.production.json",
  });
  for (const item of result.checks) console.log(`${item.ok ? "✓" : "✗"} ${item.label}`);
  if (!result.ready) {
    console.error("\nPilot is not ready: resolve every ✗ item, then run this command again.");
    process.exitCode = 1;
  } else {
    console.log("\nPilot preflight passed. It is safe to prepare the event bundle and deploy.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const flag = values[index];
    if (!["--config", "--event", "--secrets"].includes(flag))
      throw new Error(`Unknown argument: ${flag}`);
    const value = values[index + 1];
    if (!value) throw new Error(`${flag} requires a value.`);
    parsed[flag.slice(2)] = value;
    index += 1;
  }
  return parsed;
}
