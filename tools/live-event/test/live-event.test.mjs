import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { prepareEventBundle } from "../lib.mjs";

test("unique mode creates one link plus PNG and SVG per claim slot without overwriting", async () => {
  const root = await createFixture("unique", 2);
  const outputDir = resolve(root, "output");
  const result = await prepareEventBundle({
    inputPath: resolve(root, "event.json"),
    outputDir,
    now: new Date("2026-07-31T00:00:00.000Z"),
    randomCode: sequence("unique"),
  });

  assert.equal(result.publicLinkCount, 2);
  assert.equal(result.claimSlotCount, 2);
  assert.deepEqual(
    { width: result.imageCheck.width, height: result.imageCheck.height },
    { width: 256, height: 256 },
  );
  const csv = await readFile(resolve(outputDir, "claim-links.csv"), "utf8");
  assert.equal(csv.trim().split("\n").length, 3);
  const png = await readFile(resolve(outputDir, "qr/001.png"));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.match(await readFile(resolve(outputDir, "qr/001.svg"), "utf8"), /<svg/);
  assert.match(await readFile(resolve(outputDir, "qr-index.html"), "utf8"), /唯一 QR/);
  assert.match(await readFile(resolve(outputDir, "artwork.svg"), "utf8"), /<circle/);
  const summary = JSON.parse(await readFile(resolve(outputDir, "event-summary.json"), "utf8"));
  assert.equal(summary.files.artwork, "artwork.svg");

  await assert.rejects(
    prepareEventBundle({
      inputPath: resolve(root, "event.json"),
      outputDir,
      randomCode: sequence("again"),
    }),
    /refusing to overwrite/,
  );
  await rm(root, { recursive: true, force: true });
});

test("shared mode creates one public QR backed by multiple claim slots", async () => {
  const root = await createFixture("shared", 3);
  const outputDir = resolve(root, "output");
  const result = await prepareEventBundle({
    inputPath: resolve(root, "event.json"),
    outputDir,
    randomCode: sequence("shared"),
  });

  assert.equal(result.publicLinkCount, 1);
  assert.equal(result.claimSlotCount, 3);
  const csv = await readFile(resolve(outputDir, "claim-links.csv"), "utf8");
  assert.equal(csv.trim().split("\n").length, 2);
  assert.match(csv, /shared,3/);
  const sql = await readFile(resolve(outputDir, "load-event.sql"), "utf8");
  assert.match(sql, /'draft'/);
  assert.doesNotMatch(sql, /'published'/);
  assert.equal([...sql.matchAll(/'event-test-shared'/g)].length, 4);
  const accessHashes = [
    ...sql.matchAll(/\('[0-9a-f]{64}', 'event-test-shared', '([0-9a-f]{64})'\)/g),
  ].map((match) => match[1]);
  assert.equal(accessHashes.length, 3);
  assert.equal(new Set(accessHashes).size, 1);
  await readFile(resolve(outputDir, "qr/shared.png"));
  await readFile(resolve(outputDir, "qr/shared.svg"));
  await rm(root, { recursive: true, force: true });
});

test("image validation rejects an extension that does not match file contents", async () => {
  const root = await createFixture("unique", 1);
  await writeFile(resolve(root, "artwork.png"), "not a png");
  const eventPath = resolve(root, "event.json");
  const event = JSON.parse(await readFile(eventPath, "utf8"));
  event.imageFile = "./artwork.png";
  await writeFile(eventPath, `${JSON.stringify(event)}\n`);
  await assert.rejects(
    prepareEventBundle({
      inputPath: eventPath,
      outputDir: resolve(root, "output"),
      randomCode: sequence("bad-image"),
    }),
    /must be PNG, JPEG, WebP, GIF, or SVG/,
  );
  await rm(root, { recursive: true, force: true });
});

async function createFixture(claimMode, claimCount) {
  const root = await mkdtemp(resolve(tmpdir(), "live-event-test-"));
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><circle cx="128" cy="128" r="100"/></svg>';
  await writeFile(resolve(root, "artwork.svg"), svg);
  await writeFile(
    resolve(root, "event.json"),
    `${JSON.stringify({
      eventId: `event-test-${claimMode}`,
      slug: `test-${claimMode}`,
      title: "測試活動",
      description: "活動建立自動測試",
      imageUrl: "/artwork.svg",
      imageFile: "./artwork.svg",
      eventUrl: null,
      startsAt: "2026-08-01T00:00:00.000Z",
      claimOpensAt: "2026-07-01T00:00:00.000Z",
      claimClosesAt: "2026-12-31T23:59:59.999Z",
      maxSupply: claimCount,
      claimCount,
      claimMode,
      publicBaseUrl: "https://example.test",
    })}\n`,
  );
  return root;
}

function sequence(prefix) {
  let index = 0;
  return () => `${prefix}-${++index}-0123456789abcdef`;
}
