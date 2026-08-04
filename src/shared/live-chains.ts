import { base, baseSepolia } from "viem/chains";

export type SupportedLiveChain = typeof base | typeof baseSepolia;

export function supportedLiveChain(chainId: number): SupportedLiveChain | null {
  if (chainId === base.id) return base;
  if (chainId === baseSepolia.id) return baseSepolia;
  return null;
}

export function transactionExplorerUrl(chainId: number, transactionHash: string): string {
  const chain = supportedLiveChain(chainId);
  const explorer = chain?.blockExplorers?.default.url;
  if (!explorer) throw new Error(`Unsupported live chain: ${chainId}`);
  return `${explorer}/tx/${transactionHash}`;
}
