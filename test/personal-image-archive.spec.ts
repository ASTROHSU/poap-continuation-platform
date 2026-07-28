import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it, vi } from "vitest";
import {
  buildMediaArchivePlan,
  createPersonalImageArchiveZip,
  PERSONAL_IMAGE_ARCHIVE_BLOB_LIMIT_BYTES,
  personalImageArchiveFilename,
  type PersonalImageArchivePlan,
} from "../src/react-app/personal-image-archive";
import type {
  OwnedCollectionArchive,
  PersonalArchiveSnapshot,
} from "../src/react-app/personal-export";
import type { CollectionProfile, Drop, MomentDetail } from "../src/react-app/types";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const SNAPSHOTS = {
  catalog: "catalog-2026-07-02-v1",
  holdings: "holdings-2026-07-28-v1",
  collections: "collections-2026-07-14-v1",
  moments: "moments-2026-07-23-v1",
};
const encoder = new TextEncoder();

describe("personal image archive planning", () => {
  it("enumerates every archived image family, deduplicates objects, and preserves references", () => {
    const dropUrl = artworkUrl(42);
    const collectionLogo = collectionUrl("media", hash("a"), "webp");
    const collectionDrop = collectionUrl("drop-artwork", hash("b"), "png");
    const momentOriginal = momentUrl("original", hash("c"), "jpg");
    const momentThumbnail = momentUrl("thumbnail", hash("d"), "webp");
    const momentHeic = momentUrl("original", hash("e"), "heic");
    const momentDng = momentUrl("original", hash("f"), "dng");
    const relatedImage = momentUrl("original", hash("1"), "png");
    const ownedCapsuleImage = momentUrl("original", hash("2"), "avif");
    const profile = collectionProfile(collectionLogo);
    const moment = momentDetail({
      previewUrl: momentOriginal,
      thumbnailUrl: momentThumbnail,
      imageUrl: momentOriginal,
      heicUrl: momentHeic,
      dngUrl: momentDng,
      relatedImage,
    });
    const snapshot = personalSnapshot({
      drops: [drop(42, dropUrl)],
      collectionProfiles: [profile],
      ownedCollections: [ownedCollection(profile, dropUrl, collectionDrop)],
      authoredMoments: [moment],
      taggedMoments: [moment],
      ownedCapsules: [
        {
          capsuleId: 7,
          externalId: null,
          title: "Shared",
          description: null,
          imageUrl: relatedImage,
          url: "https://example.com/capsule",
          owner: ADDRESS,
          createdOn: "2026-07-23T00:00:00.000Z",
        },
        {
          capsuleId: 8,
          externalId: null,
          title: "Unique",
          description: null,
          imageUrl: ownedCapsuleImage,
          url: null,
          owner: ADDRESS,
          createdOn: "2026-07-23T00:00:00.000Z",
        },
      ],
    });

    const plan = buildMediaArchivePlan(snapshot);

    expect(plan.count).toBe(9);
    expect(plan.knownBytes).toBe(26);
    expect(plan.unknownByteLengthCount).toBe(5);
    expect(plan.breakdown).toEqual({
      poaps: 1,
      collections: 2,
      moments: 5,
      capsules: 1,
    });
    expect(plan.entries.map((entry) => entry.path)).toEqual(
      [...plan.entries.map((entry) => entry.path)].sort(),
    );

    const artwork = plan.entries.find((entry) => entry.url === dropUrl);
    expect(artwork?.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "drop-artwork", ownerId: "42" }),
        expect.objectContaining({ kind: "collection-drop-artwork", ownerId: "42" }),
      ]),
    );
    const logo = plan.entries.find((entry) => entry.url === collectionLogo);
    expect(logo?.expectedBytes).toBe(12);
    expect(logo?.references.map((reference) => reference.kind)).toEqual(
      expect.arrayContaining(["collection-logo", "collection-media"]),
    );
    const original = plan.entries.find((entry) => entry.url === momentOriginal);
    expect(original?.references.map((reference) => reference.kind)).toEqual(
      expect.arrayContaining(["moment-preview", "moment-media"]),
    );
    expect(
      original?.references.some((reference) => reference.context?.startsWith("authored:")),
    ).toBe(true);
    expect(original?.references.some((reference) => reference.context?.startsWith("tagged:"))).toBe(
      true,
    );
    const related = plan.entries.find((entry) => entry.url === relatedImage);
    expect(related?.references.map((reference) => reference.kind)).toEqual(
      expect.arrayContaining(["moment-link-image", "moment-capsule-image", "owned-capsule-image"]),
    );
  });

  it("includes address-bound hidden artwork stored in the Holdings snapshot", () => {
    const hiddenArtwork = holdingsUrl("drop-artwork", hash("9"), "png");
    const snapshot = personalSnapshot({
      drops: [
        {
          ...drop(228228, hiddenArtwork),
          isHidden: true,
        },
      ],
    });

    const plan = buildMediaArchivePlan(snapshot);

    expect(plan.count).toBe(1);
    expect(plan.breakdown.poaps).toBe(1);
    expect(plan.entries[0]).toMatchObject({
      url: hiddenArtwork,
      category: "poaps",
      references: [expect.objectContaining({ kind: "drop-artwork", ownerId: "228228" })],
    });
  });

  it("excludes external, mutable, wrong-snapshot, query-bearing, video, and unpublished media", () => {
    const badProfile = collectionProfile("https://images.example/logo.webp");
    badProfile.collection.bannerUrl = `${collectionUrl("media", hash("a"), "webp")}?size=2`;
    badProfile.media = [
      {
        ...badProfile.media[0]!,
        objectUrl: collectionUrl("media", hash("b"), "png"),
        eligibleForPublish: false,
      },
    ];
    const wrongMoment = momentDetail({
      previewUrl: momentUrl("original", hash("c"), "jpg").replace(
        SNAPSHOTS.moments,
        "moments-other",
      ),
      thumbnailUrl: null,
      imageUrl: momentUrl("original", hash("d"), "jpg"),
      heicUrl: null,
      dngUrl: null,
      relatedImage: "https://example.com/image.png",
    });
    wrongMoment.media = [
      {
        mediaId: "video-1",
        kind: "video",
        mimeType: "video/mp4",
        url: momentUrl("original", hash("e"), "mp4"),
        thumbnailUrl: null,
        byteLength: 10,
        durationMs: 1_000,
        position: 0,
        width: 10,
        height: 10,
      },
      {
        mediaId: "audio-1",
        kind: "audio",
        mimeType: "audio/mpeg",
        url: momentUrl("original", hash("f"), "mp3"),
        thumbnailUrl: null,
        byteLength: 10,
        durationMs: 1_000,
        position: 1,
        width: null,
        height: null,
      },
    ];

    const plan = buildMediaArchivePlan(
      personalSnapshot({
        drops: [
          drop(1, "https://images.example/1.webp"),
          drop(2, `${artworkUrl(2)}#mutable`),
          drop(3, artworkUrl(4)),
          { ...drop(5, artworkUrl(5)), hasArtwork: false },
        ],
        collectionProfiles: [badProfile],
        authoredMoments: [wrongMoment],
      }),
    );

    expect(plan.count).toBe(0);
    expect(plan.entries).toEqual([]);
  });

  it("includes archived thumbnails for non-image media without including their originals", () => {
    const thumbnailUrl = momentUrl("thumbnail", hash("9"), "webp");
    const videoUrl = momentUrl("original", hash("8"), "mp4");
    const moment = momentDetail({
      previewUrl: videoUrl,
      thumbnailUrl,
      imageUrl: videoUrl,
      heicUrl: null,
      dngUrl: null,
      relatedImage: null,
    });
    moment.previewMedia!.kind = "video";
    moment.previewMedia!.mimeType = "video/mp4";
    moment.media = [
      {
        mediaId: "video-1",
        kind: "video",
        mimeType: "video/mp4",
        url: videoUrl,
        thumbnailUrl,
        byteLength: 10,
        durationMs: 1_000,
        position: 0,
        width: 10,
        height: 10,
      },
    ];

    const plan = buildMediaArchivePlan(personalSnapshot({ authoredMoments: [moment] }));

    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      url: thumbnailUrl,
      expectedContentType: null,
    });
    expect(plan.entries[0]!.references.map((reference) => reference.kind)).toEqual([
      "moment-thumbnail",
      "moment-thumbnail",
    ]);
  });

  it("fails closed when immutable metadata conflicts with a content-addressed URL", () => {
    const profile = collectionProfile(collectionUrl("media", hash("a"), "webp"));
    profile.media[0]!.sha256 = hash("b");
    expect(() =>
      buildMediaArchivePlan(personalSnapshot({ collectionProfiles: [profile] })),
    ).toThrow("inconsistent SHA-256");

    const duplicate = momentUrl("original", hash("c"), "jpg");
    const authored = momentDetail({
      previewUrl: duplicate,
      thumbnailUrl: null,
      imageUrl: duplicate,
      heicUrl: null,
      dngUrl: null,
      relatedImage: null,
    });
    authored.previewMedia!.mimeType = "image/jpeg";
    authored.media[0]!.byteLength = 3;
    const tagged = structuredClone(authored);
    tagged.media[0]!.byteLength = 4;
    expect(() =>
      buildMediaArchivePlan(
        personalSnapshot({ authoredMoments: [authored], taggedMoments: [tagged] }),
      ),
    ).toThrow("conflicting byte lengths");
  });

  it("uses a stable, privacy-safe filename", () => {
    expect(personalImageArchiveFilename(ADDRESS.toUpperCase())).toBe(
      "poapin-all-images-0x111111-111111.zip",
    );
    expect(personalImageArchiveFilename("not an address")).toBe(
      "poapin-all-images-public-address.zip",
    );
  });
});

describe("personal image archive ZIP", () => {
  it("retries before an entry starts, streams files sequentially, and emits an auditable STORE ZIP", async () => {
    const plan = twoDropPlan();
    const first = encoder.encode("first-image");
    const second = encoder.encode("second-image");
    const calls: string[] = [];
    const waits: number[] = [];
    let firstAttempts = 0;
    const progress: Array<{
      completedFiles: number;
      totalFiles: number;
      downloadedBytes: number;
      currentPath: string | null;
    }> = [];

    const result = await createPersonalImageArchiveZip(
      plan,
      new AbortController().signal,
      (update) => progress.push(update),
      {
        maxAttempts: 2,
        wait: async (milliseconds) => {
          waits.push(milliseconds);
        },
        fetch: async (input, init) => {
          const url = String(input);
          calls.push(url);
          expect(init).toMatchObject({
            method: "GET",
            mode: "cors",
            credentials: "omit",
            redirect: "error",
          });
          if (url === plan.entries[0]!.url) {
            firstAttempts += 1;
            if (firstAttempts === 1) {
              return new Response("busy", { status: 503 });
            }
            return imageResponse(first, "image/webp");
          }
          expect(url).toBe(plan.entries[1]!.url);
          return imageResponse(second, "image/webp");
        },
      },
    );

    expect(waits).toEqual([500]);
    expect(calls).toEqual([plan.entries[0]!.url, plan.entries[0]!.url, plan.entries[1]!.url]);
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.fileCount).toBe(2);
    expect(result.downloadedBytes).toBe(first.byteLength + second.byteLength);
    expect(result.archiveBytes).toBeGreaterThan(result.downloadedBytes);
    expect(progress.at(-1)).toEqual({
      completedFiles: 2,
      totalFiles: 2,
      downloadedBytes: first.byteLength + second.byteLength,
      currentPath: null,
    });

    const archive = unzipSync(new Uint8Array(await result.blob!.arrayBuffer()));
    expect(Object.keys(archive).sort()).toEqual(
      ["README.md", "media-manifest.json", ...plan.entries.map((entry) => entry.path)].sort(),
    );
    expect(archive[plan.entries[0]!.path]).toEqual(first);
    expect(archive[plan.entries[1]!.path]).toEqual(second);
    const manifest = JSON.parse(strFromU8(archive["media-manifest.json"]!)) as {
      schemaVersion: string;
      entries: Array<{ bytes: number; references: unknown[] }>;
    };
    expect(manifest.schemaVersion).toBe("poapin-personal-image-archive-v1");
    expect(manifest.entries.map((entry) => entry.bytes)).toEqual([
      first.byteLength,
      second.byteLength,
    ]);
    expect(manifest.entries.every((entry) => entry.references.length > 0)).toBe(true);
  });

  it("writes to a supplied stream without retaining a Blob", async () => {
    const plan = oneDropPlan();
    const image = encoder.encode("streamed");
    const chunks: Uint8Array[] = [];
    let closed = false;
    const writable = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk.slice());
      },
      close() {
        closed = true;
      },
    });

    const result = await createPersonalImageArchiveZip(
      plan,
      new AbortController().signal,
      undefined,
      {
        writable,
        fetch: async () => imageResponse(image, "image/webp"),
      },
    );

    expect(result.blob).toBeNull();
    expect(closed).toBe(true);
    const archive = unzipSync(concat(chunks));
    expect(archive[plan.entries[0]!.path]).toEqual(image);
  });

  it("verifies content-addressed SHA-256 and records an observed hash for every image", async () => {
    const image = encoder.encode("content-addressed-image");
    const digest = bytesToHex(sha256(image));
    const url = momentUrl("original", digest, "jpg");
    const moment = momentDetail({
      previewUrl: url,
      thumbnailUrl: null,
      imageUrl: url,
      heicUrl: null,
      dngUrl: null,
      relatedImage: null,
    });
    moment.previewMedia!.mimeType = "image/jpeg";
    moment.media[0]!.mimeType = "image/jpeg";
    moment.media[0]!.byteLength = image.byteLength;
    const plan = buildMediaArchivePlan(personalSnapshot({ authoredMoments: [moment] }));

    const result = await createPersonalImageArchiveZip(
      plan,
      new AbortController().signal,
      undefined,
      {
        fetch: async () => imageResponse(image, "image/jpeg"),
      },
    );
    const archive = unzipSync(new Uint8Array(await result.blob!.arrayBuffer()));
    const manifest = JSON.parse(strFromU8(archive["media-manifest.json"]!)) as {
      entries: Array<{ sha256: string; expectedSha256: string | null }>;
    };
    expect(manifest.entries).toEqual([
      expect.objectContaining({ sha256: digest, expectedSha256: digest }),
    ]);

    const corrupted = image.slice();
    corrupted[0] ^= 0xff;
    await expect(
      createPersonalImageArchiveZip(plan, new AbortController().signal, undefined, {
        fetch: async () => imageResponse(corrupted, "image/jpeg"),
      }),
    ).rejects.toThrow("content-addressed SHA-256");
  });

  it("aborts the output and never completes a partial archive after a body failure", async () => {
    const plan = oneDropPlan();
    const bodyFailure = new Error("connection lost");
    let abortedWith: unknown;
    let closed = false;
    const writable = new WritableStream<Uint8Array>({
      close() {
        closed = true;
      },
      abort(reason) {
        abortedWith = reason;
      },
    });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("partial"));
        controller.error(bodyFailure);
      },
    });

    await expect(
      createPersonalImageArchiveZip(plan, new AbortController().signal, undefined, {
        writable,
        fetch: async () =>
          new Response(body, {
            status: 200,
            headers: {
              "Content-Type": "image/webp",
              "Content-Length": "999",
            },
          }),
      }),
    ).rejects.toThrow("connection lost");
    expect(closed).toBe(false);
    expect(abortedWith).toBe(bodyFailure);
  });

  it("rejects missing metadata, byte-mismatched, and non-image responses", async () => {
    const plan = oneDropPlan();
    const expectedPlan: PersonalImageArchivePlan = structuredClone(plan);
    expectedPlan.entries[0]!.expectedBytes = 4;
    expectedPlan.knownBytes = 4;
    expectedPlan.unknownByteLengthCount = 0;

    await expect(
      createPersonalImageArchiveZip(plan, new AbortController().signal, undefined, {
        fetch: async () =>
          new Response(new Uint8Array(), {
            headers: { "Content-Type": "image/webp" },
          }),
      }),
    ).rejects.toThrow("missing or invalid Content-Length");
    await expect(
      createPersonalImageArchiveZip(expectedPlan, new AbortController().signal, undefined, {
        fetch: async () => imageResponse(encoder.encode("three"), "image/webp"),
      }),
    ).rejects.toThrow("archived byte length");
    await expect(
      createPersonalImageArchiveZip(plan, new AbortController().signal, undefined, {
        fetch: async () => imageResponse(encoder.encode("<html>"), "text/html"),
      }),
    ).rejects.toThrow("non-image");
  });

  it("cancels a rejected response before any image bytes are retained", async () => {
    const plan = oneDropPlan();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode("partial"));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(
      createPersonalImageArchiveZip(plan, new AbortController().signal, undefined, {
        fetch: async () =>
          new Response(body, {
            status: 206,
            headers: {
              "Content-Type": "image/webp",
              "Content-Length": "7",
            },
          }),
      }),
    ).rejects.toThrow("directly");
    expect(cancelled).toBe(true);
  });

  it("fails before fetching when a Blob fallback cannot safely hold the known bytes", async () => {
    const plan = oneDropPlan();
    plan.entries[0]!.expectedBytes = PERSONAL_IMAGE_ARCHIVE_BLOB_LIMIT_BYTES;
    plan.knownBytes = PERSONAL_IMAGE_ARCHIVE_BLOB_LIMIT_BYTES;
    plan.unknownByteLengthCount = 0;
    const fetcher = vi.fn();

    await expect(
      createPersonalImageArchiveZip(plan, new AbortController().signal, undefined, {
        fetch: fetcher,
      }),
    ).rejects.toThrow("larger than 256 MiB");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not fetch after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn();
    await expect(
      createPersonalImageArchiveZip(oneDropPlan(), controller.signal, undefined, {
        fetch: fetcher,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function personalSnapshot(
  overrides: Partial<PersonalArchiveSnapshot> = {},
): PersonalArchiveSnapshot {
  return {
    schemaVersion: "poapin-personal-site-source-v1",
    manifest: {
      schemaVersion: "poapin-personal-export-v1",
      address: ADDRESS,
      snapshots: SNAPSHOTS,
      sources: {
        catalog: { snapshotId: SNAPSHOTS.catalog },
        holdings: { snapshotId: SNAPSHOTS.holdings },
        collections: {
          snapshotId: SNAPSHOTS.collections,
          releaseId: "collections-release",
        },
        moments: {
          snapshotId: SNAPSHOTS.moments,
          releaseId: "moments-release",
          sourceDatabaseSha256: hash("3"),
          buildManifestSha256: hash("4"),
        },
      },
      counts: {
        holdings: 0,
        authoredMoments: 0,
        taggedMoments: 0,
        ownedCollections: 0,
        ownedCapsules: 0,
      },
      segments: {
        holdings: { path: "/api/holdings", pageSize: 96 },
        ownedCollections: { path: "/api/collections", pageSize: 24 },
        moments: { path: "/api/moments", pageSize: 24 },
        taggedMoments: { path: "/api/tagged", pageSize: 24 },
        ownedCapsules: { path: "/api/capsules", pageSize: 24 },
      },
    },
    address: ADDRESS,
    generatedAt: "2026-07-24T00:00:00.000Z",
    holdings: [],
    drops: [],
    unavailableDropIds: [],
    heldDropMemberships: [],
    collectionProfiles: [],
    ownedCollections: [],
    authoredMoments: [],
    taggedMoments: [],
    ownedCapsules: [],
    authoredMomentAssociations: [],
    taggedMomentAssociations: [],
    ...overrides,
  };
}

function drop(dropId: number, imageUrl: string): Drop {
  return {
    dropId,
    title: `Drop ${dropId}`,
    startDate: "2026-07-23T00:00:00.000Z",
    year: 2026,
    imageUrl,
    hasArtwork: true,
  };
}

function collectionProfile(logoUrl: string): CollectionProfile {
  return {
    snapshotId: SNAPSHOTS.collections,
    collection: {
      collectionId: 7,
      slug: "collection-7",
      title: "Collection 7",
      description: null,
      type: "user",
      year: 2026,
      updatedOn: "2026-07-23T00:00:00.000Z",
      itemCount: 2,
      sectionCount: 0,
      logoUrl,
      bannerUrl: "https://images.example/banner.webp",
      isFeatured: false,
      isVerified: false,
      typeRank: null,
      ownerAddress: ADDRESS,
      externalUrl: null,
      createdOn: "2026-07-23T00:00:00.000Z",
      featuredOn: null,
      verification: null,
    },
    urls: [],
    uiSettings: null,
    media: [
      {
        role: "logo",
        objectUrl: logoUrl,
        contentType: "image/webp",
        byteLength: 12,
        sha256: hash("a"),
        width: 128,
        height: 128,
        status: "stored",
        eligibleForPublish: true,
      },
    ],
    sections: [],
    artists: [],
    organizations: [],
  };
}

function ownedCollection(
  profile: CollectionProfile,
  archiveDropUrl: string,
  collectionDropUrl: string,
): OwnedCollectionArchive {
  return {
    collectionId: profile.collection.collectionId,
    manifest: {
      schemaVersion: "poapin-collection-export-v1",
      snapshotId: SNAPSHOTS.collections,
      releaseId: "collections-release",
      collectionId: profile.collection.collectionId,
      counts: {
        items: 1,
        sections: 0,
        urls: 0,
        media: 1,
        artistDrops: 1,
        suggestions: 0,
        dropStats: 0,
      },
      segments: [],
    },
    profile,
    segments: {
      items: [
        {
          itemId: 1,
          drop: {
            dropId: 42,
            imageUrl: archiveDropUrl,
            isHidden: false,
            isPrivate: false,
          },
        },
      ],
      "artist-drops": [
        {
          artistId: "artist-1",
          dropId: 99,
          drop: {
            dropId: 99,
            imageUrl: collectionDropUrl,
            isHidden: false,
            isPrivate: false,
          },
        },
      ],
    },
  };
}

function momentDetail(options: {
  previewUrl: string;
  thumbnailUrl: string | null;
  imageUrl: string;
  heicUrl: string | null;
  dngUrl: string | null;
  relatedImage: string | null;
}): MomentDetail {
  const media: MomentDetail["media"] = [
    {
      mediaId: "image-1",
      kind: "image",
      mimeType: "image/jpeg",
      url: options.imageUrl,
      thumbnailUrl: options.thumbnailUrl,
      byteLength: 3,
      durationMs: null,
      position: 0,
      width: 10,
      height: 10,
    },
  ];
  if (options.heicUrl) {
    media.push({
      mediaId: "image-heic",
      kind: "image",
      mimeType: "image/heic",
      url: options.heicUrl,
      thumbnailUrl: null,
      byteLength: 5,
      durationMs: null,
      position: 1,
      width: 10,
      height: 10,
    });
  }
  if (options.dngUrl) {
    media.push({
      mediaId: "image-dng",
      kind: "image",
      mimeType: "image/x-adobe-dng",
      url: options.dngUrl,
      thumbnailUrl: null,
      byteLength: 6,
      durationMs: null,
      position: 2,
      width: 10,
      height: 10,
    });
  }
  return {
    momentId: "moment-1",
    displayId: null,
    author: ADDRESS,
    description: null,
    createdOn: "2026-07-23T00:00:00.000Z",
    updatedOn: null,
    isUpdated: false,
    sourceMediaCount: media.length,
    mediaCount: media.length,
    mediaPreservationState: "complete",
    previewMedia: {
      mediaId: "image-1",
      kind: "image",
      mimeType: "image/jpeg",
      url: options.previewUrl,
      thumbnailUrl: options.thumbnailUrl,
      width: 10,
      height: 10,
    },
    dropIds: [42],
    collectionIds: [7],
    cid: null,
    tokenId: null,
    media,
    links: options.relatedImage
      ? [
          {
            linkId: "link-1",
            title: null,
            description: null,
            url: "https://example.com",
            imageUrl: options.relatedImage,
            createdOn: null,
          },
        ]
      : [],
    userTags: [],
    capsules: options.relatedImage
      ? [
          {
            capsuleId: 7,
            externalId: null,
            title: null,
            description: null,
            imageUrl: options.relatedImage,
            url: null,
            owner: ADDRESS,
            createdOn: "2026-07-23T00:00:00.000Z",
          },
        ]
      : [],
  };
}

function oneDropPlan(): PersonalImageArchivePlan {
  return buildMediaArchivePlan(personalSnapshot({ drops: [drop(1, artworkUrl(1))] }));
}

function twoDropPlan(): PersonalImageArchivePlan {
  return buildMediaArchivePlan(
    personalSnapshot({
      drops: [drop(1, artworkUrl(1)), drop(2, artworkUrl(2))],
    }),
  );
}

function artworkUrl(dropId: number): string {
  return `https://media.poap.in/snapshots/${SNAPSHOTS.catalog}/artwork/${dropId}.webp`;
}

function collectionUrl(
  family: "media" | "drop-artwork",
  sha256: string,
  extension: string,
): string {
  return `https://media.poap.in/snapshots/${SNAPSHOTS.collections}/collections/${family}/sha256/${sha256.slice(0, 2)}/${sha256}.${extension}`;
}

function holdingsUrl(family: "drop-artwork", sha256: string, extension: string): string {
  return `https://media.poap.in/snapshots/${SNAPSHOTS.holdings}/holdings/${family}/sha256/${sha256.slice(0, 2)}/${sha256}.${extension}`;
}

function momentUrl(variant: "original" | "thumbnail", sha256: string, extension: string): string {
  return `https://media.poap.in/snapshots/${SNAPSHOTS.moments}/moments/${variant}/sha256/${sha256.slice(0, 2)}/${sha256}.${extension}`;
}

function hash(character: string): string {
  return character.repeat(64);
}

function imageResponse(bytes: Uint8Array, contentType: string): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(bytes.byteLength),
      ETag: '"immutable"',
    },
  });
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}
