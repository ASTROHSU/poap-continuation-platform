import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

test("signer generator stores one non-overwritable secret without printing it", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "mint-signer-test-"));
  const script = resolve(import.meta.dirname, "../signer.mjs");
  const first = await execFileAsync(process.execPath, [script, root]);
  const key = (await readFile(resolve(root, "mint-signer.key"), "utf8")).trim();
  const address = (await readFile(resolve(root, "mint-signer-address.txt"), "utf8")).trim();

  assert.match(key, /^0x[0-9a-f]{64}$/);
  assert.match(address, /^0x[0-9a-fA-F]{40}$/);
  assert.doesNotMatch(first.stdout, new RegExp(key.slice(2)));
  assert.equal((await stat(resolve(root, "mint-signer.key"))).mode & 0o777, 0o600);

  await assert.rejects(execFileAsync(process.execPath, [script, root]), /already exist/);
  assert.equal((await readFile(resolve(root, "mint-signer.key"), "utf8")).trim(), key);
  await rm(root, { recursive: true, force: true });
});
