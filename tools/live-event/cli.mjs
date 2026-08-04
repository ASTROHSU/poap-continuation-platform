import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { prepareEventBundle } from "./lib.mjs";

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.event) {
    throw new Error(
      "Usage: npm run event:prepare -- --event events/my-event.json [--out build/events/my-event] [--load local|remote --config path]",
    );
  }

  const result = await prepareEventBundle({
    inputPath: args.event,
    outputDir: args.out,
  });

  console.log(
    `Prepared ${result.publicLinkCount} public link(s), ${result.claimSlotCount} claim slot(s), and PNG/SVG QR files in ${result.outputDir}`,
  );
  if (result.imageCheck.status === "url-only") {
    console.warn(`Image check: ${result.imageCheck.message}`);
  } else {
    console.log(
      `Image check: ${result.imageCheck.format}, ${result.imageCheck.width}×${result.imageCheck.height}, ${result.imageCheck.bytes} bytes (${result.imageCheck.path})`,
    );
  }

  if (args.load) {
    if (args.load === "remote" && args.confirmRemote !== result.event.slug) {
      throw new Error(
        `Remote load requires --confirm-remote ${result.event.slug}. No remote data was changed.`,
      );
    }
    loadDatabase(result.outputDir, args.load, args.config);
  } else {
    console.log(
      `Load locally without manual SQL: npm run event:load -- --bundle ${result.outputDir} --slug ${result.event.slug} --target local`,
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function loadDatabase(outputDir, target, config) {
  const configArgs = config ? ["--config", config] : [];
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    [
      "--no-install",
      "wrangler",
      ...configArgs,
      "d1",
      "execute",
      "LIVE_DB",
      `--${target}`,
      "--file",
      resolve(outputDir, "load-event.sql"),
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`D1 load failed with exit code ${result.status}.`);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (["--event", "--out", "--load", "--confirm-remote", "--config"].includes(value)) {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      parsed[toKey(value)] = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (parsed.load && !["local", "remote"].includes(parsed.load)) {
    throw new Error("--load must be local or remote.");
  }
  return parsed;
}

function toKey(flag) {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}
