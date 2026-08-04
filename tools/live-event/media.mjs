import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.bundle) throw new Error("--bundle is required.");
  if (!args.bucket) throw new Error("--bucket is required.");
  if (!["local", "remote"].includes(args.target)) {
    throw new Error("--target must be local or remote.");
  }

  const bundle = resolve(args.bundle);
  const summary = JSON.parse(await readFile(resolve(bundle, "event-summary.json"), "utf8"));
  const slug = summary.slug;
  if (!isSlug(slug)) throw new Error("The bundle contains an invalid event slug.");
  if (args.target === "remote" && args.confirmRemote !== slug) {
    throw new Error(
      `Remote media upload requires --confirm-remote ${slug}. No remote object was changed.`,
    );
  }

  const files = [
    {
      name: "metadata.json",
      contentType: "application/json; charset=utf-8",
      cacheControl: "public, max-age=300",
    },
  ];
  if (summary.files?.artwork) {
    files.push({
      name: summary.files.artwork,
      contentType: imageContentType(summary.imageCheck?.format),
      cacheControl: "public, max-age=31536000, immutable",
    });
  }

  for (const file of files) {
    uploadObject({
      bucket: args.bucket,
      key: `live/events/${slug}/${file.name}`,
      file: resolve(bundle, file.name),
      contentType: file.contentType,
      cacheControl: file.cacheControl,
      target: args.target,
    });
  }

  console.log(
    JSON.stringify(
      {
        slug,
        target: args.target,
        bucket: args.bucket,
        uploaded: files.map((file) => `live/events/${slug}/${file.name}`),
        metadataPath: `/media/live/events/${slug}/metadata.json`,
        artworkPath: summary.files?.artwork
          ? `/media/live/events/${slug}/${summary.files.artwork}`
          : null,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function uploadObject({ bucket, key, file, contentType, cacheControl, target }) {
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    [
      "--no-install",
      "wrangler",
      "r2",
      "object",
      "put",
      `${bucket}/${key}`,
      `--${target}`,
      "--file",
      file,
      "--content-type",
      contentType,
      "--cache-control",
      cacheControl,
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Media upload failed for ${key} with exit code ${result.status}.`);
  }
}

function parseArgs(values) {
  const parsed = { target: "local" };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (["--bundle", "--bucket", "--target", "--confirm-remote"].includes(value)) {
      const next = values[index + 1];
      if (!next) throw new Error(`${value} requires a value.`);
      parsed[value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = next;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  return parsed;
}

function imageContentType(format) {
  const types = {
    png: "image/png",
    jpeg: "image/jpeg",
    webp: "image/webp",
    gif: "image/gif",
    svg: "image/svg+xml",
  };
  const contentType = types[format];
  if (!contentType) throw new Error(`Unsupported artwork format in bundle: ${format}`);
  return contentType;
}

function isSlug(value) {
  return typeof value === "string" && /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(value);
}
