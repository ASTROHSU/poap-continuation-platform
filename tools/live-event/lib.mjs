import { createHash, randomBytes } from "node:crypto";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import QRCode from "qrcode";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/;

export async function prepareEventBundle({
  inputPath,
  outputDir,
  now = new Date(),
  randomCode = () => randomBytes(24).toString("base64url"),
}) {
  const absoluteInputPath = resolve(inputPath);
  const raw = JSON.parse(await readFile(absoluteInputPath, "utf8"));
  const event = validateEvent(raw);
  const absoluteOutputDir = resolve(outputDir ?? `build/events/${event.slug}`);

  await assertOutputIsNew(absoluteOutputDir);
  const imageCheck = await inspectEventImage(event, dirname(absoluteInputPath));
  const artworkFile =
    imageCheck.status === "checked" ? `artwork.${imageExtension(imageCheck.format)}` : null;
  const publicCodes =
    event.claimMode === "shared"
      ? [randomCode()]
      : Array.from({ length: event.claimCount }, () => randomCode());
  assertCodesUnique(publicCodes);

  const publicLinks = publicCodes.map((code, index) => ({
    number: index + 1,
    code,
    accessCodeHash: sha256(code),
    url: claimUrl(event, code),
  }));
  const slots =
    event.claimMode === "shared"
      ? Array.from({ length: event.claimCount }, (_, index) => ({
          slot: index + 1,
          codeHash: sha256(`${publicCodes[0]}:slot:${index + 1}:${randomCode()}`),
          accessCodeHash: publicLinks[0].accessCodeHash,
        }))
      : publicLinks.map((link) => ({
          slot: link.number,
          codeHash: link.accessCodeHash,
          accessCodeHash: link.accessCodeHash,
        }));

  await mkdir(resolve(absoluteOutputDir, "qr"), { recursive: true, mode: 0o700 });
  const qrFiles = [];
  for (const link of publicLinks) {
    const basename = event.claimMode === "shared" ? "shared" : String(link.number).padStart(3, "0");
    const pngPath = resolve(absoluteOutputDir, "qr", `${basename}.png`);
    const svgPath = resolve(absoluteOutputDir, "qr", `${basename}.svg`);
    const options = {
      errorCorrectionLevel: "M",
      margin: 4,
      width: 768,
      color: { dark: "#101416ff", light: "#ffffffff" },
    };
    await Promise.all([
      QRCode.toFile(pngPath, link.url, { ...options, type: "png" }),
      QRCode.toFile(svgPath, link.url, { ...options, type: "svg" }),
    ]);
    qrFiles.push({
      ...link,
      png: `qr/${basename}.png`,
      svg: `qr/${basename}.svg`,
    });
  }

  const generatedAt = now.toISOString();
  const artifacts = {
    sql: buildLoadSql(event, slots),
    csv: buildLinksCsv(event, publicLinks),
    html: buildPrintableIndex(event, qrFiles, generatedAt),
    summary: `${JSON.stringify(
      {
        ...event,
        generatedAt,
        publicLinkCount: publicLinks.length,
        claimSlotCount: slots.length,
        imageCheck,
        files: {
          databaseLoad: "load-event.sql",
          claimLinks: "claim-links.csv",
          printableIndex: "qr-index.html",
          qrDirectory: "qr/",
          tokenMetadata: "metadata.json",
          artwork: artworkFile,
        },
      },
      null,
      2,
    )}\n`,
    metadata: `${JSON.stringify(
      {
        name: event.title,
        description: event.description,
        image: event.imageUrl,
        external_url: event.eventUrl,
        attributes: [
          { trait_type: "Issuer", value: "兆量富足教育協會" },
          { trait_type: "Event date", value: event.startsAt },
          { trait_type: "Network", value: event.chainId === 84532 ? "Base Sepolia" : "Base" },
        ],
      },
      null,
      2,
    )}\n`,
  };

  if (artworkFile) {
    const artworkPath = resolve(absoluteOutputDir, artworkFile);
    await copyFile(imageCheck.path, artworkPath);
    await chmod(artworkPath, 0o600);
  }

  await Promise.all([
    writeSecret(resolve(absoluteOutputDir, "load-event.sql"), artifacts.sql),
    writeSecret(resolve(absoluteOutputDir, "claim-links.csv"), artifacts.csv),
    writeSecret(resolve(absoluteOutputDir, "qr-index.html"), artifacts.html),
    writeSecret(resolve(absoluteOutputDir, "event-summary.json"), artifacts.summary),
    writeSecret(resolve(absoluteOutputDir, "metadata.json"), artifacts.metadata),
  ]);

  return {
    event,
    outputDir: absoluteOutputDir,
    publicLinkCount: publicLinks.length,
    claimSlotCount: slots.length,
    imageCheck,
  };
}

export function validateEvent(value) {
  if (!value || typeof value !== "object")
    throw new Error("Event file must contain a JSON object.");
  const requiredText = [
    "eventId",
    "slug",
    "title",
    "description",
    "imageUrl",
    "startsAt",
    "claimOpensAt",
    "claimClosesAt",
    "publicBaseUrl",
  ];
  for (const field of requiredText) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      throw new Error(`${field} must be a non-empty string.`);
    }
  }
  if (!SLUG_PATTERN.test(value.slug)) {
    throw new Error("slug must contain 3-80 lowercase letters, numbers, or hyphens.");
  }
  if (value.eventId.length < 8 || value.eventId.length > 80) {
    throw new Error("eventId must contain 8-80 characters.");
  }
  if (value.title.length > 160) throw new Error("title must contain at most 160 characters.");

  const dates = {};
  for (const field of ["startsAt", "claimOpensAt", "claimClosesAt"]) {
    const timestamp = Date.parse(value[field]);
    if (Number.isNaN(timestamp)) throw new Error(`${field} must be an ISO date.`);
    dates[field] = timestamp;
  }
  if (dates.claimOpensAt >= dates.claimClosesAt) {
    throw new Error("claimOpensAt must be earlier than claimClosesAt.");
  }
  if (
    !Number.isInteger(value.maxSupply) ||
    value.maxSupply < 1 ||
    !Number.isInteger(value.claimCount) ||
    value.claimCount < 1 ||
    value.claimCount > value.maxSupply
  ) {
    throw new Error(
      "maxSupply and claimCount must be positive integers, with claimCount <= maxSupply.",
    );
  }

  const claimMode = value.claimMode ?? "unique";
  if (!["unique", "shared"].includes(claimMode)) {
    throw new Error("claimMode must be either unique or shared.");
  }
  assertHttpUrl(value.publicBaseUrl, "publicBaseUrl");
  if (!value.imageUrl.startsWith("/")) assertHttpUrl(value.imageUrl, "imageUrl");
  if (value.eventUrl !== null && value.eventUrl !== undefined && value.eventUrl !== "") {
    assertHttpUrl(value.eventUrl, "eventUrl");
  }
  const chainId = value.chainId ?? 84532;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    throw new Error("chainId must be a positive integer.");
  }

  return {
    eventId: value.eventId,
    slug: value.slug,
    title: value.title,
    description: value.description,
    imageUrl: value.imageUrl,
    imageFile:
      typeof value.imageFile === "string" && value.imageFile.trim() ? value.imageFile.trim() : null,
    eventUrl: typeof value.eventUrl === "string" && value.eventUrl ? value.eventUrl : null,
    startsAt: new Date(dates.startsAt).toISOString(),
    claimOpensAt: new Date(dates.claimOpensAt).toISOString(),
    claimClosesAt: new Date(dates.claimClosesAt).toISOString(),
    maxSupply: value.maxSupply,
    claimCount: value.claimCount,
    claimMode,
    chainId,
    publicBaseUrl: value.publicBaseUrl.replace(/\/+$/, ""),
  };
}

export async function inspectEventImage(event, inputDirectory) {
  if (!event.imageFile) {
    return {
      status: "url-only",
      message: "No local imageFile was provided; URL syntax was checked, file bytes were not.",
    };
  }
  const path = resolve(inputDirectory, event.imageFile);
  const file = await readFile(path);
  const fileStat = await stat(path);
  if (!fileStat.isFile()) throw new Error(`imageFile is not a file: ${path}`);
  if (file.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`imageFile exceeds the 10 MiB event-image limit: ${path}`);
  }
  const image = detectImage(file, extname(path).toLowerCase());
  if (!image) {
    throw new Error("imageFile must be PNG, JPEG, WebP, GIF, or SVG and match its file contents.");
  }
  if (!image.width || !image.height) {
    throw new Error("imageFile dimensions could not be read.");
  }
  if (image.width < 128 || image.height < 128 || image.width > 4096 || image.height > 4096) {
    throw new Error("imageFile width and height must each be between 128 and 4096 pixels.");
  }
  return {
    status: "checked",
    path,
    format: image.format,
    width: image.width,
    height: image.height,
    bytes: file.byteLength,
  };
}

function buildLoadSql(event, slots) {
  return [
    "PRAGMA foreign_keys = ON;",
    "",
    "INSERT INTO live_events (",
    "  event_id, slug, title, description, image_url, event_url,",
    "  starts_at, claim_opens_at, claim_closes_at, chain_id, max_supply, status, claim_mode",
    ") VALUES (",
    `  ${sqlText(event.eventId)},`,
    `  ${sqlText(event.slug)},`,
    `  ${sqlText(event.title)},`,
    `  ${sqlText(event.description)},`,
    `  ${sqlText(event.imageUrl)},`,
    `  ${event.eventUrl === null ? "NULL" : sqlText(event.eventUrl)},`,
    `  ${sqlText(event.startsAt)},`,
    `  ${sqlText(event.claimOpensAt)},`,
    `  ${sqlText(event.claimClosesAt)},`,
    `  ${event.chainId},`,
    `  ${event.maxSupply},`,
    // Events are loaded fail-closed. Publish only after media, contract and
    // indexer coordinates have all been connected and audited.
    "  'draft',",
    `  ${sqlText(event.claimMode)}`,
    ");",
    "",
    "INSERT INTO live_claim_codes (code_hash, event_id, access_code_hash) VALUES",
    slots
      .map(
        (slot, index) =>
          `  (${sqlText(slot.codeHash)}, ${sqlText(event.eventId)}, ${sqlText(slot.accessCodeHash)})${
            index === slots.length - 1 ? ";" : ","
          }`,
      )
      .join("\n"),
    "",
  ].join("\n");
}

function buildLinksCsv(event, links) {
  return [
    "number,claim_mode,capacity,claim_url",
    ...links.map((link) =>
      [
        link.number,
        event.claimMode,
        event.claimMode === "shared" ? event.claimCount : 1,
        csvText(link.url),
      ].join(","),
    ),
    "",
  ].join("\n");
}

function buildPrintableIndex(event, qrFiles, generatedAt) {
  const cards = qrFiles
    .map(
      (file) => `
        <article class="card">
          <img src="${htmlText(file.svg)}" alt="領取 QR Code ${file.number}">
          <h2>${htmlText(event.title)}</h2>
          <p>${event.claimMode === "shared" ? `共用 QR · 最多 ${event.claimCount} 人` : `領取資格 ${file.number}`}</p>
          <a href="${htmlText(file.url)}">開啟領取頁</a>
        </article>`,
    )
    .join("\n");
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <title>${htmlText(event.title)} · QR Code</title>
  <style>
    *{box-sizing:border-box}body{margin:0;padding:24px;font:16px/1.5 system-ui,sans-serif;color:#101416;background:#f4f0e8}
    header{max-width:900px;margin:0 auto 24px}h1{margin:0 0 8px}.meta{color:#596166}
    main{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px;max-width:1100px;margin:auto}
    .card{break-inside:avoid;padding:24px;text-align:center;border:1px solid #d7d1c5;border-radius:18px;background:#fff}
    .card img{display:block;width:min(100%,320px);height:auto;margin:auto}.card h2{font-size:18px}.card a{color:#315f58}
    @media print{body{padding:0;background:#fff}header{padding:12mm 12mm 0}.card{border:1px solid #999;border-radius:0;page-break-inside:avoid}main{padding:8mm 12mm}}
  </style>
</head>
<body>
  <header>
    <h1>${htmlText(event.title)}</h1>
    <p>${htmlText(event.description)}</p>
    <p class="meta">${event.claimMode === "shared" ? "共用 QR" : `${qrFiles.length} 個唯一 QR`} · 產生於 ${htmlText(generatedAt)}</p>
  </header>
  <main>${cards}
  </main>
</body>
</html>
`;
}

async function assertOutputIsNew(outputDir) {
  try {
    await access(outputDir);
    const files = await readdir(outputDir);
    if (files.length > 0) {
      throw new Error(
        `Output directory already contains files; refusing to overwrite: ${outputDir}`,
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function claimUrl(event, code) {
  return `${event.publicBaseUrl}/claim/${event.slug}?code=${encodeURIComponent(code)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertCodesUnique(codes) {
  if (new Set(codes).size !== codes.length) throw new Error("Random claim code collision; retry.");
}

function detectImage(file, extension) {
  if (
    extension === ".png" &&
    file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return { format: "png", width: file.readUInt32BE(16), height: file.readUInt32BE(20) };
  if ([".jpg", ".jpeg"].includes(extension) && file[0] === 0xff && file[1] === 0xd8) {
    const dimensions = jpegDimensions(file);
    return dimensions ? { format: "jpeg", ...dimensions } : null;
  }
  if (
    extension === ".webp" &&
    file.subarray(0, 4).toString("ascii") === "RIFF" &&
    file.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return webpDimensions(file);
  if (extension === ".gif" && ["GIF87a", "GIF89a"].includes(file.subarray(0, 6).toString("ascii")))
    return { format: "gif", width: file.readUInt16LE(6), height: file.readUInt16LE(8) };
  if (extension === ".svg") {
    const source = file.subarray(0, 4096).toString("utf8");
    if (!source.includes("<svg")) return null;
    const width = numberAttribute(source, "width");
    const height = numberAttribute(source, "height");
    if (width && height) return { format: "svg", width, height };
    const viewBox = source.match(
      /\bviewBox\s*=\s*["'][-\d.]+[,\s]+[-\d.]+[,\s]+([\d.]+)[,\s]+([\d.]+)["']/i,
    );
    if (viewBox) return { format: "svg", width: Number(viewBox[1]), height: Number(viewBox[2]) };
  }
  return null;
}

function jpegDimensions(file) {
  let offset = 2;
  while (offset + 8 < file.length) {
    if (file[offset] !== 0xff) return null;
    const marker = file[offset + 1];
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      return { height: file.readUInt16BE(offset + 5), width: file.readUInt16BE(offset + 7) };
    }
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
    } else {
      offset += 2 + file.readUInt16BE(offset + 2);
    }
  }
  return null;
}

function webpDimensions(file) {
  const chunk = file.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X" && file.length >= 30) {
    return {
      format: "webp",
      width: 1 + file.readUIntLE(24, 3),
      height: 1 + file.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8L" && file.length >= 25) {
    const bits = file.readUInt32LE(21);
    return {
      format: "webp",
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === "VP8 " && file.length >= 30) {
    return {
      format: "webp",
      width: file.readUInt16LE(26) & 0x3fff,
      height: file.readUInt16LE(28) & 0x3fff,
    };
  }
  return null;
}

function numberAttribute(source, name) {
  const match = source.match(new RegExp(`\\b${name}\\s*=\\s*["']([\\d.]+)(?:px)?["']`, "i"));
  return match ? Number(match[1]) : null;
}

function imageExtension(format) {
  return format === "jpeg" ? "jpg" : format;
}

function assertHttpUrl(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${field} must use http or https.`);
  }
}

function sqlText(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function csvText(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function htmlText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function writeSecret(path, contents) {
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
}
