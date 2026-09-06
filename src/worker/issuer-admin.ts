import { verifyMagicIdentity } from "./magic-auth";
import type { Bindings } from "./types";
import { ApiError } from "./validation";

// Artwork is sent through the Vercel API proxy as base64 JSON. Keep the raw
// file below 3 MiB so the encoded request stays safely under Vercel's 4.5 MB
// function payload limit.
const MAX_ARTWORK_BYTES = 3 * 1024 * 1024;
const MIN_MAGIC_DID_TOKEN_LENGTH = 64;
const MAX_MAGIC_DID_TOKEN_LENGTH = 8192;
const MAX_ADMIN_EMAIL_LENGTH = 254;
const BASE_MAINNET_CHAIN_ID = 8453;
const LIVE_MEDIA_PREFIX = "/media/live/events";
const ALLOWED_ARTWORK_TYPES = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
]);

export interface IssuerAdminIdentity {
  email: string;
  address: `0x${string}`;
}

export interface IssuerManagedEvent {
  eventId: string;
  slug: string;
  title: string;
  issuer: string;
  description: string;
  imageUrl: string;
  eventUrl: string | null;
  startsAt: string;
  claimOpensAt: string;
  claimClosesAt: string;
  chainId: number;
  contractAddress: string | null;
  tokenId: string | null;
  maxSupply: number;
  claimMode: "unique" | "shared";
  status: "draft" | "published" | "closed";
  updatedAt: string;
  eventType: string;
  location: string;
  collaborators: string[];
}

interface ManagedEventRow {
  event_id: string;
  slug: string;
  title: string;
  issuer: string;
  description: string;
  image_url: string;
  event_url: string | null;
  starts_at: string;
  claim_opens_at: string;
  claim_closes_at: string;
  chain_id: number;
  contract_address: string | null;
  token_id: string | null;
  max_supply: number;
  claim_mode: "unique" | "shared";
  status: "draft" | "published" | "closed";
  updated_at: string;
}

const ADMIN_EVENT_SELECT = `
  SELECT event_id, slug, title, issuer, description, image_url, event_url,
         starts_at, claim_opens_at, claim_closes_at, chain_id,
         contract_address, token_id, max_supply, claim_mode, status, updated_at
  FROM live_events
`;

export function issuerAdminEmails(value: string | undefined): Set<string> {
  return new Set(
    String(value || "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isIssuerAdminEmail(value: string, configured: string | undefined): boolean {
  return issuerAdminEmails(configured).has(value.trim().toLowerCase());
}

export async function requireIssuerAdmin(
  env: Bindings,
  request: Request,
  explicit?: { didToken?: unknown; email?: unknown },
): Promise<IssuerAdminIdentity> {
  const didToken =
    typeof explicit?.didToken === "string"
      ? explicit.didToken.trim()
      : request.headers
          .get("authorization")
          ?.replace(/^Bearer\s+/i, "")
          .trim() || "";
  const email =
    typeof explicit?.email === "string"
      ? explicit.email.trim()
      : request.headers.get("x-issuer-email")?.trim() || "";
  if (
    didToken.length < MIN_MAGIC_DID_TOKEN_LENGTH ||
    didToken.length > MAX_MAGIC_DID_TOKEN_LENGTH ||
    !email ||
    email.length > MAX_ADMIN_EMAIL_LENGTH
  ) {
    throw new ApiError(401, "請先使用管理者 Email 登入。", "issuer_admin_auth_required");
  }
  if (issuerAdminEmails(env.ISSUER_ADMIN_EMAILS).size === 0) {
    throw new ApiError(503, "發行管理者尚未設定。", "issuer_admin_unconfigured");
  }
  const identity = await verifyMagicIdentity(env, { didToken, expectedEmail: email });
  if (!isIssuerAdminEmail(identity.email, env.ISSUER_ADMIN_EMAILS)) {
    throw new ApiError(403, "這個帳號沒有活動管理權限。", "issuer_admin_forbidden");
  }
  return identity;
}

export async function listIssuerEvents(db: D1Database): Promise<IssuerManagedEvent[]> {
  const rows = await db
    .prepare(`${ADMIN_EVENT_SELECT} WHERE chain_id = ? ORDER BY starts_at DESC, slug ASC`)
    .bind(BASE_MAINNET_CHAIN_ID)
    .all<ManagedEventRow>();
  return Promise.all((rows.results || []).map((row) => mapManagedEvent(row, null)));
}

export async function loadIssuerEvent(
  env: Pick<Bindings, "LIVE_DB" | "ARCHIVE_BUCKET">,
  slug: string,
): Promise<IssuerManagedEvent | null> {
  const row = await env.LIVE_DB.prepare(
    `${ADMIN_EVENT_SELECT} WHERE slug = ? AND chain_id = ? LIMIT 1`,
  )
    .bind(slug, BASE_MAINNET_CHAIN_ID)
    .first<ManagedEventRow>();
  if (!row) return null;
  const metadata = await readMetadata(env.ARCHIVE_BUCKET, row.slug);
  return mapManagedEvent(row, metadata);
}

export async function updateIssuerEvent(
  env: Pick<Bindings, "LIVE_DB" | "ARCHIVE_BUCKET">,
  identity: IssuerAdminIdentity,
  input: Record<string, unknown>,
): Promise<{ event: IssuerManagedEvent; revisionId: string }> {
  const slug = validSlug(input.slug);
  const current = await loadIssuerEvent(env, slug);
  if (!current) throw new ApiError(404, "找不到這個正式活動。", "issuer_event_not_found");
  const expectedUpdatedAt = requiredText(input.expectedUpdatedAt, "活動版本", 80);
  if (current.updatedAt !== expectedUpdatedAt) {
    throw new ApiError(409, "活動已被更新，請重新載入後再修改。", "issuer_event_conflict");
  }

  const next = normalizeUpdate(current, input);
  const artwork = parseArtwork(input.artwork);
  const revisionPayload = JSON.stringify({
    eventId: current.eventId,
    expectedUpdatedAt,
    next,
    artworkSha256: artwork ? await sha256Hex(artwork.bytes) : null,
  });
  const revisionId = (await sha256Hex(new TextEncoder().encode(revisionPayload))).slice(0, 20);
  if (artwork) {
    const filename = `artwork-${revisionId}.${artwork.extension}`;
    await env.ARCHIVE_BUCKET.put(`live/events/${slug}/${filename}`, artwork.bytes, {
      httpMetadata: {
        contentType: artwork.contentType,
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { revisionId, updatedBy: identity.address },
    });
    next.imageUrl = `${LIVE_MEDIA_PREFIX}/${slug}/${filename}`;
  }

  const originalMetadata = (await readMetadata(env.ARCHIVE_BUCKET, slug)) || {};
  const nextMetadata = buildManagedMetadata(next, originalMetadata);
  await env.ARCHIVE_BUCKET.put(
    `live/events/${slug}/metadata-${revisionId}.json`,
    JSON.stringify(nextMetadata, null, 2),
    {
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { revisionId, updatedBy: identity.address },
    },
  );

  const updatedAt = new Date().toISOString();
  const update = env.LIVE_DB.prepare(
    `UPDATE live_events
       SET title = ?, issuer = ?, description = ?, image_url = ?, event_url = ?,
           starts_at = ?, claim_opens_at = ?, claim_closes_at = ?, updated_at = ?
     WHERE event_id = ? AND slug = ? AND updated_at = ?`,
  ).bind(
    next.title,
    next.issuer,
    next.description,
    next.imageUrl,
    next.eventUrl,
    next.startsAt,
    next.claimOpensAt,
    next.claimClosesAt,
    updatedAt,
    current.eventId,
    current.slug,
    expectedUpdatedAt,
  );
  const audit = env.LIVE_DB.prepare(
    `INSERT INTO live_event_revisions
       (revision_id, event_id, action, before_json, after_json, created_by_address)
     SELECT ?, ?, 'update', ?, ?, ?
     WHERE EXISTS (
       SELECT 1 FROM live_events WHERE event_id = ? AND slug = ? AND updated_at = ?
     )`,
  ).bind(
    revisionId,
    current.eventId,
    JSON.stringify(current),
    JSON.stringify({ ...next, updatedAt }),
    identity.address,
    current.eventId,
    current.slug,
    updatedAt,
  );
  const [updateResult] = await env.LIVE_DB.batch([update, audit]);
  if (!updateResult.meta.changes) {
    throw new ApiError(409, "活動已被更新，請重新載入後再修改。", "issuer_event_conflict");
  }

  await env.ARCHIVE_BUCKET.put(
    `live/events/${slug}/metadata.json`,
    JSON.stringify(nextMetadata, null, 2),
    {
      httpMetadata: {
        contentType: "application/json; charset=utf-8",
        cacheControl: "public, max-age=300",
      },
      customMetadata: { revisionId, updatedBy: identity.address },
    },
  );
  const event = await loadIssuerEvent(env, slug);
  if (!event) throw new ApiError(503, "活動更新後無法重新載入。", "issuer_event_reload_failed");
  return { event, revisionId };
}

export async function transitionIssuerEvent(
  env: Pick<Bindings, "LIVE_DB" | "ARCHIVE_BUCKET">,
  identity: IssuerAdminIdentity,
  input: Record<string, unknown>,
): Promise<{ event: IssuerManagedEvent; revisionId: string }> {
  const slug = validSlug(input.slug);
  const current = await loadIssuerEvent(env, slug);
  if (!current) throw new ApiError(404, "找不到這個正式活動。", "issuer_event_not_found");
  const expectedUpdatedAt = requiredText(input.expectedUpdatedAt, "活動版本", 80);
  if (current.updatedAt !== expectedUpdatedAt) {
    throw new ApiError(409, "活動已被更新，請重新載入後再操作。", "issuer_event_conflict");
  }
  const nextStatus =
    input.status === "closed" ? "closed" : input.status === "published" ? "published" : null;
  if (!nextStatus) throw new ApiError(400, "活動狀態不正確。", "issuer_event_status_invalid");
  if (!allowedTransition(current.status, nextStatus)) {
    throw new ApiError(409, "目前的活動狀態不能執行這個操作。", "issuer_event_transition_invalid");
  }
  const updatedAt = new Date().toISOString();
  const revisionId = (
    await sha256Hex(
      new TextEncoder().encode(
        JSON.stringify({ eventId: current.eventId, expectedUpdatedAt, nextStatus }),
      ),
    )
  ).slice(0, 20);
  const [result] = await env.LIVE_DB.batch([
    env.LIVE_DB.prepare(
      `UPDATE live_events SET status = ?, updated_at = ?
       WHERE event_id = ? AND slug = ? AND updated_at = ?`,
    ).bind(nextStatus, updatedAt, current.eventId, current.slug, expectedUpdatedAt),
    env.LIVE_DB.prepare(
      `INSERT INTO live_event_revisions
         (revision_id, event_id, action, before_json, after_json, created_by_address)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM live_events WHERE event_id = ? AND slug = ? AND updated_at = ?
       )`,
    ).bind(
      revisionId,
      current.eventId,
      nextStatus === "closed" ? "close" : "reopen",
      JSON.stringify(current),
      JSON.stringify({ ...current, status: nextStatus, updatedAt }),
      identity.address,
      current.eventId,
      current.slug,
      updatedAt,
    ),
  ]);
  if (!result.meta.changes) {
    throw new ApiError(409, "活動已被更新，請重新載入後再操作。", "issuer_event_conflict");
  }
  const event = await loadIssuerEvent(env, slug);
  if (!event) throw new ApiError(503, "活動更新後無法重新載入。", "issuer_event_reload_failed");
  return { event, revisionId };
}

function normalizeUpdate(current: IssuerManagedEvent, input: Record<string, unknown>) {
  const startsAt = iso(input.startsAt, "活動開始時間");
  const claimOpensAt = iso(input.claimOpensAt, "開放領取時間");
  const claimClosesAt = iso(input.claimClosesAt, "結束領取時間");
  if (Date.parse(claimOpensAt) >= Date.parse(claimClosesAt)) {
    throw new ApiError(400, "結束領取時間必須晚於開放領取時間。", "issuer_event_time_invalid");
  }
  if (Date.parse(claimOpensAt) > Date.parse(startsAt)) {
    throw new ApiError(400, "開放領取時間不可晚於活動開始時間。", "issuer_event_time_invalid");
  }
  return {
    ...current,
    title: requiredText(input.title, "活動名稱", 160),
    issuer: requiredText(input.issuer, "發行單位", 160),
    description: optionalText(input.description, 1_000),
    eventUrl: optionalHttpsUrl(input.eventUrl),
    startsAt,
    claimOpensAt,
    claimClosesAt,
    eventType: optionalText(input.eventType, 60) || "活動紀念",
    location: optionalText(input.location, 120),
    collaborators: list(input.collaborators, 12, 120),
  };
}

function buildManagedMetadata(event: IssuerManagedEvent, original: Record<string, unknown>) {
  const managedTraits = new Set([
    "Issuer",
    "Event date",
    "Event type",
    "Location",
    "Collaborator",
    "發行單位",
    "活動日期",
    "活動形式",
    "活動地點",
    "合作單位",
  ]);
  const preserved = Array.isArray(original.attributes)
    ? original.attributes.filter(
        (item) =>
          item &&
          typeof item === "object" &&
          !managedTraits.has(String((item as Record<string, unknown>).trait_type || "")),
      )
    : [];
  return {
    ...original,
    name: event.title,
    description: event.description,
    image: absolutePublicUrl(event.imageUrl),
    external_url: event.eventUrl || `https://poap.blocktrend.today/claim/${event.slug}`,
    attributes: [
      { trait_type: "Issuer", value: event.issuer },
      { trait_type: "Event date", value: event.startsAt },
      { trait_type: "Event type", value: event.eventType || "活動紀念" },
      ...(event.location ? [{ trait_type: "Location", value: event.location }] : []),
      ...event.collaborators.map((value) => ({ trait_type: "Collaborator", value })),
      ...preserved,
    ],
  };
}

async function readMetadata(
  bucket: R2Bucket,
  slug: string,
): Promise<Record<string, unknown> | null> {
  const object = await bucket.get(`live/events/${slug}/metadata.json`);
  if (!object) return null;
  try {
    const value = JSON.parse(await object.text());
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function mapManagedEvent(
  row: ManagedEventRow,
  metadata: Record<string, unknown> | null,
): IssuerManagedEvent {
  const fields = metadataFields(metadata);
  return {
    eventId: row.event_id,
    slug: row.slug,
    title: row.title,
    issuer: row.issuer,
    description: row.description,
    imageUrl: row.image_url,
    eventUrl: row.event_url,
    startsAt: row.starts_at,
    claimOpensAt: row.claim_opens_at,
    claimClosesAt: row.claim_closes_at,
    chainId: row.chain_id,
    contractAddress: row.contract_address,
    tokenId: row.token_id,
    maxSupply: row.max_supply,
    claimMode: row.claim_mode,
    status: row.status,
    updatedAt: row.updated_at,
    ...fields,
  };
}

function metadataFields(metadata: Record<string, unknown> | null) {
  const attributes = Array.isArray(metadata?.attributes) ? metadata.attributes : [];
  const values = (names: string[]) =>
    attributes
      .filter((item) => item && typeof item === "object")
      .filter((item) => names.includes(String((item as Record<string, unknown>).trait_type || "")))
      .map((item) => String((item as Record<string, unknown>).value || "").trim())
      .filter(Boolean);
  return {
    eventType: values(["Event type", "活動形式"])[0] || "活動紀念",
    location: values(["Location", "活動地點"])[0] || "",
    collaborators: values(["Collaborator", "合作單位"]).flatMap((value) =>
      value
        .split(/[、,，]/)
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  };
}

function parseArtwork(value: unknown): {
  bytes: Uint8Array;
  contentType: string;
  extension: string;
} | null {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "Artwork 資料格式不正確。", "issuer_artwork_invalid");
  }
  const record = value as Record<string, unknown>;
  const contentType = String(record.type || "").toLowerCase();
  const extension = ALLOWED_ARTWORK_TYPES.get(contentType);
  if (!extension) throw new ApiError(400, "Artwork 格式不支援。", "issuer_artwork_type_invalid");
  const dataUrl = String(record.dataUrl || "");
  const match = /^data:([^;,]+);base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl);
  if (!match || match[1].toLowerCase() !== contentType) {
    throw new ApiError(400, "Artwork 內容格式不正確。", "issuer_artwork_invalid");
  }
  let binary: string;
  try {
    binary = atob(match[2]);
  } catch {
    throw new ApiError(400, "Artwork 內容無法讀取。", "issuer_artwork_invalid");
  }
  if (binary.length === 0 || binary.length > MAX_ARTWORK_BYTES) {
    throw new ApiError(400, "Artwork 必須小於 3 MiB。", "issuer_artwork_size_invalid");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (!matchesArtworkSignature(bytes, contentType)) {
    throw new ApiError(400, "Artwork 副檔名與實際內容不一致。", "issuer_artwork_signature_invalid");
  }
  return { bytes, contentType, extension };
}

function matchesArtworkSignature(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === "image/png") {
    return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
  }
  if (contentType === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (contentType === "image/gif") {
    const header = new TextDecoder().decode(bytes.slice(0, 6));
    return header === "GIF87a" || header === "GIF89a";
  }
  if (contentType === "image/webp") {
    const riff = new TextDecoder().decode(bytes.slice(0, 4));
    const webp = new TextDecoder().decode(bytes.slice(8, 12));
    return riff === "RIFF" && webp === "WEBP";
  }
  return false;
}

function allowedTransition(from: string, to: string): boolean {
  return (
    from === to ||
    (from === "draft" && (to === "published" || to === "closed")) ||
    (from === "published" && to === "closed") ||
    (from === "closed" && to === "published")
  );
}

function validSlug(value: unknown): string {
  const slug = String(value || "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(slug)) {
    throw new ApiError(400, "活動代號格式不正確。", "issuer_event_slug_invalid");
  }
  return slug;
}

function requiredText(value: unknown, label: string, max: number): string {
  const text = optionalText(value, max);
  if (!text) throw new ApiError(400, `請填寫${label}。`, "issuer_event_field_required");
  return text;
}

function optionalText(value: unknown, max: number): string {
  const text = String(value || "").trim();
  if (text.length > max) {
    throw new ApiError(400, `欄位內容不可超過 ${max} 字。`, "issuer_event_field_too_long");
  }
  return text;
}

function list(value: unknown, maxItems: number, maxLength: number): string[] {
  const source = Array.isArray(value) ? value : String(value || "").split(/[、,，]/);
  const result = source.map((item) => optionalText(item, maxLength)).filter(Boolean);
  if (result.length > maxItems) {
    throw new ApiError(400, `最多只能填寫 ${maxItems} 個合作單位。`, "issuer_event_list_too_long");
  }
  return result;
}

function iso(value: unknown, label: string): string {
  const stamp = Date.parse(String(value || ""));
  if (Number.isNaN(stamp)) {
    throw new ApiError(400, `請填寫正確的${label}。`, "issuer_event_time_invalid");
  }
  return new Date(stamp).toISOString();
}

function optionalHttpsUrl(value: unknown): string | null {
  const text = String(value || "").trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ApiError(400, "活動網址格式不正確。", "issuer_event_url_invalid");
  }
  if (url.protocol !== "https:") {
    throw new ApiError(400, "活動網址必須使用 HTTPS。", "issuer_event_url_invalid");
  }
  return url.toString();
}

function absolutePublicUrl(value: string): string {
  return value.startsWith("/") ? `https://poap.blocktrend.today${value}` : value;
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const stable = new Uint8Array(value.byteLength);
  stable.set(value);
  const bytes = await crypto.subtle.digest("SHA-256", stable.buffer);
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
