import assert from "node:assert/strict";
import test from "node:test";

import {
  addressBoundsForPrefix,
  backfillSql,
  shouldSplitFailure,
} from "../backfill-drop-collectors.mjs";

test("address prefixes become exact owner primary-key ranges", () => {
  assert.deepEqual(addressBoundsForPrefix("0"), {
    lower: `0x${"0".repeat(40)}`,
    upper: `0x1${"0".repeat(39)}`,
  });
  assert.deepEqual(addressBoundsForPrefix("0f"), {
    lower: `0x0f${"0".repeat(38)}`,
    upper: `0x10${"0".repeat(38)}`,
  });
  assert.deepEqual(addressBoundsForPrefix("ffff"), {
    lower: `0xffff${"0".repeat(36)}`,
    upper: null,
  });
  for (const invalid of ["", "A", "xyz", "00000"]) {
    assert.throws(() => addressBoundsForPrefix(invalid), /lowercase hex/);
  }
});

test("backfill SQL is resumable, bounded, and journals only a completed range", () => {
  const sql = backfillSql("a3");
  assert.match(sql, /INSERT OR IGNORE INTO drop_collector_refs/);
  assert.match(sql, /owner_address_norm >= '0xa300000000000000000000000000000000000000'/);
  assert.match(sql, /owner_address_norm < '0xa400000000000000000000000000000000000000'/);
  assert.match(sql, /INSERT OR REPLACE INTO drop_collector_backfill/);
  assert.match(sql, /'a3',\s+changes\(\)/);
  assert.doesNotMatch(sql, /OFFSET|COUNT\(\*\)/);
});

test("only D1 resource failures trigger a smaller address range", () => {
  assert.equal(shouldSplitFailure("out of memory: SQLITE_NOMEM [code: 7500]"), true);
  assert.equal(
    shouldSplitFailure('{"text":"internal error","notes":[{"text":"reference [code: 7500]"}]}'),
    true,
  );
  assert.equal(shouldSplitFailure("D1 query timed out"), true);
  assert.equal(shouldSplitFailure("authentication failed"), false);
  assert.equal(shouldSplitFailure("no such table: drop_collector_refs"), false);
});
