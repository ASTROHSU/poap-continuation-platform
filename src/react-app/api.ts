import type {
  ArchiveMeta,
  CollectionExportPage,
  CollectionDetailResponse,
  CollectionExportManifest,
  CollectionItemsPage,
  CollectionsMeta,
  CollectionProfilesResponse,
  CollectionSummary,
  CollectionType,
  CapsuleOwnerExportPage,
  Drop,
  DropCollectorsPage,
  DropDetailBatchResponse,
  DropSort,
  EventType,
  HeldDropCollectionMembershipsResponse,
  MomentAuthorExportPage,
  MomentTaggedExportPage,
  MomentDetail,
  MomentMediaKind,
  MomentsMeta,
  MomentsPageResponse,
  OwnedCollectionsPage,
  OwnerPageResponse,
  PageResponse,
  PersonalExportManifest,
  PersonalHoldingsPage,
  AddressResolution,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  readonly retryAfterMs: number | null;

  constructor(status: number, message: string, retryAfterMs: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    signal,
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: unknown };
      if (typeof body.error === "string" && body.error) message = body.error;
    } catch {
      // Keep the status-based fallback when an edge error is not JSON.
    }
    throw new ApiError(
      response.status,
      message,
      parseRetryAfter(response.headers.get("Retry-After")),
    );
  }

  return (await response.json()) as T;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

export function getMeta(signal?: AbortSignal) {
  return requestJson<ArchiveMeta>("/api/meta", signal);
}

export function getCollectionsMeta(signal?: AbortSignal) {
  return requestJson<CollectionsMeta>("/api/collections/meta", signal);
}

export function getMomentsMeta(signal?: AbortSignal) {
  return requestJson<MomentsMeta>("/api/moments/meta", signal);
}

export function resolveAddressName(name: string, signal?: AbortSignal) {
  const params = new URLSearchParams({ name: name.trim() });
  return requestJson<AddressResolution>(`/api/resolve-address?${params}`, signal);
}

export interface DropQuery {
  q?: string;
  year?: number;
  type?: EventType;
  sort?: DropSort;
  cursor?: string | null;
  limit?: number;
}

export function getDrops(query: DropQuery, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q.trim());
  if (query.year) params.set("year", String(query.year));
  if (query.type && query.type !== "all") params.set("type", query.type);
  if (query.sort && query.sort !== "recent") params.set("sort", query.sort);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(query.limit ?? 48));
  return requestJson<PageResponse<Drop>>(`/api/drops?${params}`, signal);
}

export function getDrop(dropId: number, signal?: AbortSignal) {
  return requestJson<Drop>(`/api/drops/${dropId}`, signal);
}

export function getDropCollectors(dropId: number, cursor?: string | null, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: "48" });
  if (cursor) params.set("cursor", cursor);
  return requestJson<DropCollectorsPage>(`/api/drops/${dropId}/collectors?${params}`, signal);
}

export function getDropDetailsBatch(dropIds: number[], signal?: AbortSignal) {
  const params = new URLSearchParams({ ids: dropIds.join(",") });
  return requestJson<DropDetailBatchResponse>(`/api/drops/export/batch?${params}`, signal);
}

export function getOwner(address: string, cursor?: string | null, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: "48" });
  if (cursor) params.set("cursor", cursor);
  return requestJson<OwnerPageResponse>(
    `/api/owners/${encodeURIComponent(address)}?${params}`,
    signal,
  );
}

export interface CollectionsQuery {
  q?: string;
  year?: number;
  type?: CollectionType;
  cursor?: string | null;
  limit?: number;
}

export function getCollections(query: CollectionsQuery, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (query.q) params.set("q", query.q.trim());
  if (query.year) params.set("year", String(query.year));
  if (query.type && query.type !== "all") params.set("type", query.type);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(query.limit ?? 24));
  return requestJson<PageResponse<CollectionSummary>>(`/api/collections?${params}`, signal);
}

export function getCollection(collectionId: number, signal?: AbortSignal) {
  return requestJson<CollectionDetailResponse>(`/api/collections/${collectionId}`, signal);
}

export function getCollectionItems(
  collectionId: number,
  cursor?: string | null,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: "24" });
  if (cursor) params.set("cursor", cursor);
  return requestJson<CollectionItemsPage>(
    `/api/collections/${collectionId}/items?${params}`,
    signal,
  );
}

export function getCollectionExportManifest(collectionId: number, signal?: AbortSignal) {
  return requestJson<CollectionExportManifest>(`/api/collections/${collectionId}/export`, signal);
}

export interface MomentsQuery {
  author?: string;
  drop?: number;
  collection?: number;
  media?: MomentMediaKind;
  cursor?: string | null;
  limit?: number;
}

export function getMoments(query: MomentsQuery = {}, signal?: AbortSignal) {
  const params = new URLSearchParams();
  if (query.author) params.set("author", query.author.toLowerCase());
  if (query.drop) params.set("drop", String(query.drop));
  if (query.collection) params.set("collection", String(query.collection));
  if (query.media) params.set("media", query.media);
  if (query.cursor) params.set("cursor", query.cursor);
  params.set("limit", String(query.limit ?? 24));
  return requestJson<MomentsPageResponse>(`/api/moments?${params}`, signal);
}

export function getMoment(momentId: string, signal?: AbortSignal) {
  return requestJson<MomentDetail>(`/api/moments/${encodeURIComponent(momentId)}`, signal);
}

export function getMomentAuthorExport(
  address: string,
  cursor?: string | null,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: "48" });
  if (cursor) params.set("cursor", cursor);
  return requestJson<MomentAuthorExportPage>(
    `/api/moments/authors/${encodeURIComponent(address.toLowerCase())}/export?${params}`,
    signal,
  );
}

export function getMomentTaggedExport(
  address: string,
  cursor: string | null,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: "48" });
  if (cursor) params.set("cursor", cursor);
  return requestJson<MomentTaggedExportPage>(
    `/api/moments/tags/${encodeURIComponent(address.toLowerCase())}/export?${params}`,
    signal,
  );
}

export function getOwnedCapsulesExport(
  address: string,
  cursor: string | null,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: "48" });
  if (cursor) params.set("cursor", cursor);
  return requestJson<CapsuleOwnerExportPage>(
    `/api/capsules/owners/${encodeURIComponent(address.toLowerCase())}/export?${params}`,
    signal,
  );
}

export function getPersonalExportManifest(address: string, signal?: AbortSignal) {
  return requestJson<PersonalExportManifest>(
    `/api/owners/${encodeURIComponent(address.toLowerCase())}/export/manifest`,
    signal,
  );
}

export function getPersonalHoldingsPage(
  address: string,
  cursor?: string | null,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: "480" });
  if (cursor) params.set("cursor", cursor);
  return requestJson<PersonalHoldingsPage>(
    `/api/owners/${encodeURIComponent(address.toLowerCase())}/export/holdings?${params}`,
    signal,
  );
}

export function resolveHeldDropCollections(dropIds: number[], signal?: AbortSignal) {
  const params = new URLSearchParams({ drop_ids: dropIds.join(",") });
  return requestJson<HeldDropCollectionMembershipsResponse>(
    `/api/collections/resolve?${params}`,
    signal,
  );
}

export function getOwnedCollectionsExport(
  address: string,
  cursor?: string | null,
  signal?: AbortSignal,
) {
  const params = new URLSearchParams({ limit: "48" });
  if (cursor) params.set("cursor", cursor);
  return requestJson<OwnedCollectionsPage>(
    `/api/collections/owners/${encodeURIComponent(address.toLowerCase())}/export?${params}`,
    signal,
  );
}

export function getCollectionProfiles(collectionIds: number[], signal?: AbortSignal) {
  const params = new URLSearchParams({ ids: collectionIds.join(",") });
  return requestJson<CollectionProfilesResponse>(`/api/collections/export/batch?${params}`, signal);
}

export function getCollectionExportPath<T>(
  path: string,
  signal?: AbortSignal,
): Promise<CollectionExportPage<T>> {
  if (!/^\/api\/collections\/[1-9]\d{0,9}\/export\/[a-z-]+(?:\?.*)?$/.test(path)) {
    return Promise.reject(new Error("The collection export returned an unsafe segment path."));
  }
  return requestJson<CollectionExportPage<T>>(path, signal);
}
