import { createPublicClient, http, type Address, type Hash } from "viem";
import { base } from "viem/chains";

export {
  ISSUER_CONTRACT,
  ISSUER_OWNER,
  ISSUER_CHAIN,
  issuerAbi,
  issuancePlan,
  verifyIssuanceReceipt,
} from "./issuer-issuance.ts";
export type { IssuanceEvent, IssuancePlan } from "./issuer-issuance.ts";
import {
  ISSUER_CONTRACT,
  ISSUER_OWNER,
  ISSUER_CHAIN,
  issuerAbi,
  issuancePlan,
  type IssuanceEvent,
  type IssuancePlan,
} from "./issuer-issuance.ts";

export const issuerPublicClient = () =>
  createPublicClient({
    chain: base,
    transport: http("https://base-rpc.publicnode.com", { timeout: 15_000, retryCount: 0 }),
  });
export type IssuerPublicClient = ReturnType<typeof issuerPublicClient>;

export interface WalletProvider {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}
export interface WalletChoice {
  id: string;
  name: string;
  provider: WalletProvider;
}

/** Provider discovery never asks for accounts or permissions. Names are plain text only. */
export function discoverWallets(target: Window, onChoice: (choice: WalletChoice) => void) {
  const seen = new Set<WalletProvider>();
  function add(provider: unknown, id: string, name: string) {
    if (
      !provider ||
      typeof provider !== "object" ||
      !("request" in provider) ||
      typeof provider.request !== "function" ||
      seen.has(provider as WalletProvider)
    )
      return;
    seen.add(provider as WalletProvider);
    onChoice({ id, name: name.slice(0, 80), provider: provider as WalletProvider });
  }
  const announce = (event: Event) => {
    const detail: unknown = (event as CustomEvent).detail;
    if (!detail || typeof detail !== "object" || !("info" in detail) || !("provider" in detail))
      return;
    const info = detail.info;
    if (
      !info ||
      typeof info !== "object" ||
      !("uuid" in info) ||
      !("name" in info) ||
      typeof info.uuid !== "string" ||
      typeof info.name !== "string"
    )
      return;
    add(detail.provider, info.uuid, info.name);
  };
  target.addEventListener("eip6963:announceProvider", announce);
  target.dispatchEvent(new Event("eip6963:requestProvider"));
  const injected = (
    target as Window & {
      ethereum?: WalletProvider & {
        providers?: WalletProvider[];
        isRabby?: boolean;
        isTrust?: boolean;
      };
    }
  ).ethereum;
  for (const [index, provider] of (injected?.providers ?? (injected ? [injected] : [])).entries()) {
    const flags = provider as WalletProvider & { isRabby?: boolean; isTrust?: boolean };
    add(
      provider,
      `injected-${index}`,
      flags.isRabby ? "Rabby" : flags.isTrust ? "Trust Wallet" : `瀏覽器錢包 ${index + 1}`,
    );
  }
  return () => target.removeEventListener("eip6963:announceProvider", announce);
}

export async function requireOwnerWallet(provider: WalletProvider, connect = false) {
  const accounts = await provider.request({
    method: connect ? "eth_requestAccounts" : "eth_accounts",
  });
  const chain = await provider.request({ method: "eth_chainId" });
  if (chain !== "0x2105") throw new Error("請在錢包切換至 Base 主網（8453），再重新連接核對。");
  if (
    !Array.isArray(accounts) ||
    typeof accounts[0] !== "string" ||
    accounts[0].toLowerCase() !== ISSUER_OWNER
  ) {
    throw new Error(`請在錢包選擇合約 owner：${ISSUER_OWNER}`);
  }
  return accounts[0].toLowerCase() as Address;
}

function eventMissing(error: unknown): boolean {
  const visited = new Set<unknown>();
  for (let current = error; current && typeof current === "object" && !visited.has(current);) {
    visited.add(current);
    const item = current as { data?: { errorName?: string }; cause?: unknown };
    if (item.data?.errorName === "EventDoesNotExist") return true;
    current = item.cause;
  }
  return false;
}

export async function reviewIssuance(
  client: IssuerPublicClient,
  event: IssuanceEvent,
  loadMetadata: typeof fetch = fetch,
) {
  const plan = issuancePlan(event);
  if (!plan) throw new Error("此活動不在本次四場發行範圍。");
  if ((await client.getChainId()) !== ISSUER_CHAIN) throw new Error("唯讀節點網路不符，已停止。");
  const owner = await client.readContract({
    address: ISSUER_CONTRACT,
    abi: issuerAbi,
    functionName: "owner",
  });
  if (owner.toLowerCase() !== ISSUER_OWNER)
    throw new Error("合約 owner 已變更，請重新確認發行設定。");
  // The private admin hostname proxies the same media; use its same-origin
  // route so metadata verification does not depend on cross-origin CORS.
  const response = await loadMetadata(new URL(plan.metadataUri).pathname, {
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("無法讀取正式 metadata，請稍後重新核對。");
  const metadata = await response.json();
  if (
    metadata.name !== event.title ||
    new URL(metadata.image, "https://poap.blocktrend.today").href !==
      new URL(event.imageUrl, "https://poap.blocktrend.today").href
  ) {
    throw new Error("正式 metadata 與活動名稱或圖片不符，請先儲存並重新載入活動。");
  }
  try {
    const config = await client.readContract({
      address: ISSUER_CONTRACT,
      abi: issuerAbi,
      functionName: "eventConfig",
      args: [BigInt(plan.tokenId)],
    });
    if (config[0] !== 200n || config[2] !== plan.metadataUri) {
      throw new Error("Token 已被其他活動使用或 metadata 不符，禁止發行。");
    }
    return { plan, issued: true, active: config[1] };
  } catch (error) {
    if (!eventMissing(error)) throw error;
  }
  return { plan, issued: false, active: false };
}

export interface IssuanceJournal {
  phase: "wallet" | "pending" | "uncertain";
  hash?: Hash;
}
export const journalKey = (plan: IssuancePlan) =>
  `issuer:${ISSUER_CHAIN}:${ISSUER_CONTRACT}:${plan.slug}`;
export function loadJournal(
  storage: Pick<Storage, "getItem">,
  plan: IssuancePlan,
): IssuanceJournal | null {
  const raw = storage.getItem(journalKey(plan));
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    if (
      ["wallet", "pending", "uncertain"].includes(value.phase) &&
      (value.hash === undefined || /^0x[0-9a-fA-F]{64}$/.test(value.hash))
    )
      return value;
  } catch {
    /* Invalid storage must also fail closed. */
  }
  return { phase: "uncertain" };
}

/** Called only by a deliberate user click, inside a cross-tab Web Lock. */
export async function issueWithOwnerWallet(input: {
  provider: WalletProvider;
  client: IssuerPublicClient;
  event: IssuanceEvent;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  isCurrent: () => boolean;
  loadMetadata?: typeof fetch;
}) {
  const { provider, client, event, storage, isCurrent } = input;
  const plan = issuancePlan(event);
  if (!plan) throw new Error("活動不在發行範圍。");
  if (loadJournal(storage, plan))
    throw new Error("已有待確認的錢包請求或交易，禁止重送；請先查核。");
  const review = await reviewIssuance(client, event, input.loadMetadata);
  if (review.issued) throw new Error("此活動已發行，禁止重送。");
  await requireOwnerWallet(provider);
  await client.simulateContract({
    address: ISSUER_CONTRACT,
    abi: issuerAbi,
    functionName: "createEvent",
    account: ISSUER_OWNER,
    args: [BigInt(plan.tokenId), 200n, plan.metadataUri],
  });
  await requireOwnerWallet(provider);
  if (!isCurrent()) throw new Error("錢包、網路或活動已變更，請重新核對。");
  storage.setItem(journalKey(plan), JSON.stringify({ phase: "wallet" }));
  let hash: unknown;
  try {
    hash = await provider.request({
      method: "eth_sendTransaction",
      params: [
        {
          from: ISSUER_OWNER,
          to: ISSUER_CONTRACT,
          chainId: "0x2105",
          value: "0x0",
          data: plan.data,
        },
      ],
    });
  } catch (error) {
    if ((error as { code?: number })?.code === 4001) storage.removeItem(journalKey(plan));
    else storage.setItem(journalKey(plan), JSON.stringify({ phase: "uncertain" }));
    throw error;
  }
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    storage.setItem(journalKey(plan), JSON.stringify({ phase: "uncertain" }));
    throw new Error("錢包未回傳可驗證的交易 hash；結果未確定，請勿重送。");
  }
  const journal: IssuanceJournal = { phase: "pending", hash: hash as Hash };
  storage.setItem(journalKey(plan), JSON.stringify(journal));
  return journal;
}
