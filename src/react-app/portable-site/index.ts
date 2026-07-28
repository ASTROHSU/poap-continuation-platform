import {
  buildAgentPrompts,
  buildArchiveBootstrap,
  buildDeployGuide,
  buildIndexHtml,
  buildReadme,
  buildSiteCss,
  buildSiteJs,
} from "./templates";
import type { PersonalArchiveSnapshot } from "../personal-export";
import type {
  PortableCollectionArtistDrop,
  PortableCollectionDropStats,
  PortableCollectionSuggestion,
  PortableOwnedCollectionExport,
  PortableSiteBuild,
  PortableSiteDatasetId,
  PortableSiteDatasetManifest,
  PortableSiteFile,
  PortableSiteManifest,
  PortableSiteManifestFile,
  PortableSiteRuntimeManifest,
  PortableSiteSnapshot,
  PortableSiteSources,
  PortableSiteTab,
} from "./types";

export type {
  PortableCollectionArtistDrop,
  PortableCollectionDropStats,
  PortableCollectionSuggestion,
  PortableCollectionVisibleDropStats,
  PortableOwnedCollectionExport,
  PortableSiteBuild,
  PortableSiteDatasetId,
  PortableSiteDatasetManifest,
  PortableSiteFile,
  PortableSiteManifest,
  PortableSiteManifestFile,
  PortableSiteRuntimeManifest,
  PortableSiteSnapshot,
  PortableSiteSnapshotIds,
  PortableSiteSources,
  PortableSiteTab,
} from "./types";

export const PORTABLE_SITE_LIMITS = {
  maxFiles: 1_000,
  maxFileBytes: 5_242_880,
  dataChunkTargetBytes: 3_670_016,
} as const;

const MANIFEST_PATH = "manifest.json";
const RUNTIME_BOOTSTRAP_PATH = "assets/archive.bootstrap.js";
const DATA_SCHEMA_VERSION = "poapin-portable-data-v1";
const textEncoder = new TextEncoder();

export type PortableSiteInput = PortableSiteSnapshot | PersonalArchiveSnapshot;

interface DatasetSource {
  id: PortableSiteDatasetId;
  tab: PortableSiteTab;
  label: string;
  items: unknown[];
}

interface ChunkBody {
  schemaVersion: typeof DATA_SCHEMA_VERSION;
  dataset: PortableSiteDatasetId;
  address: string;
  snapshotIds: PortableSiteSnapshot["snapshotIds"];
  sources: PortableSiteSources;
  chunk: { index: number; total: number };
  count: number;
  items: unknown[];
}

/**
 * Builds a deterministic, deploy-ready map that can be passed directly to a ZIP writer.
 * Every value is UTF-8 encoded and every path is relative to the archive root.
 */
export async function buildPortableSiteFiles(
  snapshot: PortableSiteInput,
  signal?: AbortSignal,
): Promise<Map<string, Uint8Array>> {
  const build = await buildPortableSiteBundle(snapshot, signal);
  const files = new Map<string, Uint8Array>();
  for (let index = 0; index < build.files.length; index += 1) {
    signal?.throwIfAborted();
    const file = build.files[index]!;
    files.set(file.path, textEncoder.encode(file.content));
    if (signal && index > 0 && index % 8 === 0) await yieldForCancellation(signal);
  }
  signal?.throwIfAborted();
  return files;
}

/**
 * Builds the same files with their decoded text and integrity metadata exposed.
 *
 * The returned manifest hashes every file except itself, avoiding a recursive digest.
 * No input array or record is mutated.
 */
export async function buildPortableSiteBundle(
  snapshot: PortableSiteInput,
  signal?: AbortSignal,
): Promise<PortableSiteBuild> {
  signal?.throwIfAborted();
  const normalized = normalizeSnapshot(snapshot);
  const datasets = buildDatasetSources(normalized);
  const files: PortableSiteFile[] = [];
  const datasetManifests: PortableSiteDatasetManifest[] = [];

  for (const dataset of datasets) {
    signal?.throwIfAborted();
    const chunks = await chunkDataset(dataset, normalized, signal);
    const paths: string[] = [];
    for (const chunk of chunks) {
      const path = `data/${dataset.id}-${String(chunk.chunk.index).padStart(4, "0")}.data.js`;
      paths.push(path);
      files.push(await createDataTransportFile(path, serializeJson(chunk), chunk.count));
    }
    datasetManifests.push({
      id: dataset.id,
      tab: dataset.tab,
      label: dataset.label,
      count: dataset.items.length,
      paths,
    });
    if (signal) await yieldForCancellation(signal);
  }

  const provisionalManifest = buildManifest(normalized, datasetManifests, []);
  const runtimeManifest = buildRuntimeManifest(normalized, datasetManifests, files);
  const staticContents: Array<[string, string, string]> = [
    ["index.html", buildIndexHtml(), "text/html; charset=utf-8"],
    ["assets/site.css", buildSiteCss(), "text/css; charset=utf-8"],
    ["assets/site.js", buildSiteJs(), "text/javascript; charset=utf-8"],
    [
      RUNTIME_BOOTSTRAP_PATH,
      buildArchiveBootstrap(runtimeManifest),
      "text/javascript; charset=utf-8",
    ],
    ["robots.txt", "User-agent: *\nDisallow: /\n", "text/plain; charset=utf-8"],
    ["README.md", buildReadme(provisionalManifest), "text/markdown; charset=utf-8"],
    ["DEPLOY.md", buildDeployGuide(), "text/markdown; charset=utf-8"],
    ...Object.entries(buildAgentPrompts(provisionalManifest)).map(
      ([path, content]) =>
        [path, content, "text/markdown; charset=utf-8"] as [string, string, string],
    ),
  ];
  for (const [path, content, mimeType] of staticContents) {
    signal?.throwIfAborted();
    files.push(await createFile(path, content, mimeType, 0));
  }
  const checksums = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((file) => `${file.sha256}  ${file.path}`)
    .join("\n");
  files.push(
    await createFile(
      "checksums.sha256",
      `${checksums}\n`,
      "text/plain; charset=utf-8",
      files.length,
    ),
  );

  assertUniqueSafePaths(files);
  assertBundleLimits(files.length + 1, files);

  const integrityFiles = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(toManifestFile);
  const manifest = buildManifest(normalized, datasetManifests, integrityFiles);
  const manifestFile = await createFile(
    MANIFEST_PATH,
    serializeJson(manifest, true),
    "application/json",
    integrityFiles.length,
  );
  assertBundleLimits(files.length + 1, [...files, manifestFile]);
  signal?.throwIfAborted();

  return {
    manifest,
    files: [manifestFile, ...files].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function normalizeSnapshot(snapshot: PortableSiteInput): PortableSiteSnapshot {
  const portable = isPersonalArchiveSnapshot(snapshot)
    ? personalArchiveToPortableSnapshot(snapshot)
    : snapshot;
  const address = requireText(portable.address, "address").toLowerCase();
  const snapshotIds = {
    holdings: requireText(portable.snapshotIds.holdings, "holdings snapshot ID"),
    collections: requireText(portable.snapshotIds.collections, "collections snapshot ID"),
    moments: requireText(portable.snapshotIds.moments, "moments snapshot ID"),
  };
  const sources = normalizeSources(portable.sources, snapshotIds);
  const holdings = portable.holdings.map((holding) => ({
    sourceUid: holding.sourceUid,
    poapId: holding.poapId,
    dropId: holding.dropId,
    mintedOn: holding.mintedOn ?? null,
    ownerAddress: holding.ownerAddress,
    network: holding.network,
    transferCount: holding.transferCount,
  }));
  const drops = portable.drops.map(normalizeDropRecord);
  const unavailableDropIds = normalizeUnavailableDropIds(portable.unavailableDropIds);
  const ownedCollectionExports = portable.ownedCollectionExports.map(copyOwnedCollection);
  for (const collection of ownedCollectionExports) {
    validateOwnedCollection(collection, snapshotIds.collections, sources.collections.releaseId);
  }
  const normalized: PortableSiteSnapshot = {
    address,
    generatedAt: portable.generatedAt
      ? requireText(portable.generatedAt, "generation time")
      : undefined,
    snapshotIds,
    sources,
    holdings,
    drops,
    unavailableDropIds,
    collectionProfiles: [...portable.collectionProfiles],
    heldDropMemberships: [...portable.heldDropMemberships],
    authoredMomentAssociations: (portable.authoredMomentAssociations ?? []).map((association) => ({
      collectionId: association.collectionId,
      momentIds: [...association.momentIds],
    })),
    taggedMomentAssociations: (portable.taggedMomentAssociations ?? []).map((association) => ({
      collectionId: association.collectionId,
      momentIds: [...association.momentIds],
    })),
    ownedCollectionExports,
    publicAuthoredMoments: [...portable.publicAuthoredMoments],
    publicTaggedMoments: [...portable.publicTaggedMoments],
    ownedCapsules: [...portable.ownedCapsules],
  };
  validateNormalizedDropCoverage(normalized);
  return normalized;
}

function isPersonalArchiveSnapshot(
  snapshot: PortableSiteInput,
): snapshot is PersonalArchiveSnapshot {
  return "schemaVersion" in snapshot && snapshot.schemaVersion === "poapin-personal-site-source-v1";
}

function personalArchiveToPortableSnapshot(
  snapshot: PersonalArchiveSnapshot,
): PortableSiteSnapshot {
  return {
    address: snapshot.address,
    generatedAt: snapshot.generatedAt,
    snapshotIds: snapshot.manifest.snapshots,
    sources: snapshot.manifest.sources,
    holdings: snapshot.holdings,
    drops: snapshot.drops,
    unavailableDropIds: snapshot.unavailableDropIds,
    collectionProfiles: snapshot.collectionProfiles,
    heldDropMemberships: snapshot.heldDropMemberships,
    authoredMomentAssociations: snapshot.authoredMomentAssociations,
    taggedMomentAssociations: snapshot.taggedMomentAssociations,
    ownedCollectionExports: snapshot.ownedCollections.map((collection) => {
      for (const segment of collection.manifest.segments) {
        if (
          segment.name !== "metadata" &&
          !Object.prototype.hasOwnProperty.call(collection.segments, segment.name)
        ) {
          throw new Error(
            `Owned collection ${collection.collectionId} is missing its declared ${segment.name} segment.`,
          );
        }
      }
      return {
        manifest: collection.manifest,
        profile: collection.profile,
        items: (collection.segments.items ?? []) as PortableOwnedCollectionExport["items"],
        artistDrops: (collection.segments["artist-drops"] ?? []) as PortableCollectionArtistDrop[],
        suggestions: (collection.segments.suggestions ?? []) as PortableCollectionSuggestion[],
        dropStats: (collection.segments["drop-stats"] ?? []) as PortableCollectionDropStats[],
      };
    }),
    publicAuthoredMoments: snapshot.authoredMoments,
    publicTaggedMoments: snapshot.taggedMoments,
    ownedCapsules: snapshot.ownedCapsules,
  };
}

function copyOwnedCollection(
  collection: PortableOwnedCollectionExport,
): PortableOwnedCollectionExport {
  return {
    ...collection,
    items: [...collection.items],
    artistDrops: [...collection.artistDrops],
    suggestions: [...collection.suggestions],
    dropStats: [...collection.dropStats],
  };
}

function validateOwnedCollection(
  collection: PortableOwnedCollectionExport,
  collectionsSnapshotId: string,
  collectionsReleaseId: string,
): void {
  const collectionId = collection.profile.collection.collectionId;
  if (
    collection.manifest.schemaVersion !== "poapin-collection-export-v1" ||
    collection.manifest.collectionId !== collectionId ||
    collection.manifest.snapshotId !== collectionsSnapshotId ||
    collection.manifest.releaseId !== collectionsReleaseId ||
    collection.profile.snapshotId !== collectionsSnapshotId
  ) {
    throw new Error(`Owned collection ${collectionId} does not match the portable snapshot.`);
  }
  const segmentCounts = new Map(
    collection.manifest.segments.map((segment) => [segment.name, segment.count]),
  );
  if (
    collection.items.length !== collection.manifest.counts.items ||
    collection.artistDrops.length !== collection.manifest.counts.artistDrops ||
    collection.suggestions.length !== collection.manifest.counts.suggestions ||
    collection.dropStats.length !== collection.manifest.counts.dropStats ||
    segmentCounts.get("metadata") !== 1 ||
    segmentCounts.get("items") !== collection.items.length ||
    (collection.artistDrops.length > 0 &&
      segmentCounts.get("artist-drops") !== collection.artistDrops.length) ||
    (collection.suggestions.length > 0 &&
      segmentCounts.get("suggestions") !== collection.suggestions.length) ||
    (collection.dropStats.length > 0 &&
      segmentCounts.get("drop-stats") !== collection.dropStats.length)
  ) {
    throw new Error(`Owned collection ${collectionId} does not match its declared segment counts.`);
  }
  if (
    collection.profile.sections.length !== collection.manifest.counts.sections ||
    collection.profile.urls.length !== collection.manifest.counts.urls ||
    collection.profile.media.length !== collection.manifest.counts.media
  ) {
    throw new Error(`Owned collection ${collectionId} profile counts do not match its manifest.`);
  }
}

function requireText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Portable site ${label} is required.`);
  return normalized;
}

function normalizeSources(
  sources: PortableSiteSources,
  snapshotIds: PortableSiteSnapshot["snapshotIds"],
): PortableSiteSources {
  const normalized = {
    holdings: {
      snapshotId: requireText(sources.holdings.snapshotId, "holdings source snapshot ID"),
    },
    collections: {
      snapshotId: requireText(sources.collections.snapshotId, "Collections source snapshot ID"),
      releaseId: requireText(sources.collections.releaseId, "Collections release ID"),
    },
    moments: {
      snapshotId: requireText(sources.moments.snapshotId, "Moments source snapshot ID"),
      releaseId: requireText(sources.moments.releaseId, "Moments release ID"),
      sourceDatabaseSha256: requireSha256(
        sources.moments.sourceDatabaseSha256,
        "Moments source database SHA-256",
      ),
      buildManifestSha256: requireSha256(
        sources.moments.buildManifestSha256,
        "Moments build manifest SHA-256",
      ),
    },
  };
  if (
    normalized.holdings.snapshotId !== snapshotIds.holdings ||
    normalized.collections.snapshotId !== snapshotIds.collections ||
    normalized.moments.snapshotId !== snapshotIds.moments
  ) {
    throw new Error("Portable site source identities do not match their snapshot IDs.");
  }
  return normalized;
}

function requireSha256(value: string, label: string): string {
  const normalized = requireText(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`Portable site ${label} must be a lowercase SHA-256 digest.`);
  }
  return normalized;
}

function validateNormalizedDropCoverage(snapshot: PortableSiteSnapshot): void {
  const dropIds = new Set<number>();
  for (const drop of snapshot.drops) {
    if (!Number.isSafeInteger(drop.dropId) || drop.dropId <= 0 || dropIds.has(drop.dropId)) {
      throw new Error("Portable site Drops must have unique positive IDs.");
    }
    dropIds.add(drop.dropId);
  }
  const unavailable = new Set(snapshot.unavailableDropIds);
  if (snapshot.unavailableDropIds.some((dropId) => dropIds.has(dropId))) {
    throw new Error("Portable site available and unavailable Drop sets must not overlap.");
  }
  const referenced = new Set<number>();
  const addReference = (dropId: number) => {
    if (!Number.isSafeInteger(dropId) || dropId <= 0) {
      throw new Error("Portable site data contains an invalid Drop reference.");
    }
    referenced.add(dropId);
  };
  const sourceUids = new Set<string>();
  for (const holding of snapshot.holdings) {
    if (
      !holding.sourceUid ||
      sourceUids.has(holding.sourceUid) ||
      holding.ownerAddress.toLowerCase() !== snapshot.address
    ) {
      throw new Error("Portable site holdings do not match their normalized address.");
    }
    sourceUids.add(holding.sourceUid);
    addReference(holding.dropId);
  }
  for (const membership of snapshot.heldDropMemberships) {
    for (const dropId of membership.matchedDropIds) addReference(dropId);
  }
  for (const moment of [...snapshot.publicAuthoredMoments, ...snapshot.publicTaggedMoments]) {
    for (const dropId of moment.dropIds) addReference(dropId);
  }
  for (const collection of snapshot.ownedCollectionExports) {
    for (const item of collection.items) {
      if (item.drop) addReference(item.drop.dropId);
    }
    for (const item of collection.artistDrops) addReference(item.dropId);
    for (const item of collection.suggestions) addReference(item.dropId);
    for (const item of collection.dropStats) addReference(item.dropId);
  }
  for (const dropId of referenced) {
    if (!dropIds.has(dropId) && !unavailable.has(dropId)) {
      throw new Error("Portable site Drop references are missing availability records.");
    }
  }
  for (const dropId of [...dropIds, ...unavailable]) {
    if (!referenced.has(dropId)) {
      throw new Error("Portable site Drop availability includes an unreferenced ID.");
    }
  }
}

function normalizeDropRecord(
  drop: PortableSiteSnapshot["drops"][number],
): PortableSiteSnapshot["drops"][number] {
  return {
    dropId: drop.dropId,
    fancyId: drop.fancyId ?? null,
    title: drop.title,
    description: drop.description ?? null,
    startDate: drop.startDate,
    endDate: drop.endDate ?? null,
    city: drop.city ?? null,
    country: drop.country ?? null,
    year: drop.year,
    isVirtual: drop.isVirtual ?? null,
    eventUrl: drop.eventUrl ?? null,
    channel: drop.channel ?? null,
    platform: drop.platform ?? null,
    locationType: drop.locationType ?? null,
    timezone: drop.timezone ?? null,
    createdAt: drop.createdAt ?? null,
    imageUrl: drop.imageUrl,
    hasArtwork: drop.hasArtwork ?? Boolean(drop.imageUrl),
    tokenCount: drop.tokenCount ?? 0,
    reservationsTotal: drop.reservationsTotal ?? 0,
    reservationsMinted: drop.reservationsMinted ?? 0,
    reservationsUnminted: drop.reservationsUnminted ?? 0,
    ...(drop.isPrivate === true ? { isPrivate: true as const } : {}),
    ...(drop.isHidden === true ? { isHidden: true as const } : {}),
  };
}

function normalizeUnavailableDropIds(dropIds: number[]): number[] {
  const unique = new Set<number>();
  for (const dropId of dropIds) {
    if (!Number.isSafeInteger(dropId) || dropId <= 0 || unique.has(dropId)) {
      throw new Error("Portable site unavailable Drops must have unique positive IDs.");
    }
    unique.add(dropId);
  }
  return [...unique].sort((left, right) => left - right);
}

function buildDatasetSources(snapshot: PortableSiteSnapshot): DatasetSource[] {
  const owned = snapshot.ownedCollectionExports;
  return [
    {
      id: "holdings",
      tab: "poaps",
      label: "Token-level holdings",
      items: snapshot.holdings,
    },
    {
      id: "drops",
      tab: "poaps",
      label: "Unique Drop details",
      items: snapshot.drops,
    },
    {
      id: "unavailable-drop-references",
      tab: "poaps",
      label: "Drop references without public details",
      items: snapshot.unavailableDropIds.map((dropId) => ({
        dropId,
        reason: "not-public-or-not-found",
      })),
    },
    {
      id: "collection-profiles",
      tab: "collections",
      label: "Collection profiles",
      items: snapshot.collectionProfiles,
    },
    {
      id: "held-drop-memberships",
      tab: "collections",
      label: "Held-drop memberships",
      items: snapshot.heldDropMemberships,
    },
    {
      id: "authored-moment-associations",
      tab: "collections",
      label: "Collections associated with authored Moments",
      items: snapshot.authoredMomentAssociations ?? [],
    },
    {
      id: "tagged-moment-associations",
      tab: "collections",
      label: "Collections associated with tagged Moments",
      items: snapshot.taggedMomentAssociations ?? [],
    },
    {
      id: "owned-collections",
      tab: "owned",
      label: "Owned collection profiles",
      items: owned.map((entry) => ({
        collectionId: entry.profile.collection.collectionId,
        manifest: entry.manifest,
        profile: entry.profile,
      })),
    },
    {
      id: "owned-collection-items",
      tab: "owned",
      label: "Owned collection items",
      items: flattenOwnedSegment(owned, "items"),
    },
    {
      id: "owned-collection-artist-drops",
      tab: "owned",
      label: "Owned collection artist drops",
      items: flattenOwnedSegment(owned, "artistDrops"),
    },
    {
      id: "owned-collection-suggestions",
      tab: "owned",
      label: "Owned collection suggestions",
      items: flattenOwnedSegment(owned, "suggestions"),
    },
    {
      id: "owned-collection-drop-stats",
      tab: "owned",
      label: "Owned collection drop statistics",
      items: flattenOwnedSegment(owned, "dropStats"),
    },
    {
      id: "moments-authored",
      tab: "moments",
      label: "Public authored moments",
      items: snapshot.publicAuthoredMoments,
    },
    {
      id: "moments-tagged",
      tab: "moments",
      label: "Public moments that tag this address",
      items: snapshot.publicTaggedMoments,
    },
    {
      id: "capsules",
      tab: "moments",
      label: "Public Capsules with this archived owner",
      items: snapshot.ownedCapsules,
    },
  ];
}

function flattenOwnedSegment(
  collections: PortableOwnedCollectionExport[],
  key: "items" | "artistDrops" | "suggestions" | "dropStats",
): unknown[] {
  return collections.flatMap((entry) =>
    entry[key].map((item) => ({
      collectionId: entry.profile.collection.collectionId,
      item,
    })),
  );
}

async function chunkDataset(
  dataset: DatasetSource,
  snapshot: PortableSiteSnapshot,
  signal?: AbortSignal,
): Promise<ChunkBody[]> {
  if (dataset.items.length === 0) return [];
  const itemChunks: unknown[][] = [];
  let current: unknown[] = [];
  let currentItemBytes = 0;
  const envelopeBytes =
    utf8Bytes(serializeJson(makeChunkBody(dataset.id, snapshot, 9_999, 9_999, []))) + 64;

  for (let index = 0; index < dataset.items.length; index += 1) {
    if (signal && index > 0 && index % 512 === 0) await yieldForCancellation(signal);
    const item = dataset.items[index];
    const itemBytes = jsonArrayItemBytes(item);
    const separatorBytes = current.length === 0 ? 0 : 1;
    if (
      envelopeBytes + currentItemBytes + separatorBytes + itemBytes <
      PORTABLE_SITE_LIMITS.dataChunkTargetBytes
    ) {
      current.push(item);
      currentItemBytes += separatorBytes + itemBytes;
      continue;
    }
    if (current.length === 0) {
      throw new Error(
        `A ${dataset.id} record is too large for the 3.5 MiB portable data chunk target.`,
      );
    }
    itemChunks.push(current);
    current = [item];
    currentItemBytes = itemBytes;
    if (envelopeBytes + currentItemBytes >= PORTABLE_SITE_LIMITS.dataChunkTargetBytes) {
      throw new Error(
        `A ${dataset.id} record is too large for the 3.5 MiB portable data chunk target.`,
      );
    }
  }
  if (current.length > 0) itemChunks.push(current);

  const total = itemChunks.length;
  return itemChunks.map((items, index) => {
    const body = makeChunkBody(dataset.id, snapshot, index + 1, total, items);
    if (utf8Bytes(serializeJson(body)) >= PORTABLE_SITE_LIMITS.dataChunkTargetBytes) {
      throw new Error(`${dataset.id} chunk ${index + 1} exceeded its 3.5 MiB target.`);
    }
    return body;
  });
}

function makeChunkBody(
  dataset: PortableSiteDatasetId,
  snapshot: PortableSiteSnapshot,
  index: number,
  total: number,
  items: unknown[],
): ChunkBody {
  return {
    schemaVersion: DATA_SCHEMA_VERSION,
    dataset,
    address: snapshot.address,
    snapshotIds: snapshot.snapshotIds,
    sources: snapshot.sources,
    chunk: { index, total },
    count: items.length,
    items,
  };
}

function buildManifest(
  snapshot: PortableSiteSnapshot,
  datasets: PortableSiteDatasetManifest[],
  files: PortableSiteManifestFile[],
): PortableSiteManifest {
  const owned = snapshot.ownedCollectionExports;
  const media = mediaCoverage(snapshot);
  return {
    schemaVersion: "poapin-portable-site-v2",
    address: snapshot.address,
    generatedAt: snapshot.generatedAt ?? null,
    generator: {
      name: "POAPin",
      siteUrl: "https://poap.in",
      sourceUrl: "https://github.com/glorylab/poapin-archive",
    },
    snapshotIds: snapshot.snapshotIds,
    sources: snapshot.sources,
    counts: {
      holdings: snapshot.holdings.length,
      uniqueDrops: snapshot.drops.length,
      privateHeldDrops: snapshot.drops.filter((drop) => drop.isPrivate === true).length,
      hiddenHeldDrops: snapshot.drops.filter((drop) => drop.isHidden === true).length,
      unavailableDropReferences: snapshot.unavailableDropIds.length,
      collectionProfiles: snapshot.collectionProfiles.length,
      heldDropMemberships: snapshot.heldDropMemberships.length,
      authoredMomentAssociations: snapshot.authoredMomentAssociations?.length ?? 0,
      taggedMomentAssociations: snapshot.taggedMomentAssociations?.length ?? 0,
      ownedCollections: owned.length,
      ownedCollectionItems: countOwned(owned, "items"),
      ownedCollectionArtistDrops: countOwned(owned, "artistDrops"),
      ownedCollectionSuggestions: countOwned(owned, "suggestions"),
      ownedCollectionDropStats: countOwned(owned, "dropStats"),
      publicAuthoredMoments: snapshot.publicAuthoredMoments.length,
      publicTaggedMoments: snapshot.publicTaggedMoments.length,
      ownedCapsules: snapshot.ownedCapsules.length,
    },
    coverage: {
      mediaReferences: media.references,
      knownReferencedMediaBytes: media.knownBytes,
      unknownByteLengthReferences: media.unknownByteLengthReferences,
      taggedMomentsIncluded: true,
    },
    policies: {
      historicalSnapshot: true,
      claimsCurrentOwnership: false,
      collectionMembership: "collection-items-v1",
      media: {
        mode: "remote-references",
        baseUrl: "https://media.poap.in",
        bundled: false,
        autoplay: false,
      },
      robots: "noindex,nofollow",
    },
    datasets,
    deployment: {
      maxFiles: PORTABLE_SITE_LIMITS.maxFiles,
      maxFileBytes: PORTABLE_SITE_LIMITS.maxFileBytes,
      dataChunkTargetBytes: PORTABLE_SITE_LIMITS.dataChunkTargetBytes,
    },
    integrity: {
      algorithm: "SHA-256",
      scope: "Every generated file except manifest.json",
    },
    files,
  };
}

function buildRuntimeManifest(
  snapshot: PortableSiteSnapshot,
  datasets: PortableSiteDatasetManifest[],
  dataFiles: PortableSiteFile[],
): PortableSiteRuntimeManifest {
  const manifest = buildManifest(snapshot, datasets, []);
  return {
    schemaVersion: "poapin-portable-runtime-v1",
    address: manifest.address,
    generatedAt: manifest.generatedAt,
    snapshotIds: manifest.snapshotIds,
    sources: manifest.sources,
    counts: manifest.counts,
    datasets: manifest.datasets,
    files: dataFiles.map((file) => {
      if (!file.payload) {
        throw new Error(`${file.path} is missing its portable JSON payload metadata.`);
      }
      return {
        path: file.path,
        count: file.count,
        payload: file.payload,
      };
    }),
  };
}

function mediaCoverage(snapshot: PortableSiteSnapshot): {
  references: number;
  knownBytes: number;
  unknownByteLengthReferences: number;
} {
  const references = new Map<string, number | null>();
  const add = (url: string | null | undefined, bytes: number | null | undefined) => {
    if (!url) return;
    const knownBytes = typeof bytes === "number" && bytes > 0 ? bytes : null;
    const existing = references.get(url);
    if (knownBytes !== null) references.set(url, Math.max(existing ?? 0, knownBytes));
    else if (existing === undefined) references.set(url, null);
  };
  for (const drop of snapshot.drops) {
    if (drop.hasArtwork !== false) add(drop.imageUrl, 0);
  }
  for (const profile of snapshot.collectionProfiles) {
    add(profile.collection.logoUrl, 0);
    add(profile.collection.bannerUrl, 0);
    for (const media of profile.media) add(media.objectUrl, media.byteLength);
  }
  for (const owned of snapshot.ownedCollectionExports) {
    for (const item of owned.items) {
      add(item.drop && "imageUrl" in item.drop ? item.drop.imageUrl : null, null);
    }
    for (const item of owned.artistDrops) {
      add(item.drop && "imageUrl" in item.drop ? item.drop.imageUrl : null, null);
    }
    for (const item of owned.suggestions) {
      add(item.drop && "imageUrl" in item.drop ? item.drop.imageUrl : null, null);
    }
  }
  for (const moment of [...snapshot.publicAuthoredMoments, ...snapshot.publicTaggedMoments]) {
    add(moment.previewMedia?.url, null);
    add(moment.previewMedia?.thumbnailUrl, null);
    for (const media of moment.media) add(media.url, media.byteLength);
    for (const link of moment.links) add(link.imageUrl, null);
    for (const capsule of moment.capsules) add(capsule.imageUrl, null);
  }
  for (const capsule of snapshot.ownedCapsules) add(capsule.imageUrl, null);
  const values = [...references.values()];
  return {
    references: references.size,
    knownBytes: values.reduce<number>((total, bytes) => total + (bytes ?? 0), 0),
    unknownByteLengthReferences: values.filter((bytes) => bytes === null).length,
  };
}

function countOwned(
  collections: PortableOwnedCollectionExport[],
  key: "items" | "artistDrops" | "suggestions" | "dropStats",
): number {
  return collections.reduce((total, entry) => total + entry[key].length, 0);
}

async function createFile(
  path: string,
  content: string,
  mimeType: string,
  count: number,
): Promise<PortableSiteFile> {
  const bytes = utf8Bytes(content);
  return {
    path,
    content,
    mimeType,
    bytes,
    count,
    sha256: await sha256Hex(content),
  };
}

async function createDataTransportFile(
  path: string,
  json: string,
  count: number,
): Promise<PortableSiteFile> {
  const encoded = base64UrlEncode(json);
  const content =
    `globalThis.__POAPIN_ARCHIVE__.chunk(\n` +
    `  ${JSON.stringify(path)},\n` +
    `  ${JSON.stringify(encoded)}\n` +
    `);\n`;
  const file = await createFile(path, content, "text/javascript; charset=utf-8", count);
  return {
    ...file,
    payload: {
      encoding: "base64url",
      mimeType: "application/json",
      bytes: utf8Bytes(json),
      sha256: await sha256Hex(json),
    },
  };
}

function toManifestFile(file: PortableSiteFile): PortableSiteManifestFile {
  return {
    path: file.path,
    mimeType: file.mimeType,
    bytes: file.bytes,
    count: file.count,
    sha256: file.sha256,
    ...(file.payload ? { payload: file.payload } : {}),
  };
}

function assertUniqueSafePaths(files: PortableSiteFile[]): void {
  const paths = new Set<string>();
  for (const file of files) {
    if (
      !file.path ||
      file.path.startsWith("/") ||
      file.path.includes("\\") ||
      file.path.split("/").includes("..")
    ) {
      throw new Error(`Portable site path is not relative and safe: ${file.path}`);
    }
    if (paths.has(file.path)) throw new Error(`Portable site path is duplicated: ${file.path}`);
    paths.add(file.path);
  }
}

function assertBundleLimits(fileCount: number, files: PortableSiteFile[]): void {
  if (fileCount > PORTABLE_SITE_LIMITS.maxFiles) {
    throw new Error(`Portable site has ${fileCount} files; Cloudflare Drop supports up to 1,000.`);
  }
  for (const file of files) {
    if (file.bytes > PORTABLE_SITE_LIMITS.maxFileBytes) {
      throw new Error(
        `${file.path} is ${file.bytes} bytes; Cloudflare Drop supports files up to 5 MiB.`,
      );
    }
  }
}

function serializeJson(value: unknown, pretty = false): string {
  return `${JSON.stringify(value, null, pretty ? 2 : undefined)}\n`;
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function base64UrlEncode(value: string): string {
  const bytes = textEncoder.encode(value);
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32_768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32_768)));
  }
  return btoa(chunks.join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function jsonArrayItemBytes(value: unknown): number {
  const serialized = JSON.stringify([value]);
  return utf8Bytes(serialized.slice(1, -1));
}

function yieldForCancellation(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(done, 0);
    signal.addEventListener("abort", aborted, { once: true });

    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }

    function aborted() {
      globalThis.clearTimeout(timeout);
      reject(signal.reason);
    }
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
