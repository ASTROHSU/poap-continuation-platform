import {
  ApiError,
  getCollectionExportManifest,
  getCollectionExportPath,
  getCollectionProfiles,
  getDropDetailsBatch,
  getMomentTaggedExport,
  getOwnedCapsulesExport,
  getOwnedCollectionsExport,
  getPersonalExportManifest,
  getPersonalHoldingsPage,
  resolveHeldDropCollections,
} from "./api";
import { collectMomentAuthorExport } from "./moment-export";
import type {
  CollectionExportManifest,
  CollectionProfile,
  CollectionSummary,
  Drop,
  HeldDropCollectionMembership,
  MomentCapsule,
  MomentDetail,
  PersonalHoldingReference,
  PersonalExportManifest,
} from "./types";

const OWNER_INTERVAL_MS = 1_100;
const BROWSE_INTERVAL_MS = 550;
const DEFAULT_RETRY_AFTER_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 5;
const DROP_RESOLVE_BATCH_SIZE = 96;
const DROP_DETAIL_BATCH_SIZE = 96;
const COLLECTION_PROFILE_BATCH_SIZE = 16;

export type PersonalExportStage =
  | "manifest"
  | "holdings"
  | "moments"
  | "tagged-moments"
  | "capsules"
  | "drops"
  | "memberships"
  | "owned-collections"
  | "profiles"
  | "owned-collection-data";

export interface PersonalExportProgress {
  stage: PersonalExportStage;
  current: number;
  total: number | null;
  detail: string;
  retryAfterSeconds?: number;
}

export interface OwnedCollectionArchive {
  collectionId: number;
  manifest: CollectionExportManifest;
  profile: CollectionProfile;
  segments: Partial<Record<CollectionExportManifest["segments"][number]["name"], unknown[]>>;
}

export interface AuthoredMomentCollectionAssociation {
  collectionId: number;
  momentIds: string[];
}

export interface PersonalArchiveSnapshot {
  schemaVersion: "poapin-personal-site-source-v1";
  manifest: PersonalExportManifest;
  address: string;
  generatedAt: string;
  holdings: PersonalHoldingReference[];
  drops: Drop[];
  unavailableDropIds: number[];
  heldDropMemberships: HeldDropCollectionMembership[];
  collectionProfiles: CollectionProfile[];
  ownedCollections: OwnedCollectionArchive[];
  authoredMoments: MomentDetail[];
  taggedMoments: MomentDetail[];
  ownedCapsules: MomentCapsule[];
  authoredMomentAssociations: AuthoredMomentCollectionAssociation[];
  taggedMomentAssociations: AuthoredMomentCollectionAssociation[];
}

export interface PersonalExportRuntime {
  ownerIntervalMs?: number;
  browseIntervalMs?: number;
}

interface RequestPacer {
  wait(signal: AbortSignal): Promise<void>;
  markStarted(): void;
}

export async function collectPersonalArchive(
  address: string,
  signal: AbortSignal,
  onProgress: (progress: PersonalExportProgress) => void,
  runtime: PersonalExportRuntime = {},
): Promise<PersonalArchiveSnapshot> {
  const normalizedAddress = address.toLowerCase();
  signal.throwIfAborted();
  onProgress({
    stage: "manifest",
    current: 0,
    total: null,
    detail: "Reading the immutable archive identities…",
  });
  const manifest = await getPersonalExportManifest(normalizedAddress, signal);
  assertPersonalManifest(manifest, normalizedAddress);
  onProgress({
    stage: "manifest",
    current: 1,
    total: 1,
    detail: "Archive identities verified.",
  });

  const ownerPacer = createPacer(runtime.ownerIntervalMs ?? OWNER_INTERVAL_MS);
  const browsePacer = createPacer(runtime.browseIntervalMs ?? BROWSE_INTERVAL_MS);
  const {
    holdings,
    drops,
    unavailableDropIds: holdingUnavailableDropIds,
  } = await collectHoldings(normalizedAddress, manifest, ownerPacer, signal, onProgress);

  const authoredMoments = await collectMoments(normalizedAddress, manifest, signal, onProgress);
  const taggedMoments = await collectTaggedMoments(
    normalizedAddress,
    manifest,
    ownerPacer,
    signal,
    onProgress,
  );
  const ownedCapsules = await collectOwnedCapsules(
    normalizedAddress,
    manifest,
    ownerPacer,
    signal,
    onProgress,
  );

  const heldDropMemberships = await collectMemberships(
    [...new Set(holdings.map((holding) => holding.dropId))],
    manifest,
    ownerPacer,
    signal,
    onProgress,
  );

  const ownedCollectionSummaries = await collectOwnedCollectionSummaries(
    normalizedAddress,
    manifest,
    ownerPacer,
    signal,
    onProgress,
  );

  const allCollectionIds = new Set<number>();
  for (const membership of heldDropMemberships) {
    allCollectionIds.add(membership.collection.collectionId);
  }
  for (const collection of ownedCollectionSummaries) {
    allCollectionIds.add(collection.collectionId);
  }
  for (const moment of authoredMoments) {
    for (const collectionId of moment.collectionIds) allCollectionIds.add(collectionId);
  }
  for (const moment of taggedMoments) {
    for (const collectionId of moment.collectionIds) allCollectionIds.add(collectionId);
  }

  const collectionProfiles = await collectProfiles(
    [...allCollectionIds].sort((left, right) => left - right),
    manifest,
    ownerPacer,
    signal,
    onProgress,
  );
  const profileById = new Map(
    collectionProfiles.map((profile) => [profile.collection.collectionId, profile]),
  );
  const ownedCollections = await collectOwnedCollectionData(
    ownedCollectionSummaries,
    profileById,
    manifest,
    browsePacer,
    signal,
    onProgress,
  );
  const { drops: completeDrops, unavailableDropIds } = await collectReferencedDrops(
    drops,
    holdingUnavailableDropIds,
    authoredMoments,
    taggedMoments,
    ownedCollections,
    manifest,
    ownerPacer,
    signal,
    onProgress,
  );

  signal.throwIfAborted();
  return {
    schemaVersion: "poapin-personal-site-source-v1",
    manifest,
    address: normalizedAddress,
    generatedAt: new Date().toISOString(),
    holdings,
    drops: completeDrops,
    unavailableDropIds,
    heldDropMemberships,
    collectionProfiles,
    ownedCollections,
    authoredMoments,
    taggedMoments,
    ownedCapsules,
    authoredMomentAssociations: buildAuthoredMomentAssociations(authoredMoments),
    taggedMomentAssociations: buildAuthoredMomentAssociations(taggedMoments),
  };
}

async function collectHoldings(
  address: string,
  manifest: PersonalExportManifest,
  pacer: RequestPacer,
  signal: AbortSignal,
  onProgress: (progress: PersonalExportProgress) => void,
): Promise<{
  holdings: PersonalHoldingReference[];
  drops: Drop[];
  unavailableDropIds: number[];
}> {
  const items: PersonalHoldingReference[] = [];
  const drops = new Map<number, Drop>();
  const unavailableDropIds = new Set<number>();
  const sourceUids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const page = await pacedRequest(
      pacer,
      signal,
      () => getPersonalHoldingsPage(address, cursor, signal),
      (seconds) =>
        onProgress({
          stage: "holdings",
          current: items.length,
          total: manifest.counts.holdings,
          detail: "The archive is busy; the export will continue automatically.",
          retryAfterSeconds: seconds,
        }),
    );
    if (
      page.schemaVersion !== "poapin-personal-holdings-page-v2" ||
      page.snapshotId !== manifest.snapshots.holdings ||
      page.collectionsSnapshotId !== manifest.sources.collections.snapshotId ||
      page.collectionsReleaseId !== manifest.sources.collections.releaseId ||
      page.address !== address ||
      page.total !== manifest.counts.holdings ||
      !Array.isArray(page.drops) ||
      !Array.isArray(page.unavailableDropIds)
    ) {
      throw new Error("The holdings snapshot changed during export; please start again.");
    }
    for (const holding of page.items) {
      if (sourceUids.has(holding.sourceUid)) {
        throw new Error("The holdings export repeated a token; the download was stopped safely.");
      }
      sourceUids.add(holding.sourceUid);
      items.push(holding);
    }
    const pageDropIds = new Set(page.items.map((holding) => holding.dropId));
    const responseDropIds = new Set<number>();
    for (const drop of page.drops) {
      if (
        !pageDropIds.has(drop.dropId) ||
        responseDropIds.has(drop.dropId) ||
        unavailableDropIds.has(drop.dropId)
      ) {
        throw new Error("The holdings export returned an unexpected or repeated Drop.");
      }
      responseDropIds.add(drop.dropId);
      const existing = drops.get(drop.dropId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(drop)) {
        throw new Error("A Drop changed between holdings pages; please start again.");
      }
      drops.set(drop.dropId, drop);
    }
    for (const dropId of page.unavailableDropIds) {
      assertPositiveDropId(dropId);
      if (!pageDropIds.has(dropId) || responseDropIds.has(dropId) || drops.has(dropId)) {
        throw new Error("The holdings export returned an invalid unavailable Drop ID.");
      }
      responseDropIds.add(dropId);
      unavailableDropIds.add(dropId);
    }
    if (responseDropIds.size !== pageDropIds.size) {
      throw new Error("The holdings export omitted a referenced Drop.");
    }
    onProgress({
      stage: "holdings",
      current: items.length,
      total: manifest.counts.holdings,
      detail: `${items.length.toLocaleString("en")} of ${manifest.counts.holdings.toLocaleString("en")} holdings read`,
    });
    cursor = checkedNextCursor(page.nextCursor, cursors, "holdings");
  } while (cursor);

  if (items.length !== manifest.counts.holdings) {
    throw new Error(
      `The holdings export ended at ${items.length.toLocaleString("en")} of ${manifest.counts.holdings.toLocaleString("en")} records.`,
    );
  }
  return {
    holdings: items,
    drops: [...drops.values()].sort((left, right) => left.dropId - right.dropId),
    unavailableDropIds: [...unavailableDropIds].sort((left, right) => left - right),
  };
}

async function collectMoments(
  address: string,
  manifest: PersonalExportManifest,
  signal: AbortSignal,
  onProgress: (progress: PersonalExportProgress) => void,
): Promise<MomentDetail[]> {
  const result = await collectMomentAuthorExport(address, signal, (progress) => {
    onProgress({
      stage: "moments",
      current: progress.records,
      total: manifest.counts.authoredMoments,
      detail: `${progress.records.toLocaleString("en")} of ${manifest.counts.authoredMoments.toLocaleString("en")} public authored Moments read`,
      retryAfterSeconds: progress.retryAfterSeconds,
    });
  });
  if (result.snapshotId !== manifest.snapshots.moments) {
    throw new Error("The Moments snapshot changed during export; please start again.");
  }
  if (
    result.release.releaseId !== manifest.sources.moments.releaseId ||
    result.release.sourceDatabaseSha256 !== manifest.sources.moments.sourceDatabaseSha256 ||
    result.release.buildManifestSha256 !== manifest.sources.moments.buildManifestSha256
  ) {
    throw new Error("The Moments release changed during export; please start again.");
  }
  if (result.items.length !== manifest.counts.authoredMoments) {
    throw new Error(
      `The Moments export ended at ${result.items.length.toLocaleString("en")} of ${manifest.counts.authoredMoments.toLocaleString("en")} records.`,
    );
  }
  return result.items;
}

async function collectTaggedMoments(
  address: string,
  manifest: PersonalExportManifest,
  pacer: RequestPacer,
  signal: AbortSignal,
  onProgress: (progress: PersonalExportProgress) => void,
): Promise<MomentDetail[]> {
  const items: MomentDetail[] = [];
  const momentIds = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await pacedRequest(
      pacer,
      signal,
      () => getMomentTaggedExport(address, cursor, signal),
      (seconds) =>
        onProgress({
          stage: "tagged-moments",
          current: items.length,
          total: manifest.counts.taggedMoments,
          detail: "The archive is busy; tagged Moments will continue automatically.",
          retryAfterSeconds: seconds,
        }),
    );
    if (
      page.schemaVersion !== "poapin-moment-tagged-export-v1" ||
      page.address !== address ||
      !matchesMomentRelease(page, manifest)
    ) {
      throw new Error("The tagged Moments release changed during export.");
    }
    for (const moment of page.items) {
      if (!moment.momentId || momentIds.has(moment.momentId)) {
        throw new Error("The tagged Moments export repeated a Moment.");
      }
      momentIds.add(moment.momentId);
      items.push(moment);
    }
    onProgress({
      stage: "tagged-moments",
      current: items.length,
      total: manifest.counts.taggedMoments,
      detail: `${items.length.toLocaleString("en")} of ${manifest.counts.taggedMoments.toLocaleString("en")} public tagged Moments read`,
    });
    cursor = checkedNextCursor(page.nextCursor, cursors, "tagged Moments");
  } while (cursor);
  if (items.length !== manifest.counts.taggedMoments) {
    throw new Error(
      `The tagged Moments export ended at ${items.length} of ${manifest.counts.taggedMoments} records.`,
    );
  }
  return items;
}

async function collectOwnedCapsules(
  address: string,
  manifest: PersonalExportManifest,
  pacer: RequestPacer,
  signal: AbortSignal,
  onProgress: (progress: PersonalExportProgress) => void,
): Promise<MomentCapsule[]> {
  const items: MomentCapsule[] = [];
  const capsuleIds = new Set<number>();
  const cursors = new Set<string>();
  let cursor: string | null = null;
  do {
    const page = await pacedRequest(
      pacer,
      signal,
      () => getOwnedCapsulesExport(address, cursor, signal),
      (seconds) =>
        onProgress({
          stage: "capsules",
          current: items.length,
          total: manifest.counts.ownedCapsules,
          detail: "The archive is busy; Capsules will continue automatically.",
          retryAfterSeconds: seconds,
        }),
    );
    if (
      page.schemaVersion !== "poapin-capsule-owner-export-v1" ||
      page.address !== address ||
      !matchesMomentRelease(page, manifest)
    ) {
      throw new Error("The Capsule release changed during export.");
    }
    for (const capsule of page.items) {
      if (
        !Number.isSafeInteger(capsule.capsuleId) ||
        capsule.capsuleId <= 0 ||
        capsuleIds.has(capsule.capsuleId)
      ) {
        throw new Error("The Capsule export repeated or malformed a Capsule.");
      }
      capsuleIds.add(capsule.capsuleId);
      items.push(capsule);
    }
    onProgress({
      stage: "capsules",
      current: items.length,
      total: manifest.counts.ownedCapsules,
      detail: `${items.length.toLocaleString("en")} of ${manifest.counts.ownedCapsules.toLocaleString("en")} public Capsules read`,
    });
    cursor = checkedNextCursor(page.nextCursor, cursors, "Capsules");
  } while (cursor);
  if (items.length !== manifest.counts.ownedCapsules) {
    throw new Error(
      `The Capsule export ended at ${items.length} of ${manifest.counts.ownedCapsules} records.`,
    );
  }
  return items;
}

function matchesMomentRelease(
  page: {
    snapshotId: string;
    releaseId: string;
    sourceDatabaseSha256: string;
    buildManifestSha256: string;
  },
  manifest: PersonalExportManifest,
): boolean {
  return (
    page.snapshotId === manifest.sources.moments.snapshotId &&
    page.releaseId === manifest.sources.moments.releaseId &&
    page.sourceDatabaseSha256 === manifest.sources.moments.sourceDatabaseSha256 &&
    page.buildManifestSha256 === manifest.sources.moments.buildManifestSha256
  );
}

async function collectMemberships(
  dropIds: number[],
  manifest: PersonalExportManifest,
  pacer: RequestPacer,
  signal: AbortSignal,
  onProgress: (progress: PersonalExportProgress) => void,
): Promise<HeldDropCollectionMembership[]> {
  const batches = chunk(dropIds, DROP_RESOLVE_BATCH_SIZE);
  const memberships = new Map<
    number,
    { collection: CollectionSummary; matchedDropIds: Set<number> }
  >();

  for (let index = 0; index < batches.length; index += 1) {
    const requestedDropIds = batches[index];
    const response = await pacedRequest(
      pacer,
      signal,
      () => resolveHeldDropCollections(requestedDropIds, signal),
      (seconds) =>
        onProgress({
          stage: "memberships",
          current: index,
          total: batches.length,
          detail: "The archive is busy; Collection matching will continue automatically.",
          retryAfterSeconds: seconds,
        }),
    );
    if (
      response.schemaVersion !== "poapin-collection-memberships-v1" ||
      response.snapshotId !== manifest.snapshots.collections ||
      response.releaseId !== manifest.sources.collections.releaseId ||
      !sameIntegerSet(response.requestedDropIds, requestedDropIds)
    ) {
      throw new Error("The Collection membership response did not match the requested snapshot.");
    }
    const allowedDropIds = new Set(requestedDropIds);
    for (const membership of response.memberships) {
      const collectionId = membership.collection.collectionId;
      const existing = memberships.get(collectionId) ?? {
        collection: membership.collection,
        matchedDropIds: new Set<number>(),
      };
      for (const dropId of membership.matchedDropIds) {
        if (!allowedDropIds.has(dropId)) {
          throw new Error("A Collection membership escaped the requested Drop set.");
        }
        existing.matchedDropIds.add(dropId);
      }
      memberships.set(collectionId, existing);
    }
    onProgress({
      stage: "memberships",
      current: index + 1,
      total: batches.length,
      detail: `${Math.min((index + 1) * DROP_RESOLVE_BATCH_SIZE, dropIds.length).toLocaleString("en")} of ${dropIds.length.toLocaleString("en")} unique Drops matched`,
    });
  }

  return [...memberships.values()]
    .map(({ collection, matchedDropIds }) => ({
      collection,
      matchedDropIds: [...matchedDropIds].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.collection.collectionId - right.collection.collectionId);
}

async function collectOwnedCollectionSummaries(
  address: string,
  manifest: PersonalExportManifest,
  pacer: RequestPacer,
  signal: AbortSignal,
  onProgress: (progress: PersonalExportProgress) => void,
): Promise<CollectionSummary[]> {
  const items: CollectionSummary[] = [];
  const collectionIds = new Set<number>();
  const cursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const page = await pacedRequest(
      pacer,
      signal,
      () => getOwnedCollectionsExport(address, cursor, signal),
      (seconds) =>
        onProgress({
          stage: "owned-collections",
          current: items.length,
          total: manifest.counts.ownedCollections,
          detail: "The archive is busy; owned Collection lookup will continue automatically.",
          retryAfterSeconds: seconds,
        }),
    );
    if (
      page.schemaVersion !== "poapin-owned-collections-page-v1" ||
      page.snapshotId !== manifest.snapshots.collections ||
      page.releaseId !== manifest.sources.collections.releaseId ||
      page.address !== address
    ) {
      throw new Error("The owned Collections snapshot changed during export.");
    }
    for (const collection of page.items) {
      if (collectionIds.has(collection.collectionId)) {
        throw new Error("The owned Collections export repeated a Collection.");
      }
      collectionIds.add(collection.collectionId);
      items.push(collection);
    }
    onProgress({
      stage: "owned-collections",
      current: items.length,
      total: manifest.counts.ownedCollections,
      detail: `${items.length.toLocaleString("en")} of ${manifest.counts.ownedCollections.toLocaleString("en")} historically owned Collections read`,
    });
    cursor = checkedNextCursor(page.nextCursor, cursors, "owned Collections");
  } while (cursor);

  if (items.length !== manifest.counts.ownedCollections) {
    throw new Error(
      `The owned Collections export ended at ${items.length} of ${manifest.counts.ownedCollections} records.`,
    );
  }
  return items;
}

async function collectProfiles(
  collectionIds: number[],
  manifest: PersonalExportManifest,
  pacer: RequestPacer,
  signal: AbortSignal,
  onProgress: (progress: PersonalExportProgress) => void,
): Promise<CollectionProfile[]> {
  const profiles = new Map<number, CollectionProfile>();
  const batches = chunk(collectionIds, COLLECTION_PROFILE_BATCH_SIZE);
  for (let index = 0; index < batches.length; index += 1) {
    const ids = batches[index];
    const response = await pacedRequest(
      pacer,
      signal,
      () => getCollectionProfiles(ids, signal),
      (seconds) =>
        onProgress({
          stage: "profiles",
          current: profiles.size,
          total: collectionIds.length,
          detail: "The archive is busy; Collection profiles will continue automatically.",
          retryAfterSeconds: seconds,
        }),
    );
    if (
      response.schemaVersion !== "poapin-collection-profiles-v1" ||
      response.snapshotId !== manifest.snapshots.collections ||
      response.releaseId !== manifest.sources.collections.releaseId
    ) {
      throw new Error("The Collection profile snapshot changed during export.");
    }
    const expectedIds = new Set(ids);
    for (const profile of response.profiles) {
      const collectionId = profile.collection.collectionId;
      if (!expectedIds.has(collectionId) || profiles.has(collectionId)) {
        throw new Error("A Collection profile did not match the requested ID set.");
      }
      profiles.set(collectionId, profile);
    }
    if (response.profiles.length !== ids.length) {
      throw new Error("One or more public Collection profiles were unavailable.");
    }
    onProgress({
      stage: "profiles",
      current: profiles.size,
      total: collectionIds.length,
      detail: `${profiles.size.toLocaleString("en")} of ${collectionIds.length.toLocaleString("en")} Collection profiles read`,
    });
  }
  return [...profiles.values()].sort(
    (left, right) => left.collection.collectionId - right.collection.collectionId,
  );
}

async function collectOwnedCollectionData(
  ownedSummaries: CollectionSummary[],
  profiles: Map<number, CollectionProfile>,
  manifest: PersonalExportManifest,
  pacer: RequestPacer,
  signal: AbortSignal,
  onProgress: (progress: PersonalExportProgress) => void,
): Promise<OwnedCollectionArchive[]> {
  const output: OwnedCollectionArchive[] = [];
  for (let index = 0; index < ownedSummaries.length; index += 1) {
    const summary = ownedSummaries[index];
    const collectionId = summary.collectionId;
    const profile = profiles.get(collectionId);
    if (!profile) throw new Error(`Collection ${collectionId} is missing its public profile.`);
    const exportManifest = await pacedRequest(
      pacer,
      signal,
      () => getCollectionExportManifest(collectionId, signal),
      (seconds) =>
        onProgress({
          stage: "owned-collection-data",
          current: index,
          total: ownedSummaries.length,
          detail: `Waiting to continue Collection ${collectionId}…`,
          retryAfterSeconds: seconds,
        }),
    );
    if (
      exportManifest.schemaVersion !== "poapin-collection-export-v1" ||
      exportManifest.snapshotId !== manifest.snapshots.collections ||
      exportManifest.releaseId !== manifest.sources.collections.releaseId ||
      exportManifest.collectionId !== collectionId
    ) {
      throw new Error(`Collection ${collectionId} changed during export.`);
    }
    assertCollectionExportManifest(exportManifest);

    const segments: OwnedCollectionArchive["segments"] = {};
    for (const segment of exportManifest.segments) {
      if (segment.name === "metadata") continue;
      const segmentItems: unknown[] = [];
      const recordIds = new Set<string>();
      let path: string | null = segment.path;
      const seenPaths = new Set<string>();
      while (path) {
        if (seenPaths.has(path)) {
          throw new Error(`Collection ${collectionId} repeated an export page.`);
        }
        seenPaths.add(path);
        const page = await pacedRequest(
          pacer,
          signal,
          () => getCollectionExportPath<unknown>(path!, signal),
          (seconds) =>
            onProgress({
              stage: "owned-collection-data",
              current: index,
              total: ownedSummaries.length,
              detail: `Waiting to continue Collection ${collectionId}…`,
              retryAfterSeconds: seconds,
            }),
        );
        if (
          page.schemaVersion !== "poapin-collection-export-v1" ||
          page.snapshotId !== manifest.snapshots.collections ||
          page.releaseId !== manifest.sources.collections.releaseId ||
          page.segment !== segment.name ||
          page.collectionId !== collectionId
        ) {
          throw new Error(`Collection ${collectionId} changed during export.`);
        }
        for (const item of page.items) {
          const recordId = collectionSegmentRecordId(segment.name, item);
          if (recordIds.has(recordId)) {
            throw new Error(`Collection ${collectionId} repeated a ${segment.name} record.`);
          }
          recordIds.add(recordId);
          segmentItems.push(item);
        }
        path = page.nextPath;
      }
      if (segmentItems.length !== segment.count) {
        throw new Error(
          `Collection ${collectionId} ${segment.name} ended at ${segmentItems.length} of ${segment.count} records.`,
        );
      }
      segments[segment.name] = segmentItems;
    }
    output.push({ collectionId, manifest: exportManifest, profile, segments });
    onProgress({
      stage: "owned-collection-data",
      current: index + 1,
      total: ownedSummaries.length,
      detail: `${index + 1} of ${ownedSummaries.length} historically owned Collections fully read`,
    });
  }
  return output;
}

async function collectReferencedDrops(
  initialDrops: Drop[],
  initialUnavailableDropIds: number[],
  authoredMoments: MomentDetail[],
  taggedMoments: MomentDetail[],
  ownedCollections: OwnedCollectionArchive[],
  manifest: PersonalExportManifest,
  pacer: RequestPacer,
  signal: AbortSignal,
  onProgress: (progress: PersonalExportProgress) => void,
): Promise<{ drops: Drop[]; unavailableDropIds: number[] }> {
  const dropById = new Map<number, Drop>();
  const referencedDropIds = new Set<number>();
  const unavailableDropIds = new Set<number>();
  for (const drop of initialDrops) {
    assertPositiveDropId(drop.dropId);
    if (dropById.has(drop.dropId)) {
      throw new Error("The personal export repeated a normalized Drop.");
    }
    dropById.set(drop.dropId, drop);
    referencedDropIds.add(drop.dropId);
  }
  for (const dropId of initialUnavailableDropIds) {
    assertPositiveDropId(dropId);
    if (dropById.has(dropId) || unavailableDropIds.has(dropId)) {
      throw new Error("The holdings export returned overlapping Drop availability.");
    }
    unavailableDropIds.add(dropId);
    referencedDropIds.add(dropId);
  }
  for (const moment of [...authoredMoments, ...taggedMoments]) {
    for (const dropId of moment.dropIds) {
      assertPositiveDropId(dropId);
      referencedDropIds.add(dropId);
    }
  }
  for (const collection of ownedCollections) {
    for (const records of Object.values(collection.segments)) {
      for (const record of records ?? []) {
        for (const dropId of collectionRecordDropIds(record)) {
          assertPositiveDropId(dropId);
          referencedDropIds.add(dropId);
        }
      }
    }
  }

  const missingDropIds = [...referencedDropIds]
    .filter((dropId) => !dropById.has(dropId) && !unavailableDropIds.has(dropId))
    .sort((left, right) => left - right);
  const batches = chunk(missingDropIds, DROP_DETAIL_BATCH_SIZE);
  let processed = referencedDropIds.size - missingDropIds.length;
  onProgress({
    stage: "drops",
    current: processed,
    total: referencedDropIds.size,
    detail: `${processed.toLocaleString("en")} of ${referencedDropIds.size.toLocaleString("en")} referenced Drop records available`,
  });

  for (const requestedDropIds of batches) {
    const response = await pacedRequest(
      pacer,
      signal,
      () => getDropDetailsBatch(requestedDropIds, signal),
      (seconds) =>
        onProgress({
          stage: "drops",
          current: processed,
          total: referencedDropIds.size,
          detail: "The archive is busy; public Drop details will continue automatically.",
          retryAfterSeconds: seconds,
        }),
    );
    if (
      response.schemaVersion !== "poapin-drop-detail-batch-v1" ||
      response.snapshotId !== manifest.snapshots.holdings ||
      !sameIntegerSet(response.requestedDropIds, requestedDropIds)
    ) {
      throw new Error("The Drop detail response did not match the requested snapshot.");
    }
    const allowed = new Set(requestedDropIds);
    const returned = new Set<number>();
    for (const drop of response.drops) {
      assertPositiveDropId(drop.dropId);
      if (!allowed.has(drop.dropId) || returned.has(drop.dropId) || dropById.has(drop.dropId)) {
        throw new Error("The Drop detail export returned an unexpected or repeated Drop.");
      }
      returned.add(drop.dropId);
      dropById.set(drop.dropId, drop);
    }
    for (const dropId of response.unavailableDropIds) {
      assertPositiveDropId(dropId);
      if (!allowed.has(dropId) || returned.has(dropId) || unavailableDropIds.has(dropId)) {
        throw new Error("The Drop detail export returned an invalid unavailable ID.");
      }
      returned.add(dropId);
      unavailableDropIds.add(dropId);
    }
    if (returned.size !== requestedDropIds.length) {
      throw new Error("The Drop detail export omitted a requested ID.");
    }
    processed += requestedDropIds.length;
    onProgress({
      stage: "drops",
      current: processed,
      total: referencedDropIds.size,
      detail: `${processed.toLocaleString("en")} of ${referencedDropIds.size.toLocaleString("en")} referenced Drop records resolved`,
    });
  }

  return {
    drops: [...dropById.values()].sort((left, right) => left.dropId - right.dropId),
    unavailableDropIds: [...unavailableDropIds].sort((left, right) => left - right),
  };
}

function collectionRecordDropIds(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const output: number[] = [];
  if (typeof record.dropId === "number") output.push(record.dropId);
  if (
    record.drop &&
    typeof record.drop === "object" &&
    typeof (record.drop as Record<string, unknown>).dropId === "number"
  ) {
    output.push((record.drop as Record<string, number>).dropId);
  }
  return output;
}

function assertPositiveDropId(dropId: number): void {
  if (!Number.isSafeInteger(dropId) || dropId <= 0) {
    throw new Error("The personal export contains an invalid Drop ID.");
  }
}

function buildAuthoredMomentAssociations(
  moments: MomentDetail[],
): AuthoredMomentCollectionAssociation[] {
  const associations = new Map<number, Set<string>>();
  for (const moment of moments) {
    for (const collectionId of moment.collectionIds) {
      const momentIds = associations.get(collectionId) ?? new Set<string>();
      momentIds.add(moment.momentId);
      associations.set(collectionId, momentIds);
    }
  }
  return [...associations.entries()]
    .map(([collectionId, momentIds]) => ({
      collectionId,
      momentIds: [...momentIds].sort(),
    }))
    .sort((left, right) => left.collectionId - right.collectionId);
}

function assertCollectionExportManifest(manifest: CollectionExportManifest): void {
  const counts = {
    metadata: 1,
    items: manifest.counts.items,
    "artist-drops": manifest.counts.artistDrops,
    suggestions: manifest.counts.suggestions,
    "drop-stats": manifest.counts.dropStats,
  } satisfies Record<CollectionExportManifest["segments"][number]["name"], number>;
  const names = new Set<string>();
  for (const segment of manifest.segments) {
    if (
      names.has(segment.name) ||
      !nonNegativeInteger(segment.count) ||
      segment.count !== counts[segment.name]
    ) {
      throw new Error(`Collection ${manifest.collectionId} has an invalid export manifest.`);
    }
    names.add(segment.name);
  }
  if (!names.has("metadata") || !names.has("items")) {
    throw new Error(`Collection ${manifest.collectionId} has an incomplete export manifest.`);
  }
  for (const [name, count] of Object.entries(counts)) {
    if (count > 0 && !names.has(name)) {
      throw new Error(`Collection ${manifest.collectionId} is missing its ${name} segment.`);
    }
  }
}

function collectionSegmentRecordId(
  segment: Exclude<CollectionExportManifest["segments"][number]["name"], "metadata">,
  value: unknown,
): string {
  if (!value || typeof value !== "object") {
    throw new Error(`Collection ${segment} segment returned an invalid record.`);
  }
  const record = value as Record<string, unknown>;
  if (segment === "items" && Number.isSafeInteger(record.itemId)) {
    return String(record.itemId);
  }
  if (
    segment === "artist-drops" &&
    typeof record.artistId === "string" &&
    record.artistId.length > 0 &&
    Number.isSafeInteger(record.dropId)
  ) {
    return `${record.artistId}\u0000${record.dropId}`;
  }
  if (segment === "suggestions" && Number.isSafeInteger(record.suggestionId)) {
    return String(record.suggestionId);
  }
  if (segment === "drop-stats" && Number.isSafeInteger(record.dropId)) {
    return String(record.dropId);
  }
  throw new Error(`Collection ${segment} segment returned a record without a stable ID.`);
}

async function pacedRequest<T>(
  pacer: RequestPacer,
  signal: AbortSignal,
  request: () => Promise<T>,
  onRateLimit: (retryAfterSeconds: number) => void,
): Promise<T> {
  let retries = 0;
  for (;;) {
    signal.throwIfAborted();
    await pacer.wait(signal);
    pacer.markStarted();
    try {
      return await request();
    } catch (cause) {
      if (
        !(cause instanceof ApiError) ||
        cause.status !== 429 ||
        retries >= MAX_RATE_LIMIT_RETRIES
      ) {
        throw cause;
      }
      retries += 1;
      const retryAfterMs = Math.max(
        cause.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS,
        OWNER_INTERVAL_MS,
      );
      onRateLimit(Math.ceil(retryAfterMs / 1_000));
      await abortableWait(retryAfterMs, signal);
    }
  }
}

function createPacer(intervalMs: number): RequestPacer {
  let lastStartedAt: number | null = null;
  return {
    async wait(signal) {
      if (lastStartedAt === null) return;
      await abortableWait(Math.max(0, intervalMs - (Date.now() - lastStartedAt)), signal);
    },
    markStarted() {
      lastStartedAt = Date.now();
    },
  };
}

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(done, milliseconds);
    signal.addEventListener("abort", aborted, { once: true });
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      window.clearTimeout(timeout);
      reject(signal.reason);
    }
  });
}

function checkedNextCursor(
  nextCursor: string | null,
  seen: Set<string>,
  label: string,
): string | null {
  if (!nextCursor) return null;
  if (seen.has(nextCursor)) throw new Error(`The ${label} cursor repeated.`);
  seen.add(nextCursor);
  return nextCursor;
}

function assertPersonalManifest(manifest: PersonalExportManifest, address: string): void {
  if (
    manifest.schemaVersion !== "poapin-personal-export-v1" ||
    manifest.address !== address ||
    !manifest.snapshots.holdings ||
    !manifest.snapshots.collections ||
    !manifest.snapshots.moments ||
    !manifest.sources ||
    !manifest.sources.holdings ||
    !manifest.sources.collections ||
    !manifest.sources.moments ||
    manifest.sources.holdings.snapshotId !== manifest.snapshots.holdings ||
    manifest.sources.collections.snapshotId !== manifest.snapshots.collections ||
    !manifest.sources.collections.releaseId ||
    manifest.sources.moments.snapshotId !== manifest.snapshots.moments ||
    !manifest.sources.moments.releaseId ||
    !/^[0-9a-f]{64}$/.test(manifest.sources.moments.sourceDatabaseSha256) ||
    !/^[0-9a-f]{64}$/.test(manifest.sources.moments.buildManifestSha256) ||
    !nonNegativeInteger(manifest.counts.holdings) ||
    !nonNegativeInteger(manifest.counts.authoredMoments) ||
    !nonNegativeInteger(manifest.counts.taggedMoments) ||
    !nonNegativeInteger(manifest.counts.ownedCollections) ||
    !nonNegativeInteger(manifest.counts.ownedCapsules)
  ) {
    throw new Error("The personal export manifest is incomplete or belongs to another address.");
  }
}

function nonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameIntegerSet(left: number[], right: number[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return new Set(left).size === left.length && left.every((value) => expected.has(value));
}

function chunk<T>(items: T[], size: number): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < items.length; offset += size) {
    output.push(items.slice(offset, offset + size));
  }
  return output;
}
