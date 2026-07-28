#!/usr/bin/env node

import process from "node:process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import {
  DEFAULT_CONCURRENCY,
  DEFAULT_DELAY_MS,
  DEFAULT_ENDPOINT,
  DEFAULT_SHARDS,
} from "./config.mjs";
import { packageCompassHoldingsSnapshot } from "./backup.mjs";
import { buildCompassHoldingsD1 } from "./d1.mjs";
import { captureCompassHoldingsSnapshot } from "./snapshot.mjs";
import { captureReferencedDrops } from "./referenced-drops.mjs";
import { uploadCompassHoldingsBackup } from "./upload-backup.mjs";
import { verifyCompassHoldingsD1Locally } from "./local-verify.mjs";

const HELP = `Usage:
  node tools/compass-holdings/cli.mjs snapshot --output <directory> [options]
  node tools/compass-holdings/cli.mjs referenced-drops --input <snapshot-directory> [options]
  node tools/compass-holdings/cli.mjs build-d1 --input <snapshot-directory> [options]
  node tools/compass-holdings/cli.mjs verify-local --input <d1-directory> --output <sqlite>
  node tools/compass-holdings/cli.mjs package --input <snapshot-directory> [options]
  node tools/compass-holdings/cli.mjs upload-backup --report <backup-report> [options]

Snapshot options:
  --snapshot-id <id>       Defaults to compass-holdings-YYYY-MM-DD-v1.
  --endpoint <https-url>   Compass GraphQL endpoint.
  --concurrency <1..8>     Concurrent ID-range workers (default: ${DEFAULT_CONCURRENCY}).
  --shards <n>             Persistent ID ranges (default: ${DEFAULT_SHARDS}).
  --delay-ms <n>           Minimum delay per worker request (default: ${DEFAULT_DELAY_MS}).
  --resume                 Resume the exact initialized capture.
  --help                   Show this help.

Referenced Drop options:
  --input <directory>      Complete Compass Holdings snapshot.
  --endpoint <https-url>   Compass GraphQL endpoint.
  --concurrency <1..8>     Concurrent metadata batches (default: 4).
  --delay-ms <n>           Minimum delay between requests (default: ${DEFAULT_DELAY_MS}).
  --resume                 Resume or verify the exact companion capture.

D1 build options:
  --input <directory>      Complete Compass Holdings snapshot.
  --output <directory>     Defaults to <input>/d1.
  --max-shard-mib <n>      SQL shard ceiling (default: 8 MiB).
  --max-statement-kib <n>  SQL statement ceiling (default: 90 KiB, max: 96).
  --rows-per-statement <n> Multi-row INSERT batch size (default: 100).

Package options:
  --input <directory>      Complete capture with a verified d1/ build.
  --output <archive>       Defaults to <input>.tar.gz beside the snapshot.
  --part-mib <n>           Upload-safe part size (default: 90 MiB, max: 90).

Backup upload options:
  --report <file>          Package sidecar *.tar.gz.report.json.
  --bucket <name>          Private R2 bucket.
  --checkpoint <file>      Defaults beside the report.
  --verify-downloads       Download and hash every uploaded object.
`;

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === "--help" || command === "-h" || !command) {
    process.stdout.write(HELP);
    return command ? 0 : 1;
  }
  if (command === "build-d1") return buildD1(rest);
  if (command === "referenced-drops") return referencedDrops(rest);
  if (command === "verify-local") return verifyLocal(rest);
  if (command === "package") return packageSnapshot(rest);
  if (command === "upload-backup") return uploadBackup(rest);
  if (command !== "snapshot") throw new Error(`Unknown command: ${command}`);
  const { values } = parseArgs({
    args: rest,
    strict: true,
    allowPositionals: false,
    options: {
      output: { type: "string" },
      "snapshot-id": { type: "string" },
      endpoint: { type: "string", default: DEFAULT_ENDPOINT },
      concurrency: { type: "string" },
      shards: { type: "string" },
      "delay-ms": { type: "string" },
      resume: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.output) throw new Error("--output is required.");
  let requests = 0;
  const manifest = await captureCompassHoldingsSnapshot({
    output: values.output,
    snapshotId: values["snapshot-id"],
    endpoint: values.endpoint,
    concurrency: parseOptionalInteger(values.concurrency, DEFAULT_CONCURRENCY, "--concurrency"),
    shards: parseOptionalInteger(values.shards, DEFAULT_SHARDS, "--shards"),
    delayMs: parseOptionalInteger(values["delay-ms"], DEFAULT_DELAY_MS, "--delay-ms"),
    resume: values.resume,
    onRequest: () => {
      requests += 1;
    },
    onProgress: (progress) => {
      if (progress.phase === "initialized") {
        process.stdout.write(
          `[compass-holdings] frozen upper=${progress.upperPoapId} rows=${progress.expectedRows}\n`,
        );
        return;
      }
      if (progress.phase === "capture") {
        process.stdout.write(
          `[compass-holdings] shard=${progress.shardId} rows=${progress.rows}/${progress.expectedRows} pages=${progress.pages}\n`,
        );
      }
    },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, requests, manifest }, null, 2)}\n`);
  return 0;
}

async function referencedDrops(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      input: { type: "string" },
      endpoint: { type: "string", default: DEFAULT_ENDPOINT },
      concurrency: { type: "string", default: "4" },
      "delay-ms": { type: "string" },
      resume: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.input) throw new Error("--input is required.");
  let requests = 0;
  const manifest = await captureReferencedDrops({
    input: values.input,
    endpoint: values.endpoint,
    concurrency: parseRequiredInteger(values.concurrency, "--concurrency"),
    delayMs: parseOptionalInteger(values["delay-ms"], DEFAULT_DELAY_MS, "--delay-ms"),
    resume: values.resume,
    onRequest: () => {
      requests += 1;
    },
    onProgress: (progress) => {
      if (
        progress.batch % 25 === 0 ||
        progress.batch === progress.batches ||
        progress.missing > 0
      ) {
        process.stdout.write(
          `[compass-holdings] referenced-drops ${progress.batch}/${progress.batches} captured=${progress.captured} missing=${progress.missing}\n`,
        );
      }
    },
  });
  process.stdout.write(`${JSON.stringify({ ok: true, requests, manifest }, null, 2)}\n`);
  return 0;
}

async function verifyLocal(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  for (const name of ["input", "output"]) {
    if (!values[name]) throw new Error(`--${name} is required.`);
  }
  const result = await verifyCompassHoldingsD1Locally({
    input: values.input,
    output: values.output,
    onProgress: ({ index, total, artifact }) => {
      process.stdout.write(`[compass-holdings] local-d1 ${index + 1}/${total} ${artifact.path}\n`);
    },
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        reportPath: result.reportPath,
        database: result.report.database,
        counts: result.report.counts,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function uploadBackup(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      report: { type: "string" },
      bucket: { type: "string" },
      checkpoint: { type: "string" },
      "verify-downloads": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  for (const name of ["report", "bucket"]) {
    if (!values[name]) throw new Error(`--${name} is required.`);
  }
  const result = await uploadCompassHoldingsBackup({
    report: values.report,
    bucket: values.bucket,
    checkpoint: values.checkpoint,
    verifyDownloads: values["verify-downloads"],
    onProgress: ({ phase, index, total, object }) => {
      process.stdout.write(`[compass-holdings] r2 ${phase} ${index + 1}/${total} ${object.key}\n`);
    },
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        reportPath: result.uploadReportPath,
        bucket: result.uploadReport.bucket,
        objects: result.uploadReport.counts.objects,
        verified: result.uploadReport.verified,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function packageSnapshot(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      "part-mib": { type: "string", default: "90" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.input) throw new Error("--input is required.");
  const { report, reportPath } = await packageCompassHoldingsSnapshot({
    input: values.input,
    output: values.output,
    partBytes: parseRequiredInteger(values["part-mib"], "--part-mib") * 1024 * 1024,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        reportPath,
        archive: report.archive,
        parts: report.parts.length,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function buildD1(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      input: { type: "string" },
      output: { type: "string" },
      "max-shard-mib": { type: "string", default: "8" },
      "max-statement-kib": { type: "string", default: "90" },
      "rows-per-statement": { type: "string", default: "100" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!values.input) throw new Error("--input is required.");
  const { report, reportPath } = await buildCompassHoldingsD1({
    input: values.input,
    output: values.output,
    maxShardBytes: parseRequiredInteger(values["max-shard-mib"], "--max-shard-mib") * 1024 * 1024,
    maxStatementBytes:
      parseRequiredInteger(values["max-statement-kib"], "--max-statement-kib") * 1024,
    rowsPerStatement: parseRequiredInteger(values["rows-per-statement"], "--rows-per-statement"),
    onProgress: (progress) => {
      process.stdout.write(
        `[compass-holdings] d1 tokens=${progress.tokens}/${progress.expected}\n`,
      );
    },
  });
  process.stdout.write(
    `${JSON.stringify({ ok: true, reportPath, tables: report.tables }, null, 2)}\n`,
  );
  return 0;
}

function parseOptionalInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  return parseRequiredInteger(value, label);
}

function parseRequiredInteger(value, label) {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be an integer.`);
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${label} is too large.`);
  return number;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (error) {
    process.stderr.write(`[compass-holdings] ${error?.stack ?? error}\n`);
    process.exitCode = 1;
  }
}
