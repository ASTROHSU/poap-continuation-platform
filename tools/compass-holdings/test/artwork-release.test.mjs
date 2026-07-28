import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const RELEASE_ROOT = new URL("../artwork-releases/", import.meta.url);
const SHA256 = /^[0-9a-f]{64}$/;
const CONTENT_TYPES = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
]);

test("checked-in Holdings artwork releases bind every verified object", async () => {
  const files = (await readdir(RELEASE_ROOT)).filter((name) => name.endsWith(".json")).sort();
  assert.ok(files.length > 0);

  for (const file of files) {
    const release = JSON.parse(await readFile(new URL(file, RELEASE_ROOT), "utf8"));
    assert.equal(release.schemaVersion, "poapin-holdings-artwork-release-v1");
    assert.match(release.snapshotId, /^[a-z0-9][a-z0-9._-]{0,63}$/);
    assert.ok(release.releaseId.startsWith(`${release.snapshotId}-artwork-`));
    assert.ok(Number.isFinite(Date.parse(release.archivedAt)));
    assert.ok(Array.isArray(release.objects) && release.objects.length > 0);

    const dropIds = new Set();
    const objectKeys = new Set();
    let byteLength = 0;
    for (const object of release.objects) {
      assert.ok(Number.isSafeInteger(object.dropId) && object.dropId > 0);
      assert.ok(!dropIds.has(object.dropId));
      dropIds.add(object.dropId);
      assert.match(object.sha256, SHA256);
      assert.ok(Number.isSafeInteger(object.byteLength) && object.byteLength > 0);
      byteLength += object.byteLength;

      const keyPrefix = `snapshots/${release.snapshotId}/holdings/drop-artwork/sha256/`;
      assert.ok(object.objectKey.startsWith(keyPrefix));
      assert.ok(!objectKeys.has(object.objectKey));
      objectKeys.add(object.objectKey);
      const filename = object.objectKey.slice(keyPrefix.length);
      const match = /^([0-9a-f]{2})\/([0-9a-f]{64})\.([a-z0-9]+)$/.exec(filename);
      assert.ok(match);
      assert.equal(match[1], object.sha256.slice(0, 2));
      assert.equal(match[2], object.sha256);
      assert.equal(CONTENT_TYPES.get(match[3]), object.contentType);

      const sourceUrl = new URL(object.sourceUrl);
      assert.equal(sourceUrl.protocol, "https:");
      assert.equal(sourceUrl.username, "");
      assert.equal(sourceUrl.password, "");
    }

    assert.equal(release.verification.objectCount, release.objects.length);
    assert.equal(release.verification.byteLength, byteLength);
  }
});
