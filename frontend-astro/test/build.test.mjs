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
