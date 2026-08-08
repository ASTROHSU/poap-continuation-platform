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
import { fetchChainIndexerStatus, runLiveChainIndexer } from "./chain-indexer";
import { fetchLegacyPoapHoldings } from "./legacy-poap";
import {
  assertSameOrigin,
  decryptEmail,
  EMAIL_SESSION_TTL_SECONDS,
  encryptEmail,
  expiredSessionCookie,
  hmacEmail,
  MAGIC_LINK_TTL_SECONDS,
  normalizeEmail,
  randomToken,
  readSessionToken,
  sessionCookie,
  sha256Hex,
} from "./email-auth";
import { mayExposeDevelopmentMagicLink, sendMagicLinkEmail } from "./email";
import {
  asLiveClaimRecord,
  beginEmailReservationRelay,
  bindEmailReservationWallet,
  consumeChallengeAndCreateSession,
  createEmailSession,
  createEmailChallenge,
  fetchEmailReservation,
  fetchEmailReservations,
  fetchSessionEmailHmac,
  fetchValidEmailChallenge,
  hasAvailableEmailClaimSlot,
  markEmailReservationMinted,
  pruneExpiredEmailAuthArtifacts,
  recordEmailReservationRelayTransaction,
  refreshEmailReservationAuthorization,
  releaseEmailReservationRelay,
  reserveClaimForVerifiedEmail,
  revokeEmailSession,
} from "./email-reservations";
import {
  fetchEmailWallet,
  fetchMagicEmailIdentityByAddress,
  reconcileEmailReservationsForWallet,
  recordMagicEmailIdentity,
} from "./email-wallets";
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
  beginLiveClaimRelay,
  fetchLiveClaim,
  fetchLiveEvent,
  fetchLiveHoldings,
  markLiveClaimMinted,
  recordLiveClaimRelayTransaction,
  refreshLiveClaimAuthorization,
  reserveLiveClaim,
  releaseLiveClaimRelay,
} from "./live";
import { relayMintAuthorization, signMintAuthorization, verifyMintTransaction } from "./minting";
import {
  ensureVerifiedEmailWallet,
  publicWalletProvisioningConfig,
  walletProvisioningMode,
} from "./wallet-provisioning";
import { transactionExplorerUrl } from "../shared/live-chains";
import { publicMagicEmbeddedWalletConfig, verifyMagicIdentity } from "./magic-auth";
import {
  mirrorArchiveMediaBatch,
  parseArchiveMediaMirrorRequest,
  PUBLIC_ARCHIVE_MEDIA_ORIGIN,
} from "./archive-media-mirror";
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
const LEGACY_POAP_CACHE_SCHEMA = "legacy-poap-v6";

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

app.get("/api/app-config", (context) => {
  assertNoQuery(new URL(context.req.url));
  return context.json({
    mode: context.env.APP_MODE ?? "combined",
    walletProvisioning: publicWalletProvisioningConfig(context.env),
    embeddedWallet: publicMagicEmbeddedWalletConfig(context.env),
  });
});

/**
 * A deliberately non-public migration control plane. It is used only by the
 * local mirror runner while moving the verified supplemental artwork release
 * into this project's R2 bucket. The endpoint is unavailable until its secret
 * has been configured in the deployed Worker.
 */
app.post("/api/admin/archive-media/mirror", async (context) => {
  const secret = context.env.ARCHIVE_MEDIA_MIRROR_SECRET;
  if (!isAuthorizedArchiveMediaMirrorRequest(context.req.raw, secret)) {
    throw new ApiError(401, "Archive media mirror authorization is required.", "mirror_unauthorized");
  }
  const body = await parseJsonObject(context.req.raw, "Archive media mirror request");
  const { afterDropId, limit, untilDropId } = parseArchiveMediaMirrorRequest(body);
  const result = await mirrorArchiveMediaBatch(context.env, afterDropId, limit, untilDropId);
  return context.json(result, 200, { "Cache-Control": "private, no-store" });
});

app.post("/api/live/magic/session", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  assertSameOrigin(context.req.raw);
  const body = await parseMagicSessionBody(context.req.raw);
  const identity = await verifyMagicIdentity(context.env, body);
  const emailHmac = await hmacEmail(identity.email, context.env.EMAIL_LOOKUP_SECRET);
  let recordedIdentity = null;
  try {
    recordedIdentity = await recordMagicEmailIdentity(context.env.LIVE_DB, {
      emailHmac,
      address: identity.address,
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
  }
  if (!recordedIdentity) {
    throw new ApiError(
      409,
      "這個 Email 錢包與既有紀錄不一致，請聯絡主辦單位。",
      "magic_identity_conflict",
    );
  }
  await reconcileEmailReservationsForWallet(context.env.LIVE_DB, {
    emailHmac,
    address: identity.address,
  });
  const sessionToken = randomToken();
  await createEmailSession(context.env.LIVE_DB, {
    sessionHash: await sha256Hex(sessionToken),
    emailHmac,
    expiresAt: Math.floor(Date.now() / 1000) + EMAIL_SESSION_TTL_SECONDS,
  });
  return context.json({ provider: "magic", address: identity.address }, 200, {
    "Cache-Control": "private, no-store",
    "Set-Cookie": sessionCookie(sessionToken, context.req.raw),
  });
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

app.get("/media/live/events/:slug/:filename", async (context) => {
  assertNoQuery(new URL(context.req.url));
  const slug = normalizeLiveSlug(context.req.param("slug"));
  const filename = normalizeLiveMediaFilename(context.req.param("filename"));
  const object = await context.env.ARCHIVE_BUCKET.get(`live/events/${slug}/${filename}`);
  if (!object) {
    return context.json({ error: "Media not found.", code: "media_not_found" }, 404, {
      "Cache-Control": "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
    });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set(
    "Cache-Control",
    headers.get("Cache-Control") ??
      (filename === "metadata.json"
        ? "public, max-age=300"
        : "public, max-age=31536000, immutable"),
  );
  return new Response(object.body, { headers });
});

app.get("/media/archive/snapshots/:snapshotId/artwork/:filename", async (context) => {
  assertNoQuery(new URL(context.req.url));
  const snapshotId = context.req.param("snapshotId");
  const filename = context.req.param("filename");
  if (snapshotId !== context.env.SNAPSHOT_ID || !/^[1-9][0-9]*\.webp$/.test(filename)) {
    throw new ApiError(404, "Archive artwork not found.", "media_not_found");
  }
  const object = await context.env.ARCHIVE_MEDIA_BUCKET.get(
    `snapshots/${snapshotId}/artwork/${filename}`,
  );
  if (!object) {
    return context.json({ error: "Media not found.", code: "media_not_found" }, 404, {
      "Cache-Control": "public, max-age=60",
      "X-Content-Type-Options": "nosniff",
    });
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", "image/webp");
  headers.set("ETag", object.httpEtag);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
});

app.get(
  "/media/archive/snapshots/:snapshotId/:namespace/drop-artwork/sha256/:prefix/:filename",
  async (context) => {
    assertNoQuery(new URL(context.req.url));
    const snapshotId = context.req.param("snapshotId");
    const namespace = context.req.param("namespace");
    const prefix = context.req.param("prefix");
    const filename = context.req.param("filename");
    const match = /^([0-9a-f]{64})\.(png|jpg|gif|webp|avif|heic)$/.exec(filename);
    const activeSnapshot =
      (namespace === "collections" && snapshotId === context.env.COLLECTIONS_SNAPSHOT_ID) ||
      (namespace === "holdings" && snapshotId === context.env.HOLDINGS_SNAPSHOT_ID);
    if (!activeSnapshot || !match || prefix !== match[1].slice(0, 2)) {
      throw new ApiError(404, "Archive artwork not found.", "media_not_found");
    }

    const segments = [
      "snapshots",
      snapshotId,
      namespace,
      "drop-artwork",
      "sha256",
      prefix,
      filename,
    ];
    const expectedContentType = new Map([
      ["png", "image/png"],
      ["jpg", "image/jpeg"],
      ["gif", "image/gif"],
      ["webp", "image/webp"],
      ["avif", "image/avif"],
      ["heic", "image/heic"],
    ]).get(match[2]);
    if (!expectedContentType) throw new ApiError(404, "Archive artwork not found.", "media_not_found");

    const objectKey = segments.join("/");
    const mirrored = await context.env.ARCHIVE_MEDIA_BUCKET.get(objectKey);
    if (mirrored) {
      if (
        mirrored.customMetadata?.sha256 !== match[1] ||
        mirrored.httpMetadata?.contentType !== expectedContentType
      ) {
        throw new ApiError(502, "Archive artwork response was invalid.", "media_invalid");
      }
      const headers = new Headers({
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Type": expectedContentType,
        "Cross-Origin-Resource-Policy": "cross-origin",
        "ETag": mirrored.httpEtag,
        "X-Content-Type-Options": "nosniff",
      });
      return new Response(mirrored.body, { headers });
    }

    // Keep the public archive functional while the one-time mirror runs. Once
    // the runner verifies all rows, this fallback is removed in its own deploy.
    const upstreamUrl = `${PUBLIC_ARCHIVE_MEDIA_ORIGIN}/${segments
      .map((segment) => encodeURIComponent(segment))
      .join("/")}`;
    const upstream = await fetch(upstreamUrl);
    if (!upstream.ok || !upstream.body) {
      return context.json({ error: "Media not found.", code: "media_not_found" }, 404, {
        "Cache-Control": "public, max-age=60",
        "X-Content-Type-Options": "nosniff",
      });
    }
    if (upstream.headers.get("Content-Type")?.split(";", 1)[0] !== expectedContentType) {
      throw new ApiError(502, "Archive artwork response was invalid.", "media_invalid");
    }

    const headers = new Headers({
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": expectedContentType,
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
    const etag = upstream.headers.get("ETag");
    const lastModified = upstream.headers.get("Last-Modified");
    if (etag) headers.set("ETag", etag);
    if (lastModified) headers.set("Last-Modified", lastModified);
    return new Response(upstream.body, { headers });
  },
);

app.get("/api/live/events/:slug", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  assertNoQuery(new URL(context.req.url));
  const slug = normalizeLiveSlug(context.req.param("slug"));
  const event = await fetchLiveEvent(context.env.LIVE_DB.withSession("first-primary"), slug);
  if (!event) {
    throw new ApiError(404, "This claim event is unavailable.", "live_event_not_found");
  }
  return context.json(event, 200, { "Cache-Control": "public, max-age=30" });
});

app.post("/api/live/events/:slug/email-reservations", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const slug = normalizeLiveSlug(context.req.param("slug"));
  const event = await fetchLiveEvent(context.env.LIVE_DB.withSession("first-primary"), slug);
  if (!event) {
    throw new ApiError(404, "This claim event is unavailable.", "live_event_not_found");
  }
  const body = await parseEmailReservationBody(context.req.raw);
  const email = normalizeEmail(body.email);
  const accessCodeHash = await sha256Hex(body.code);
  const nowIso = new Date().toISOString();
  if (event.status !== "published" || event.claimOpensAt > nowIso || event.claimClosesAt < nowIso) {
    throw new ApiError(409, "This claim event is not accepting reservations.", "live_event_closed");
  }
  const available = await hasAvailableEmailClaimSlot(
    context.env.LIVE_DB.withSession("first-primary"),
    event.eventId,
    accessCodeHash,
  );
  if (!available) {
    throw new ApiError(
      409,
      "This claim link is invalid, expired, or already used.",
      "live_claim_unavailable",
    );
  }
  const challenge = await prepareEmailChallenge(context.env, {
    purpose: "reserve",
    eventId: event.eventId,
    accessCodeHash,
    email,
  });
  const magicLink = `${validatedPublicAppUrl(context.env.PUBLIC_APP_URL)}/email/verify?token=${encodeURIComponent(challenge.token)}`;
  await sendMagicLinkEmail(context.env, {
    challengeId: challenge.challengeId,
    email,
    magicLink,
    purpose: "reserve",
    eventTitle: event.title,
  });
  return context.json(
    {
      status: "verification_sent",
      ...(mayExposeDevelopmentMagicLink(context.env) ? { debugMagicLink: magicLink } : {}),
    },
    202,
    { "Cache-Control": "private, no-store" },
  );
});

app.post("/api/live/email/login", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const body = await parseEmailBody(context.req.raw);
  const email = normalizeEmail(body.email);
  const challenge = await prepareEmailChallenge(context.env, {
    purpose: "login",
    eventId: null,
    accessCodeHash: null,
    email,
  });
  const magicLink = `${validatedPublicAppUrl(context.env.PUBLIC_APP_URL)}/email/verify?token=${encodeURIComponent(challenge.token)}`;
  await sendMagicLinkEmail(context.env, {
    challengeId: challenge.challengeId,
    email,
    magicLink,
    purpose: "login",
  });
  return context.json(
    {
      status: "verification_sent",
      ...(mayExposeDevelopmentMagicLink(context.env) ? { debugMagicLink: magicLink } : {}),
    },
    202,
    { "Cache-Control": "private, no-store" },
  );
});

app.post("/api/live/email/verify", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const body = await parseMagicLinkBody(context.req.raw);
  const tokenHash = await sha256Hex(body.token);
  const now = Math.floor(Date.now() / 1000);
  const challenge = await fetchValidEmailChallenge(
    context.env.LIVE_DB.withSession("first-primary"),
    tokenHash,
    now,
  );
  if (!challenge) {
    throw new ApiError(
      409,
      "This verification link is invalid, expired, or already used.",
      "email_challenge_unavailable",
    );
  }

  let reservation = null;
  if (challenge.purpose === "reserve") {
    try {
      reservation = await reserveClaimForVerifiedEmail(context.env.LIVE_DB, challenge);
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      reservation =
        (
          await fetchEmailReservations(
            context.env.LIVE_DB.withSession("first-primary"),
            challenge.emailHmac,
          )
        ).find((item) => item.event.eventId === challenge.eventId) ?? null;
    }
    if (!reservation) {
      throw new ApiError(
        409,
        "The claim slot is no longer available. Please request a new link.",
        "live_claim_unavailable",
      );
    }
  }

  const sessionToken = randomToken();
  const sessionHash = await sha256Hex(sessionToken);
  const consumed = await consumeChallengeAndCreateSession(context.env.LIVE_DB, {
    challengeId: challenge.challengeId,
    tokenHash,
    sessionHash,
    emailHmac: challenge.emailHmac,
    sessionExpiresAt: now + EMAIL_SESSION_TTL_SECONDS,
    now,
  });
  if (!consumed) {
    throw new ApiError(
      409,
      "This verification link is invalid, expired, or already used.",
      "email_challenge_unavailable",
    );
  }
  let emailWallet = null;
  if (walletProvisioningMode(context.env) === "magic-pregen") {
    try {
      const verifiedEmail = normalizeEmail(
        await decryptEmail(
          challenge.emailCiphertext,
          challenge.emailIv,
          context.env.EMAIL_DATA_KEY,
        ),
      );
      emailWallet = await ensureVerifiedEmailWallet(context.env, {
        email: verifiedEmail,
        emailHmac: challenge.emailHmac,
      });
    } catch (error) {
      // Email verification and reservations must remain available when the
      // optional wallet provider is degraded or misconfigured.
      console.error("Verified Email wallet could not be prepared", error);
    }
  }
  return context.json(
    {
      purpose: challenge.purpose,
      reservation: reservation ? publicEmailReservation(reservation) : null,
      wallet: publicEmailWallet(emailWallet),
      redirectTo: "/email/collection",
    },
    200,
    {
      "Cache-Control": "private, no-store",
      "Set-Cookie": sessionCookie(sessionToken, context.req.raw),
    },
  );
});

app.get("/api/live/email/reservations", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  assertNoQuery(new URL(context.req.url));
  const emailHmac = await requireEmailSession(context.env, context.req.raw);
  const reservations = await fetchEmailReservations(
    context.env.LIVE_DB.withSession("first-primary"),
    emailHmac,
  );
  const wallet = await fetchEmailWallet(
    context.env.LIVE_DB.withSession("first-primary"),
    emailHmac,
  );
  return context.json(
    {
      items: reservations.map(publicEmailReservation),
      walletConfig: publicWalletProvisioningConfig(context.env),
      wallet: publicEmailWallet(wallet),
    },
    200,
    { "Cache-Control": "private, no-store" },
  );
});

app.get("/api/live/email/wallet", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  assertNoQuery(new URL(context.req.url));
  const emailHmac = await requireEmailSession(context.env, context.req.raw);
  const wallet = await fetchEmailWallet(
    context.env.LIVE_DB.withSession("first-primary"),
    emailHmac,
  );
  return context.json(
    {
      config: publicWalletProvisioningConfig(context.env),
      wallet: publicEmailWallet(wallet),
    },
    200,
    { "Cache-Control": "private, no-store" },
  );
});

app.post("/api/live/email/wallet", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  assertSameOrigin(context.req.raw);
  if (walletProvisioningMode(context.env) !== "magic-pregen") {
    throw new ApiError(
      409,
      "Email wallet provisioning is not enabled.",
      "wallet_provider_disabled",
    );
  }
  const sessionEmailHmac = await requireEmailSession(context.env, context.req.raw);
  const body = await parseEmailBody(context.req.raw);
  const email = normalizeEmail(body.email);
  const submittedEmailHmac = await hmacEmail(email, context.env.EMAIL_LOOKUP_SECRET);
  if (submittedEmailHmac !== sessionEmailHmac) {
    throw new ApiError(403, "This Email does not match the verified session.", "email_mismatch");
  }
  const wallet = await ensureVerifiedEmailWallet(context.env, {
    email,
    emailHmac: sessionEmailHmac,
  });
  return context.json(
    { config: publicWalletProvisioningConfig(context.env), wallet: publicEmailWallet(wallet) },
    wallet?.status === "ready" ? 200 : 202,
    { "Cache-Control": "private, no-store" },
  );
});

app.post("/api/live/email/reservations/:reservationId/bind", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const body = await parseAddressBody(context.req.raw);
  assertSameOrigin(context.req.raw);
  const emailHmac = await requireEmailSession(context.env, context.req.raw);
  const reservationId = normalizeReservationId(context.req.param("reservationId"));
  const address = normalizeAddress(body.address) as `0x${string}`;
  const deadline = Math.floor(Date.now() / 1000) + 15 * 60;
  let reservation = await fetchEmailReservation(
    context.env.LIVE_DB.withSession("first-primary"),
    reservationId,
    emailHmac,
  );
  if (!reservation) {
    throw new ApiError(404, "Email reservation was not found.", "email_reservation_not_found");
  }
  if (reservation.boundAddress && reservation.boundAddress !== address) {
    throw new ApiError(
      409,
      "This reservation is already bound to another wallet.",
      "email_reservation_wallet_locked",
    );
  }
  try {
    if (!reservation.boundAddress || !reservation.mintNonce) {
      reservation = await bindEmailReservationWallet(context.env.LIVE_DB, {
        reservationId,
        emailHmac,
        address,
        mintNonce: randomBytes32(),
        deadline,
      });
    } else if (
      reservation.mintedTxHash === null &&
      (reservation.mintAuthorizationDeadline ?? 0) < deadline - 60
    ) {
      reservation = await refreshEmailReservationAuthorization(
        context.env.LIVE_DB,
        reservationId,
        emailHmac,
        deadline,
      );
    }
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    throw new ApiError(409, "這個錢包已經領取過這場活動。", "live_claim_duplicate_wallet");
  }
  if (!reservation) {
    throw new ApiError(409, "The wallet could not be bound.", "email_reservation_unavailable");
  }
  const claim = asLiveClaimRecord(reservation);
  const mintAuthorization =
    claim && reservation.mintedTxHash === null && reservation.relayTxHash === null
      ? await signMintAuthorization(reservation.event, claim, context.env.MINT_SIGNER_PRIVATE_KEY)
      : null;
  return context.json(
    {
      ...publicEmailReservation(reservation),
      mintAuthorization,
    },
    200,
    { "Cache-Control": "private, no-store" },
  );
});

app.post("/api/live/email/reservations/:reservationId/relay", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  assertSameOrigin(context.req.raw);
  const body = await parseAddressBody(context.req.raw);
  const emailHmac = await requireEmailSession(context.env, context.req.raw);
  const reservationId = normalizeReservationId(context.req.param("reservationId"));
  const address = normalizeAddress(body.address) as `0x${string}`;
  let reservation = await fetchEmailReservation(
    context.env.LIVE_DB.withSession("first-primary"),
    reservationId,
    emailHmac,
  );
  if (!reservation || reservation.boundAddress !== address) {
    throw new ApiError(
      409,
      "No matching email reservation exists.",
      "email_reservation_unavailable",
    );
  }
  if (!reservation.event.contractAddress || reservation.event.tokenId === null) {
    throw new ApiError(409, "Onchain minting is not configured.", "live_mint_not_configured");
  }

  const existingHash = reservation.mintedTxHash ?? reservation.relayTxHash;
  if (existingHash) {
    return context.json(
      relayResponse(reservation.event, address, existingHash),
      reservation.mintedTxHash ? 200 : 202,
      { "Cache-Control": "private, no-store" },
    );
  }

  const deadline = Math.floor(Date.now() / 1000) + 15 * 60;
  if ((reservation.mintAuthorizationDeadline ?? 0) < deadline - 60) {
    reservation = await refreshEmailReservationAuthorization(
      context.env.LIVE_DB,
      reservationId,
      emailHmac,
      deadline,
    );
  }
  const claim = reservation ? asLiveClaimRecord(reservation) : null;
  if (!reservation || !claim) {
    throw new ApiError(409, "The wallet must be bound before minting.", "live_claim_unavailable");
  }
  const authorization = await signMintAuthorization(
    reservation.event,
    claim,
    context.env.MINT_SIGNER_PRIVATE_KEY,
  );
  if (!authorization) {
    throw new ApiError(409, "Onchain minting is not configured.", "live_mint_not_configured");
  }

  const startedAt = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const acquired = await beginEmailReservationRelay(
    context.env.LIVE_DB,
    reservationId,
    emailHmac,
    address,
    startedAt,
    staleBefore,
  );
  if (!acquired) {
    const current = await fetchEmailReservation(
      context.env.LIVE_DB.withSession("first-primary"),
      reservationId,
      emailHmac,
    );
    const currentHash = current?.mintedTxHash ?? current?.relayTxHash;
    if (currentHash) {
      return context.json(
        relayResponse(reservation.event, address, currentHash),
        current?.mintedTxHash ? 200 : 202,
        { "Cache-Control": "private, no-store" },
      );
    }
    throw new ApiError(409, "The sponsored mint is already being submitted.", "live_relay_pending");
  }

  let transactionHash: `0x${string}`;
  try {
    transactionHash = await relayMintAuthorization(
      liveRpcUrl(context.env, reservation.event.chainId),
      reservation.event,
      authorization,
      context.env.MINT_RELAYER_PRIVATE_KEY,
    );
  } catch (error) {
    await releaseEmailReservationRelay(
      context.env.LIVE_DB,
      reservationId,
      emailHmac,
      address,
      startedAt,
    );
    console.error("Sponsored email-reservation mint failed", error);
    throw new ApiError(502, "The sponsored mint could not be submitted.", "live_relay_failed");
  }

  try {
    const recorded = await recordEmailReservationRelayTransaction(
      context.env.LIVE_DB,
      reservationId,
      emailHmac,
      address,
      startedAt,
      transactionHash,
    );
    if (!recorded) {
      console.error("Sponsored mint was submitted but its hash could not be recorded", {
        reservationId,
        transactionHash,
      });
    }
  } catch (error) {
    console.error("Sponsored mint was submitted but its hash could not be recorded", {
      reservationId,
      transactionHash,
      error,
    });
  }
  return context.json(relayResponse(reservation.event, address, transactionHash), 202, {
    "Cache-Control": "private, no-store",
  });
});

app.post("/api/live/email/reservations/:reservationId/mints", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const body = await parseEmailMintBody(context.req.raw);
  assertSameOrigin(context.req.raw);
  const emailHmac = await requireEmailSession(context.env, context.req.raw);
  const reservationId = normalizeReservationId(context.req.param("reservationId"));
  const address = normalizeAddress(body.address) as `0x${string}`;
  const reservation = await fetchEmailReservation(
    context.env.LIVE_DB.withSession("first-primary"),
    reservationId,
    emailHmac,
  );
  if (!reservation || reservation.boundAddress !== address) {
    throw new ApiError(
      409,
      "No matching email reservation exists.",
      "email_reservation_unavailable",
    );
  }
  if (reservation.mintedTxHash && reservation.mintedTxHash !== body.transactionHash) {
    throw new ApiError(
      409,
      "This reservation was confirmed by another transaction.",
      "live_mint_conflict",
    );
  }
  const verification = await verifyMintTransaction(
    liveRpcUrl(context.env, reservation.event.chainId),
    body.transactionHash,
    reservation.event,
    address,
  );
  if (verification === "pending") {
    throw new ApiError(409, "The mint transaction is still pending.", "live_mint_pending");
  }
  if (verification === "invalid") {
    throw new ApiError(
      409,
      "The transaction does not contain the expected badge mint.",
      "live_mint_invalid",
    );
  }
  const minted = await markEmailReservationMinted(
    context.env.LIVE_DB,
    reservationId,
    emailHmac,
    address,
    body.transactionHash,
  );
  if (!minted) {
    throw new ApiError(409, "The mint could not be recorded.", "live_mint_conflict");
  }
  return context.json(
    {
      eventId: reservation.event.eventId,
      slug: reservation.event.slug,
      address,
      mintStatus: "minted",
      mintedAt: minted.mintedAt,
      transactionHash: body.transactionHash,
      explorerUrl: transactionExplorerUrl(reservation.event.chainId, body.transactionHash),
    },
    200,
    { "Cache-Control": "private, no-store" },
  );
});

app.post("/api/live/email/logout", async (context) => {
  assertSameOrigin(context.req.raw);
  const token = readSessionToken(context.req.raw);
  if (token) await revokeEmailSession(context.env.LIVE_DB, await sha256Hex(token));
  return context.json({ status: "signed_out" }, 200, {
    "Cache-Control": "private, no-store",
    "Set-Cookie": expiredSessionCookie(context.req.raw),
  });
});

app.post("/api/live/events/:slug/claims", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const slug = normalizeLiveSlug(context.req.param("slug"));
  const event = await fetchLiveEvent(context.env.LIVE_DB.withSession("first-primary"), slug);
  if (!event) {
    throw new ApiError(404, "This claim event is unavailable.", "live_event_not_found");
  }

  const body = await parseClaimBody(context.req.raw);
  const address = normalizeAddress(body.address) as `0x${string}`;
  const codeHash = await sha256Hex(body.code);
  const authorizationDeadline = Math.floor(Date.now() / 1000) + 15 * 60;
  let claim = await fetchLiveClaim(
    context.env.LIVE_DB.withSession("first-primary"),
    event.eventId,
    codeHash,
    address,
  );
  const wasReserved = claim !== null;
  if (!claim) {
    const now = new Date().toISOString();
    if (event.status === "closed") {
      throw new ApiError(409, "This claim event is closed.", "live_event_closed");
    }
    if (event.claimOpensAt > now) {
      throw new ApiError(409, "This claim event is not open yet.", "live_event_not_open");
    }
    if (event.claimClosesAt < now) {
      throw new ApiError(409, "This claim link has expired.", "live_event_expired");
    }
    claim = await reserveLiveClaim(
      context.env.LIVE_DB,
      event.eventId,
      codeHash,
      address,
      randomBytes32(),
      authorizationDeadline,
    );
  } else if (
    claim.mintedTxHash === null &&
    claim.mintAuthorizationDeadline < authorizationDeadline - 60
  ) {
    claim = await refreshLiveClaimAuthorization(
      context.env.LIVE_DB,
      event.eventId,
      codeHash,
      address,
      authorizationDeadline,
    );
  }
  if (!claim) {
    throw new ApiError(
      409,
      "This claim link is invalid, expired, or already used.",
      "live_claim_unavailable",
    );
  }
  const magicIdentity = await fetchMagicEmailIdentityByAddress(
    context.env.LIVE_DB.withSession("first-primary"),
    address,
  );
  if (magicIdentity) {
    await reconcileEmailReservationsForWallet(context.env.LIVE_DB, {
      emailHmac: magicIdentity.emailHmac,
      address,
    });
  }
  const mintAuthorization =
    claim.mintedTxHash === null
      ? await signMintAuthorization(event, claim, context.env.MINT_SIGNER_PRIVATE_KEY)
      : null;
  return context.json(
    {
      eventId: event.eventId,
      slug,
      address,
      claimedAt: claim.claimedAt,
      mintStatus: claim.mintedTxHash ? "minted" : mintAuthorization ? "ready" : "reserved",
      mintedTxHash: claim.mintedTxHash,
      mintAuthorization,
    },
    wasReserved ? 200 : 201,
    { "Cache-Control": "private, no-store" },
  );
});

app.post("/api/live/events/:slug/relay", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  assertSameOrigin(context.req.raw);
  const slug = normalizeLiveSlug(context.req.param("slug"));
  const event = await fetchLiveEvent(context.env.LIVE_DB.withSession("first-primary"), slug);
  if (!event) {
    throw new ApiError(404, "This mint event is unavailable.", "live_event_not_found");
  }
  if (!event.contractAddress || event.tokenId === null) {
    throw new ApiError(409, "Onchain minting is not configured.", "live_mint_not_configured");
  }

  const body = await parseClaimBody(context.req.raw);
  const address = normalizeAddress(body.address) as `0x${string}`;
  const codeHash = await sha256Hex(body.code);
  let claim = await fetchLiveClaim(
    context.env.LIVE_DB.withSession("first-primary"),
    event.eventId,
    codeHash,
    address,
  );
  if (!claim) {
    throw new ApiError(409, "No matching claim reservation exists.", "live_claim_unavailable");
  }

  const existingHash = claim.mintedTxHash ?? claim.relayTxHash;
  if (existingHash) {
    return context.json(
      relayResponse(event, address, existingHash),
      claim.mintedTxHash ? 200 : 202,
      {
        "Cache-Control": "private, no-store",
      },
    );
  }

  const deadline = Math.floor(Date.now() / 1000) + 15 * 60;
  if (claim.mintAuthorizationDeadline < deadline - 60) {
    claim = await refreshLiveClaimAuthorization(
      context.env.LIVE_DB,
      event.eventId,
      codeHash,
      address,
      deadline,
    );
  }
  if (!claim) {
    throw new ApiError(409, "The mint authorization is unavailable.", "live_claim_unavailable");
  }
  const authorization = await signMintAuthorization(
    event,
    claim,
    context.env.MINT_SIGNER_PRIVATE_KEY,
  );
  if (!authorization) {
    throw new ApiError(409, "Onchain minting is not configured.", "live_mint_not_configured");
  }

  const startedAt = new Date().toISOString();
  const staleBefore = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  const acquired = await beginLiveClaimRelay(
    context.env.LIVE_DB,
    event.eventId,
    codeHash,
    address,
    startedAt,
    staleBefore,
  );
  if (!acquired) {
    const current = await fetchLiveClaim(
      context.env.LIVE_DB.withSession("first-primary"),
      event.eventId,
      codeHash,
      address,
    );
    const currentHash = current?.mintedTxHash ?? current?.relayTxHash;
    if (currentHash) {
      return context.json(
        relayResponse(event, address, currentHash),
        current?.mintedTxHash ? 200 : 202,
        {
          "Cache-Control": "private, no-store",
        },
      );
    }
    throw new ApiError(409, "The sponsored mint is already being submitted.", "live_relay_pending");
  }

  let transactionHash: `0x${string}`;
  try {
    transactionHash = await relayMintAuthorization(
      liveRpcUrl(context.env, event.chainId),
      event,
      authorization,
      context.env.MINT_RELAYER_PRIVATE_KEY,
    );
  } catch (error) {
    await releaseLiveClaimRelay(context.env.LIVE_DB, event.eventId, codeHash, address, startedAt);
    console.error("Sponsored mint failed", error);
    throw new ApiError(502, "The sponsored mint could not be submitted.", "live_relay_failed");
  }

  try {
    const recorded = await recordLiveClaimRelayTransaction(
      context.env.LIVE_DB,
      event.eventId,
      codeHash,
      address,
      startedAt,
      transactionHash,
    );
    if (!recorded) {
      console.error("Sponsored mint was submitted but its hash could not be recorded", {
        eventId: event.eventId,
        transactionHash,
      });
    }
  } catch (error) {
    console.error("Sponsored mint was submitted but its hash could not be recorded", {
      eventId: event.eventId,
      transactionHash,
      error,
    });
  }
  return context.json(relayResponse(event, address, transactionHash), 202, {
    "Cache-Control": "private, no-store",
  });
});

app.post("/api/live/events/:slug/mints", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  const slug = normalizeLiveSlug(context.req.param("slug"));
  const event = await fetchLiveEvent(context.env.LIVE_DB.withSession("first-primary"), slug);
  if (!event) {
    throw new ApiError(404, "This mint event is unavailable.", "live_event_not_found");
  }
  if (!event.contractAddress || event.tokenId === null) {
    throw new ApiError(409, "Onchain minting is not configured.", "live_mint_not_configured");
  }
  const body = await parseMintBody(context.req.raw);
  const address = normalizeAddress(body.address) as `0x${string}`;
  const codeHash = await sha256Hex(body.code);
  const claim = await fetchLiveClaim(
    context.env.LIVE_DB.withSession("first-primary"),
    event.eventId,
    codeHash,
    address,
  );
  if (!claim) {
    throw new ApiError(409, "No matching claim reservation exists.", "live_claim_unavailable");
  }
  if (claim.mintedTxHash && claim.mintedTxHash !== body.transactionHash) {
    throw new ApiError(
      409,
      "This claim was confirmed by another transaction.",
      "live_mint_conflict",
    );
  }

  const verification = await verifyMintTransaction(
    liveRpcUrl(context.env, event.chainId),
    body.transactionHash,
    event,
    address,
  );
  if (verification === "pending") {
    throw new ApiError(409, "The mint transaction is still pending.", "live_mint_pending");
  }
  if (verification === "invalid") {
    throw new ApiError(
      409,
      "The transaction does not contain the expected badge mint.",
      "live_mint_invalid",
    );
  }
  const minted = await markLiveClaimMinted(
    context.env.LIVE_DB,
    event.eventId,
    codeHash,
    address,
    body.transactionHash,
  );
  if (!minted) {
    throw new ApiError(409, "The mint could not be recorded.", "live_mint_conflict");
  }
  return context.json(
    {
      eventId: event.eventId,
      slug,
      address,
      mintStatus: "minted",
      mintedAt: minted.mintedAt,
      transactionHash: body.transactionHash,
      explorerUrl: transactionExplorerUrl(event.chainId, body.transactionHash),
    },
    200,
    { "Cache-Control": "private, no-store" },
  );
});

app.get("/api/live/owners/:address", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  assertNoQuery(new URL(context.req.url));
  const address = normalizeAddress(context.req.param("address"));
  const items = await fetchLiveHoldings(context.env.LIVE_DB.withSession("first-primary"), address);
  return context.json({ address, items }, 200, { "Cache-Control": "private, no-store" });
});

app.get("/api/legacy/owners/:address", async (context) => {
  const limited = await enforceRateLimit(context.env.OWNER_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  assertNoQuery(new URL(context.req.url));
  const address = normalizeAddress(context.req.param("address")) as `0x${string}`;
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/legacy/owners/${address}`,
      snapshotId: LEGACY_POAP_CACHE_SCHEMA,
      apiVersion: `${context.env.API_CACHE_VERSION}.${LEGACY_POAP_CACHE_SCHEMA}`,
      edgeTtlSeconds: 300,
      browserTtlSeconds: 0,
      executionCtx: context.executionCtx,
    },
    async () => context.json(await fetchLegacyPoapHoldings(context.env, address)),
  );
});

app.get("/api/live/indexer/status", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  assertNoQuery(new URL(context.req.url));
  const items = await fetchChainIndexerStatus(context.env.LIVE_DB.withSession("first-primary"));
  return context.json({ items }, 200, { "Cache-Control": "public, max-age=15, s-maxage=15" });
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

/**
 * Core ZIP archive view used by the association frontend. It intentionally
 * depends only on the official catalog + holdings snapshot; the separate
 * Glory Lab Collections and Moments releases are not required.
 */
app.get("/api/archive/owners/:address", async (context) => {
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
      canonicalPath: `/api/archive/owners/${query.address}`,
      canonicalSearch: query.canonicalSearch,
      snapshotId: `${context.env.HOLDINGS_SNAPSHOT_ID}.${context.env.SNAPSHOT_ID}`,
      apiVersion: `${context.env.API_CACHE_VERSION}.archive-core.${OWNER_CACHE_SCHEMA}`,
      edgeTtlSeconds: 86_400,
      browserTtlSeconds: 0,
      executionCtx: context.executionCtx,
    },
    async () => {
      const holdingsDb = context.env.HOLDINGS_DB.withSession("first-primary");
      const catalogDb = context.env.CATALOG_DB.withSession("first-primary");
      return context.json(
        await fetchOwner(
          holdingsDb,
          catalogDb,
          null,
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

app.get("/api/archive/drops/:id", async (context) => {
  const limited = await enforceRateLimit(context.env.BROWSE_RATE_LIMITER, context.req.raw);
  if (limited) return limited;
  assertNoQuery(new URL(context.req.url));
  const dropId = parseDropId(context.req.param("id"));
  return withSnapshotCache(
    {
      requestUrl: context.req.url,
      canonicalPath: `/api/archive/drops/${dropId}`,
      snapshotId: context.env.SNAPSHOT_ID,
      apiVersion: `${context.env.API_CACHE_VERSION}.archive-core.drop-detail-v1`,
      edgeTtlSeconds: 2_592_000,
      browserTtlSeconds: 300,
      executionCtx: context.executionCtx,
    },
    async () => {
      const catalogDb = context.env.CATALOG_DB.withSession("first-primary");
      const drop = await fetchDrop(
        catalogDb,
        dropId,
        context.env.MEDIA_BASE_URL,
        context.env.SNAPSHOT_ID,
      );
      if (!drop) throw new ApiError(404, "Archive Drop not found.", "drop_not_found");
      return context.json(drop);
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

function normalizeLiveSlug(value: string): string {
  const slug = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/.test(slug)) {
    throw new ApiError(400, "Claim event slug is invalid.", "invalid_live_event_slug");
  }
  return slug;
}

function normalizeLiveMediaFilename(value: string): string {
  if (value === "metadata.json" || /^artwork\.(?:png|jpg|webp|gif|svg)$/.test(value)) {
    return value;
  }
  throw new ApiError(404, "Media not found.", "media_not_found");
}

function isAuthorizedArchiveMediaMirrorRequest(request: Request, secret: string | undefined): boolean {
  if (!secret || secret.length < 32) return false;
  const authorization = request.headers.get("Authorization");
  const expected = `Bearer ${secret}`;
  if (!authorization || authorization.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ authorization.charCodeAt(index);
  }
  return difference === 0;
}

async function parseClaimBody(request: Request): Promise<{ code: string; address: string }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "Claim request must be valid JSON.", "invalid_claim_body");
  }
  if (!body || typeof body !== "object") {
    throw new ApiError(400, "Claim request is invalid.", "invalid_claim_body");
  }
  const input = body as Record<string, unknown>;
  if (typeof input.code !== "string" || input.code.length < 8 || input.code.length > 255) {
    throw new ApiError(400, "Claim code is invalid.", "invalid_claim_code");
  }
  if (typeof input.address !== "string") {
    throw new ApiError(400, "Wallet address is required.", "invalid_address");
  }
  return { code: input.code, address: input.address };
}

async function parseMintBody(
  request: Request,
): Promise<{ code: string; address: string; transactionHash: `0x${string}` }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, "Mint request must be valid JSON.", "invalid_mint_body");
  }
  if (!body || typeof body !== "object") {
    throw new ApiError(400, "Mint request is invalid.", "invalid_mint_body");
  }
  const input = body as Record<string, unknown>;
  if (typeof input.code !== "string" || input.code.length < 8 || input.code.length > 255) {
    throw new ApiError(400, "Claim code is invalid.", "invalid_claim_code");
  }
  if (typeof input.address !== "string") {
    throw new ApiError(400, "Wallet address is required.", "invalid_address");
  }
  if (
    typeof input.transactionHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(input.transactionHash)
  ) {
    throw new ApiError(400, "Transaction hash is invalid.", "invalid_transaction_hash");
  }
  return {
    code: input.code,
    address: input.address,
    transactionHash: input.transactionHash.toLowerCase() as `0x${string}`,
  };
}

function randomBytes32(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function parseEmailReservationBody(
  request: Request,
): Promise<{ code: string; email: unknown }> {
  const body = await parseJsonObject(request, "Email reservation request");
  if (typeof body.code !== "string" || body.code.length < 8 || body.code.length > 255) {
    throw new ApiError(400, "Claim code is invalid.", "invalid_claim_code");
  }
  return { code: body.code, email: body.email };
}

async function parseEmailBody(request: Request): Promise<{ email: unknown }> {
  const body = await parseJsonObject(request, "Email login request");
  return { email: body.email };
}

async function parseMagicLinkBody(request: Request): Promise<{ token: string }> {
  const body = await parseJsonObject(request, "Verification request");
  if (
    typeof body.token !== "string" ||
    body.token.length < 32 ||
    body.token.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(body.token)
  ) {
    throw new ApiError(400, "Verification token is invalid.", "invalid_email_challenge");
  }
  return { token: body.token };
}

async function parseMagicSessionBody(
  request: Request,
): Promise<{ didToken: string; expectedEmail: string }> {
  const body = await parseJsonObject(request, "Magic authentication request");
  if (
    typeof body.didToken !== "string" ||
    body.didToken.length < 64 ||
    body.didToken.length > 8_192
  ) {
    throw new ApiError(400, "Magic authentication token is invalid.", "invalid_magic_token");
  }
  return { didToken: body.didToken, expectedEmail: normalizeEmail(body.email) };
}

async function parseAddressBody(request: Request): Promise<{ address: string }> {
  const body = await parseJsonObject(request, "Wallet binding request");
  if (typeof body.address !== "string") {
    throw new ApiError(400, "Wallet address is required.", "invalid_address");
  }
  return { address: body.address };
}

async function parseEmailMintBody(
  request: Request,
): Promise<{ address: string; transactionHash: `0x${string}` }> {
  const body = await parseJsonObject(request, "Mint confirmation request");
  if (typeof body.address !== "string") {
    throw new ApiError(400, "Wallet address is required.", "invalid_address");
  }
  if (
    typeof body.transactionHash !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(body.transactionHash)
  ) {
    throw new ApiError(400, "Transaction hash is invalid.", "invalid_transaction_hash");
  }
  return {
    address: body.address,
    transactionHash: body.transactionHash.toLowerCase() as `0x${string}`,
  };
}

async function parseJsonObject(request: Request, label: string): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ApiError(400, `${label} must be valid JSON.`, "invalid_request_body");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, `${label} is invalid.`, "invalid_request_body");
  }
  return body as Record<string, unknown>;
}

async function prepareEmailChallenge(
  env: Bindings,
  input: {
    purpose: "reserve" | "login";
    eventId: string | null;
    accessCodeHash: string | null;
    email: string;
  },
): Promise<{ challengeId: string; token: string }> {
  const challengeId = crypto.randomUUID();
  const token = randomToken();
  const [emailHmac, encrypted, tokenHash] = await Promise.all([
    hmacEmail(input.email, env.EMAIL_LOOKUP_SECRET),
    encryptEmail(input.email, env.EMAIL_DATA_KEY),
    sha256Hex(token),
  ]);
  await createEmailChallenge(env.LIVE_DB, {
    challengeId,
    purpose: input.purpose,
    eventId: input.eventId,
    accessCodeHash: input.accessCodeHash,
    emailHmac,
    emailCiphertext: encrypted.ciphertext,
    emailIv: encrypted.iv,
    tokenHash,
    expiresAt: Math.floor(Date.now() / 1000) + MAGIC_LINK_TTL_SECONDS,
  });
  return { challengeId, token };
}

async function requireEmailSession(env: Bindings, request: Request): Promise<string> {
  const token = readSessionToken(request);
  if (!token) {
    throw new ApiError(401, "Sign in with your Email link first.", "email_session_required");
  }
  const emailHmac = await fetchSessionEmailHmac(
    env.LIVE_DB.withSession("first-primary"),
    await sha256Hex(token),
    Math.floor(Date.now() / 1000),
  );
  if (!emailHmac) {
    throw new ApiError(401, "Your Email session has expired.", "email_session_expired");
  }
  return emailHmac;
}

function normalizeReservationId(value: string): string {
  const id = value.trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new ApiError(400, "Reservation ID is invalid.", "invalid_email_reservation");
  }
  return id;
}

function validatedPublicAppUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("PUBLIC_APP_URL must use HTTPS outside local development.");
  }
  return url.origin;
}

function publicEmailReservation(
  reservation: Awaited<ReturnType<typeof fetchEmailReservation>> extends infer T
    ? Exclude<T, null>
    : never,
) {
  // A sponsored transaction is already the collector's completed action. The
  // chain indexer can confirm ownership later without making the Email view
  // fall back to the earlier "reserved" state in the meantime.
  const effectiveMintHash = reservation.mintedTxHash ?? reservation.relayTxHash;
  return {
    reservationId: reservation.reservationId,
    reservedAt: reservation.reservedAt,
    boundAddress: reservation.boundAddress,
    claimedAt: reservation.claimedAt,
    mintStatus: effectiveMintHash
      ? ("minted" as const)
      : reservation.boundAddress
        ? ("ready" as const)
        : ("reserved" as const),
    mintedTxHash: effectiveMintHash,
    mintedAt: reservation.mintedAt,
    mintedExplorerUrl: effectiveMintHash
      ? transactionExplorerUrl(reservation.event.chainId, effectiveMintHash)
      : null,
    event: reservation.event,
  };
}

function publicEmailWallet(wallet: Awaited<ReturnType<typeof fetchEmailWallet>>) {
  return wallet
    ? {
        provider: wallet.provider,
        status: wallet.status,
        address: wallet.address,
        updatedAt: wallet.updatedAt,
      }
    : null;
}

function relayResponse(
  event: { eventId: string; slug: string; chainId: number },
  address: `0x${string}`,
  transactionHash: `0x${string}`,
) {
  return {
    eventId: event.eventId,
    slug: event.slug,
    address,
    transactionHash,
    explorerUrl: transactionExplorerUrl(event.chainId, transactionHash),
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("UNIQUE constraint failed") ||
      error.message.includes("constraint failed"))
  );
}

function liveRpcUrl(
  env: Pick<Bindings, "BASE_RPC_URL" | "BASE_MAINNET_RPC_URL">,
  chainId: number,
): string {
  if (chainId === 84532) return env.BASE_RPC_URL;
  if (chainId === 8453) return env.BASE_MAINNET_RPC_URL;
  throw new ApiError(409, "This event uses an unsupported chain.", "live_chain_unsupported");
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

export default {
  fetch: app.fetch,
  async scheduled(
    _controller: ScheduledController,
    env: Bindings,
    _context: ExecutionContext,
  ): Promise<void> {
    const [indexer, emailPrune] = await Promise.all([
      runLiveChainIndexer(env),
      pruneExpiredEmailAuthArtifacts(env.LIVE_DB),
    ]);
    console.log("Scheduled continuation maintenance completed", { indexer, emailPrune });
  },
};
