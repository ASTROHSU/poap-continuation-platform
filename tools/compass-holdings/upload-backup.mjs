import { spawn } from "node:child_process";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describeFile, invariant } from "../archive-import/lib/util.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_WRANGLER = resolve(PROJECT_ROOT, "node_modules/wrangler/bin/wrangler.js");
const SHA256 = /^[0-9a-f]{64}$/;
const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

export async function uploadCompassHoldingsBackup(options = {}) {
  const settings = normalizeOptions(options);
  const backupReport = JSON.parse(await readFile(settings.report, "utf8"));
  const objects = await buildUploadPlan(settings.report, backupReport);
  const completed = await readCheckpoint(settings.checkpoint);
  for (const [index, object] of objects.entries()) {
    const prior = completed.get(object.key);
    if (prior) {
      invariant(
        prior.sha256 === object.sha256 && prior.byteLength === object.byteLength,
        `Upload checkpoint differs for ${object.key}.`,
      );
      settings.onProgress({ phase: "upload-skip", index, total: objects.length, object });
      continue;
    }
    settings.onProgress({ phase: "upload", index, total: objects.length, object });
    await putObject(settings, object);
    const event = {
      version: 1,
      uploadedAt: new Date().toISOString(),
      bucket: settings.bucket,
      key: object.key,
      sha256: object.sha256,
      byteLength: object.byteLength,
    };
    await appendFile(settings.checkpoint, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    completed.set(object.key, event);
  }

  let verifiedObjects = 0;
  if (settings.verifyDownloads) {
    const temporary = await mkdtemp(resolve(tmpdir(), "poapin-holdings-r2-verify-"));
    try {
      for (const [index, object] of objects.entries()) {
        settings.onProgress({ phase: "verify", index, total: objects.length, object });
        const output = resolve(temporary, `object-${String(index).padStart(5, "0")}`);
        await getObject(settings, object.key, output);
        const downloaded = await describeFile(output);
        invariant(
          downloaded.sha256 === object.sha256 && downloaded.byteLength === object.byteLength,
          `R2 round-trip verification failed for ${object.key}.`,
        );
        await rm(output, { force: true });
        verifiedObjects += 1;
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  const uploadReport = {
    version: 1,
    dataset: "poapin-compass-holdings-r2-upload",
    snapshotId: backupReport.snapshotId,
    completedAt: new Date().toISOString(),
    bucket: settings.bucket,
    prefix: backupReport.r2.keyPrefix,
    complete: true,
    verified: settings.verifyDownloads,
    counts: {
      objects: objects.length,
      verified: verifiedObjects,
    },
    bytes: objects.reduce((sum, object) => sum + object.byteLength, 0),
    sourceReport: {
      path: basename(settings.report),
      ...(await describeFile(settings.report)),
    },
    objects: objects.map(({ absolutePath: _absolutePath, ...object }) => object),
  };
  const uploadReportPath = `${settings.report}.upload.json`;
  await writeFile(uploadReportPath, `${JSON.stringify(uploadReport, null, 2)}\n`, {
    flag: "w",
    mode: 0o600,
  });
  const uploadReportArtifact = await describeFile(uploadReportPath);
  const reportObject = {
    key: `${backupReport.r2.keyPrefix}/upload-reports/sha256/${uploadReportArtifact.sha256}.json`,
    absolutePath: uploadReportPath,
    contentType: "application/json",
    ...uploadReportArtifact,
  };
  await putObject(settings, reportObject);
  const temporary = await mkdtemp(resolve(tmpdir(), "poapin-holdings-r2-report-"));
  try {
    const downloaded = resolve(temporary, "upload-report.json");
    await getObject(settings, reportObject.key, downloaded);
    const checked = await describeFile(downloaded);
    invariant(
      checked.sha256 === reportObject.sha256 && checked.byteLength === reportObject.byteLength,
      "R2 upload report round-trip verification failed.",
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { uploadReport, uploadReportPath, reportObject };
}

export async function buildUploadPlan(reportPath, report) {
  validateBackupReport(report);
  const base = dirname(reportPath);
  const packageManifestPath = safeResolve(base, report.packageManifest.path);
  const packageManifest = JSON.parse(await readFile(packageManifestPath, "utf8"));
  const captureRoot = dirname(packageManifestPath);
  const d1ReportPath = resolve(captureRoot, "d1/report.json");
  const d1Report = JSON.parse(await readFile(d1ReportPath, "utf8"));
  invariant(
    d1Report?.dataset === "poapin-compass-holdings-d1" &&
      d1Report.snapshotId === report.snapshotId &&
      packageManifest?.dataset === "poapin-compass-holdings-package" &&
      packageManifest.snapshotId === report.snapshotId &&
      d1Report.source?.database?.sha256 === packageManifest.source?.databaseSha256,
    "D1 report does not belong to the backup package.",
  );

  const prefix = report.r2.keyPrefix;
  const objects = [];
  for (const part of report.parts) {
    const absolutePath = safeResolve(base, part.path);
    objects.push({
      key: `${prefix}/package/parts/${basename(part.path)}`,
      absolutePath,
      contentType: "application/octet-stream",
      sha256: part.sha256,
      byteLength: part.byteLength,
    });
  }
  for (const [name, absolutePath] of [
    ["package/package-manifest.json", packageManifestPath],
    ["package/backup-report.json", reportPath],
    ["capture/manifest.json", resolve(captureRoot, "manifest.json")],
    ["capture/source.json", resolve(captureRoot, "source.json")],
    [
      "capture/referenced-drops-manifest.json",
      resolve(captureRoot, "referenced-drops-manifest.json"),
    ],
    ["d1/report.json", d1ReportPath],
  ]) {
    objects.push({
      key: `${prefix}/${name}`,
      absolutePath,
      contentType: "application/json",
      ...(await describeFile(absolutePath)),
    });
  }
  for (const artifact of d1Report.artifacts ?? []) {
    const absolutePath = safeResolve(resolve(captureRoot, "d1"), artifact.path);
    objects.push({
      key: `${prefix}/d1/${artifact.path}`,
      absolutePath,
      contentType: "application/sql",
      sha256: artifact.sha256,
      byteLength: artifact.byteLength,
    });
  }
  const keys = new Set();
  for (const object of objects) {
    invariant(!keys.has(object.key), `R2 upload plan repeats ${object.key}.`);
    keys.add(object.key);
    const local = await describeFile(object.absolutePath);
    invariant(
      local.sha256 === object.sha256 && local.byteLength === object.byteLength,
      `R2 upload source differs from its manifest: ${object.key}.`,
    );
  }
  return objects;
}

function validateBackupReport(report) {
  invariant(
    report?.version === 1 &&
      report.dataset === "poapin-compass-holdings-backup" &&
      /^[a-z0-9][a-z0-9._-]{0,63}$/.test(report.snapshotId ?? "") &&
      SHA256.test(report.archive?.sha256 ?? "") &&
      Array.isArray(report.parts) &&
      report.parts.length > 0 &&
      report.r2?.public === false &&
      report.r2.keyPrefix ===
        `snapshots/${report.snapshotId}/packages/sha256/${report.archive.sha256}`,
    "Compass Holdings backup report is invalid.",
  );
  let bytes = 0;
  for (const part of report.parts) {
    invariant(
      typeof part.path === "string" &&
        Number.isSafeInteger(part.byteLength) &&
        part.byteLength > 0 &&
        SHA256.test(part.sha256 ?? ""),
      "Compass Holdings backup part descriptor is invalid.",
    );
    bytes += part.byteLength;
  }
  invariant(bytes === report.archive.byteLength, "Backup parts do not cover the archive.");
}

async function readCheckpoint(path) {
  let contents = "";
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
  const events = new Map();
  for (const [index, line] of contents.split("\n").entries()) {
    if (!line) continue;
    const event = JSON.parse(line);
    invariant(
      event?.version === 1 &&
        typeof event.key === "string" &&
        SHA256.test(event.sha256 ?? "") &&
        Number.isSafeInteger(event.byteLength) &&
        event.byteLength > 0,
      `Invalid upload checkpoint line ${index + 1}.`,
    );
    const prior = events.get(event.key);
    invariant(
      !prior || (prior.sha256 === event.sha256 && prior.byteLength === event.byteLength),
      `Conflicting upload checkpoint for ${event.key}.`,
    );
    events.set(event.key, event);
  }
  return events;
}

async function putObject(settings, object) {
  await runWrangler(settings, [
    "r2",
    "object",
    "put",
    `${settings.bucket}/${object.key}`,
    "--file",
    object.absolutePath,
    "--content-type",
    object.contentType,
    "--remote",
    "--force",
  ]);
}

async function getObject(settings, key, output) {
  await runWrangler(settings, [
    "r2",
    "object",
    "get",
    `${settings.bucket}/${key}`,
    "--file",
    output,
    "--remote",
  ]);
}

async function runWrangler(settings, args) {
  const child = spawn(process.execPath, [settings.wranglerBin, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: resolve(PROJECT_ROOT, ".wrangler/release/logs"),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (stdout.length < 64 * 1024) stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });
  const [code] = await once(child, "close");
  invariant(
    code === 0,
    `Wrangler R2 operation failed: ${stderr.trim() || stdout.trim() || `exit ${code}`}.`,
  );
}

function safeResolve(root, path) {
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error(`Backup path escapes its root: ${path}.`);
  }
  return absolute;
}

function normalizeOptions(options) {
  invariant(typeof options.report === "string" && options.report.length > 0, "report is required.");
  invariant(BUCKET.test(options.bucket ?? ""), "bucket is invalid.");
  return {
    report: resolve(options.report),
    bucket: options.bucket,
    checkpoint: resolve(options.checkpoint ?? `${options.report}.upload-checkpoint.jsonl`),
    verifyDownloads: options.verifyDownloads === true,
    wranglerBin: resolve(options.wranglerBin ?? DEFAULT_WRANGLER),
    onProgress: options.onProgress ?? (() => {}),
  };
}

export const uploadInternals = {
  normalizeOptions,
  readCheckpoint,
  validateBackupReport,
};
