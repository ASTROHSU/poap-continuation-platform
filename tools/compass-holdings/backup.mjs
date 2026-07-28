import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { basename, dirname, relative, resolve, sep } from "node:path";

import {
  describeFile,
  endWritable,
  invariant,
  writeWithBackpressure,
} from "../archive-import/lib/util.mjs";
import { readJson, writeJsonAtomic } from "../collections-backup/lib/files.mjs";

const FORMAT_VERSION = 1;
const DEFAULT_PART_BYTES = 95_000_000;

export async function packageCompassHoldingsSnapshot(options = {}) {
  const settings = normalizeOptions(options);
  const root = await realpath(settings.input);
  await mkdir(dirname(settings.archive), { recursive: true });
  settings.archive = resolve(await realpath(dirname(settings.archive)), basename(settings.archive));
  const captureManifest = await readJson(resolve(root, "manifest.json"));
  const referencedDropsManifest = await readJson(resolve(root, "referenced-drops-manifest.json"));
  const d1Report = await readJson(resolve(root, "d1/report.json"));
  validateIdentity(captureManifest, referencedDropsManifest, d1Report);
  await validateSourceArtifacts(root, captureManifest, referencedDropsManifest, d1Report);

  const packageManifestPath = resolve(root, "package-manifest.json");
  try {
    await lstat(packageManifestPath);
    throw new Error("package-manifest.json already exists; preserve or move the prior package.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const files = await inventoryFiles(root);
  const packageManifest = {
    version: FORMAT_VERSION,
    dataset: "poapin-compass-holdings-package",
    snapshotId: captureManifest.snapshotId,
    generatedAt: new Date().toISOString(),
    source: {
      captureManifestSha256: (await describeFile(resolve(root, "manifest.json"))).sha256,
      d1ReportSha256: (await describeFile(resolve(root, "d1/report.json"))).sha256,
      databaseSha256: captureManifest.database.sha256,
      referencedDropsManifestSha256: (
        await describeFile(resolve(root, "referenced-drops-manifest.json"))
      ).sha256,
      referencedDropsDatabaseSha256: referencedDropsManifest.database.sha256,
    },
    files,
    restore: {
      join: "Concatenate parts in ascending path order.",
      verify: "Verify the joined archive SHA-256, extract it, then verify every listed file.",
    },
  };
  await writeJsonAtomic(packageManifestPath, packageManifest);

  await assertAbsent(settings.archive);
  await runTar(root, settings.archive);
  const archive = {
    path: basename(settings.archive),
    ...(await describeFile(settings.archive)),
  };
  const partsDirectory = `${settings.archive}.parts`;
  await assertAbsent(partsDirectory);
  await mkdir(partsDirectory, { recursive: false, mode: 0o700 });
  const parts = await splitArchive(settings.archive, partsDirectory, settings.partBytes);
  invariant(
    parts.reduce((sum, part) => sum + part.byteLength, 0) === archive.byteLength,
    "Backup parts do not cover the complete archive.",
  );

  const report = {
    version: FORMAT_VERSION,
    dataset: "poapin-compass-holdings-backup",
    snapshotId: captureManifest.snapshotId,
    generatedAt: new Date().toISOString(),
    packageManifest: {
      path: relative(dirname(settings.archive), packageManifestPath).replaceAll("\\", "/"),
      ...(await describeFile(packageManifestPath)),
    },
    archive,
    partBytes: settings.partBytes,
    parts,
    r2: {
      suggestedBucket: "poapin-holdings-backups",
      keyPrefix: `snapshots/${captureManifest.snapshotId}/packages/sha256/${archive.sha256}`,
      public: false,
    },
  };
  const reportPath = `${settings.archive}.report.json`;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { report, reportPath };
}

async function validateSourceArtifacts(root, capture, referencedDrops, d1) {
  const database = await describeFile(resolve(root, "compass-holdings.sqlite"));
  invariant(
    database.sha256 === capture.database.sha256 &&
      database.byteLength === capture.database.byteLength,
    "Capture database differs from its manifest.",
  );
  const referencedDatabase = await describeFile(resolve(root, "compass-referenced-drops.sqlite"));
  invariant(
    referencedDatabase.sha256 === referencedDrops.database.sha256 &&
      referencedDatabase.byteLength === referencedDrops.database.byteLength,
    "Referenced Drop database differs from its manifest.",
  );
  for (const artifact of d1.artifacts) {
    const path = safeResolve(resolve(root, "d1"), artifact.path);
    const description = await describeFile(path);
    invariant(
      description.sha256 === artifact.sha256 && description.byteLength === artifact.byteLength,
      `D1 artifact differs from its report: ${artifact.path}.`,
    );
  }
}

function validateIdentity(capture, referencedDrops, d1) {
  invariant(
    capture?.version === 1 &&
      capture.dataset === "poapin-compass-holdings" &&
      capture.counts?.captured === capture.counts?.expected,
    "Compass Holdings capture is incomplete.",
  );
  invariant(
    referencedDrops?.version === 1 &&
      referencedDrops.dataset === "poapin-compass-referenced-drops" &&
      referencedDrops.snapshotId === capture.snapshotId &&
      referencedDrops.counts?.captured + referencedDrops.counts?.missing ===
        referencedDrops.counts?.requested,
    "Referenced Drop capture is incomplete.",
  );
  invariant(
    d1?.version === 1 &&
      d1.dataset === "poapin-compass-holdings-d1" &&
      d1.snapshotId === capture.snapshotId &&
      d1.source?.database?.sha256 === capture.database?.sha256 &&
      d1.source?.referencedDrops?.database?.sha256 === referencedDrops.database?.sha256 &&
      d1.tables?.tokens === capture.counts.captured,
    "D1 build does not belong to the complete capture.",
  );
}

async function inventoryFiles(root) {
  const paths = [];
  await walk(root, root, paths);
  const files = [];
  for (const path of paths.sort((left, right) => left.localeCompare(right, "en"))) {
    files.push({
      path: relative(root, path).replaceAll("\\", "/"),
      ...(await describeFile(path)),
    });
  }
  return files;
}

async function walk(root, directory, paths) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = safeResolve(root, relative(root, resolve(directory, entry.name)));
    if (entry.isSymbolicLink()) throw new Error(`Backup input contains a symlink: ${path}.`);
    if (entry.isDirectory()) await walk(root, path, paths);
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Backup input contains an unsupported entry: ${path}.`);
  }
}

async function runTar(root, archive) {
  await mkdir(dirname(archive), { recursive: true });
  const child = spawn(
    "tar",
    ["--no-xattrs", "-czf", archive, "-C", dirname(root), basename(root)],
    {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    },
  );
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 64 * 1024) stderr += chunk;
  });
  const [code] = await once(child, "close");
  invariant(code === 0, `tar failed: ${stderr.trim() || `exit ${code}`}.`);
}

async function splitArchive(archive, output, partBytes) {
  const parts = [];
  let sequence = 0;
  let current = null;
  const openPart = () => {
    const name = `${basename(archive)}.part-${String(sequence).padStart(4, "0")}`;
    sequence += 1;
    const path = resolve(output, name);
    current = {
      path,
      name,
      stream: createWriteStream(path, { flags: "wx", mode: 0o600 }),
      hash: createHash("sha256"),
      byteLength: 0,
    };
  };
  const closePart = async () => {
    if (!current) return;
    await endWritable(current.stream);
    parts.push({
      path: `${basename(output)}/${current.name}`,
      byteLength: current.byteLength,
      sha256: current.hash.digest("hex"),
    });
    current = null;
  };

  for await (const chunk of createReadStream(archive, { highWaterMark: 8 * 1024 * 1024 })) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (!current) openPart();
      const available = partBytes - current.byteLength;
      const slice = chunk.subarray(offset, offset + available);
      current.hash.update(slice);
      current.byteLength += slice.byteLength;
      await writeWithBackpressure(current.stream, slice);
      offset += slice.byteLength;
      if (current.byteLength === partBytes) await closePart();
    }
  }
  await closePart();
  invariant(parts.length > 0, "Backup archive is empty.");
  return parts;
}

function safeResolve(root, path) {
  const absolute = resolve(root, path);
  const local = relative(root, absolute);
  if (local === ".." || local.startsWith(`..${sep}`)) {
    throw new Error(`Backup path escapes its root: ${path}.`);
  }
  return absolute;
}

async function assertAbsent(path) {
  try {
    await stat(path);
    throw new Error(`Refusing to overwrite existing backup output: ${path}.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function normalizeOptions(options) {
  invariant(typeof options.input === "string" && options.input.length > 0, "input is required.");
  const input = resolve(options.input);
  const archive = resolve(options.output ?? resolve(dirname(input), `${basename(input)}.tar.gz`));
  const partBytes = options.partBytes ?? DEFAULT_PART_BYTES;
  invariant(
    Number.isSafeInteger(partBytes) && partBytes >= 5 * 1024 * 1024 && partBytes <= 95_000_000,
    "partBytes must be from 5 MiB to 95,000,000 bytes.",
  );
  return { input, archive, partBytes };
}

export const backupInternals = {
  normalizeOptions,
  validateIdentity,
};
