#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { JsonlCheckpoint } from "./lib/checkpoint.mjs";
import {
  DEFAULT_ARTWORK_COUNT,
  DEFAULT_CACHE_CONTROL,
  DEFAULT_CHECKPOINT_PATH,
  DEFAULT_MAX_COMPRESSION_RATIO,
  DEFAULT_MAX_ENTRY_BYTES,
  DEFAULT_REPORT_PATH,
  DEFAULT_SOURCE_BYTE_LENGTH,
  DEFAULT_SOURCE_SHA256,
  DEFAULT_SOURCE_URL,
  SNAPSHOT_ID_PATTERN,
} from "./lib/constants.mjs";
import { loadArtworkManifest } from "./lib/manifest.mjs";
import { uploadArtworkArchive } from "./lib/pipeline.mjs";
import { createR2Target, ImmutableR2Uploader, redactErrorMessage } from "./lib/r2.mjs";
import { openArchiveSource } from "./lib/source.mjs";
import { createWorkerBridgeTarget } from "./lib/worker-bridge.mjs";

const HELP = `POAPin Archive — immutable R2 artwork uploader

Streams a local or HTTPS ZIP directly into a snapshot-scoped R2 namespace.
The complete archive is never written or extracted by this tool.

Usage:
  npm run media:upload -- --snapshot-id 2026-07-02-v1 [options]

Required:
  --snapshot-id <id>       Lowercase snapshot slug used in object keys.
  --manifest <path>        Importer-generated r2/artwork-manifest.ndjson.

Input and safety:
  --source <path|url>       ZIP source (default: official POAP Archive URL).
  --media-base-url <url>    Public HTTPS origin used by the reviewed manifest
                            (default: https://media.poap.in).
  --allow-unverified-source
                            Disable the pinned byte/hash/count checks. Development only.
  --limit <count>           Process only this many new artworks (partial smoke test).
  --max-entry-mib <count>   Per-artwork compressed/decoded limit (default: 32).

R2 target (not required with --dry-run):
  --bucket <name>           R2 bucket; defaults to R2_BUCKET.
  --account-id <id>         Cloudflare account ID; defaults to R2_ACCOUNT_ID.
  --endpoint <https-url>    Override R2 S3 endpoint; defaults to R2_ENDPOINT.
  --bridge-url <https-origin>
                            Use the temporary authenticated Worker bridge instead
                            of S3 credentials.

Credentials are read only from R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and the
optional R2_SESSION_TOKEN used by temporary credentials. They are intentionally
not accepted as flags or written to logs/reports.

The Worker bridge reads its 32-byte base64url secret only from
R2_UPLOAD_BRIDGE_SECRET. The root secret is never sent in a request.

Run control:
  --concurrency <1-16>      Concurrent decompression/upload tasks (default: 4).
  --attempts <1-10>         Attempts per R2 object (default: 4).
  --max-failures <count>    Stop after this many object failures (default: 25).
  --checkpoint <path>       Resume journal (default: ${DEFAULT_CHECKPOINT_PATH}).
  --report <path>           JSON result report (default: ${DEFAULT_REPORT_PATH}).
  --dry-run                 Parse, decompress, and verify without R2 credentials/writes.
  --help                    Show this help.

Objects are created without overwrite at:
  snapshots/<snapshot-id>/artwork/<drop_id>.webp
`;

export function parseCliOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      "snapshot-id": { type: "string" },
      manifest: { type: "string" },
      source: { type: "string", default: DEFAULT_SOURCE_URL },
      "media-base-url": { type: "string", default: "https://media.poap.in" },
      "allow-unverified-source": { type: "boolean", default: false },
      limit: { type: "string" },
      "max-entry-mib": { type: "string", default: String(DEFAULT_MAX_ENTRY_BYTES / 1024 / 1024) },
      bucket: { type: "string" },
      "account-id": { type: "string" },
      endpoint: { type: "string" },
      "bridge-url": { type: "string" },
      concurrency: { type: "string", default: "4" },
      attempts: { type: "string", default: "4" },
      "max-failures": { type: "string", default: "25" },
      checkpoint: { type: "string", default: DEFAULT_CHECKPOINT_PATH },
      report: { type: "string", default: DEFAULT_REPORT_PATH },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) return { help: true };
  const snapshotId = values["snapshot-id"];
  if (!snapshotId || !SNAPSHOT_ID_PATTERN.test(snapshotId)) {
    throw optionError(
      "--snapshot-id is required and must be a 1-64 character lowercase slug (letters, numbers, dots, underscores, or hyphens).",
    );
  }
  if (!values.manifest) {
    throw optionError(
      "--manifest is required; use the importer-generated r2/artwork-manifest.ndjson.",
    );
  }
  const concurrency = boundedInteger(values.concurrency, "--concurrency", 1, 16);
  const attempts = boundedInteger(values.attempts, "--attempts", 1, 10);
  const maxFailures = boundedInteger(values["max-failures"], "--max-failures", 1, 10_000);
  const maximumEntryMiB = boundedInteger(values["max-entry-mib"], "--max-entry-mib", 1, 512);
  const limit =
    values.limit === undefined ? null : boundedInteger(values.limit, "--limit", 1, 1_000_000);
  const verifyKnownSource = !values["allow-unverified-source"];
  const mediaBaseUrl = parseMediaBaseUrl(values["media-base-url"]);
  if (values["bridge-url"] && (values.endpoint || values["account-id"])) {
    throw optionError("--bridge-url cannot be combined with --endpoint or --account-id.");
  }

  return {
    help: false,
    snapshotId,
    manifestPath: values.manifest,
    sourceValue: values.source,
    mediaBaseUrl,
    accountId: values["account-id"],
    endpointValue: values.endpoint,
    bridgeUrlValue: values["bridge-url"],
    bucketValue: values.bucket,
    concurrency,
    attempts,
    maxFailures,
    maximumEntryBytes: maximumEntryMiB * 1024 * 1024,
    maximumCompressionRatio: DEFAULT_MAX_COMPRESSION_RATIO,
    progressEvery: 250,
    limit,
    checkpointPath: values.checkpoint,
    reportPath: values.report,
    dryRun: values["dry-run"],
    cacheControl: DEFAULT_CACHE_CONTROL,
    expectedSourceBytes: verifyKnownSource ? DEFAULT_SOURCE_BYTE_LENGTH : null,
    expectedSourceSha256: verifyKnownSource ? DEFAULT_SOURCE_SHA256 : null,
    expectedArtworkCount: verifyKnownSource ? DEFAULT_ARTWORK_COUNT : null,
  };
}

function parseMediaBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw optionError("--media-base-url must be a valid HTTPS origin.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw optionError("--media-base-url must be a valid HTTPS origin without a path.");
  }
  return url.origin;
}

export async function main(argv = process.argv.slice(2)) {
  let config;
  try {
    config = parseCliOptions(argv);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error("Run with --help for usage.");
    return 2;
  }
  if (config.help) {
    console.log(HELP);
    return 0;
  }

  const controller = new AbortController();
  let interrupted = false;
  const stop = () => {
    if (interrupted) return;
    interrupted = true;
    console.error("Interrupt received; finishing active uploads and checkpoint writes…");
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let checkpoint = null;
  let secrets = [];
  let source = null;
  let r2Client = null;
  try {
    const manifest = await loadArtworkManifest(config.manifestPath, {
      snapshotId: config.snapshotId,
      cacheControl: config.cacheControl,
      mediaBaseUrl: config.mediaBaseUrl,
    });
    let uploader = null;
    let bucket = null;
    let endpoint = null;
    let transport = null;
    let protocolVersion = null;

    if (!config.dryRun) {
      if (config.bridgeUrlValue) {
        const target = createWorkerBridgeTarget({
          bridgeUrl: config.bridgeUrlValue,
          bucket: config.bucketValue,
          snapshotId: config.snapshotId,
          cacheControl: config.cacheControl,
          maximumEntryBytes: config.maximumEntryBytes,
          attempts: config.attempts,
        });
        bucket = target.bucket;
        endpoint = target.endpoint;
        protocolVersion = target.protocolVersion;
        secrets = target.secrets;
        uploader = target.uploader;
        transport = "worker-bridge";
        await uploader.verifyTarget({ signal: controller.signal });
        console.error("Authenticated upload bridge preflight passed.");
      } else {
        const target = createR2Target({
          accountId: config.accountId,
          endpoint: config.endpointValue,
          bucket: config.bucketValue,
        });
        bucket = target.bucket;
        endpoint = target.endpoint;
        secrets = target.secrets;
        r2Client = target.client;
        uploader = new ImmutableR2Uploader({
          client: target.client,
          bucket,
          cacheControl: config.cacheControl,
          attempts: config.attempts,
          secrets,
        });
        transport = "s3";
      }
    }

    source = await openArchiveSource(config.sourceValue, { signal: controller.signal });

    if (!config.dryRun) {
      checkpoint = await new JsonlCheckpoint(config.checkpointPath).open({
        snapshotId: config.snapshotId,
        archiveSha256: config.expectedSourceSha256,
        manifestSha256: manifest.sha256,
        endpoint,
        bucket,
        cacheControl: config.cacheControl,
        objectPrefix: `snapshots/${config.snapshotId}/artwork/`,
      });
      if (checkpoint.warning) console.error(`Checkpoint warning: ${checkpoint.warning}`);
    }

    console.error(
      `${config.dryRun ? "Validating" : "Uploading"} ${source.label} for snapshot ${config.snapshotId}` +
        `${config.limit ? ` (limit ${config.limit})` : ""}…`,
    );
    const report = await uploadArtworkArchive({
      source,
      manifest,
      uploader,
      checkpoint,
      signal: controller.signal,
      options: {
        ...config,
        bucket,
        endpoint,
        transport,
        protocolVersion,
      },
      onProgress({ settled, counts }) {
        console.error(
          `Processed ${settled.toLocaleString("en-US")} artworks: ` +
            `${counts.uploaded.toLocaleString("en-US")} uploaded, ` +
            `${counts.reused.toLocaleString("en-US")} reused, ` +
            `${counts.checkpointSkipped.toLocaleString("en-US")} checkpoint-skipped, ` +
            `${counts.failed.toLocaleString("en-US")} failed.`,
        );
      },
    });
    await checkpoint?.close();
    checkpoint = null;
    await writeJsonReport(config.reportPath, report);

    const completed =
      report.counts.uploaded +
      report.counts.reused +
      report.counts.checkpointSkipped +
      report.counts.dryRunValidated;
    const outcome = report.complete
      ? "Complete"
      : report.ok
        ? "Partial run complete"
        : "Incomplete";
    console.error(
      `${outcome}: ${completed.toLocaleString("en-US")} artwork objects; ` +
        `${report.counts.failed.toLocaleString("en-US")} failed. Report: ${config.reportPath}`,
    );
    return interrupted ? 130 : report.ok ? 0 : 1;
  } catch (error) {
    source?.stream.destroy();
    const message = redactErrorMessage(error, secrets);
    console.error(`Upload did not start or could not finish: ${message}`);
    return interrupted ? 130 : 1;
  } finally {
    await checkpoint?.close().catch((error) => {
      console.error(`Could not close checkpoint: ${redactErrorMessage(error, secrets)}`);
    });
    r2Client?.destroy();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function writeJsonReport(filePath, report) {
  const target = resolve(filePath);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, target);
}

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw optionError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function optionError(message) {
  const error = new Error(message);
  error.code = "INVALID_OPTION";
  return error;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) process.exitCode = await main();
