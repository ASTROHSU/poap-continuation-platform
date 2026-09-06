import type { Bindings } from "./types";

type BaseMainnetRpcBindings = Pick<Bindings, "BASE_MAINNET_RPC_URL">;
type BaseMainnetLiveRpcBindings = BaseMainnetRpcBindings &
  Pick<Bindings, "BASE_MAINNET_FALLBACK_RPC_URL">;

export function baseMainnetRpcUrl(env: BaseMainnetRpcBindings): string {
  return env.BASE_MAINNET_RPC_URL;
}

export function baseMainnetLiveRpcUrls(env: BaseMainnetLiveRpcBindings): readonly string[] {
  const primary = baseMainnetRpcUrl(env);
  const fallback = env.BASE_MAINNET_FALLBACK_RPC_URL?.trim();
  return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

export function baseMainnetHistoryRpcUrl(
  env: BaseMainnetRpcBindings & Pick<Bindings, "BASE_MAINNET_INDEXER_RPC_URL">,
): string {
  return env.BASE_MAINNET_INDEXER_RPC_URL?.trim() || baseMainnetRpcUrl(env);
}
