// Shared owner-issuance protocol used by both the browser and the Worker.
import {
  decodeEventLog,
  encodeFunctionData,
  parseAbi,
  type Hash,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
export interface IssuanceReceiptClient {
  getChainId(): Promise<number>;
  getBlockNumber(): Promise<bigint>;
  getTransactionReceipt(args: {
    hash: Hash;
  }): Promise<Pick<TransactionReceipt, "to" | "from" | "status" | "blockNumber" | "logs">>;
  getTransaction(args: {
    hash: Hash;
  }): Promise<{ to: Address | null; from: Address; input: Hex; value: bigint }>;
}

export const ISSUER_CONTRACT = "0x9375b610859b1a5feea3c7c7c45fc20712f506cb" as const;
export const ISSUER_OWNER = "0xb3492740f78c046b5bd6c6d4c188623bcecc36ac" as const;
export const ISSUER_CHAIN = 8453;
export const issuerAbi = parseAbi([
  "function owner() view returns (address)",
  "function eventConfig(uint256 tokenId) view returns (uint128 maxSupply, bool active, string metadataUri)",
  "function createEvent(uint256 tokenId, uint128 maxSupply, string metadataUri)",
  "event EventConfigured(uint256 indexed tokenId, uint256 maxSupply, string metadataUri)",
  "function increaseMaxSupply(uint256[] tokenIds, uint128 newMaxSupply)",
  "error EventDoesNotExist(uint256 tokenId)",
]);

const tokenIds: Record<string, number> = {
  "november-book-club-2026": 10,
  "platform-operations-okx-bybit-2026-11": 11,
  "december-book-club-2026": 12,
  "platform-operations-firstrade-etoro-2026-12": 13,
  // 2026 donor credentials (verified unconfigured on chain before assignment).
  "donation-monthly-2026": 14,
  "donation-quarterly-2026": 15,
  "donation-yearly-2026": 16,
};

export interface IssuanceEvent {
  slug: string;
  title: string;
  imageUrl: string;
  chainId: number;
  maxSupply: number;
  tokenId: string | null;
  contractAddress: string | null;
}

// New events default to a generous cap: unclaimed supply costs nothing, and a cap that is
// too small can only be raised later through a contract call.
export const DEFAULT_MAX_SUPPLY = 3000;
export const MAX_SUPPLY_LIMIT = 1_000_000;
const validMaxSupply = (value: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= MAX_SUPPLY_LIMIT;

export function issuancePlan(event: IssuanceEvent) {
  const tokenId = tokenIds[event.slug];
  if (!tokenId) return null;
  if (
    event.chainId !== ISSUER_CHAIN ||
    !validMaxSupply(event.maxSupply) ||
    (event.tokenId !== null && event.tokenId !== String(tokenId)) ||
    (event.contractAddress !== null && event.contractAddress.toLowerCase() !== ISSUER_CONTRACT)
  )
    throw new Error("活動的網路、供給量或 Token 設定不符，已停止發行。");
  const metadataUri = `https://poap.blocktrend.today/media/live/events/${event.slug}/metadata.json`;
  return {
    slug: event.slug,
    tokenId,
    maxSupply: event.maxSupply,
    metadataUri,
    data: encodeFunctionData({
      abi: issuerAbi,
      functionName: "createEvent",
      args: [BigInt(tokenId), BigInt(event.maxSupply), metadataUri],
    }),
  };
}

export type IssuancePlan = NonNullable<ReturnType<typeof issuancePlan>>;
export async function verifyIssuanceReceipt(
  client: IssuanceReceiptClient,
  plan: IssuancePlan,
  hash: Hash,
) {
  if ((await client.getChainId()) !== ISSUER_CHAIN) throw new Error("唯讀節點網路不符。");
  const [receipt, tx, block] = await Promise.all([
    client.getTransactionReceipt({ hash }),
    client.getTransaction({ hash }),
    client.getBlockNumber(),
  ]);
  if (receipt.status !== "success") throw new Error("交易已失敗，尚未發行；請保留交易連結供查核。");
  if (
    receipt.to?.toLowerCase() !== ISSUER_CONTRACT ||
    receipt.from.toLowerCase() !== ISSUER_OWNER ||
    tx.to?.toLowerCase() !== ISSUER_CONTRACT ||
    tx.from.toLowerCase() !== ISSUER_OWNER ||
    tx.input.toLowerCase() !== plan.data.toLowerCase() ||
    tx.value !== 0n
  ) {
    throw new Error("交易的發送者、合約或完整參數不符，不能認定發行完成。");
  }
  const matched = receipt.logs.some((log) => {
    if (log.address.toLowerCase() !== ISSUER_CONTRACT) return false;
    try {
      const decoded = decodeEventLog({
        abi: issuerAbi,
        eventName: "EventConfigured",
        data: log.data,
        topics: log.topics,
      });
      return (
        decoded.args.tokenId === BigInt(plan.tokenId) &&
        decoded.args.maxSupply === BigInt(plan.maxSupply) &&
        decoded.args.metadataUri === plan.metadataUri
      );
    } catch {
      return false;
    }
  });
  if (!matched) throw new Error("回執沒有相符的 EventConfigured 紀錄，請勿重送。");
  if (block < receipt.blockNumber + 1n)
    throw new Error("交易已上鏈，正等待第二個區塊確認；請稍後再查核，勿重送。");
  return { hash, blockNumber: receipt.blockNumber.toString() };
}
