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
  if (!/"BASE_MAINNET_RPC_URL"\s*:\s*"https:\/\/mainnet\.base\.org"/.test(source)) {
    missing.push("original Base mainnet RPC endpoint");
  }
  if (!/"BASE_MAINNET_FALLBACK_RPC_URL"\s*:\s*"https:\/\/base-rpc\.publicnode\.com"/.test(source)) {
    missing.push("independent Base mainnet fallback RPC endpoint");
  }

  if (missing.length > 0) {
    throw new Error(
      `Refusing to deploy ${configPath}: missing ${missing.join(", ")}. ` +
        "A deployment without these entries can leave mint jobs pending forever.",
    );
  }
}
