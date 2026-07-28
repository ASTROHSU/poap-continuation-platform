#!/usr/bin/env node

import process from "node:process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  archiveHoldingsArtwork,
  buildHoldingsArtworkPlan,
  captureArchiveArtworkIndex,
  finalizeHoldingsArtwork,
  loadHoldingsArtworkD1,
  reviewUnavailableHoldingsArtwork,
} from "./artwork.mjs";

const HELP = `Usage:
  node tools/compass-holdings/artwork-cli.mjs catalog-index [options]
  node tools/compass-holdings/artwork-cli.mjs plan [options]
  node tools/compass-holdings/artwork-cli.mjs capture [options]
  node tools/compass-holdings/artwork-cli.mjs review-unavailable [options]
  node tools/compass-holdings/artwork-cli.mjs finalize [options]
  node tools/compass-holdings/artwork-cli.mjs load-d1 [options]

Catalog index:
  --output <json>             Immutable list of active Archive artwork IDs.
  --snapshot-id <id>          Active fixed Archive snapshot.
  --database <binding>        Wrangler D1 binding (default: CATALOG_DB).
  --config <path>             Wrangler config (default: wrangler.jsonc).

Plan:
  --input <directory>         Complete Compass Holdings snapshot.
  --archive-index <json>      Output from catalog-index.
  --collections <directory>   Verified Collections snapshot.
  --output <directory>        Defaults to <input>/artwork-archive.

Capture:
  --input <directory>         Artwork plan directory.
  --bridge-url <origin>       Temporary HMAC upload Worker.
  --bucket <name>             Public R2 bucket.
  --archive-snapshot-id <id>  Fixed Archive ID bound to the bridge.
  --concurrency <1..16>       Default: 4.
  --maximum-mib <n>           Per-image ceiling (default: 95).
  --limit <n>                 Optional smoke-test limit; never marks complete.

The HMAC secret is read only from COLLECTIONS_R2_BRIDGE_SECRET.

Review unavailable:
  --input <directory>         Artwork plan/capture directory after retries.
  --output <json>             Optional terminal-evidence destination.

Finalize:
  --input <directory>         Complete artwork plan/capture directory.
  --release-id <id>           Snapshot-scoped immutable release ID.
  --output <json>             Optional coverage release destination.

Load D1:
  --input <directory>         Finalized d1-artwork directory.
  --database <binding>        Wrangler D1 binding (default: HOLDINGS_DB).
  --config <path>             Wrangler config (default: wrangler.jsonc).
`;

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return command ? 0 : 1;
  }
  if (command === "catalog-index") return catalogIndex(rest);
  if (command === "plan") return plan(rest);
  if (command === "capture") return capture(rest);
  if (command === "review-unavailable") return reviewUnavailable(rest);
  if (command === "finalize") return finalize(rest);
  if (command === "load-d1") return loadD1(rest);
  throw new Error(`Unknown artwork command: ${command}`);
}

async function reviewUnavailable(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return showHelp();
  requireOptions(values, ["input"]);
  const result = await reviewUnavailableHoldingsArtwork({
    input: values.input,
    output: values.output,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        path: result.path,
        terminalUnavailable: result.report.count,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function finalize(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      input: { type: "string" },
      "release-id": { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return showHelp();
  requireOptions(values, ["input", "release-id"]);
  const result = await finalizeHoldingsArtwork({
    input: values.input,
    releaseId: values["release-id"],
    output: values.output,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        releasePath: result.releasePath,
        coverage: result.release.coverage,
        d1Root: result.d1Root,
        shards: result.d1Report.shards.length,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function loadD1(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      input: { type: "string" },
      database: { type: "string", default: "HOLDINGS_DB" },
      config: { type: "string", default: "wrangler.jsonc" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return showHelp();
  requireOptions(values, ["input"]);
  const result = await loadHoldingsArtworkD1({
    input: values.input,
    database: values.database,
    config: values.config,
    onProgress: (progress) => {
      if (progress.phase === "load") {
        process.stdout.write(
          `[holdings-artwork] d1 ${progress.index + 1}/${progress.total} ${progress.shard.path}\n`,
        );
      } else {
        process.stdout.write(
          `[holdings-artwork] d1 verify ${progress.rows}/${progress.expected}\n`,
        );
      }
    },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, result }, null, 2)}\n`);
  return 0;
}

async function catalogIndex(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      output: { type: "string" },
      "snapshot-id": { type: "string" },
      database: { type: "string", default: "CATALOG_DB" },
      config: { type: "string", default: "wrangler.jsonc" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return showHelp();
  requireOptions(values, ["output", "snapshot-id"]);
  const result = await captureArchiveArtworkIndex({
    output: values.output,
    snapshotId: values["snapshot-id"],
    database: values.database,
    config: values.config,
    onProgress: ({ rows }) => process.stdout.write(`[holdings-artwork] archive=${rows}\n`),
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, path: result.path, count: result.index.count }, null, 2)}\n`,
  );
  return 0;
}

async function plan(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      input: { type: "string" },
      "archive-index": { type: "string" },
      collections: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return showHelp();
  requireOptions(values, ["input", "archive-index", "collections"]);
  const result = await buildHoldingsArtworkPlan({
    input: values.input,
    archiveArtworkIndex: values["archive-index"],
    collectionsInput: values.collections,
    output: values.output,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        artworkRoot: result.artworkRoot,
        counts: result.report.counts,
        plan: result.report.plan,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function capture(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      input: { type: "string" },
      "bridge-url": { type: "string" },
      bucket: { type: "string" },
      "archive-snapshot-id": { type: "string" },
      concurrency: { type: "string", default: "4" },
      "maximum-mib": { type: "string", default: "95" },
      limit: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return showHelp();
  requireOptions(values, ["input", "bridge-url", "bucket", "archive-snapshot-id"]);
  let previous = 0;
  const report = await archiveHoldingsArtwork({
    input: values.input,
    bridgeUrl: values["bridge-url"],
    bucket: values.bucket,
    archiveSnapshotId: values["archive-snapshot-id"],
    concurrency: integer(values.concurrency, "--concurrency", 1, 16),
    maximumBytes: integer(values["maximum-mib"], "--maximum-mib", 1, 95) * 1024 * 1024,
    limit: values.limit ? integer(values.limit, "--limit", 1, Number.MAX_SAFE_INTEGER) : null,
    onProgress: ({ completed, scheduled, total, dropId, status }) => {
      if (completed === scheduled || completed - previous >= 25 || status === "failed") {
        previous = completed;
        process.stdout.write(
          `[holdings-artwork] ${completed}/${scheduled} scheduled; ${total} total; drop=${dropId} ${status}\n`,
        );
      }
    },
  });
  process.stdout.write(`${JSON.stringify({ ok: report.complete, report }, null, 2)}\n`);
  return report.complete || values.limit ? 0 : 1;
}

function requireOptions(values, names) {
  for (const name of names) if (!values[name]) throw new Error(`--${name} is required.`);
}

function integer(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return number;
}

function showHelp() {
  process.stdout.write(HELP);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`[holdings-artwork] ${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}
