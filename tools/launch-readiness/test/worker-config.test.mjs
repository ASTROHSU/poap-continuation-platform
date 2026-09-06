import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyMintRelayCoordinatorConfig } from "../worker-config.mjs";

test("accepts a worker configuration with the mint coordinator binding and migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-config-"));
  const path = join(directory, "wrangler.jsonc");
  await writeFile(
    path,
    JSON.stringify({
      migrations: [{ new_sqlite_classes: ["MintRelayCoordinator"] }],
      durable_objects: {
        bindings: [{ name: "MINT_RELAY_COORDINATOR", class_name: "MintRelayCoordinator" }],
      },
    }),
  );
  await assert.doesNotReject(verifyMintRelayCoordinatorConfig(path));
});

test("rejects a worker configuration that would strand mint jobs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "worker-config-"));
  const path = join(directory, "wrangler.jsonc");
  await writeFile(path, JSON.stringify({ durable_objects: { bindings: [] } }));
  await assert.rejects(verifyMintRelayCoordinatorConfig(path), /leaves mint jobs pending forever/);
});
