import { describe, expect, it } from "vitest";
import {
  collectionDropArtworkUrl,
  collectionMediaObjectUrl,
  holdingDropArtworkUrl,
} from "../src/worker/media";
import {
  parseArchiveMediaMirrorRequest,
  validateMirrorRow,
} from "../src/worker/archive-media-mirror";

const MEDIA_ORIGIN = "https://media.poap.in";
const ARCHIVE_SNAPSHOT = "2026-07-02-v1";
const COLLECTIONS_SNAPSHOT = "collections-2026-07-22-v1";
const HOLDINGS_SNAPSHOT = "compass-holdings-2026-07-28-v1";
const SHA256 = "ab" + "c".repeat(62);
const COLLECTION_MEDIA_KEY = `snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/ab/${SHA256}.png`;
const COLLECTION_DROP_KEY = `snapshots/${COLLECTIONS_SNAPSHOT}/collections/drop-artwork/sha256/ab/${SHA256}.gif`;
const ARCHIVE_DROP_KEY = `snapshots/${ARCHIVE_SNAPSHOT}/artwork/42.webp`;
const HOLDING_DROP_KEY = `snapshots/${HOLDINGS_SNAPSHOT}/holdings/drop-artwork/sha256/ab/${SHA256}.png`;

describe("public media object-key policy", () => {
  it("maps only current-snapshot Collection branding objects", () => {
    expect(
      collectionMediaObjectUrl(`${MEDIA_ORIGIN}///`, COLLECTION_MEDIA_KEY, COLLECTIONS_SNAPSHOT),
    ).toBe(`${MEDIA_ORIGIN}/${COLLECTION_MEDIA_KEY}`);

    for (const key of [
      COLLECTION_DROP_KEY,
      ARCHIVE_DROP_KEY,
      `snapshots/older-collections/collections/media/sha256/ab/${SHA256}.png`,
      "private/backup.tar.gz",
      `snapshots/${COLLECTIONS_SNAPSHOT}/backup/sha256/ab/${SHA256}.png`,
    ]) {
      expect(collectionMediaObjectUrl(MEDIA_ORIGIN, key, COLLECTIONS_SNAPSHOT)).toBeNull();
    }
  });

  it("maps drop artwork only from the active archive or Collections snapshot", () => {
    expect(
      collectionDropArtworkUrl(
        MEDIA_ORIGIN,
        ARCHIVE_DROP_KEY,
        ARCHIVE_SNAPSHOT,
        COLLECTIONS_SNAPSHOT,
        42,
      ),
    ).toBe(`${MEDIA_ORIGIN}/${ARCHIVE_DROP_KEY}`);
    expect(
      collectionDropArtworkUrl(
        MEDIA_ORIGIN,
        COLLECTION_DROP_KEY,
        ARCHIVE_SNAPSHOT,
        COLLECTIONS_SNAPSHOT,
        42,
      ),
    ).toBe(`${MEDIA_ORIGIN}/${COLLECTION_DROP_KEY}`);

    for (const key of [
      COLLECTION_MEDIA_KEY,
      `snapshots/older-archive/artwork/42.webp`,
      `snapshots/older-collections/collections/drop-artwork/sha256/ab/${SHA256}.gif`,
      "private/backup.tar.gz",
      "snapshots/../private/backup.tar.gz",
    ]) {
      expect(
        collectionDropArtworkUrl(MEDIA_ORIGIN, key, ARCHIVE_SNAPSHOT, COLLECTIONS_SNAPSHOT, 42),
      ).toBeNull();
    }
  });

  it("maps holder-only artwork only from active archive, Collections, or Holdings snapshots", () => {
    for (const key of [ARCHIVE_DROP_KEY, COLLECTION_DROP_KEY, HOLDING_DROP_KEY]) {
      expect(
        holdingDropArtworkUrl(
          MEDIA_ORIGIN,
          key,
          ARCHIVE_SNAPSHOT,
          HOLDINGS_SNAPSHOT,
          COLLECTIONS_SNAPSHOT,
          42,
        ),
      ).toBe(`${MEDIA_ORIGIN}/${key}`);
    }

    for (const key of [
      `snapshots/older-holdings/holdings/drop-artwork/sha256/ab/${SHA256}.png`,
      `snapshots/${HOLDINGS_SNAPSHOT}/collections/drop-artwork/sha256/ab/${SHA256}.png`,
      `snapshots/${HOLDINGS_SNAPSHOT}/holdings/drop-artwork/sha256/00/${SHA256}.png`,
      "private/backup.tar.gz",
    ]) {
      expect(
        holdingDropArtworkUrl(
          MEDIA_ORIGIN,
          key,
          ARCHIVE_SNAPSHOT,
          HOLDINGS_SNAPSHOT,
          COLLECTIONS_SNAPSHOT,
          42,
        ),
      ).toBeNull();
    }
  });

  it("rejects malformed hashes, prefixes, extensions, IDs, and configured snapshots", () => {
    const invalidCollectionKeys = [
      `snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/00/${SHA256}.png`,
      `snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/ab/${SHA256.slice(0, 63)}.png`,
      `snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/ab/${SHA256.toUpperCase()}.png`,
      `snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/ab/${SHA256}.jpeg`,
      `snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/ab/${SHA256}.svg`,
      `/snapshots/${COLLECTIONS_SNAPSHOT}/collections/media/sha256/ab/${SHA256}.png`,
    ];
    for (const key of invalidCollectionKeys) {
      expect(collectionMediaObjectUrl(MEDIA_ORIGIN, key, COLLECTIONS_SNAPSHOT)).toBeNull();
    }

    for (const key of [
      `snapshots/${ARCHIVE_SNAPSHOT}/artwork/0.webp`,
      `snapshots/${ARCHIVE_SNAPSHOT}/artwork/01.webp`,
      `snapshots/${ARCHIVE_SNAPSHOT}/artwork/43.webp`,
      `snapshots/${ARCHIVE_SNAPSHOT}/artwork/42.png`,
      `snapshots/${ARCHIVE_SNAPSHOT}/artwork/9007199254740992.webp`,
    ]) {
      expect(
        collectionDropArtworkUrl(MEDIA_ORIGIN, key, ARCHIVE_SNAPSHOT, COLLECTIONS_SNAPSHOT, 42),
      ).toBeNull();
    }

    expect(collectionMediaObjectUrl(MEDIA_ORIGIN, COLLECTION_MEDIA_KEY, "../private")).toBeNull();
    expect(
      collectionDropArtworkUrl(
        MEDIA_ORIGIN,
        ARCHIVE_DROP_KEY,
        "ARCHIVE-SNAPSHOT",
        COLLECTIONS_SNAPSHOT,
        42,
      ),
    ).toBeNull();
  });
});

describe("archive media mirror policy", () => {
  it("accepts only active, content-addressed artwork rows", () => {
    expect(
      validateMirrorRow(
        {
          drop_id: 42,
          object_key: HOLDING_DROP_KEY,
          sha256: SHA256,
          byte_length: 128,
          content_type: "image/png",
        },
        HOLDINGS_SNAPSHOT,
        COLLECTIONS_SNAPSHOT,
      ),
    ).toBe("image/png");

    expect(() =>
      validateMirrorRow(
        {
          drop_id: 42,
          object_key: `private/${SHA256}.png`,
          sha256: SHA256,
          byte_length: 128,
          content_type: "image/png",
        },
        HOLDINGS_SNAPSHOT,
        COLLECTIONS_SNAPSHOT,
      ),
    ).toThrow("outside the active release");
  });

  it("accepts bounded numeric mirror cursors only", () => {
    expect(parseArchiveMediaMirrorRequest({ afterDropId: 123, limit: 12 })).toEqual({
      afterDropId: 123,
      limit: 12,
    });
    expect(() => parseArchiveMediaMirrorRequest({ afterDropId: -1 })).toThrow(
      "cursor is invalid",
    );
    expect(() => parseArchiveMediaMirrorRequest({ limit: "12" })).toThrow("limit is invalid");
  });
});
