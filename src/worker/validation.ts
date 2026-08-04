import type {
  CollectionCursor,
  CollectionExportSegmentCursor,
  CollectionExportSegmentKind,
  CollectionExportSegmentQuery,
  CollectionItemCursor,
  CollectionItemsQuery,
  CollectionsQuery,
  CollectionType,
  DropCollectorsCursor,
  DropCollectorsQuery,
  DropCursor,
  DropSort,
  DropsQuery,
  EventType,
  OwnedCollectionsCursor,
  OwnedCollectionsQuery,
  OwnerCursor,
  OwnerQuery,
  PersonalHoldingsCursor,
  PersonalHoldingsQuery,
} from "./types";
import type {
  CapsuleCursor,
  CapsuleOwnerQuery,
  MomentCursor,
  MomentMediaKind,
  MomentPageQuery,
  MomentsQuery,
} from "./moments-repository";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SOURCE_UID = /^[A-Za-z0-9:_-]{1,128}$/;
const ARTIST_ID = /^[A-Za-z0-9-]{1,128}$/;
const SEARCH_TERM = /[\p{L}\p{N}]+/gu;
const DROP_PARAMS = new Set(["q", "year", "type", "sort", "cursor", "limit"]);
const OWNER_PARAMS = new Set(["cursor", "limit"]);
const ID_LIST_PARAMS = new Set(["ids"]);
const DROP_ID_LIST_PARAMS = new Set(["drop_ids"]);
const COLLECTION_PARAMS = new Set(["q", "year", "type", "cursor", "limit"]);
const COLLECTION_ITEM_PARAMS = new Set(["cursor", "limit"]);
const MOMENT_PARAMS = new Set(["author", "drop", "collection", "media", "cursor", "limit"]);
const MOMENT_PAGE_PARAMS = new Set(["media", "cursor", "limit"]);
const SORTS = new Set<DropSort>(["recent", "oldest", "popular"]);
const EVENT_TYPES = new Set<EventType>(["all", "virtual", "in-person"]);
const COLLECTION_TYPES = new Set<CollectionType>(["all", "artist", "organization", "user"]);
const MOMENT_MEDIA_KINDS = new Set<MomentMediaKind>(["image", "video", "audio", "other"]);
const MOMENT_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MOMENT_CURSOR_ID = /^[A-Za-z0-9-]{1,128}$/;

export type ApiStatus = 400 | 401 | 403 | 404 | 409 | 413 | 502 | 503;

export class ApiError extends Error {
  constructor(
    readonly status: ApiStatus,
    message: string,
    readonly code = "invalid_request",
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function assertNoQuery(url: URL): void {
  let hasParameter = false;
  url.searchParams.forEach(() => {
    hasParameter = true;
  });
  if (hasParameter) {
    throw new ApiError(400, "This endpoint does not accept query parameters.");
  }
}

export function parseDropId(raw: string): number {
  if (!/^[1-9]\d{0,9}$/.test(raw)) {
    throw new ApiError(400, "Drop ID must be a positive integer.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ApiError(400, "Drop ID is outside the supported range.");
  }
  return value;
}

export function parseCollectionId(raw: string): number {
  if (!/^[1-9]\d{0,9}$/.test(raw)) {
    throw new ApiError(400, "Collection ID must be a positive integer.");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new ApiError(400, "Collection ID is outside the supported range.");
  }
  return value;
}

export function normalizeAddress(raw: string): string {
  if (!ADDRESS.test(raw)) {
    throw new ApiError(400, "Enter an exact 0x-prefixed, 40-character address.");
  }
  return raw.toLowerCase();
}

export function parseMomentId(raw: string): string {
  if (!MOMENT_ID.test(raw)) {
    throw new ApiError(400, "Moment ID must be a complete UUID.");
  }
  return raw.toLowerCase();
}

export function parseMomentsQuery(
  url: URL,
  snapshotId: string,
): MomentsQuery & { canonicalSearch: string } {
  assertKnownParams(url.searchParams, MOMENT_PARAMS);
  const rawAuthor = optionalParam(url.searchParams, "author");
  const author = rawAuthor === null ? null : normalizeAddress(rawAuthor);
  const dropId = parseOptionalInteger(url.searchParams, "drop", 1, 9_999_999_999);
  const collectionId = parseOptionalInteger(url.searchParams, "collection", 1, 9_999_999_999);
  const mediaKind = parseOptionalEnum(url.searchParams, "media", MOMENT_MEDIA_KINDS);
  const limit = parseLimit(url.searchParams, 24);
  const filterKey = JSON.stringify({ author, dropId, collectionId, mediaKind, limit });
  const rawCursor = optionalParam(url.searchParams, "cursor");
  const cursor =
    rawCursor === null
      ? null
      : validateMomentCursor(decodeCursor<MomentCursor>(rawCursor), snapshotId, filterKey);

  const canonical = new URLSearchParams();
  if (author !== null) canonical.set("author", author);
  if (dropId !== null) canonical.set("drop", String(dropId));
  if (collectionId !== null) canonical.set("collection", String(collectionId));
  if (mediaKind !== null) canonical.set("media", mediaKind);
  if (cursor) canonical.set("cursor", encodeCursor(cursor));
  canonical.set("limit", String(limit));
  return {
    author,
    dropId,
    collectionId,
    mediaKind,
    limit,
    cursor,
    filterKey,
    canonicalSearch: canonical.toString(),
  };
}

export function parseMomentPageQuery(
  url: URL,
  snapshotId: string,
  scope: string,
  fallbackLimit = 24,
): MomentPageQuery & { canonicalSearch: string } {
  assertKnownParams(url.searchParams, MOMENT_PAGE_PARAMS);
  const mediaKind = parseOptionalEnum(url.searchParams, "media", MOMENT_MEDIA_KINDS);
  const limit = parseLimit(url.searchParams, fallbackLimit);
  const filterKey = JSON.stringify({ scope, mediaKind, limit });
  const rawCursor = optionalParam(url.searchParams, "cursor");
  const cursor =
    rawCursor === null
      ? null
      : validateMomentCursor(decodeCursor<MomentCursor>(rawCursor), snapshotId, filterKey);
  const canonical = new URLSearchParams();
  if (mediaKind !== null) canonical.set("media", mediaKind);
  if (cursor) canonical.set("cursor", encodeCursor(cursor));
  canonical.set("limit", String(limit));
  return { mediaKind, limit, cursor, filterKey, canonicalSearch: canonical.toString() };
}

export function parseCapsuleOwnerQuery(
  url: URL,
  rawAddress: string,
  snapshotId: string,
  releaseKey: string,
): CapsuleOwnerQuery {
  assertKnownParams(url.searchParams, OWNER_PARAMS);
  const address = normalizeAddress(rawAddress);
  const limit = parseLimit(url.searchParams, 48);
  const filterKey = JSON.stringify({
    scope: "capsule-owner-export",
    address,
    releaseKey,
    limit,
  });
  const rawCursor = optionalParam(url.searchParams, "cursor");
  const cursor =
    rawCursor === null
      ? null
      : validateCapsuleCursor(decodeCursor<CapsuleCursor>(rawCursor), snapshotId, filterKey);
  const canonical = new URLSearchParams();
  if (cursor) canonical.set("cursor", encodeCursor(cursor));
  canonical.set("limit", String(limit));
  return { address, limit, cursor, filterKey, canonicalSearch: canonical.toString() };
}

export function parseDropsQuery(url: URL, snapshotId: string): DropsQuery {
  assertKnownParams(url.searchParams, DROP_PARAMS);

  const rawQuery = optionalParam(url.searchParams, "q");
  const search = rawQuery === null ? null : normalizeSearch(rawQuery);
  const year = parseOptionalInteger(url.searchParams, "year", 1900, 2100);
  const type = parseEnum(url.searchParams, "type", EVENT_TYPES, "all");
  const sort = parseEnum(url.searchParams, "sort", SORTS, "recent");
  const limit = parseLimit(url.searchParams, 48);
  const filterKey = JSON.stringify({ q: search?.text ?? "", year, type, sort, limit });

  const rawCursor = optionalParam(url.searchParams, "cursor");
  const cursor =
    rawCursor === null
      ? null
      : validateDropCursor(decodeCursor<DropCursor>(rawCursor), snapshotId, filterKey, sort);

  const canonical = new URLSearchParams();
  if (search) canonical.set("q", search.text);
  if (year !== null) canonical.set("year", String(year));
  if (type !== "all") canonical.set("type", type);
  if (sort !== "recent") canonical.set("sort", sort);
  if (cursor) canonical.set("cursor", encodeCursor(cursor));
  canonical.set("limit", String(limit));

  return {
    q: search?.text ?? null,
    ftsQuery: search?.ftsQuery ?? null,
    year,
    type,
    sort,
    limit,
    cursor,
    filterKey,
    canonicalSearch: canonical.toString(),
  };
}

export function parseOwnerQuery(url: URL, rawAddress: string, snapshotId: string): OwnerQuery {
  assertKnownParams(url.searchParams, OWNER_PARAMS);
  const address = normalizeAddress(rawAddress);
  const limit = parseLimit(url.searchParams, 48);
  const filterKey = JSON.stringify({ address, limit });
  const rawCursor = optionalParam(url.searchParams, "cursor");
  const cursor =
    rawCursor === null
      ? null
      : validateOwnerCursor(decodeCursor<OwnerCursor>(rawCursor), snapshotId, filterKey);

  const canonical = new URLSearchParams();
  if (cursor) canonical.set("cursor", encodeCursor(cursor));
  canonical.set("limit", String(limit));

  return { address, limit, cursor, filterKey, canonicalSearch: canonical.toString() };
}

export function parseDropCollectorsQuery(
  url: URL,
  rawDropId: string,
  snapshotId: string,
): DropCollectorsQuery {
  assertKnownParams(url.searchParams, OWNER_PARAMS);
  const dropId = parseDropId(rawDropId);
  const limit = parseLimit(url.searchParams, 48);
  const filterKey = JSON.stringify({ scope: "drop-collectors", dropId, limit });
  const rawCursor = optionalParam(url.searchParams, "cursor");
  const cursor =
    rawCursor === null
      ? null
      : validateDropCollectorsCursor(
          decodeCursor<DropCollectorsCursor>(rawCursor),
          snapshotId,
          filterKey,
        );

  const canonical = new URLSearchParams();
  if (cursor) canonical.set("cursor", encodeCursor(cursor));
  canonical.set("limit", String(limit));
  return { dropId, limit, cursor, filterKey, canonicalSearch: canonical.toString() };
}

export function parsePersonalHoldingsQuery(
  url: URL,
  rawAddress: string,
  snapshotId: string,
): PersonalHoldingsQuery {
  assertKnownParams(url.searchParams, OWNER_PARAMS);
  const address = normalizeAddress(rawAddress);
  const limit = parseBoundedLimit(url.searchParams, 480, 480);
  const filterKey = JSON.stringify({ scope: "personal-holdings", address, limit });
  const rawCursor = optionalParam(url.searchParams, "cursor");
  const cursor =
    rawCursor === null
      ? null
      : validatePersonalHoldingsCursor(
          decodeCursor<PersonalHoldingsCursor>(rawCursor),
          snapshotId,
          filterKey,
        );

  const canonical = new URLSearchParams();
  if (cursor) canonical.set("cursor", encodeCursor(cursor));
  canonical.set("limit", String(limit));
  return { address, limit, cursor, filterKey, canonicalSearch: canonical.toString() };
}

export function parseOwnedCollectionsQuery(
  url: URL,
  rawAddress: string,
  snapshotId: string,
): OwnedCollectionsQuery {
  assertKnownParams(url.searchParams, OWNER_PARAMS);
  const address = normalizeAddress(rawAddress);
  const limit = parseLimit(url.searchParams, 48);
  const filterKey = JSON.stringify({ scope: "owned-collections", address, limit });
  const rawCursor = optionalParam(url.searchParams, "cursor");
  const cursor =
    rawCursor === null
      ? null
      : validateOwnedCollectionsCursor(
          decodeCursor<OwnedCollectionsCursor>(rawCursor),
          snapshotId,
          filterKey,
        );

  const canonical = new URLSearchParams();
  if (cursor) canonical.set("cursor", encodeCursor(cursor));
  canonical.set("limit", String(limit));
  return { address, limit, cursor, filterKey, canonicalSearch: canonical.toString() };
}

export function parseDropIdsQuery(url: URL): { dropIds: number[]; canonicalSearch: string } {
  const dropIds = parseIdList(url, "drop_ids", DROP_ID_LIST_PARAMS, 96, parseDropId);
  return { dropIds, canonicalSearch: `drop_ids=${dropIds.join("%2C")}` };
}

export function parseDropDetailBatchQuery(url: URL): {
  dropIds: number[];
  canonicalSearch: string;
} {
  const dropIds = parseIdList(url, "ids", ID_LIST_PARAMS, 96, parseDropId);
  return { dropIds, canonicalSearch: `ids=${dropIds.join("%2C")}` };
}

export function parseCollectionBatchIdsQuery(url: URL): {
  collectionIds: number[];
  canonicalSearch: string;
} {
  const collectionIds = parseIdList(url, "ids", ID_LIST_PARAMS, 16, parseCollectionId);
  return { collectionIds, canonicalSearch: `ids=${collectionIds.join("%2C")}` };
}

export function parseCollectionsQuery(url: URL, snapshotId: string): CollectionsQuery {
  assertKnownParams(url.searchParams, COLLECTION_PARAMS);

  const rawQuery = optionalParam(url.searchParams, "q");
  const search = rawQuery === null ? null : normalizeSearch(rawQuery);
  const year = parseOptionalInteger(url.searchParams, "year", 1900, 2200);
  const type = parseEnum(url.searchParams, "type", COLLECTION_TYPES, "all");
  const limit = parseLimit(url.searchParams, 24);
  const filterKey = JSON.stringify({ q: search?.text ?? "", year, type, limit });

  const rawCursor = optionalParam(url.searchParams, "cursor");
  const cursor =
    rawCursor === null
      ? null
      : validateCollectionCursor(decodeCursor<CollectionCursor>(rawCursor), snapshotId, filterKey);

  const canonical = new URLSearchParams();
  if (search) canonical.set("q", search.text);
  if (year !== null) canonical.set("year", String(year));
  if (type !== "all") canonical.set("type", type);
  if (cursor) canonical.set("cursor", encodeCursor(cursor));
  canonical.set("limit", String(limit));

  return {
    q: search?.text ?? null,
    ftsQuery: search?.ftsQuery ?? null,
    year,
    type,
    limit,
    cursor,
    filterKey,
    canonicalSearch: canonical.toString(),
  };
}

export function parseCollectionItemsQuery(
  url: URL,
  rawCollectionId: string,
  snapshotId: string,
): CollectionItemsQuery {
  assertKnownParams(url.searchParams, COLLECTION_ITEM_PARAMS);
  const collectionId = parseCollectionId(rawCollectionId);
  const limit = parseLimit(url.searchParams, 24);
  const filterKey = JSON.stringify({ collectionId, limit });
  const rawCursor = optionalParam(url.searchParams, "cursor");
  const cursor =
    rawCursor === null
      ? null
      : validateCollectionItemCursor(
          decodeCursor<CollectionItemCursor>(rawCursor),
          snapshotId,
          filterKey,
        );

  const canonical = new URLSearchParams();
  if (cursor) canonical.set("cursor", encodeCursor(cursor));
  canonical.set("limit", String(limit));

  return { collectionId, limit, cursor, filterKey, canonicalSearch: canonical.toString() };
}

export function parseCollectionExportSegmentQuery(
  url: URL,
  rawCollectionId: string,
  segment: CollectionExportSegmentKind,
  snapshotId: string,
): CollectionExportSegmentQuery {
  assertKnownParams(url.searchParams, COLLECTION_ITEM_PARAMS);
  const collectionId = parseCollectionId(rawCollectionId);
  const limit = parseLimit(url.searchParams, 24);
  const filterKey = JSON.stringify({ collectionId, segment, limit });
  const rawCursor = optionalParam(url.searchParams, "cursor");
  const cursor =
    rawCursor === null
      ? null
      : validateCollectionExportSegmentCursor(
          decodeCursor<CollectionExportSegmentCursor>(rawCursor),
          snapshotId,
          filterKey,
          segment,
        );

  const canonical = new URLSearchParams();
  if (cursor) canonical.set("cursor", encodeCursor(cursor));
  canonical.set("limit", String(limit));
  return { collectionId, segment, limit, cursor, filterKey, canonicalSearch: canonical.toString() };
}

export function encodeCursor(
  value:
    | DropCursor
    | OwnerCursor
    | DropCollectorsCursor
    | PersonalHoldingsCursor
    | OwnedCollectionsCursor
    | CollectionCursor
    | CollectionItemCursor
    | CollectionExportSegmentCursor
    | MomentCursor
    | CapsuleCursor,
): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function validateMomentCursor(
  cursor: MomentCursor,
  snapshotId: string,
  filterKey: string,
): MomentCursor {
  if (
    !isObject(cursor) ||
    cursor.v !== 1 ||
    cursor.c !== "moments" ||
    cursor.s !== snapshotId ||
    cursor.f !== filterKey ||
    !Number.isInteger(cursor.p) ||
    cursor.p < 2 ||
    cursor.p > 10_000 ||
    typeof cursor.k !== "string" ||
    cursor.k.length === 0 ||
    cursor.k.length > 64 ||
    /[\u0000-\u001f]/.test(cursor.k) ||
    typeof cursor.i !== "string" ||
    !MOMENT_CURSOR_ID.test(cursor.i)
  ) {
    throw new ApiError(400, "Cursor does not belong to this Moments query or snapshot.");
  }
  return cursor;
}

function validateCapsuleCursor(
  cursor: CapsuleCursor,
  snapshotId: string,
  filterKey: string,
): CapsuleCursor {
  if (
    !isObject(cursor) ||
    cursor.v !== 1 ||
    cursor.c !== "capsules" ||
    cursor.s !== snapshotId ||
    cursor.f !== filterKey ||
    !Number.isInteger(cursor.p) ||
    cursor.p < 2 ||
    cursor.p > 10_000 ||
    typeof cursor.k !== "string" ||
    cursor.k.length === 0 ||
    cursor.k.length > 64 ||
    /[\u0000-\u001f]/.test(cursor.k) ||
    !Number.isSafeInteger(cursor.i) ||
    cursor.i <= 0
  ) {
    throw new ApiError(400, "Cursor does not belong to this Capsule owner export or release.");
  }
  return cursor;
}

function validateCollectionExportSegmentCursor(
  cursor: CollectionExportSegmentCursor,
  snapshotId: string,
  filterKey: string,
  segment: CollectionExportSegmentKind,
): CollectionExportSegmentCursor {
  const common =
    isObject(cursor) &&
    cursor.v === 1 &&
    cursor.c === "collection-export-segment" &&
    cursor.s === snapshotId &&
    cursor.f === filterKey &&
    cursor.g === segment &&
    Number.isInteger(cursor.p) &&
    cursor.p >= 2 &&
    cursor.p <= 10_000;
  let key = false;
  if (segment === "artist-drops") {
    key =
      typeof cursor.a === "string" &&
      ARTIST_ID.test(cursor.a) &&
      Number.isSafeInteger(cursor.d) &&
      Number(cursor.d) > 0 &&
      cursor.i === undefined;
  } else if (segment === "suggestions") {
    key =
      Number.isSafeInteger(cursor.i) &&
      Number(cursor.i) > 0 &&
      cursor.a === undefined &&
      cursor.d === undefined;
  } else {
    key =
      Number.isSafeInteger(cursor.d) &&
      Number(cursor.d) > 0 &&
      cursor.a === undefined &&
      cursor.i === undefined;
  }
  if (!common || !key) {
    throw new ApiError(400, "Cursor does not belong to this export segment or snapshot.");
  }
  return cursor;
}

function validateCollectionCursor(
  cursor: CollectionCursor,
  snapshotId: string,
  filterKey: string,
): CollectionCursor {
  if (
    !isObject(cursor) ||
    cursor.v !== 1 ||
    cursor.c !== "collections" ||
    cursor.s !== snapshotId ||
    cursor.f !== filterKey ||
    !Number.isInteger(cursor.p) ||
    cursor.p < 2 ||
    cursor.p > 10_000 ||
    typeof cursor.k !== "string" ||
    cursor.k.length === 0 ||
    cursor.k.length > 64 ||
    /[\u0000-\u001f]/.test(cursor.k) ||
    !Number.isSafeInteger(cursor.i) ||
    cursor.i <= 0
  ) {
    throw new ApiError(400, "Cursor does not belong to this collections query or snapshot.");
  }
  return cursor;
}

function validateCollectionItemCursor(
  cursor: CollectionItemCursor,
  snapshotId: string,
  filterKey: string,
): CollectionItemCursor {
  if (
    !isObject(cursor) ||
    cursor.v !== 1 ||
    cursor.c !== "collection-items" ||
    cursor.s !== snapshotId ||
    cursor.f !== filterKey ||
    !Number.isInteger(cursor.p) ||
    cursor.p < 2 ||
    cursor.p > 10_000 ||
    !Number.isSafeInteger(cursor.i) ||
    cursor.i <= 0
  ) {
    throw new ApiError(400, "Cursor does not belong to this collection or snapshot.");
  }
  return cursor;
}

function decodeCursor<T>(raw: string): T {
  if (raw.length < 8 || raw.length > 768 || !BASE64URL.test(raw)) {
    throw new ApiError(400, "Cursor is invalid.");
  }
  try {
    const padded = raw
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(raw.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as T;
  } catch {
    throw new ApiError(400, "Cursor is invalid.");
  }
}

function validateDropCursor(
  cursor: DropCursor,
  snapshotId: string,
  filterKey: string,
  sort: DropSort,
): DropCursor {
  const validCommon =
    isObject(cursor) &&
    cursor.v === 1 &&
    cursor.s === snapshotId &&
    cursor.f === filterKey &&
    Number.isInteger(cursor.p) &&
    cursor.p >= 2 &&
    cursor.p <= 10_000 &&
    Number.isSafeInteger(cursor.i) &&
    cursor.i > 0;
  const validKey =
    sort === "popular"
      ? Number.isSafeInteger(cursor.k) && Number(cursor.k) >= 0
      : typeof cursor.k === "string" &&
        cursor.k.length > 0 &&
        cursor.k.length <= 64 &&
        !/[\u0000-\u001f]/.test(cursor.k);
  if (!validCommon || !validKey) {
    throw new ApiError(400, "Cursor does not belong to this query or snapshot.");
  }
  return cursor;
}

function validateOwnerCursor(
  cursor: OwnerCursor,
  snapshotId: string,
  filterKey: string,
): OwnerCursor {
  if (
    !isObject(cursor) ||
    cursor.v !== 1 ||
    cursor.s !== snapshotId ||
    cursor.f !== filterKey ||
    !Number.isSafeInteger(cursor.p) ||
    cursor.p < 0 ||
    !SOURCE_UID.test(cursor.u)
  ) {
    throw new ApiError(400, "Cursor does not belong to this address or snapshot.");
  }
  return cursor;
}

function validateDropCollectorsCursor(
  cursor: DropCollectorsCursor,
  snapshotId: string,
  filterKey: string,
): DropCollectorsCursor {
  if (
    !isObject(cursor) ||
    cursor.v !== 1 ||
    cursor.c !== "drop-collectors" ||
    cursor.s !== snapshotId ||
    cursor.f !== filterKey ||
    !Number.isInteger(cursor.p) ||
    cursor.p < 2 ||
    cursor.p > 10_000 ||
    !Number.isSafeInteger(cursor.i) ||
    cursor.i <= 0 ||
    !SOURCE_UID.test(cursor.u) ||
    !ADDRESS.test(cursor.a) ||
    cursor.a !== cursor.a.toLowerCase()
  ) {
    throw new ApiError(400, "Cursor does not belong to this Drop or snapshot.");
  }
  return cursor;
}

function validatePersonalHoldingsCursor(
  cursor: PersonalHoldingsCursor,
  snapshotId: string,
  filterKey: string,
): PersonalHoldingsCursor {
  if (
    !isObject(cursor) ||
    cursor.v !== 1 ||
    cursor.c !== "personal-holdings" ||
    cursor.s !== snapshotId ||
    cursor.f !== filterKey ||
    !Number.isSafeInteger(cursor.p) ||
    cursor.p <= 0 ||
    !SOURCE_UID.test(cursor.u)
  ) {
    throw new ApiError(400, "Cursor does not belong to this holdings export or snapshot.");
  }
  return cursor;
}

function validateOwnedCollectionsCursor(
  cursor: OwnedCollectionsCursor,
  snapshotId: string,
  filterKey: string,
): OwnedCollectionsCursor {
  if (
    !isObject(cursor) ||
    cursor.v !== 1 ||
    cursor.c !== "owned-collections" ||
    cursor.s !== snapshotId ||
    cursor.f !== filterKey ||
    !Number.isInteger(cursor.p) ||
    cursor.p < 2 ||
    cursor.p > 10_000 ||
    typeof cursor.k !== "string" ||
    cursor.k.length === 0 ||
    cursor.k.length > 64 ||
    /[\u0000-\u001f]/.test(cursor.k) ||
    !Number.isSafeInteger(cursor.i) ||
    cursor.i <= 0
  ) {
    throw new ApiError(400, "Cursor does not belong to this owned Collections export or snapshot.");
  }
  return cursor;
}

function normalizeSearch(raw: string): { text: string; ftsQuery: string } {
  const text = raw.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
  if (text.length === 0 || text.length > 64) {
    throw new ApiError(400, "Search must contain between 1 and 64 characters.");
  }
  const terms = text.match(SEARCH_TERM) ?? [];
  if (
    terms.length === 0 ||
    terms.length > 5 ||
    terms.some((term) => term.length < 2 || term.length > 32)
  ) {
    throw new ApiError(400, "Search supports up to five words of 2 to 32 characters each.");
  }
  // Reconstructing the expression from letter/number-only terms prevents callers
  // from injecting FTS operators, leading wildcards, column filters, or NEAR scans.
  // Two-character terms use exact matching; broader prefixes start at three.
  const ftsQuery = terms.map((term) => `"${term}"${term.length >= 3 ? "*" : ""}`).join(" AND ");
  return { text, ftsQuery };
}

function assertKnownParams(params: URLSearchParams, allowed: ReadonlySet<string>): void {
  let unknownKey: string | null = null;
  params.forEach((_value, key) => {
    if (!allowed.has(key) && unknownKey === null) unknownKey = key;
  });
  if (unknownKey !== null) throw new ApiError(400, `Unknown query parameter: ${unknownKey}.`);
  for (const key of allowed) {
    if (params.getAll(key).length > 1)
      throw new ApiError(400, `Query parameter ${key} may only be provided once.`);
  }
}

function optionalParam(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  if (value === null) return null;
  if (value.length === 0) throw new ApiError(400, `Query parameter ${key} cannot be empty.`);
  return value;
}

function parseLimit(params: URLSearchParams, fallback: number): number {
  return parseBoundedLimit(params, fallback, 48);
}

function parseBoundedLimit(params: URLSearchParams, fallback: number, maximum: number): number {
  const raw = optionalParam(params, "limit");
  if (raw === null) return fallback;
  const digits = String(maximum).length;
  if (!new RegExp(`^\\d{1,${digits}}$`).test(raw)) {
    throw new ApiError(400, `Limit must be an integer from 1 to ${maximum}.`);
  }
  const value = Number(raw);
  if (value < 1 || value > maximum) {
    throw new ApiError(400, `Limit must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function parseIdList(
  url: URL,
  key: "drop_ids" | "ids",
  allowed: ReadonlySet<string>,
  maximum: number,
  parseId: (raw: string) => number,
): number[] {
  assertKnownParams(url.searchParams, allowed);
  const raw = optionalParam(url.searchParams, key);
  if (raw === null) throw new ApiError(400, `Query parameter ${key} is required.`);
  if (raw.length > maximum * 12) {
    throw new ApiError(400, `Query parameter ${key} supports at most ${maximum} IDs.`);
  }
  const parts = raw.split(",");
  if (parts.length > maximum) {
    throw new ApiError(400, `Query parameter ${key} supports at most ${maximum} IDs.`);
  }
  const unique = new Set<number>();
  for (const part of parts) {
    unique.add(parseId(part));
  }
  if (unique.size === 0 || unique.size > maximum) {
    throw new ApiError(400, `Query parameter ${key} supports between 1 and ${maximum} IDs.`);
  }
  return [...unique].sort((left, right) => left - right);
}

function parseOptionalInteger(
  params: URLSearchParams,
  key: string,
  minimum: number,
  maximum: number,
): number | null {
  const raw = optionalParam(params, key);
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw new ApiError(400, `Query parameter ${key} must be an integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ApiError(400, `Query parameter ${key} is outside the supported range.`);
  }
  return value;
}

function parseEnum<T extends string>(
  params: URLSearchParams,
  key: string,
  values: ReadonlySet<T>,
  fallback: T,
): T {
  const raw = optionalParam(params, key);
  if (raw === null) return fallback;
  if (!values.has(raw as T)) throw new ApiError(400, `Query parameter ${key} is invalid.`);
  return raw as T;
}

function parseOptionalEnum<T extends string>(
  params: URLSearchParams,
  key: string,
  values: ReadonlySet<T>,
): T | null {
  const raw = optionalParam(params, key);
  if (raw === null) return null;
  if (!values.has(raw as T)) throw new ApiError(400, `Query parameter ${key} is invalid.`);
  return raw as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
