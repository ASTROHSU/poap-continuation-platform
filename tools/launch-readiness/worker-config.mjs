import { readFile } from "node:fs/promises";

export async function verifyMintRelayCoordinatorConfig(configPath) {
  const source = await readFile(configPath, "utf8");
  const missing = [];

  if (!/"name"\s*:\s*"MINT_RELAY_COORDINATOR"/.test(source)) {
    missing.push("MINT_RELAY_COORDINATOR durable object binding");
  }
  if (!/"class_name"\s*:\s*"MintRelayCoordinator"/.test(source)) {
    missing.push("MintRelayCoordinator class binding");
  }
  if (!/"new_sqlite_classes"\s*:\s*\[[^\]]*"MintRelayCoordinator"[^\]]*\]/s.test(source)) {
    missing.push("MintRelayCoordinator SQLite migration");
  }

  if (missing.length > 0) {
    throw new Error(
      `Refusing to deploy ${configPath}: missing ${missing.join(", ")}. ` +
        "A deployment without these entries leaves mint jobs pending forever.",
    );
  }
}
