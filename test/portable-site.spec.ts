import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createPortableSiteZip } from "../src/react-app/portable-site-zip";
import {
  buildPortableSiteBundle,
  buildPortableSiteFiles,
  PORTABLE_SITE_LIMITS,
  type PortableOwnedCollectionExport,
  type PortableSiteBuild,
  type PortableSiteRuntimeManifest,
  type PortableSiteSnapshot,
} from "../src/react-app/portable-site";
import type { PersonalArchiveSnapshot } from "../src/react-app/personal-export";
import type {
  CollectionProfile,
  HeldDropCollectionMembership,
  Holding,
  MomentDetail,
} from "../src/react-app/types";

const ADDRESS = "0x1111111111111111111111111111111111111111";
const SNAPSHOTS = {
  holdings: "catalog-2026-07-23",
  collections: "collections-2026-07-23",
  moments: "moments-2026-07-23",
};
const SOURCES = {
  holdings: {
    snapshotId: SNAPSHOTS.holdings,
  },
  collections: {
    snapshotId: SNAPSHOTS.collections,
    releaseId: "collections-2026-07-23-r1",
  },
  moments: {
    snapshotId: SNAPSHOTS.moments,
    releaseId: "moments-2026-07-23-r1",
    sourceDatabaseSha256: "a".repeat(64),
    buildManifestSha256: "b".repeat(64),
  },
};

describe("portable personal site generator", () => {
  it("returns ZIP-ready UTF-8 bytes from the public build function", async () => {
    const files = await buildPortableSiteFiles(fixture());
    expect(files).toBeInstanceOf(Map);
    expect(files.get("index.html")).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(files.get("manifest.json"))).toContain(
      '"schemaVersion": "poapin-portable-site-v2"',
    );
  });

  it("accepts the collected PersonalArchiveSnapshot without an integration adapter", async () => {
    const source = fixture();
    const owned = source.ownedCollectionExports[0]!;
    const personal: PersonalArchiveSnapshot = {
      schemaVersion: "poapin-personal-site-source-v1",
      manifest: {
        schemaVersion: "poapin-personal-export-v1",
        address: ADDRESS,
        snapshots: SNAPSHOTS,
        sources: SOURCES,
        counts: {
          holdings: 1,
          authoredMoments: 1,
          taggedMoments: 1,
          ownedCollections: 1,
          ownedCapsules: 1,
        },
        segments: {
          holdings: { path: "/api/holdings", pageSize: 480 },
          ownedCollections: { path: "/api/collections", pageSize: 48 },
          moments: { path: "/api/moments", pageSize: 48 },
          taggedMoments: { path: "/api/moments/tagged", pageSize: 48 },
          ownedCapsules: { path: "/api/capsules", pageSize: 48 },
        },
      },
      address: ADDRESS,
      generatedAt: "2026-07-23T00:00:00.000Z",
      holdings: source.holdings,
      drops: source.drops,
      unavailableDropIds: source.unavailableDropIds,
      heldDropMemberships: source.heldDropMemberships,
      collectionProfiles: source.collectionProfiles,
      ownedCollections: [
        {
          collectionId: 7,
          manifest: owned.manifest,
          profile: owned.profile,
          segments: {
            items: owned.items,
            "artist-drops": owned.artistDrops,
            suggestions: owned.suggestions,
            "drop-stats": owned.dropStats,
          },
        },
      ],
      authoredMoments: source.publicAuthoredMoments,
      taggedMoments: source.publicTaggedMoments,
      ownedCapsules: source.ownedCapsules,
      authoredMomentAssociations: [{ collectionId: 7, momentIds: ["moment-1"] }],
      taggedMomentAssociations: [{ collectionId: 7, momentIds: ["moment-tagged"] }],
    };

    const files = await buildPortableSiteFiles(personal);
    const manifest = JSON.parse(new TextDecoder().decode(files.get("manifest.json"))) as {
      generatedAt: string;
      counts: { ownedCollectionItems: number };
    };
    expect(manifest.generatedAt).toBe(personal.generatedAt);
    expect(manifest.counts.ownedCollectionItems).toBe(1);

    const incomplete: PersonalArchiveSnapshot = {
      ...personal,
      ownedCollections: [{ ...personal.ownedCollections[0]!, segments: {} }],
    };
    await expect(buildPortableSiteFiles(incomplete)).rejects.toThrow(
      "missing its declared items segment",
    );
  });

  it("builds safe relative files with verified manifest metadata", async () => {
    const build = await buildPortableSiteBundle(fixture());
    const byPath = new Map(build.files.map((file) => [file.path, file]));
    const manifestFile = byPath.get("manifest.json");

    expect(manifestFile).toBeDefined();
    expect(JSON.parse(manifestFile!.content)).toEqual(build.manifest);
    expect(build.files.length).toBeLessThan(PORTABLE_SITE_LIMITS.maxFiles);

    for (const file of build.files) {
      expect(file.path).not.toMatch(/^\/|\\|(?:^|\/)\.\.(?:\/|$)/);
      expect(file.bytes).toBe(new TextEncoder().encode(file.content).byteLength);
      expect(file.bytes).toBeLessThan(PORTABLE_SITE_LIMITS.maxFileBytes);
      expect(file.sha256).toBe(await sha256(file.content));
    }

    expect(build.manifest.integrity.scope).toBe("Every generated file except manifest.json");
    expect(build.manifest.files).toHaveLength(build.files.length - 1);
    for (const entry of build.manifest.files) {
      const file = byPath.get(entry.path);
      expect(file).toMatchObject(entry);
      expect(entry.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(build.manifest.counts).toMatchObject({
      holdings: 1,
      uniqueDrops: 1,
      unavailableDropReferences: 1,
      collectionProfiles: 1,
      heldDropMemberships: 1,
      authoredMomentAssociations: 1,
      taggedMomentAssociations: 1,
      ownedCollections: 1,
      ownedCollectionItems: 1,
      ownedCollectionArtistDrops: 1,
      ownedCollectionSuggestions: 1,
      ownedCollectionDropStats: 1,
      publicAuthoredMoments: 1,
      publicTaggedMoments: 1,
      ownedCapsules: 1,
    });
    expect(build.manifest.policies).toMatchObject({
      claimsCurrentOwnership: false,
      media: { baseUrl: "https://media.poap.in", bundled: false, autoplay: false },
      robots: "noindex,nofollow",
    });
    expect(build.manifest.coverage).toMatchObject({
      taggedMomentsIncluded: true,
      knownReferencedMediaBytes: 576,
      unknownByteLengthReferences: 2,
    });

    const bootstrap = byPath.get("assets/archive.bootstrap.js");
    expect(bootstrap).toBeDefined();
    expect(build.manifest.files.find((entry) => entry.path === bootstrap!.path)).toMatchObject(
      toManifestEntry(bootstrap!),
    );
    const runtime = runtimeManifest(build);
    expect(runtime).toMatchObject({
      schemaVersion: "poapin-portable-runtime-v1",
      address: build.manifest.address,
      snapshotIds: build.manifest.snapshotIds,
      sources: build.manifest.sources,
      counts: build.manifest.counts,
      datasets: build.manifest.datasets,
    });
    expect(runtime.files).toEqual(
      build.manifest.datasets.flatMap((dataset) =>
        dataset.paths.map((path) => {
          const entry = build.manifest.files.find((candidate) => candidate.path === path);
          return { path, count: entry?.count, payload: entry?.payload };
        }),
      ),
    );
    const checksumLines = file(build, "checksums.sha256").trim().split("\n");
    expect(checksumLines).toEqual(
      build.files
        .filter((entry) => !["checksums.sha256", "manifest.json"].includes(entry.path))
        .sort((left, right) => left.path.localeCompare(right.path))
        .map((entry) => `${entry.sha256}  ${entry.path}`),
    );
  });

  it("keeps unavailable held Drops separate while preserving their references", async () => {
    const input = fixture();
    input.drops = [];
    input.unavailableDropIds = [42, 404];

    const build = await buildPortableSiteBundle(input);

    expect(build.manifest.counts).toMatchObject({
      holdings: 1,
      uniqueDrops: 0,
      unavailableDropReferences: 2,
    });
    expect(dataJson(build, "data/unavailable-drop-references-0001.data.js")).toMatchObject({
      items: [
        { dropId: 42, reason: "not-public-or-not-found" },
        { dropId: 404, reason: "not-public-or-not-found" },
      ],
    });
  });

  it("rejects overlapping available and unavailable Drop availability", async () => {
    const input = fixture();
    input.unavailableDropIds = [42, 404];

    await expect(buildPortableSiteFiles(input)).rejects.toThrow(
      "available and unavailable Drop sets must not overlap",
    );
  });

  it.each([
    ["missing availability", [], "Drop references are missing availability records"],
    ["unreferenced availability", [404, 405], "Drop availability includes an unreferenced ID"],
  ])("rejects %s", async (_label, unavailableDropIds, message) => {
    const input = fixture();
    input.unavailableDropIds = unavailableDropIds;

    await expect(buildPortableSiteFiles(input)).rejects.toThrow(message);
  });

  it("includes all deployable paths and permanent project links", async () => {
    const build = await buildPortableSiteBundle(fixture());
    const paths = build.files.map((file) => file.path);

    expect(paths).toEqual(
      expect.arrayContaining([
        "index.html",
        "assets/site.css",
        "assets/site.js",
        "assets/archive.bootstrap.js",
        "manifest.json",
        "robots.txt",
        "checksums.sha256",
        "README.md",
        "DEPLOY.md",
        "prompts/cloudflare.md",
        "prompts/vercel.md",
        "prompts/filebase.md",
        "prompts/icp.md",
        "data/holdings-0001.data.js",
        "data/drops-0001.data.js",
        "data/unavailable-drop-references-0001.data.js",
        "data/collection-profiles-0001.data.js",
        "data/held-drop-memberships-0001.data.js",
        "data/authored-moment-associations-0001.data.js",
        "data/tagged-moment-associations-0001.data.js",
        "data/owned-collections-0001.data.js",
        "data/owned-collection-items-0001.data.js",
        "data/owned-collection-artist-drops-0001.data.js",
        "data/owned-collection-suggestions-0001.data.js",
        "data/owned-collection-drop-stats-0001.data.js",
        "data/moments-authored-0001.data.js",
        "data/moments-tagged-0001.data.js",
        "data/capsules-0001.data.js",
      ]),
    );

    const html = file(build, "index.html");
    expect(html).toContain('name="robots" content="noindex,nofollow"');
    expect(html).toContain('href="./assets/site.css"');
    expect(html).toContain('src="./assets/site.js"');
    expect(html).toContain('href="https://poap.in"');
    expect(html).toContain('href="https://github.com/glorylab/poapin-archive"');
    const header = html.match(/<header\b[\s\S]*?<\/header>/)?.[0];
    const footer = html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0];
    expect(header).toBeDefined();
    expect(header).not.toContain("https://poap.in");
    expect(header).not.toContain("https://github.com/glorylab/poapin-archive");
    expect(footer).toContain('href="https://poap.in"');
    expect(footer).toContain('href="https://github.com/glorylab/poapin-archive"');
    expect(html.match(/href="https:\/\/poap\.in"/g)).toHaveLength(1);
    expect(html.match(/href="https:\/\/github\.com\/glorylab\/poapin-archive"/g)).toHaveLength(1);
    expect(html).toMatch(/<\/footer>\s*<\/div>\s*<\/body>/);
    const css = file(build, "assets/site.css");
    expect(css).toContain("--canvas: #4fafc1;");
    expect(css).toContain("background-color: var(--canvas);");
    expect(css).toContain("min-height: 100svh;");
    expect(css).toContain("main { min-width: 0; flex: 1 0 auto; }");
    expect(css).not.toContain("Georgia");
    expect(css).not.toContain("#edf5f3");
    const javascript = file(build, "assets/site.js");
    expect(javascript).toContain(
      'metric("Owned Collections at snapshot", counts.ownedCollections)',
    );
    expect(javascript).toContain('metric("Public authored Moments", counts.publicAuthoredMoments)');
    expect(javascript).toContain('metric("Public tagged Moments", counts.publicTaggedMoments)');
    expect(javascript).toContain(
      'metric("Public Capsules owned at snapshot", counts.ownedCapsules)',
    );
    expect(javascript).toContain(
      'metric("Unavailable Drop details", counts.unavailableDropReferences)',
    );
    expect(javascript).toContain('metric("Private held Drops", counts.privateHeldDrops)');
    expect(javascript).toContain('momentAssociationCard(item, "Authored")');
    expect(javascript).toContain('momentAssociationCard(item, "Tagged")');
    for (const prompt of [
      "prompts/cloudflare.md",
      "prompts/vercel.md",
      "prompts/filebase.md",
      "prompts/icp.md",
    ]) {
      expect(file(build, prompt)).toContain(ADDRESS);
      expect(file(build, prompt)).toContain("https://poap.in");
      expect(file(build, prompt)).toContain("https://github.com/glorylab/poapin-archive");
    }
  });

  it("keeps the poap.in theme and footer links inside the downloaded ZIP", async () => {
    const files = await buildPortableSiteFiles(fixture());
    const result = await createPortableSiteZip(
      files,
      "2026-07-23T00:00:00.000Z",
      new AbortController().signal,
    );
    const archive = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
    const html = strFromU8(archive["index.html"]!);
    const css = strFromU8(archive["assets/site.css"]!);
    const footer = html.match(/<footer\b[\s\S]*?<\/footer>/)?.[0];

    expect(css).toContain("--canvas: #4fafc1;");
    expect(css).toContain("background-image: radial-gradient");
    expect(css).not.toContain("Georgia");
    expect(footer).toContain('href="https://poap.in"');
    expect(footer).toContain('href="https://github.com/glorylab/poapin-archive"');
    expect(html).toMatch(/<\/footer>\s*<\/div>\s*<\/body>/);
  });

  it("preserves and labels address-bound private Drop metadata", async () => {
    const input = fixture();
    input.drops[0] = { ...input.drops[0]!, isPrivate: true };

    const build = await buildPortableSiteBundle(input);
    const dropData = dataJson(build, "data/drops-0001.data.js") as {
      items: Array<{ dropId: number; isPrivate?: true; title: string }>;
    };

    expect(build.manifest.counts.privateHeldDrops).toBe(1);
    expect(dropData.items[0]).toMatchObject({
      dropId: 42,
      title: "Portable POAP 1001",
      isPrivate: true,
    });
    expect(file(build, "assets/site.js")).toContain('drop?.isPrivate ? "Private Drop"');
    expect(file(build, "README.md")).toContain(
      "private Drop records included because this exact address held a matching token",
    );
  });

  it("keeps media dormant until a visitor clicks a load button", async () => {
    const build = await buildPortableSiteBundle(fixture());
    const html = file(build, "index.html");
    const javascript = file(build, "assets/site.js");

    expect(() => new Function(javascript)).not.toThrow();
    expect(html).not.toMatch(/<(?:img|video|audio|source)\b/i);
    expect(javascript.toLowerCase()).not.toContain("autoplay");
    expect(javascript).not.toMatch(/\.play\s*\(/);
    expect(javascript).toContain('view.addEventListener("click"');
    expect(javascript).toContain("function mountMedia(button)");
    expect(javascript).toContain('media.preload = "none"');
    expect(javascript).not.toContain("fetch(");
    expect(javascript).toContain('const bootstrapPath = "assets/archive.bootstrap.js"');
    expect(javascript).toContain('loadTransport(path, "chunk")');
    expect(javascript).toContain("failed its payload SHA-256 check");
  });

  it("opens on artwork-first holdings grouped by UTC mint month", async () => {
    const build = await buildPortableSiteBundle(fixture());
    const html = file(build, "index.html");
    const javascript = file(build, "assets/site.js");
    const css = file(build, "assets/site.css");

    expect(html.indexOf('data-tab="poaps"')).toBeLessThan(html.indexOf('data-tab="overview"'));
    expect(javascript).toContain('location.hash || "#poaps"');
    expect(javascript).toContain("function groupHoldingsByMonth(items, dropsById)");
    expect(javascript).toContain('const dropsById = tab === "poaps" ? await loadDropLookup()');
    expect(javascript).toContain("dropsById.get(item.dropId)");
    expect(javascript).toContain('"Load artwork for " + title');
    expect(javascript).toContain(
      "return withArchiveFields(card, { holding: item, drop: drop || null })",
    );
    expect(javascript).toContain('label: "Minted in " + new Intl.DateTimeFormat("en", {');
    expect(javascript).toContain('timeZone: "UTC"');
    expect(javascript).toContain('label: "Mint date unavailable"');
    expect(javascript).toContain("return right.key.localeCompare(left.key)");
    expect(javascript).toContain('if (left.key === "unknown") return 1');
    expect(css).toContain(".media-action--artwork");
  });

  it("splits large datasets below 3.5 MiB without losing records or order", async () => {
    const large = "x".repeat(1_500_000);
    const input = fixture();
    input.holdings = [holding(1, "", 1), holding(2, "", 2), holding(3, "", 3)];
    input.drops = [
      holding(1, large, 1),
      holding(2, large, 2),
      holding(3, large, 3),
      holding(42, "", 42),
    ];

    const build = await buildPortableSiteBundle(input);
    const dataset = build.manifest.datasets.find((entry) => entry.id === "drops");
    expect(dataset?.paths.length).toBeGreaterThan(1);

    const ids: number[] = [];
    for (const path of dataset?.paths ?? []) {
      const chunkFile = build.files.find((entry) => entry.path === path);
      expect(chunkFile?.payload?.bytes).toBeLessThan(PORTABLE_SITE_LIMITS.dataChunkTargetBytes);
      expect(chunkFile?.bytes).toBeLessThan(PORTABLE_SITE_LIMITS.maxFileBytes);
      const chunk = dataJson(build, path) as {
        count: number;
        items: Array<{ dropId: number }>;
      };
      expect(chunk.count).toBe(chunk.items.length);
      ids.push(...chunk.items.map((item) => item.dropId));
    }
    expect(ids).toEqual([1, 2, 3, 42]);
  });

  it("builds the largest observed holdings shape without quadratic chunking", async () => {
    const input = fixture();
    input.holdings = Array.from({ length: 35_359 }, (_, index) =>
      holding(index + 1, "Scale fixture", (index % 9_705) + 1),
    );
    input.drops = Array.from({ length: 9_705 }, (_, index) =>
      holding(index + 1, "Scale fixture", index + 1),
    );
    input.unavailableDropIds = [];

    const build = await buildPortableSiteBundle(input);
    expect(build.manifest.counts).toMatchObject({
      holdings: 35_359,
      uniqueDrops: 9_705,
    });
    expect(build.files.length).toBeLessThanOrEqual(PORTABLE_SITE_LIMITS.maxFiles);
    expect(build.files.every((entry) => entry.bytes <= PORTABLE_SITE_LIMITS.maxFileBytes)).toBe(
      true,
    );
  });

  it("rejects a single record that cannot meet the portable chunk target", async () => {
    const input = fixture();
    input.holdings = [holding(1, "", 1)];
    input.drops = [
      holding(1, "x".repeat(PORTABLE_SITE_LIMITS.dataChunkTargetBytes), 1),
      holding(42, "", 42),
    ];

    await expect(buildPortableSiteFiles(input)).rejects.toThrow(
      "too large for the 3.5 MiB portable data chunk target",
    );
  });

  it("keeps archived text inert inside Base64URL transport files", async () => {
    const input = fixture();
    input.drops[0] = holding(
      1001,
      '</script><script>globalThis.pwned = true</script> \u2028 \u2029 "quoted"',
    );

    const build = await buildPortableSiteBundle(input);
    const transport = file(build, "data/drops-0001.data.js");
    const entry = build.manifest.files.find(
      (candidate) => candidate.path === "data/drops-0001.data.js",
    );
    const decoded = dataJson(build, "data/drops-0001.data.js") as {
      items: Array<{ description: string }>;
    };

    expect(transport).not.toContain("</script>");
    expect(transport).not.toContain("globalThis.pwned");
    expect(transport).toMatch(/^[\s\S]*"[A-Za-z0-9_-]+"[\s\S]*$/);
    expect(decoded.items[0]?.description).toContain("globalThis.pwned");
    expect(entry?.payload).toMatchObject({
      encoding: "base64url",
      mimeType: "application/json",
    });
    expect(entry?.payload?.sha256).toBe(await sha256(transportJson(build, entry!.path)));
  });
});

function fixture(): PortableSiteSnapshot {
  const profile = collectionProfile();
  const membership: HeldDropCollectionMembership = {
    collection: profile.collection,
    matchedDropIds: [42],
  };
  return {
    address: ADDRESS.toUpperCase(),
    snapshotIds: SNAPSHOTS,
    sources: SOURCES,
    holdings: [holding(1001, "A small archived POAP.")],
    drops: [holding(1001, "A small archived POAP.")],
    unavailableDropIds: [404],
    collectionProfiles: [profile],
    heldDropMemberships: [membership],
    authoredMomentAssociations: [{ collectionId: 7, momentIds: ["moment-1"] }],
    taggedMomentAssociations: [{ collectionId: 7, momentIds: ["moment-tagged"] }],
    ownedCollectionExports: [ownedCollection(profile)],
    publicAuthoredMoments: [moment()],
    publicTaggedMoments: [{ ...moment(), momentId: "moment-tagged", dropIds: [42, 404] }],
    ownedCapsules: [
      {
        capsuleId: 99,
        externalId: "portable-capsule",
        title: "Portable Capsule",
        description: "A standalone public Capsule.",
        imageUrl: "https://media.poap.in/capsules/99.webp",
        url: "https://poap.in",
        owner: ADDRESS,
        createdOn: "2026-07-23T00:00:00.000Z",
      },
    ],
  };
}

function holding(poapId: number, description: string, dropId = 42): Holding {
  return {
    sourceUid: `source-${poapId}`,
    poapId,
    mintedOn: 1_700_000_000,
    ownerAddress: ADDRESS,
    network: "ethereum",
    transferCount: 0,
    dropId,
    fancyId: "portable-poap",
    title: `Portable POAP ${poapId}`,
    description,
    startDate: "2026-07-23T00:00:00.000Z",
    endDate: null,
    city: null,
    country: null,
    year: 2026,
    isVirtual: true,
    eventUrl: "https://poap.in",
    imageUrl: "https://media.poap.in/snapshots/catalog/artwork/42.webp",
  };
}

function collectionProfile(): CollectionProfile {
  return {
    snapshotId: SNAPSHOTS.collections,
    collection: {
      collectionId: 7,
      slug: "portable-collection",
      title: "Portable Collection",
      description: "A complete public collection export.",
      type: "user",
      year: 2026,
      updatedOn: "2026-07-23T00:00:00.000Z",
      itemCount: 1,
      sectionCount: 1,
      logoUrl: "https://media.poap.in/collections/logo.webp",
      bannerUrl: null,
      isFeatured: false,
      isVerified: false,
      typeRank: null,
      ownerAddress: ADDRESS,
      externalUrl: "https://poap.in",
      createdOn: "2026-07-23T00:00:00.000Z",
      featuredOn: null,
      verification: null,
    },
    urls: [{ urlId: 1, url: "https://poap.in" }],
    uiSettings: {
      primaryColor: "#111111",
      highlightColor: "#e7bb65",
      darkColor: "#000000",
      greyColor: "#888888",
      whiteColor: "#ffffff",
      isVisibleInRecentList: true,
      togglePoapElements: true,
    },
    media: [
      {
        role: "logo",
        objectUrl: "https://media.poap.in/collections/logo.webp",
        contentType: "image/webp",
        byteLength: 128,
        sha256: "a".repeat(64),
        width: 256,
        height: 256,
        status: "stored",
        eligibleForPublish: true,
      },
    ],
    sections: [{ sectionId: "section-1", name: "First", position: 0 }],
    artists: [],
    organizations: [],
  };
}

function ownedCollection(profile: CollectionProfile): PortableOwnedCollectionExport {
  return {
    manifest: {
      schemaVersion: "poapin-collection-export-v1",
      snapshotId: SNAPSHOTS.collections,
      releaseId: SOURCES.collections.releaseId,
      collectionId: 7,
      counts: {
        items: 1,
        sections: 1,
        urls: 1,
        media: 1,
        artistDrops: 1,
        suggestions: 1,
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
          name: "artist-drops",
          path: "/api/collections/7/export/artist-drops?limit=48",
          pagination: "cursor",
          count: 1,
          pageSize: 48,
        },
        {
          name: "suggestions",
          path: "/api/collections/7/export/suggestions?limit=48",
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
    },
    profile,
    items: [
      {
        itemId: 1,
        createdOn: "2026-07-23T00:00:00.000Z",
        sections: [{ sectionId: "section-1", position: 0 }],
        drop: {
          dropId: 42,
          fancyId: "portable-poap",
          title: "Portable POAP",
          description: "A POAP in an owned collection.",
          startDate: "2026-07-23T00:00:00.000Z",
          endDate: "2026-07-23T01:00:00.000Z",
          expiryDate: null,
          year: 2026,
          city: null,
          country: null,
          eventUrl: "https://poap.in",
          imageUrl: "https://media.poap.in/snapshots/catalog/artwork/42.webp",
          isVirtual: true,
          isPrivate: false,
          isHidden: false,
          channel: null,
          platform: null,
          locationType: null,
          timezone: null,
          integratorId: null,
          createdDate: "2026-07-23T00:00:00.000Z",
          tokenCount: 1,
          transferCount: 0,
          emailClaims: null,
          featuredOn: null,
          momentsUploaded: 1,
        },
      },
    ],
    artistDrops: [{ artistId: "artist-1", dropId: 42, drop: null }],
    suggestions: [
      {
        suggestionId: 1,
        dropId: 42,
        suggestedBy: ADDRESS,
        createdOn: "2026-07-23T00:00:00.000Z",
        drop: null,
      },
    ],
    dropStats: [
      {
        dropId: 42,
        isPrivate: false,
        isHidden: false,
        tokenCount: 1,
        transferCount: 0,
        emailClaims: null,
        featuredOn: null,
        momentsUploaded: 1,
        byChain: [{ chain: "ethereum", createdOn: 1_700_000_000, poapCount: 1, transferCount: 0 }],
      },
    ],
  };
}

function moment(): MomentDetail {
  return {
    momentId: "moment-1",
    displayId: "A preserved moment",
    author: ADDRESS,
    description: "Public authored moment.",
    createdOn: "2026-07-23T00:00:00.000Z",
    updatedOn: null,
    isUpdated: false,
    sourceMediaCount: 3,
    mediaCount: 3,
    mediaPreservationState: "complete",
    previewMedia: {
      mediaId: "image-1",
      kind: "image",
      mimeType: "image/webp",
      url: "https://media.poap.in/moments/image.webp",
      thumbnailUrl: null,
      width: 800,
      height: 600,
    },
    dropIds: [42],
    collectionIds: [7],
    cid: "bafy-portable",
    tokenId: "1",
    media: [
      {
        mediaId: "image-1",
        kind: "image",
        mimeType: "image/webp",
        url: "https://media.poap.in/moments/image.webp",
        thumbnailUrl: null,
        byteLength: 128,
        durationMs: null,
        width: 800,
        height: 600,
        position: 0,
      },
      {
        mediaId: "video-1",
        kind: "video",
        mimeType: "video/mp4",
        url: "https://media.poap.in/moments/video.mp4",
        thumbnailUrl: null,
        byteLength: 256,
        durationMs: 5_000,
        width: 1280,
        height: 720,
        position: 1,
      },
      {
        mediaId: "audio-1",
        kind: "audio",
        mimeType: "audio/mpeg",
        url: "https://media.poap.in/moments/audio.mp3",
        thumbnailUrl: null,
        byteLength: 64,
        durationMs: 4_000,
        width: null,
        height: null,
        position: 2,
      },
    ],
    links: [],
    userTags: [],
    capsules: [],
  };
}

function file(build: PortableSiteBuild, path: string): string {
  const found = build.files.find((entry) => entry.path === path);
  if (!found) throw new Error(`Missing generated file: ${path}`);
  return found.content;
}

function dataJson(build: PortableSiteBuild, path: string): unknown {
  return JSON.parse(transportJson(build, path));
}

function toManifestEntry(fileEntry: PortableSiteBuild["files"][number]) {
  const { content: _content, ...manifestEntry } = fileEntry;
  return manifestEntry;
}

function transportJson(build: PortableSiteBuild, path: string): string {
  const match = file(build, path).match(
    /__POAPIN_ARCHIVE__\.chunk\(\s*"[^"]+",\s*"([A-Za-z0-9_-]+)"\s*\);/u,
  );
  if (!match?.[1]) throw new Error(`Missing Base64URL payload in ${path}`);
  const standard = match[1].replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function runtimeManifest(build: PortableSiteBuild): PortableSiteRuntimeManifest {
  const match = file(build, "assets/archive.bootstrap.js").match(
    /__POAPIN_ARCHIVE__\.manifest\(\s*"([A-Za-z0-9_-]+)"\s*\);/u,
  );
  if (!match?.[1]) throw new Error("Missing runtime manifest payload");
  const standard = match[1].replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  ) as PortableSiteRuntimeManifest;
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
