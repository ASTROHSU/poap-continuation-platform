import type { Bindings } from "./types";

type BaseMainnetRpcBindings = Pick<
  Bindings,
  "BASE_MAINNET_RPC_URL" | "BASE_MAINNET_ALCHEMY_RPC_URL"
>;

export function baseMainnetRpcUrl(env: BaseMainnetRpcBindings): string {
  const dedicated = env.BASE_MAINNET_ALCHEMY_RPC_URL?.trim();
  return dedicated || env.BASE_MAINNET_RPC_URL;
}

export function baseMainnetHistoryRpcUrl(
  env: BaseMainnetRpcBindings & Pick<Bindings, "BASE_MAINNET_INDEXER_RPC_URL">,
): string {
  return env.BASE_MAINNET_INDEXER_RPC_URL?.trim() || baseMainnetRpcUrl(env);
}
