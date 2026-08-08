#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";

const MAX_RETRIES = 8;
const DEFAULT_LIMIT = 12;

const options = parseArgs(process.argv.slice(2));
const secret = process.env.ARCHIVE_MEDIA_MIRROR_SECRET;
if (!secret || secret.length < 32) {
  throw new Error("ARCHIVE_MEDIA_MIRROR_SECRET must contain the deployed mirror secret.");
}

const endpoint = options.endpoint.replace(/\/+$/, "");
const state = await readState(options.state);
console.log(
  `[archive-media-mirror] resuming after drop ${state.afterDropId}; ` +
    `${state.copied} copied, ${state.skipped} already present`,
);

let processedThisRun = 0;
while (!state.complete && processedThisRun < options.maxBatches) {
  const result = await mirrorPage(endpoint, secret, state.afterDropId, options.limit);
  state.afterDropId = result.nextAfterDropId;
  state.complete = result.complete;
  state.copied += result.copied;
  state.skipped += result.skipped;
  state.bytesCopied += result.bytesCopied;
  state.batches += 1;
  state.updatedAt = new Date().toISOString();
  await writeState(options.state, state);
  processedThisRun += 1;
  console.log(
    `[archive-media-mirror] batch ${state.batches}: ${result.scanned} rows, ` +
      `${result.copied} copied, ${result.skipped} present, ` +
      `${formatBytes(state.bytesCopied)} transferred; cursor ${state.afterDropId}`,
  );
}

if (state.complete) {
  console.log(
    `[archive-media-mirror] complete: ${state.copied} copied, ${state.skipped} present, ` +
      `${formatBytes(state.bytesCopied)} transferred.`,
  );
} else {
  console.log(`[archive-media-mirror] paused after ${processedThisRun} batch(es); rerun with the same state file.`);
}

async function mirrorPage(endpoint, secret, afterDropId, limit) {
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/api/admin/archive-media/mirror`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ afterDropId, limit }),
      });
      if (!response.ok) {
        const payload = await response.text();
        throw new Error(`Mirror request returned ${response.status}: ${payload.slice(0, 400)}`);
      }
      return validateResult(await response.json());
    } catch (error) {
      lastError = error;
      if (attempt === MAX_RETRIES) break;
      const delay = Math.min(30_000, 1_000 * 2 ** (attempt - 1));
      console.warn(
        `[archive-media-mirror] retrying cursor ${afterDropId} in ${delay / 1000}s ` +
          `(attempt ${attempt}/${MAX_RETRIES}): ${errorMessage(error)}`,
      );
      await sleep(delay);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Mirror request failed.");
}

function validateResult(value) {
  if (!value || typeof value !== "object") throw new Error("Mirror response was not JSON.");
  const result = value;
  for (const key of ["nextAfterDropId", "scanned", "copied", "skipped", "bytesCopied"]) {
    if (!Number.isSafeInteger(result[key]) || result[key] < 0) {
      throw new Error(`Mirror response ${key} was invalid.`);
    }
  }
  if (typeof result.complete !== "boolean") throw new Error("Mirror response completion flag was invalid.");
  return result;
}

async function readState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    if (
      !parsed ||
      parsed.schemaVersion !== 1 ||
      !Number.isSafeInteger(parsed.afterDropId) ||
      !Number.isSafeInteger(parsed.copied) ||
      !Number.isSafeInteger(parsed.skipped) ||
      !Number.isSafeInteger(parsed.bytesCopied) ||
      !Number.isSafeInteger(parsed.batches) ||
      typeof parsed.complete !== "boolean"
    ) {
      throw new Error("Mirror state file was invalid.");
    }
    return parsed;
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return {
        schemaVersion: 1,
        afterDropId: 0,
        complete: false,
        copied: 0,
        skipped: 0,
        bytesCopied: 0,
        batches: 0,
        updatedAt: new Date().toISOString(),
      };
    }
    throw error;
  }
}

async function writeState(path, state) {
  const temporaryPath = `${path}.next`;
  await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
}

function parseArgs(argv) {
  let endpoint = process.env.ARCHIVE_MEDIA_MIRROR_ENDPOINT;
  let state = process.env.ARCHIVE_MEDIA_MIRROR_STATE;
  let limit = Number(process.env.ARCHIVE_MEDIA_MIRROR_LIMIT ?? DEFAULT_LIMIT);
  let maxBatches = Number.POSITIVE_INFINITY;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--endpoint") endpoint = argv[++index];
    else if (value === "--state") state = argv[++index];
    else if (value === "--limit") limit = Number(argv[++index]);
    else if (value === "--max-batches") maxBatches = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${value}`);
  }
  if (!endpoint || !/^https:\/\/[a-z0-9.-]+(?:\/.*)?$/i.test(endpoint)) {
    throw new Error("Pass the HTTPS Worker URL with --endpoint.");
  }
  if (!state || !state.startsWith("/")) throw new Error("Pass an absolute checkpoint path with --state.");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 18) {
    throw new Error("--limit must be an integer between 1 and 18.");
  }
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1) {
    throw new Error("--max-batches must be a positive integer.");
  }
  return { endpoint, state, limit, maxBatches };
}

function formatBytes(bytes) {
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : "unknown error";
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
