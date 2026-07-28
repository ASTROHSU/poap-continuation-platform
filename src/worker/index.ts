import { Hono } from "hono";
import { withSnapshotCache } from "./cache";
import {
  fetchCollectionArtistDrops,
  fetchCollectionDropStats,
  fetchCollectionExportManifest,
  fetchCollectionItems,
  fetchCollectionMemberships,
  fetchCollectionsMeta,
  fetchCollectionProfile,
  fetchCollectionProfilesBatch,
  fetchCollectionSuggestions,
  fetchCollections,
  fetchOwnedCollectionCount,
  fetchOwnedCollectionsPage,
} from "./collections-repository";
import { ethereumRpcUrl, parseEnsNameQuery, resolveEnsAddress, withEnsCache } from "./ens";
import { createExportResponse, MAX_SYNC_EXPORT_RECORDS } from "./exports";
import {
  fetchAuthorMomentExportPage,
  fetchCollectionMoments,
  fetchDropMoments,
  fetchMoment,
  fetchMoments,
  fetchMomentsMeta,
  fetchOwnedCapsuleExportPage,
  fetchPersonalMomentRelationCounts,
  fetchTaggedMomentExportPage,
  momentsReleaseIdentity,
} from "./moments-repository";
import {
  fetchDrop,
  fetchDropCollectors,
  fetchDropDetailBatch,
  fetchDrops,
  fetchHoldingsMeta,
  fetchMeta,
  fetchOwner,
  fetchPersonalHoldingsPage,
  fetchOwnerTotal,
  fetchSnapshotAt,
} from "./repository";
import { fetchExactHoldingDropDetail } from "./holding-drops";
import { fetchExactCollectionDropDetail } from "./private-held-drops";
import type { AppEnv, Bindings, DropDetail } from "./types";
import {
  ApiError,
  assertNoQuery,
  normalizeAddress,
  parseCapsuleOwnerQuery,
  parseCollectionId,
  parseCollectionExportSegmentQuery,
  parseCollectionBatchIdsQuery,
  parseCollectionItemsQuery,
  parseCollectionsQuery,
  parseDropIdsQuery,
  parseDropId,
  parseDropCollectorsQuery,
  parseDropDetailBatchQuery,
  parseDropsQuery,
  parseMomentId,
  parseMomentPageQuery,
  parseMomentsQuery,
  parseOwnedCollectionsQuery,
  parseOwnerQuery,
  parsePersonalHoldingsQuery,
} from "./validation";

export const app = new Hono<AppEnv>();

// Collections gained a stricter public projection after the first archive API
// release. Keep its cache namespace separate so old edge objects cannot bypass
// privacy redaction while unrelated archive endpoints retain their stable key.
const COLLECTIONS_CACHE_SCHEMA = "collections-v3";
const MOMENTS_CACHE_SCHEMA = "moments-v2";
const MOMENTS_META_CACHE_SCHEMA = "public-meta-v2";
const OWNER_CACHE_SCHEMA = "owner-v6";
const PERSONAL_EXPORT_CACHE_SCHEMA = "personal-export-v5";
const DROP_DETAIL_CACHE_SCHEMA = "drop-detail-v7";
const DROP_DETAIL_BATCH_CACHE_SCHEMA = "drop-detail-batch-v1";
const DROP_COLLECTORS_CACHE_SCHEMA = "drop-collectors-v2";

export function collectionsApiVersion(
  bindings: Pick<Bindings, "API_CACHE_VERSION" | "COLLECTIONS_RELEASE_ID">,
): string {
  if (!bindings.COLLECTIONS_RELEASE_ID) {
    throw new ApiError(
      503,
      "The Collections release identifier is not configured.",
      "collections_release_unavailable",
    );
  }
  return `${bindings.API_CACHE_VERSION}.${COLLECTIONS_CACHE_SCHEMA}.${bindings.COLLECTIONS_RELEASE_ID}`;
}

export function momentsApiVersion(
  bindings: Pick<
    Bindings,
    | "API_CACHE_VERSION"
    | "MOMENTS_RELEASE_ID"
    | "MOMENTS_SNAPSHOT_ID"
    | "MOMENTS_SOURCE_DATABASE_SHA256"
    | "MOMENTS_BUILD_MANIFEST_SHA256"
  >,
): string {
  if (!bindings.MOMENTS_RELEASE_ID) {
    throw new ApiError(
      503,
      "The Moments release identifier is not configured.",
      "moments_release_unavailable",
    );
  }
  const identity = momentsReleaseIdentity(bindings);
  return [
    bindings.API_CACHE_VERSION,
    MOMENTS_CACHE_SCHEMA,
    bindings.MOMENTS_RELEASE_ID,
    identity.sourceDatabaseSha256,
    identity.buildManifestSha256,
  ].join(".");
}

function personalExportCacheIdentity(bindings: Bindings): {
  snapshotId: string;
  apiVersion: string;
} {
  return {
    snapshotId: [
      bindings.HOLDINGS_SNAPSHOT_ID,
      bindings.SNAPSHOT_ID,
      bindings.COLLECTIONS_SNAPSHOT_ID,
      bindings.MOMENTS_SNAPSHOT_ID,
    ].join("."),
    apiVersion: [
      bindings.API_CACHE_VERSION,
      PERSONAL_EXPORT_CACHE_SCHEMA,
      collectionsApiVersion(bindings),
      momentsApiVersion(bindings),
    ].join("."),
  };
}

app.use("/api/*", async (context, next) => {
  await next();
  context.header("Referrer-Policy", "no-referrer");
  context.header("X-Content-Type-Options", "nosniff");
  context.header("X-Robots-Tag", "noindex, nofollow");
  if (context.res.status >= 400) context.header("Cache-Control", "private, no-store");
});

app.get("/api/meta", async (context) => {
  const url = new URL(context.req.url);
  assertNoQuery(url);
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: "/api/meta",
      snapshotId: `${context.env.SNAPSHOT_ID}.${context.env.HOLDINGS_SNAPSHOT_ID}`,
      apiVersion: context.env.API_CACHE_VERSION,
      edgeTtlSeconds: 2_592_000,
      browserTtlSeconds: 300,
      executionCtx: context.executionCtx,
    },
    async () => {
      const catalogDb = context.env.CATALOG_DB.withSession("first-primary");
      const holdingsDb = context.env.HOLDINGS_DB.withSession("first-primary");
      const [catalog, holdings] = await Promise.all([
        fetchMeta(catalogDb, context.env.SNAPSHOT_ID),
        fetchHoldingsMeta(holdingsDb, context.env.HOLDINGS_SNAPSHOT_ID),
      ]);
      return context.json({
        ...catalog,
        holdingsSnapshotId: holdings.snapshotId,
        holdingsSnapshotAt: holdings.snapshotAt,
        counts: {
          ...catalog.counts,
          tokens: holdings.tokens,
          owners: holdings.owners,
        },
      });
    },
  );
});

app.get("/api/collections/meta", async (context) => {
  assertNoQuery(new URL(context.req.url));
  const apiVersion = collectionsApiVersion(context.env);
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: "/api/collections/meta",
      snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      apiVersion,
      edgeTtlSeconds: 2_592_000,
      browserTtlSeconds: 300,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.COLLECTIONS_DB.withSession("first-primary");
      return context.json(
        await fetchCollectionsMeta(
          db,
          context.env.COLLECTIONS_SNAPSHOT_ID,
          context.env.COLLECTIONS_RELEASE_ID,
        ),
      );
    },
  );
});

app.get("/api/moments/meta", async (context) => {
  assertNoQuery(new URL(context.req.url));
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: "/api/moments/meta",
      snapshotId: context.env.MOMENTS_SNAPSHOT_ID,
      apiVersion: `${momentsApiVersion(context.env)}.${MOMENTS_META_CACHE_SCHEMA}`,
      edgeTtlSeconds: 2_592_000,
      browserTtlSeconds: 300,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.MOMENTS_DB.withSession("first-primary");
      return context.json(await fetchMomentsMeta(db, momentsReleaseIdentity(context.env)));
    },
  );
});

app.get("/api/resolve-address", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const name = parseEnsNameQuery(new URL(context.req.url));
  const rpcUrl = ethereumRpcUrl(context.env.ETHEREUM_RPC_URL);
  return withEnsCache(
    {
      requestUrl: context.req.url,
      name,
      apiVersion: context.env.API_CACHE_VERSION,
      executionCtx: context.executionCtx,
    },
    async () => {
      const address = await resolveEnsAddress(name, rpcUrl);
      if (!address) {
        return context.json(
          { error: "ENS name did not resolve to an address.", code: "ens_not_found" },
          404,
        );
      }
      return context.json({ name, address });
    },
  );
});

app.get("/api/moments", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseMomentsQuery(new URL(context.req.url), context.env.MOMENTS_SNAPSHOT_ID);
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: "/api/moments",
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.MOMENTS_SNAPSHOT_ID,
      apiVersion: momentsApiVersion(context.env),
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.MOMENTS_DB.withSession("first-primary");
      return context.json(
        await fetchMoments(
          db,
          query,
          momentsReleaseIdentity(context.env),
          context.env.MEDIA_BASE_URL,
        ),
      );
    },
  );
});

app.get("/api/moments/authors/:address/export", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const author = normalizeAddress(context.req.param("address"));
  const apiVersion = momentsApiVersion(context.env);
  const query = parseMomentPageQuery(
    new URL(context.req.url),
    context.env.MOMENTS_SNAPSHOT_ID,
    `author-export:${author}:${apiVersion}`,
    48,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/moments/authors/${author}/export`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.MOMENTS_SNAPSHOT_ID,
      apiVersion,
      edgeTtlSeconds: 86_400,
      browserTtlSeconds: 0,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.MOMENTS_DB.withSession("first-primary");
      const release = momentsReleaseIdentity(context.env);
      const page = await fetchAuthorMomentExportPage(
        db,
        author,
        query,
        release,
        context.env.MEDIA_BASE_URL,
      );
      return context.json({
        ...page,
        releaseId: context.env.MOMENTS_RELEASE_ID,
        sourceDatabaseSha256: release.sourceDatabaseSha256,
        buildManifestSha256: release.buildManifestSha256,
      });
    },
  );
});

app.get("/api/moments/tags/:address/export", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const address = normalizeAddress(context.req.param("address"));
  const apiVersion = momentsApiVersion(context.env);
  const query = parseMomentPageQuery(
    new URL(context.req.url),
    context.env.MOMENTS_SNAPSHOT_ID,
    `tagged-export:${address}:${apiVersion}`,
    48,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/moments/tags/${address}/export`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.MOMENTS_SNAPSHOT_ID,
      apiVersion,
      edgeTtlSeconds: 86_400,
      browserTtlSeconds: 0,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.MOMENTS_DB.withSession("first-primary");
      const release = momentsReleaseIdentity(context.env);
      const page = await fetchTaggedMomentExportPage(
        db,
        address,
        query,
        release,
        context.env.MEDIA_BASE_URL,
      );
      return context.json({
        ...page,
        releaseId: context.env.MOMENTS_RELEASE_ID,
        sourceDatabaseSha256: release.sourceDatabaseSha256,
        buildManifestSha256: release.buildManifestSha256,
      });
    },
  );
});

app.get("/api/capsules/owners/:address/export", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const apiVersion = momentsApiVersion(context.env);
  const query = parseCapsuleOwnerQuery(
    new URL(context.req.url),
    context.req.param("address"),
    context.env.MOMENTS_SNAPSHOT_ID,
    apiVersion,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/capsules/owners/${query.address}/export`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.MOMENTS_SNAPSHOT_ID,
      apiVersion,
      edgeTtlSeconds: 86_400,
      browserTtlSeconds: 0,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.MOMENTS_DB.withSession("first-primary");
      const release = momentsReleaseIdentity(context.env);
      const page = await fetchOwnedCapsuleExportPage(
        db,
        query,
        release,
        context.env.MEDIA_BASE_URL,
      );
      return context.json({
        ...page,
        releaseId: context.env.MOMENTS_RELEASE_ID,
        sourceDatabaseSha256: release.sourceDatabaseSha256,
        buildManifestSha256: release.buildManifestSha256,
      });
    },
  );
});

app.get("/api/moments/:id", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  assertNoQuery(new URL(context.req.url));
  const momentId = parseMomentId(context.req.param("id"));
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/moments/${momentId}`,
      snapshotId: context.env.MOMENTS_SNAPSHOT_ID,
      apiVersion: momentsApiVersion(context.env),
      edgeTtlSeconds: 2_592_000,
      browserTtlSeconds: 300,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.MOMENTS_DB.withSession("first-primary");
      const moment = await fetchMoment(
        db,
        momentId,
        momentsReleaseIdentity(context.env),
        context.env.MEDIA_BASE_URL,
      );
      if (!moment) throw momentNotFound();
      return context.json(moment);
    },
  );
});

app.get("/api/drops/:id/moments", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const dropId = parseDropId(context.req.param("id"));
  const query = parseMomentPageQuery(
    new URL(context.req.url),
    context.env.MOMENTS_SNAPSHOT_ID,
    `drop:${dropId}`,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/drops/${dropId}/moments`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.MOMENTS_SNAPSHOT_ID,
      apiVersion: momentsApiVersion(context.env),
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.MOMENTS_DB.withSession("first-primary");
      return context.json(
        await fetchDropMoments(
          db,
          dropId,
          query,
          momentsReleaseIdentity(context.env),
          context.env.MEDIA_BASE_URL,
        ),
      );
    },
  );
});

app.get("/api/collections/:id/moments", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const collectionId = parseCollectionId(context.req.param("id"));
  const query = parseMomentPageQuery(
    new URL(context.req.url),
    context.env.MOMENTS_SNAPSHOT_ID,
    `collection:${collectionId}`,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/collections/${collectionId}/moments`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.MOMENTS_SNAPSHOT_ID,
      apiVersion: momentsApiVersion(context.env),
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.MOMENTS_DB.withSession("first-primary");
      return context.json(
        await fetchCollectionMoments(
          db,
          collectionId,
          query,
          momentsReleaseIdentity(context.env),
          context.env.MEDIA_BASE_URL,
        ),
      );
    },
  );
});

app.get("/api/drops", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseDropsQuery(new URL(context.req.url), context.env.SNAPSHOT_ID);
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: "/api/drops",
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.SNAPSHOT_ID,
      apiVersion: context.env.API_CACHE_VERSION,
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.CATALOG_DB.withSession("first-primary");
      return context.json(
        await fetchDrops(db, query, context.env.SNAPSHOT_ID, context.env.MEDIA_BASE_URL),
      );
    },
  );
});

app.get("/api/drops/export/batch", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseDropDetailBatchQuery(new URL(context.req.url));
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: "/api/drops/export/batch",
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.SNAPSHOT_ID,
      apiVersion: `${context.env.API_CACHE_VERSION}.${DROP_DETAIL_BATCH_CACHE_SCHEMA}`,
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.CATALOG_DB.withSession("first-primary");
      return context.json(
        await fetchDropDetailBatch(
          db,
          query.dropIds,
          context.env.MEDIA_BASE_URL,
          context.env.SNAPSHOT_ID,
        ),
      );
    },
  );
});

app.get("/api/drops/:id/collectors", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseDropCollectorsQuery(
    new URL(context.req.url),
    context.req.param("id"),
    context.env.HOLDINGS_SNAPSHOT_ID,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/drops/${query.dropId}/collectors`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: `${context.env.SNAPSHOT_ID}.${context.env.HOLDINGS_SNAPSHOT_ID}`,
      apiVersion: [
        context.env.API_CACHE_VERSION,
        DROP_COLLECTORS_CACHE_SCHEMA,
        collectionsApiVersion(context.env),
      ].join("."),
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      await resolveExactDrop(context.env, query.dropId);
      const holdingsDb = context.env.HOLDINGS_DB.withSession("first-primary");
      return context.json(
        await fetchDropCollectors(holdingsDb, query, context.env.HOLDINGS_SNAPSHOT_ID),
      );
    },
  );
});

app.get("/api/drops/:id", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const url = new URL(context.req.url);
  assertNoQuery(url);
  const dropId = parseDropId(context.req.param("id"));
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/drops/${dropId}`,
      snapshotId: `${context.env.SNAPSHOT_ID}.${context.env.HOLDINGS_SNAPSHOT_ID}`,
      apiVersion: `${collectionsApiVersion(context.env)}.${DROP_DETAIL_CACHE_SCHEMA}`,
      edgeTtlSeconds: 2_592_000,
      browserTtlSeconds: 300,
      executionCtx: context.executionCtx,
    },
    async () => {
      return context.json(await resolveExactDrop(context.env, dropId));
    },
  );
});

app.get("/api/collections", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseCollectionsQuery(
    new URL(context.req.url),
    context.env.COLLECTIONS_SNAPSHOT_ID,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: "/api/collections",
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      apiVersion: collectionsApiVersion(context.env),
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.COLLECTIONS_DB.withSession("first-primary");
      return context.json(
        await fetchCollections(
          db,
          query,
          context.env.COLLECTIONS_SNAPSHOT_ID,
          context.env.MEDIA_BASE_URL,
        ),
      );
    },
  );
});

app.get("/api/collections/:id/items", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseCollectionItemsQuery(
    new URL(context.req.url),
    context.req.param("id"),
    context.env.COLLECTIONS_SNAPSHOT_ID,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/collections/${query.collectionId}/items`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      apiVersion: collectionsApiVersion(context.env),
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.COLLECTIONS_DB.withSession("first-primary");
      const page = await fetchCollectionItems(
        db,
        query,
        context.env.COLLECTIONS_SNAPSHOT_ID,
        context.env.MEDIA_BASE_URL,
        context.env.SNAPSHOT_ID,
      );
      if (!page) throw collectionNotFound();
      return context.json(page);
    },
  );
});

app.get("/api/collections/:id/export", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const url = new URL(context.req.url);
  assertNoQuery(url);
  const collectionId = parseCollectionId(context.req.param("id"));
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/collections/${collectionId}/export`,
      snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      apiVersion: collectionsApiVersion(context.env),
      edgeTtlSeconds: 2_592_000,
      browserTtlSeconds: 300,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.COLLECTIONS_DB.withSession("first-primary");
      const manifest = await fetchCollectionExportManifest(
        db,
        collectionId,
        context.env.COLLECTIONS_SNAPSHOT_ID,
      );
      if (!manifest) throw collectionNotFound();
      return context.json({
        ...manifest,
        releaseId: context.env.COLLECTIONS_RELEASE_ID,
      });
    },
  );
});

app.get("/api/collections/:id/export/metadata", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const url = new URL(context.req.url);
  assertNoQuery(url);
  const collectionId = parseCollectionId(context.req.param("id"));
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/collections/${collectionId}/export/metadata`,
      snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      apiVersion: collectionsApiVersion(context.env),
      edgeTtlSeconds: 2_592_000,
      browserTtlSeconds: 300,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.COLLECTIONS_DB.withSession("first-primary");
      const profile = await fetchCollectionProfile(
        db,
        collectionId,
        context.env.COLLECTIONS_SNAPSHOT_ID,
        context.env.MEDIA_BASE_URL,
      );
      if (!profile) throw collectionNotFound();
      return context.json({
        schemaVersion: "poapin-collection-export-v1",
        segment: "metadata",
        releaseId: context.env.COLLECTIONS_RELEASE_ID,
        ...profile,
      });
    },
  );
});

app.get("/api/collections/:id/export/items", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseCollectionItemsQuery(
    new URL(context.req.url),
    context.req.param("id"),
    context.env.COLLECTIONS_SNAPSHOT_ID,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/collections/${query.collectionId}/export/items`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      apiVersion: collectionsApiVersion(context.env),
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.COLLECTIONS_DB.withSession("first-primary");
      const page = await fetchCollectionItems(
        db,
        query,
        context.env.COLLECTIONS_SNAPSHOT_ID,
        context.env.MEDIA_BASE_URL,
        context.env.SNAPSHOT_ID,
      );
      if (!page) throw collectionNotFound();
      return context.json({
        schemaVersion: "poapin-collection-export-v1",
        snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
        releaseId: context.env.COLLECTIONS_RELEASE_ID,
        segment: "items",
        ...page,
        nextPath: collectionExportNextPath(
          query.collectionId,
          "items",
          query.limit,
          page.nextCursor,
        ),
      });
    },
  );
});

app.get("/api/collections/:id/export/artist-drops", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseCollectionExportSegmentQuery(
    new URL(context.req.url),
    context.req.param("id"),
    "artist-drops",
    context.env.COLLECTIONS_SNAPSHOT_ID,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/collections/${query.collectionId}/export/artist-drops`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      apiVersion: collectionsApiVersion(context.env),
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.COLLECTIONS_DB.withSession("first-primary");
      const page = await fetchCollectionArtistDrops(
        db,
        query,
        context.env.COLLECTIONS_SNAPSHOT_ID,
        context.env.MEDIA_BASE_URL,
        context.env.SNAPSHOT_ID,
      );
      if (!page) throw collectionNotFound();
      return context.json({
        schemaVersion: "poapin-collection-export-v1",
        snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
        releaseId: context.env.COLLECTIONS_RELEASE_ID,
        segment: "artist-drops",
        ...page,
        nextPath: collectionExportNextPath(
          query.collectionId,
          "artist-drops",
          query.limit,
          page.nextCursor,
        ),
      });
    },
  );
});

app.get("/api/collections/:id/export/suggestions", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseCollectionExportSegmentQuery(
    new URL(context.req.url),
    context.req.param("id"),
    "suggestions",
    context.env.COLLECTIONS_SNAPSHOT_ID,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/collections/${query.collectionId}/export/suggestions`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      apiVersion: collectionsApiVersion(context.env),
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.COLLECTIONS_DB.withSession("first-primary");
      const page = await fetchCollectionSuggestions(
        db,
        query,
        context.env.COLLECTIONS_SNAPSHOT_ID,
        context.env.MEDIA_BASE_URL,
        context.env.SNAPSHOT_ID,
      );
      if (!page) throw collectionNotFound();
      return context.json({
        schemaVersion: "poapin-collection-export-v1",
        snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
        releaseId: context.env.COLLECTIONS_RELEASE_ID,
        segment: "suggestions",
        ...page,
        nextPath: collectionExportNextPath(
          query.collectionId,
          "suggestions",
          query.limit,
          page.nextCursor,
        ),
      });
    },
  );
});

app.get("/api/collections/:id/export/drop-stats", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseCollectionExportSegmentQuery(
    new URL(context.req.url),
    context.req.param("id"),
    "drop-stats",
    context.env.COLLECTIONS_SNAPSHOT_ID,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/collections/${query.collectionId}/export/drop-stats`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      apiVersion: collectionsApiVersion(context.env),
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.COLLECTIONS_DB.withSession("first-primary");
      const page = await fetchCollectionDropStats(db, query, context.env.COLLECTIONS_SNAPSHOT_ID);
      if (!page) throw collectionNotFound();
      return context.json({
        schemaVersion: "poapin-collection-export-v1",
        snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
        releaseId: context.env.COLLECTIONS_RELEASE_ID,
        segment: "drop-stats",
        ...page,
        nextPath: collectionExportNextPath(
          query.collectionId,
          "drop-stats",
          query.limit,
          page.nextCursor,
        ),
      });
    },
  );
});

app.get("/api/collections/resolve", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseDropIdsQuery(new URL(context.req.url));
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: "/api/collections/resolve",
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      apiVersion: collectionsApiVersion(context.env),
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.COLLECTIONS_DB.withSession("first-primary");
      const memberships = await fetchCollectionMemberships(
        db,
        query.dropIds,
        context.env.COLLECTIONS_SNAPSHOT_ID,
        context.env.MEDIA_BASE_URL,
      );
      return context.json({
        ...memberships,
        releaseId: context.env.COLLECTIONS_RELEASE_ID,
      });
    },
  );
});

app.get("/api/collections/export/batch", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseCollectionBatchIdsQuery(new URL(context.req.url));
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: "/api/collections/export/batch",
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      apiVersion: collectionsApiVersion(context.env),
      edgeTtlSeconds: 604_800,
      browserTtlSeconds: 60,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.COLLECTIONS_DB.withSession("first-primary");
      const profiles = await fetchCollectionProfilesBatch(
        db,
        query.collectionIds,
        context.env.COLLECTIONS_SNAPSHOT_ID,
        context.env.MEDIA_BASE_URL,
      );
      return context.json({
        ...profiles,
        releaseId: context.env.COLLECTIONS_RELEASE_ID,
      });
    },
  );
});

app.get("/api/collections/owners/:address/export", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseOwnedCollectionsQuery(
    new URL(context.req.url),
    context.req.param("address"),
    context.env.COLLECTIONS_SNAPSHOT_ID,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/collections/owners/${query.address}/export`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      apiVersion: collectionsApiVersion(context.env),
      edgeTtlSeconds: 86_400,
      browserTtlSeconds: 0,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.COLLECTIONS_DB.withSession("first-primary");
      const page = await fetchOwnedCollectionsPage(
        db,
        query,
        context.env.COLLECTIONS_SNAPSHOT_ID,
        context.env.MEDIA_BASE_URL,
      );
      return context.json({
        ...page,
        releaseId: context.env.COLLECTIONS_RELEASE_ID,
      });
    },
  );
});

app.get("/api/collections/:id", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const url = new URL(context.req.url);
  assertNoQuery(url);
  const collectionId = parseCollectionId(context.req.param("id"));
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/collections/${collectionId}`,
      snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      apiVersion: collectionsApiVersion(context.env),
      edgeTtlSeconds: 2_592_000,
      browserTtlSeconds: 300,
      executionCtx: context.executionCtx,
    },
    async () => {
      const db = context.env.COLLECTIONS_DB.withSession("first-primary");
      const profile = await fetchCollectionProfile(
        db,
        collectionId,
        context.env.COLLECTIONS_SNAPSHOT_ID,
        context.env.MEDIA_BASE_URL,
      );
      if (!profile) throw collectionNotFound();
      const itemsUrl = new URL(context.req.url);
      itemsUrl.searchParams.set("limit", "24");
      const itemsQuery = parseCollectionItemsQuery(
        itemsUrl,
        String(collectionId),
        context.env.COLLECTIONS_SNAPSHOT_ID,
      );
      const items = await fetchCollectionItems(
        db,
        itemsQuery,
        context.env.COLLECTIONS_SNAPSHOT_ID,
        context.env.MEDIA_BASE_URL,
        context.env.SNAPSHOT_ID,
      );
      if (!items) throw collectionNotFound();
      return context.json({ ...profile, items });
    },
  );
});

app.get("/api/owners/:address/export/manifest", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  assertNoQuery(new URL(context.req.url));
  const address = normalizeAddress(context.req.param("address"));
  const cacheIdentity = personalExportCacheIdentity(context.env);
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/owners/${address}/export/manifest`,
      snapshotId: cacheIdentity.snapshotId,
      apiVersion: cacheIdentity.apiVersion,
      edgeTtlSeconds: 86_400,
      browserTtlSeconds: 0,
      executionCtx: context.executionCtx,
    },
    async () => {
      const holdingsDb = context.env.HOLDINGS_DB.withSession("first-primary");
      const collectionsDb = context.env.COLLECTIONS_DB.withSession("first-primary");
      const momentsDb = context.env.MOMENTS_DB.withSession("first-primary");
      const [holdings, ownedCollections, momentRelations] = await Promise.all([
        fetchOwnerTotal(holdingsDb, address, context.env.HOLDINGS_SNAPSHOT_ID),
        fetchOwnedCollectionCount(collectionsDb, address, context.env.COLLECTIONS_SNAPSHOT_ID),
        fetchPersonalMomentRelationCounts(momentsDb, address, momentsReleaseIdentity(context.env)),
      ]);
      return context.json({
        schemaVersion: "poapin-personal-export-v1",
        address,
        snapshots: {
          catalog: context.env.SNAPSHOT_ID,
          holdings: context.env.HOLDINGS_SNAPSHOT_ID,
          collections: context.env.COLLECTIONS_SNAPSHOT_ID,
          moments: context.env.MOMENTS_SNAPSHOT_ID,
        },
        sources: {
          catalog: {
            snapshotId: context.env.SNAPSHOT_ID,
          },
          holdings: {
            snapshotId: context.env.HOLDINGS_SNAPSHOT_ID,
          },
          collections: {
            snapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
            releaseId: context.env.COLLECTIONS_RELEASE_ID,
          },
          moments: {
            snapshotId: context.env.MOMENTS_SNAPSHOT_ID,
            releaseId: context.env.MOMENTS_RELEASE_ID,
            sourceDatabaseSha256: context.env.MOMENTS_SOURCE_DATABASE_SHA256,
            buildManifestSha256: context.env.MOMENTS_BUILD_MANIFEST_SHA256,
          },
        },
        counts: {
          holdings,
          authoredMoments: momentRelations.authoredMoments,
          taggedMoments: momentRelations.taggedMoments,
          ownedCollections,
          ownedCapsules: momentRelations.ownedCapsules,
        },
        segments: {
          holdings: {
            path: `/api/owners/${address}/export/holdings?limit=480`,
            pageSize: 480,
          },
          ownedCollections: {
            path: `/api/collections/owners/${address}/export?limit=48`,
            pageSize: 48,
          },
          moments: {
            path: `/api/moments/authors/${address}/export?limit=48`,
            pageSize: 48,
          },
          taggedMoments: {
            path: `/api/moments/tags/${address}/export?limit=48`,
            pageSize: 48,
          },
          ownedCapsules: {
            path: `/api/capsules/owners/${address}/export?limit=48`,
            pageSize: 48,
          },
        },
      });
    },
  );
});

app.get("/api/owners/:address/export/holdings", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parsePersonalHoldingsQuery(
    new URL(context.req.url),
    context.req.param("address"),
    context.env.HOLDINGS_SNAPSHOT_ID,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/owners/${query.address}/export/holdings`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: `${context.env.HOLDINGS_SNAPSHOT_ID}.${context.env.SNAPSHOT_ID}`,
      apiVersion: [
        context.env.API_CACHE_VERSION,
        PERSONAL_EXPORT_CACHE_SCHEMA,
        "holdings",
        collectionsApiVersion(context.env),
      ].join("."),
      edgeTtlSeconds: 86_400,
      browserTtlSeconds: 0,
      executionCtx: context.executionCtx,
    },
    async () => {
      const holdingsDb = context.env.HOLDINGS_DB.withSession("first-primary");
      const catalogDb = context.env.CATALOG_DB.withSession("first-primary");
      const collectionsDb = context.env.COLLECTIONS_DB.withSession("first-primary");
      return context.json(
        await fetchPersonalHoldingsPage(
          holdingsDb,
          catalogDb,
          collectionsDb,
          query,
          context.env.HOLDINGS_SNAPSHOT_ID,
          context.env.SNAPSHOT_ID,
          context.env.COLLECTIONS_SNAPSHOT_ID,
          context.env.COLLECTIONS_RELEASE_ID,
          context.env.MEDIA_BASE_URL,
        ),
      );
    },
  );
});

app.get("/api/owners/:address", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const query = parseOwnerQuery(
    new URL(context.req.url),
    context.req.param("address"),
    context.env.HOLDINGS_SNAPSHOT_ID,
  );
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/owners/${query.address}`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: `${context.env.HOLDINGS_SNAPSHOT_ID}.${context.env.SNAPSHOT_ID}`,
      apiVersion: [
        context.env.API_CACHE_VERSION,
        OWNER_CACHE_SCHEMA,
        collectionsApiVersion(context.env),
      ].join("."),
      edgeTtlSeconds: 86_400,
      browserTtlSeconds: 0,
      executionCtx: context.executionCtx,
    },
    async () => {
      const holdingsDb = context.env.HOLDINGS_DB.withSession("first-primary");
      const catalogDb = context.env.CATALOG_DB.withSession("first-primary");
      const collectionsDb = context.env.COLLECTIONS_DB.withSession("first-primary");
      return context.json(
        await fetchOwner(
          holdingsDb,
          catalogDb,
          collectionsDb,
          query,
          context.env.HOLDINGS_SNAPSHOT_ID,
          context.env.SNAPSHOT_ID,
          context.env.COLLECTIONS_SNAPSHOT_ID,
          context.env.MEDIA_BASE_URL,
        ),
      );
    },
  );
});

for (const format of ["csv", "json"] as const) {
  app.get(`/api/owners/:address/export.${format}`, async (context) => {
    const limited = await enforceRateLimit(context.env.EXPORT_RATE_LIMITER, context.req.raw);
    if (limited) return limited;
    assertNoQuery(new URL(context.req.url));
    const address = normalizeAddress(context.req.param("address"));
    const holdingsDb = context.env.HOLDINGS_DB.withSession("first-primary");
    const catalogDb = context.env.CATALOG_DB.withSession("first-primary");
    const collectionsDb = context.env.COLLECTIONS_DB.withSession("first-primary");
    const [total, snapshotAt] = await Promise.all([
      fetchOwnerTotal(holdingsDb, address, context.env.HOLDINGS_SNAPSHOT_ID),
      fetchSnapshotAt(holdingsDb, context.env.HOLDINGS_SNAPSHOT_ID),
    ]);
    if (total > MAX_SYNC_EXPORT_RECORDS) {
      throw new ApiError(
        413,
        `This address has ${total} records; synchronous exports are limited to ${MAX_SYNC_EXPORT_RECORDS}.`,
        "export_too_large",
      );
    }
    const response = createExportResponse({
      format,
      address,
      total,
      snapshotId: context.env.HOLDINGS_SNAPSHOT_ID,
      catalogSnapshotId: context.env.SNAPSHOT_ID,
      snapshotAt,
      holdingsDb,
      catalogDb,
      collectionsDb,
      collectionsSnapshotId: context.env.COLLECTIONS_SNAPSHOT_ID,
      mediaBaseUrl: context.env.MEDIA_BASE_URL,
    });
    response.headers.set("X-Archive-Snapshot", context.env.HOLDINGS_SNAPSHOT_ID);
    response.headers.set("X-Archive-API-Version", context.env.API_CACHE_VERSION);
    return response;
  });
}

app.notFound((context) => context.json({ error: "Not found.", code: "not_found" }, 404));

app.onError((error, context) => {
  if (error instanceof ApiError) {
    return context.json({ error: error.message, code: error.code }, error.status);
  }
  console.error("Archive API request failed", { name: error.name });
  return context.json(
    { error: "The archive is temporarily unavailable.", code: "archive_unavailable" },
    503,
  );
});

async function enforceRateLimit(limiter: RateLimit, request: Request): Promise<Response | null> {
  const actor = request.headers.get("CF-Connecting-IP") ?? "local-or-unknown";
  const { success } = await limiter.limit({ key: actor });
  if (success) return null;
  return Response.json(
    { error: "Too many requests. Try again in a minute.", code: "rate_limited" },
    {
      status: 429,
      headers: {
        "Cache-Control": "private, no-store",
        "Retry-After": "60",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

function collectionNotFound(): ApiError {
  return new ApiError(404, "Collection was not found in this snapshot.", "collection_not_found");
}

function momentNotFound(): ApiError {
  return new ApiError(404, "Moment was not found in this snapshot.", "moment_not_found");
}

async function resolveExactDrop(bindings: Bindings, dropId: number): Promise<DropDetail> {
  const catalogDb = bindings.CATALOG_DB.withSession("first-primary");
  const catalogDrop = await fetchDrop(
    catalogDb,
    dropId,
    bindings.MEDIA_BASE_URL,
    bindings.SNAPSHOT_ID,
  );
  let presentationDrop = catalogDrop;
  if (!catalogDrop || catalogDrop.isPrivate) {
    const collectionsDb = bindings.COLLECTIONS_DB.withSession("first-primary");
    const supplemental = await fetchExactCollectionDropDetail(
      collectionsDb,
      dropId,
      bindings.MEDIA_BASE_URL,
      bindings.SNAPSHOT_ID,
      bindings.COLLECTIONS_SNAPSHOT_ID,
    );
    if (supplemental.state === "available") presentationDrop = supplemental.drop;
  }

  const holdingsDb = bindings.HOLDINGS_DB.withSession("first-primary");
  const holdingDrop = await fetchExactHoldingDropDetail(
    holdingsDb,
    dropId,
    bindings.HOLDINGS_SNAPSHOT_ID,
    bindings.MEDIA_BASE_URL,
    bindings.SNAPSHOT_ID,
    bindings.COLLECTIONS_SNAPSHOT_ID,
  );
  const drop =
    holdingDrop.state === "available"
      ? mergeHoldingDrop(holdingDrop.drop, presentationDrop)
      : presentationDrop;
  if (!drop) throw new ApiError(404, "Drop was not found in this snapshot.", "drop_not_found");
  return drop;
}

function mergeHoldingDrop(holding: DropDetail, presentation: DropDetail | null): DropDetail {
  if (!presentation) return holding;
  const artwork = presentation.hasArtwork ? presentation : holding;
  return {
    ...presentation,
    ...holding,
    imageUrl: artwork.imageUrl,
    hasArtwork: artwork.hasArtwork,
    reservationsTotal: presentation.reservationsTotal,
    reservationsMinted: presentation.reservationsMinted,
    reservationsUnminted: presentation.reservationsUnminted,
    featuredOn: presentation.featuredOn,
    momentsUploaded: presentation.momentsUploaded,
  };
}

function collectionExportNextPath(
  collectionId: number,
  segment: "items" | "artist-drops" | "suggestions" | "drop-stats",
  limit: number,
  cursor: string | null,
): string | null {
  if (!cursor) return null;
  const search = new URLSearchParams({ cursor, limit: String(limit) });
  return `/api/collections/${collectionId}/export/${segment}?${search}`;
}

export default app;
