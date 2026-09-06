import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

test("deployed server includes the private issuer management route", async () => {
  const entry = await readFile(
    ".vercel/output/functions/_render.func/dist/server/entry.mjs",
    "utf8",
  );
  assert.ok(
    entry.includes("/issuer/manage"),
    "Admin route is missing from the deployment artifact",
  );
});

test("wallet collections retain live legacy holdings with snapshot fallback", async () => {
  const [component, api] = await Promise.all([
    readFile("src/components/WalletCollectionDemo.tsx", "utf8"),
    readFile("src/lib/live-api.ts", "utf8"),
  ]);
  assert.ok(component.includes("getLegacyPoapHoldings(address)"));
  assert.ok(component.includes("legacyComplete ? (legacyItems?.length ?? 0) : archiveTotal"));
  assert.ok(api.includes("/api/legacy/owners/"));
});
