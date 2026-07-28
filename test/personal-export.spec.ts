import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectPersonalArchive,
  type PersonalExportProgress,
} from "../src/react-app/personal-export";
import type {
  CollectionProfile,
  Drop,
  DropDetailBatchResponse,
  Holding,
  MomentCapsule,
  MomentDetail,
  PersonalHoldingReference,
  PersonalExportManifest,
} from "../src/react-app/types";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const SNAPSHOTS = {
  holdings: "holdings-snapshot",
  collections: "collections-snapshot",
  moments: "moments-snapshot",
};
const COLLECTIONS_RELEASE = "collections-release";
const MOMENTS_RELEASE = "moments-release";
const MOMENTS_SOURCE_SHA256 = "a".repeat(64);
const MOMENTS_BUILD_SHA256 = "b".repeat(64);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("personal archive browser collector", () => {
  it("joins complete paginated sources while preserving relationship semantics", async () => {
    installFetchFixture();
    const progress: PersonalExportProgress[] = [];
    const result = await collectPersonalArchive(
      ADDRESS,
      new AbortController().signal,
      (value) => progress.push(value),
      { ownerIntervalMs: 0, browseIntervalMs: 0 },
    );

    expect(result.holdings).toEqual([holdingReference()]);
    expect(result.drops).toEqual([drop(), referencedDrop(77)]);
    expect(result.unavailableDropIds).toEqual([88]);
    expect(result.authoredMoments).toEqual([moment()]);
    expect(result.taggedMoments).toEqual([taggedMoment()]);
    expect(result.ownedCapsules).toEqual([capsule()]);
    expect(result.heldDropMemberships).toEqual([
      {
        collection: profile().collection,
        matchedDropIds: [42],
      },
    ]);
    expect(result.collectionProfiles).toEqual([profile()]);
    expect(result.ownedCollections).toEqual([]);
    expect(result.authoredMomentAssociations).toEqual([
      { collectionId: 7, momentIds: ["moment-1"] },
    ]);
    expect(result.taggedMomentAssociations).toEqual([
      { collectionId: 7, momentIds: ["moment-tagged"] },
    ]);
    expect(progress.map((entry) => entry.stage)).toEqual(
      expect.arrayContaining([
        "manifest",
        "holdings",
        "moments",
        "tagged-moments",
        "capsules",
        "drops",
        "memberships",
        "owned-collections",
        "profiles",
      ]),
    );
  });

  it("stops when a paginated source changes snapshot", async () => {
    installFetchFixture({ holdingsSnapshot: "different-snapshot" });
    await expect(
      collectPersonalArchive(ADDRESS, new AbortController().signal, () => undefined, {
        ownerIntervalMs: 0,
        browseIntervalMs: 0,
      }),
    ).rejects.toThrow("holdings snapshot changed");
  });

  it("keeps an unavailable held Drop out of public details without losing its membership", async () => {
    installFetchFixture({
      holdingsDrops: [],
      holdingsUnavailableDropIds: [42],
    });

    const result = await collectPersonalArchive(
      ADDRESS,
      new AbortController().signal,
      () => undefined,
      { ownerIntervalMs: 0, browseIntervalMs: 0 },
    );

    expect(result.drops.map((item) => item.dropId)).toEqual([77]);
    expect(result.unavailableDropIds).toEqual([42, 88]);
    expect(result.heldDropMemberships).toEqual([
      {
        collection: profile().collection,
        matchedDropIds: [42],
      },
    ]);
  });

  it.each([
    ["omits an ID", { drops: [], unavailableDropIds: [88] }, "omitted a requested ID"],
    [
      "returns an extra ID",
      { drops: [referencedDrop(77), referencedDrop(99)], unavailableDropIds: [88] },
      "unexpected or repeated Drop",
    ],
    [
      "duplicates a public ID",
      { drops: [referencedDrop(77), referencedDrop(77)], unavailableDropIds: [88] },
      "unexpected or repeated Drop",
    ],
    [
      "overlaps public and unavailable IDs",
      { drops: [referencedDrop(77)], unavailableDropIds: [77, 88] },
      "invalid unavailable ID",
    ],
    [
      "changes snapshot",
      { snapshotId: "different-holdings-snapshot" },
      "did not match the requested snapshot",
    ],
  ] satisfies Array<[string, Partial<DropDetailBatchResponse>, string]>)(
    "rejects a Drop batch that $0",
    async (_label, dropBatch, message) => {
      installFetchFixture({ dropBatch });

      await expect(
        collectPersonalArchive(ADDRESS, new AbortController().signal, () => undefined, {
          ownerIntervalMs: 0,
          browseIntervalMs: 0,
        }),
      ).rejects.toThrow(message);
    },
  );

  it("resolves an owned Collection Drop from drop-stats when its item card is null", async () => {
    installFetchFixture({ ownedCollectionDropId: 66 });

    const result = await collectPersonalArchive(
      ADDRESS,
      new AbortController().signal,
      () => undefined,
      { ownerIntervalMs: 0, browseIntervalMs: 0 },
    );

    expect(result.ownedCollections[0]?.segments.items).toEqual([
      {
        itemId: 1,
        createdOn: null,
        sections: [],
        drop: null,
      },
    ]);
    expect(result.ownedCollections[0]?.segments["drop-stats"]).toEqual([{ dropId: 66 }]);
    expect(result.drops.map((item) => item.dropId)).toEqual([42, 66, 77]);
    expect(result.unavailableDropIds).toEqual([88]);
  });

  it("starts no network work for an already cancelled export", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    controller.abort();
    await expect(
      collectPersonalArchive(ADDRESS, controller.signal, () => undefined, {
        ownerIntervalMs: 0,
        browseIntervalMs: 0,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

interface FetchFixtureOptions {
  holdingsSnapshot?: string;
  holdingsDrops?: Drop[];
  holdingsUnavailableDropIds?: number[];
  dropBatch?: Partial<DropDetailBatchResponse>;
  ownedCollectionDropId?: number;
}

function installFetchFixture(options: FetchFixtureOptions = {}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url, "https://poap.in");
    if (url.pathname.endsWith("/export/manifest")) {
      return json(manifest(options.ownedCollectionDropId === undefined ? 0 : 1));
    }
    if (url.pathname.endsWith("/export/holdings")) {
      return json({
        schemaVersion: "poapin-personal-holdings-page-v2",
        snapshotId: options.holdingsSnapshot ?? SNAPSHOTS.holdings,
        collectionsSnapshotId: SNAPSHOTS.collections,
        collectionsReleaseId: COLLECTIONS_RELEASE,
        address: ADDRESS,
        total: 1,
        items: [holdingReference()],
        drops: options.holdingsDrops ?? [drop()],
        unavailableDropIds: options.holdingsUnavailableDropIds ?? [],
        nextCursor: null,
      });
    }
    if (url.pathname.endsWith(`/moments/authors/${ADDRESS}/export`)) {
      return json({
        schemaVersion: "poapin-moment-author-export-v1",
        snapshotId: SNAPSHOTS.moments,
        releaseId: MOMENTS_RELEASE,
        sourceDatabaseSha256: MOMENTS_SOURCE_SHA256,
        buildManifestSha256: MOMENTS_BUILD_SHA256,
        author: ADDRESS,
        items: [moment()],
        nextCursor: null,
      });
    }
    if (url.pathname.endsWith(`/moments/tags/${ADDRESS}/export`)) {
      return json({
        schemaVersion: "poapin-moment-tagged-export-v1",
        snapshotId: SNAPSHOTS.moments,
        releaseId: MOMENTS_RELEASE,
        sourceDatabaseSha256: MOMENTS_SOURCE_SHA256,
        buildManifestSha256: MOMENTS_BUILD_SHA256,
        address: ADDRESS,
        items: [taggedMoment()],
        nextCursor: null,
      });
    }
    if (url.pathname.endsWith(`/capsules/owners/${ADDRESS}/export`)) {
      return json({
        schemaVersion: "poapin-capsule-owner-export-v1",
        snapshotId: SNAPSHOTS.moments,
        releaseId: MOMENTS_RELEASE,
        sourceDatabaseSha256: MOMENTS_SOURCE_SHA256,
        buildManifestSha256: MOMENTS_BUILD_SHA256,
        address: ADDRESS,
        items: [capsule()],
        nextCursor: null,
      });
    }
    if (url.pathname === "/api/drops/export/batch") {
      const requestedDropIds =
        options.ownedCollectionDropId === undefined
          ? [77, 88]
          : [options.ownedCollectionDropId, 77, 88];
      expect(url.searchParams.get("ids")).toBe(requestedDropIds.join(","));
      const response: DropDetailBatchResponse = {
        schemaVersion: "poapin-drop-detail-batch-v1",
        snapshotId: SNAPSHOTS.holdings,
        requestedDropIds,
        drops: requestedDropIds.filter((dropId) => dropId !== 88).map(referencedDrop),
        unavailableDropIds: [88],
        ...options.dropBatch,
      };
      return json(response);
    }
    if (url.pathname === "/api/collections/resolve") {
      return json({
        schemaVersion: "poapin-collection-memberships-v1",
        snapshotId: SNAPSHOTS.collections,
        releaseId: COLLECTIONS_RELEASE,
        requestedDropIds: [42],
        memberships: [{ collection: profile().collection, matchedDropIds: [42] }],
      });
    }
    if (url.pathname.endsWith(`/collections/owners/${ADDRESS}/export`)) {
      return json({
        schemaVersion: "poapin-owned-collections-page-v1",
        snapshotId: SNAPSHOTS.collections,
        releaseId: COLLECTIONS_RELEASE,
        address: ADDRESS,
        items: options.ownedCollectionDropId === undefined ? [] : [profile().collection],
        nextCursor: null,
      });
    }
    if (url.pathname === "/api/collections/export/batch") {
      return json({
        schemaVersion: "poapin-collection-profiles-v1",
        snapshotId: SNAPSHOTS.collections,
        releaseId: COLLECTIONS_RELEASE,
        profiles: [profile()],
      });
    }
    if (url.pathname === "/api/collections/7/export") {
      return json({
        schemaVersion: "poapin-collection-export-v1",
        snapshotId: SNAPSHOTS.collections,
        releaseId: COLLECTIONS_RELEASE,
        collectionId: 7,
        counts: {
          items: 1,
          sections: 0,
          urls: 0,
          media: 0,
          artistDrops: 0,
          suggestions: 0,
          dropStats: 1,
        },
        segments: [
          {
            name: "metadata",
            path: "/api/collections/7/export/metadata",
            pagination: "none",
            count: 1,
          },
          {
            name: "items",
            path: "/api/collections/7/export/items?limit=48",
            pagination: "cursor",
            count: 1,
            pageSize: 48,
          },
          {
            name: "drop-stats",
            path: "/api/collections/7/export/drop-stats?limit=48",
            pagination: "cursor",
            count: 1,
            pageSize: 48,
          },
        ],
      });
    }
    if (url.pathname === "/api/collections/7/export/items") {
      return json({
        schemaVersion: "poapin-collection-export-v1",
        snapshotId: SNAPSHOTS.collections,
        releaseId: COLLECTIONS_RELEASE,
        segment: "items",
        collectionId: 7,
        items: [{ itemId: 1, createdOn: null, sections: [], drop: null }],
        nextPath: null,
      });
    }
    if (url.pathname === "/api/collections/7/export/drop-stats") {
      return json({
        schemaVersion: "poapin-collection-export-v1",
        snapshotId: SNAPSHOTS.collections,
        releaseId: COLLECTIONS_RELEASE,
        segment: "drop-stats",
        collectionId: 7,
        items: [{ dropId: options.ownedCollectionDropId }],
        nextPath: null,
      });
    }
    return json({ error: `Unexpected test path: ${url.pathname}` }, 404);
  });
}

function manifest(ownedCollections = 0): PersonalExportManifest {
  return {
    schemaVersion: "poapin-personal-export-v1",
    address: ADDRESS,
    snapshots: SNAPSHOTS,
    sources: {
      holdings: {
        snapshotId: SNAPSHOTS.holdings,
      },
      collections: {
        snapshotId: SNAPSHOTS.collections,
        releaseId: COLLECTIONS_RELEASE,
      },
      moments: {
        snapshotId: SNAPSHOTS.moments,
        releaseId: MOMENTS_RELEASE,
        sourceDatabaseSha256: MOMENTS_SOURCE_SHA256,
        buildManifestSha256: MOMENTS_BUILD_SHA256,
      },
    },
    counts: {
      holdings: 1,
      authoredMoments: 1,
      taggedMoments: 1,
      ownedCollections,
      ownedCapsules: 1,
    },
    segments: {
      holdings: {
        path: `/api/owners/${ADDRESS}/export/holdings?limit=480`,
        pageSize: 480,
      },
      ownedCollections: {
        path: `/api/collections/owners/${ADDRESS}/export?limit=48`,
        pageSize: 48,
      },
      moments: {
        path: `/api/moments/authors/${ADDRESS}/export?limit=48`,
        pageSize: 48,
      },
      taggedMoments: {
        path: `/api/moments/tags/${ADDRESS}/export?limit=48`,
        pageSize: 48,
      },
      ownedCapsules: {
        path: `/api/capsules/owners/${ADDRESS}/export?limit=48`,
        pageSize: 48,
      },
    },
  };
}

function holding(): Holding {
  return {
    sourceUid: "source-1",
    poapId: 1,
    dropId: 42,
    mintedOn: 1_700_000_000,
    ownerAddress: ADDRESS,
    network: "ethereum",
    transferCount: 0,
    fancyId: "portable",
    title: "Portable POAP",
    description: "A complete public Drop projection.",
    startDate: "2026-07-23T00:00:00.000Z",
    endDate: "2026-07-23T01:00:00.000Z",
    city: null,
    country: null,
    year: 2026,
    isVirtual: true,
    eventUrl: "https://poap.in",
    imageUrl: "https://media.poap.in/artwork/42.webp",
  };
}

function holdingReference(): PersonalHoldingReference {
  return {
    sourceUid: "source-1",
    poapId: 1,
    dropId: 42,
    mintedOn: 1_700_000_000,
    ownerAddress: ADDRESS,
    network: "ethereum",
    transferCount: 0,
  };
}

function drop(): Drop {
  const {
    sourceUid: _sourceUid,
    poapId: _poapId,
    mintedOn: _mintedOn,
    ownerAddress: _ownerAddress,
    network: _network,
    transferCount: _transferCount,
    ...drop
  } = holding();
  return drop;
}

function referencedDrop(dropId: number): Drop {
  return {
    dropId,
    fancyId: `referenced-${dropId}`,
    title: `Referenced Drop ${dropId}`,
    description: "A public Drop referenced by a Moment.",
    startDate: "2026-07-22T00:00:00.000Z",
    endDate: "2026-07-22T01:00:00.000Z",
    city: null,
    country: null,
    year: 2026,
    isVirtual: true,
    eventUrl: "https://poap.in",
    channel: null,
    platform: null,
    locationType: "virtual",
    timezone: "UTC",
    createdAt: "2026-07-22T00:00:00.000Z",
    imageUrl: `https://media.poap.in/artwork/${dropId}.webp`,
    hasArtwork: true,
    tokenCount: 1,
    reservationsTotal: 0,
    reservationsMinted: 0,
    reservationsUnminted: 0,
  };
}

function moment(): MomentDetail {
  return {
    momentId: "moment-1",
    displayId: "Moment one",
    author: ADDRESS,
    description: null,
    createdOn: "2026-07-23T00:00:00.000Z",
    updatedOn: null,
    isUpdated: false,
    sourceMediaCount: 0,
    mediaCount: 0,
    mediaPreservationState: "none",
    previewMedia: null,
    dropIds: [42],
    collectionIds: [7],
    cid: null,
    tokenId: null,
    media: [],
    links: [],
    userTags: [],
    capsules: [],
  };
}

function taggedMoment(): MomentDetail {
  return {
    ...moment(),
    momentId: "moment-tagged",
    displayId: "Tagged moment",
    author: "0x2222222222222222222222222222222222222222",
    dropIds: [42, 77, 88],
    userTags: [
      {
        tagId: "tag-1",
        address: ADDRESS,
        ens: null,
        x: null,
        y: null,
        createdOn: "2026-07-23T00:00:00.000Z",
      },
    ],
  };
}

function capsule(): MomentCapsule {
  return {
    capsuleId: 99,
    externalId: "portable-capsule",
    title: "Portable Capsule",
    description: "A public Capsule owned by the exported address.",
    imageUrl: "https://media.poap.in/capsules/99.webp",
    url: "https://poap.in",
    owner: ADDRESS,
    createdOn: "2026-07-23T00:00:00.000Z",
  };
}

function profile(): CollectionProfile {
  return {
    snapshotId: SNAPSHOTS.collections,
    collection: {
      collectionId: 7,
      slug: "portable",
      title: "Portable Collection",
      description: null,
      type: "user",
      year: 2026,
      updatedOn: "2026-07-23T00:00:00.000Z",
      itemCount: 1,
      sectionCount: 0,
      logoUrl: null,
      bannerUrl: null,
      isFeatured: false,
      isVerified: false,
      typeRank: null,
      ownerAddress: null,
      externalUrl: null,
      createdOn: "2026-07-23T00:00:00.000Z",
      featuredOn: null,
      verification: null,
    },
    urls: [],
    uiSettings: null,
    media: [],
    sections: [],
    artists: [],
    organizations: [],
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
