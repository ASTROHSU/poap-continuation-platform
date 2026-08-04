import { decodeFunctionResult, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import type { Bindings } from "./types";

const POAP_CONTRACT = getAddress("0x22C1f6050E56d2876009903609a2cC3fEf83B415");
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_TRANSFER_PAGES = 20;
const MAX_RPC_BATCH_SIZE = 10;

const poapAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "uri", type: "string" }],
  },
] as const;

interface AddressRef {
  hash?: unknown;
}

interface BlockscoutMetadata {
  name?: unknown;
  description?: unknown;
  image?: unknown;
  image_url?: unknown;
  external_url?: unknown;
  year?: unknown;
  attributes?: unknown;
}

interface BlockscoutTransfer {
  block_number?: unknown;
  timestamp?: unknown;
  transaction_hash?: unknown;
  from?: AddressRef;
  to?: AddressRef;
  token?: { address_hash?: unknown };
  total?: {
    token_id?: unknown;
    token_instance?: {
      external_app_url?: unknown;
      image_url?: unknown;
      metadata?: BlockscoutMetadata | null;
    } | null;
  };
}

interface BlockscoutPage {
  items?: unknown;
  next_page_params?: Record<string, string | number> | null;
}

export interface CandidateToken {
  tokenId: string;
  latestTo: string;
  mintedAt: string | null;
  transactionHash: string | null;
  tokenUri: string | null;
  metadata: BlockscoutMetadata | null;
  imageUrl: string | null;
}

type LegacyPoapNetwork = "ethereum" | "gnosis" | "base" | "arbitrum-one";

interface NetworkDefinition {
  chainId: 1 | 100 | 8453 | 42161;
  network: LegacyPoapNetwork;
  explorerApiOrigin: string;
  explorerOrigin: string;
  rpcUrl: string;
}

export interface LegacyPoapHolding {
  chainId: number;
  network: LegacyPoapNetwork;
  contractAddress: Address;
  poapId: number;
  dropId: number | null;
  title: string;
  description: string | null;
  imageUrl: string;
  startDate: string;
  city: string | null;
  country: string | null;
  eventUrl: string | null;
  year: number | null;
  mintedAt: string | null;
  transactionHash: string | null;
  explorerUrl: string;
}

export interface LegacyPoapNetworkStatus {
  chainId: number;
  network: LegacyPoapNetwork;
  expectedBalance: number;
  discoveredCount: number;
  complete: boolean;
}

export interface LegacyPoapHoldingsResponse {
  address: Address;
  total: number;
  complete: boolean;
  items: LegacyPoapHolding[];
  networks: LegacyPoapNetworkStatus[];
}

export async function fetchLegacyPoapHoldings(
  env: Pick<
    Bindings,
    | "ETHEREUM_RPC_URL"
    | "GNOSIS_MAINNET_RPC_URL"
    | "BASE_MAINNET_RPC_URL"
    | "ARBITRUM_MAINNET_RPC_URL"
  >,
  owner: Address,
): Promise<LegacyPoapHoldingsResponse> {
  const networks = networkDefinitions(env);
  const settled = await Promise.allSettled(networks.map((network) => fetchNetwork(network, owner)));
  const items: LegacyPoapHolding[] = [];
  const statuses: LegacyPoapNetworkStatus[] = [];
  let successfulNetworks = 0;

  settled.forEach((result, index) => {
    const network = networks[index];
    if (result.status === "fulfilled") {
      successfulNetworks += 1;
      items.push(...result.value.items);
      statuses.push(result.value.status);
      return;
    }
    console.error("Legacy POAP network lookup failed", {
      chainId: network.chainId,
      name: result.reason instanceof Error ? result.reason.name : "UnknownError",
      message: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
    statuses.push({
      chainId: network.chainId,
      network: network.network,
      expectedBalance: 0,
      discoveredCount: 0,
      complete: false,
    });
  });

  if (successfulNetworks === 0) throw new Error("Legacy POAP lookup is temporarily unavailable.");
  items.sort((left, right) => dateValue(right.startDate) - dateValue(left.startDate));
  return {
    address: owner,
    total: items.length,
    complete: statuses.every((status) => status.complete),
    items,
    networks: statuses,
  };
}

function networkDefinitions(
  env: Pick<
    Bindings,
    | "ETHEREUM_RPC_URL"
    | "GNOSIS_MAINNET_RPC_URL"
    | "BASE_MAINNET_RPC_URL"
    | "ARBITRUM_MAINNET_RPC_URL"
  >,
): NetworkDefinition[] {
  return [
    {
      chainId: 1,
      network: "ethereum",
      explorerApiOrigin: "https://eth.blockscout.com",
      explorerOrigin: "https://eth.blockscout.com",
      rpcUrl: env.ETHEREUM_RPC_URL,
    },
    {
      chainId: 100,
      network: "gnosis",
      explorerApiOrigin: "https://gnosis.blockscout.com",
      explorerOrigin: "https://gnosis.blockscout.com",
      rpcUrl: env.GNOSIS_MAINNET_RPC_URL,
    },
    {
      chainId: 8453,
      network: "base",
      explorerApiOrigin: "https://base.blockscout.com",
      explorerOrigin: "https://base.blockscout.com",
      rpcUrl: env.BASE_MAINNET_RPC_URL,
    },
    {
      chainId: 42161,
      network: "arbitrum-one",
      explorerApiOrigin: "https://arbitrum.blockscout.com",
      explorerOrigin: "https://arbitrum.blockscout.com",
      rpcUrl: env.ARBITRUM_MAINNET_RPC_URL,
    },
  ];
}

async function fetchNetwork(
  network: NetworkDefinition,
  owner: Address,
): Promise<{ items: LegacyPoapHolding[]; status: LegacyPoapNetworkStatus }> {
  const balanceResult = await rpcRead(network.rpcUrl, [
    encodeFunctionData({ abi: poapAbi, functionName: "balanceOf", args: [owner] }),
  ]);
  const balanceData = balanceResult[0];
  if (!balanceData) throw new Error("POAP balance could not be read.");
  const expectedBalance = safeNumber(
    decodeFunctionResult({ abi: poapAbi, functionName: "balanceOf", data: balanceData }),
  );
  if (expectedBalance === 0) {
    return {
      items: [],
      status: {
        chainId: network.chainId,
        network: network.network,
        expectedBalance: 0,
        discoveredCount: 0,
        complete: true,
      },
    };
  }

  const transfers = await fetchTransfers(network, owner);
  const candidates = collectLatestPoapTransfers(transfers, owner).filter(
    (candidate) => candidate.latestTo === owner.toLowerCase(),
  );
  const ownership = await rpcRead(
    network.rpcUrl,
    candidates.map((candidate) =>
      encodeFunctionData({
        abi: poapAbi,
        functionName: "ownerOf",
        args: [BigInt(candidate.tokenId)],
      }),
    ),
  );
  const heldCandidates = candidates.filter((candidate, index) => {
    const result = ownership[index];
    if (!result) return false;
    const currentOwner = decodeFunctionResult({
      abi: poapAbi,
      functionName: "ownerOf",
      data: result,
    });
    return currentOwner.toLowerCase() === owner.toLowerCase();
  });

  await fillMissingMetadata(network, heldCandidates);
  const items = heldCandidates.map((candidate) => toHolding(network, candidate));
  return {
    items,
    status: {
      chainId: network.chainId,
      network: network.network,
      expectedBalance,
      discoveredCount: items.length,
      complete: expectedBalance === items.length,
    },
  };
}

async function fetchTransfers(
  network: NetworkDefinition,
  owner: Address,
): Promise<BlockscoutTransfer[]> {
  const baseUrl = new URL(`/api/v2/addresses/${owner}/token-transfers`, network.explorerApiOrigin);
  baseUrl.searchParams.set("type", "ERC-721");
  baseUrl.searchParams.set("token", POAP_CONTRACT);
  const transfers: BlockscoutTransfer[] = [];
  let nextUrl: URL | null = baseUrl;

  for (let page = 0; nextUrl && page < MAX_TRANSFER_PAGES; page += 1) {
    const response = await fetch(nextUrl, { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(`Blockscout returned ${response.status}.`);
    const body = (await response.json()) as BlockscoutPage;
    const pageItems = Array.isArray(body.items) ? (body.items as BlockscoutTransfer[]) : [];
    transfers.push(...pageItems);
    if (!body.next_page_params) {
      nextUrl = null;
      continue;
    }
    const url = new URL(baseUrl);
    Object.entries(body.next_page_params).forEach(([key, value]) =>
      url.searchParams.set(key, String(value)),
    );
    nextUrl = url;
  }
  if (nextUrl) throw new Error("Legacy POAP transfer history exceeds the safe page limit.");
  return transfers;
}

export function collectLatestPoapTransfers(
  transfers: BlockscoutTransfer[],
  _owner: Address,
): CandidateToken[] {
  const byToken = new Map<string, CandidateToken>();
  for (const transfer of transfers) {
    const contract = text(transfer.token?.address_hash)?.toLowerCase();
    const tokenId = text(transfer.total?.token_id);
    if (contract !== POAP_CONTRACT.toLowerCase() || !tokenId || !/^\d+$/.test(tokenId)) continue;
    const to = text(transfer.to?.hash)?.toLowerCase() ?? "";
    const from = text(transfer.from?.hash)?.toLowerCase() ?? "";
    const instance = transfer.total?.token_instance;
    const metadata = isMetadata(instance?.metadata) ? instance.metadata : null;
    const existing = byToken.get(tokenId);
    if (!existing) {
      byToken.set(tokenId, {
        tokenId,
        latestTo: to,
        mintedAt: from === ZERO_ADDRESS ? nullableText(transfer.timestamp) : null,
        transactionHash: nullableText(transfer.transaction_hash),
        tokenUri: tokenUriFromInstance(instance),
        metadata,
        imageUrl: nullableText(instance?.image_url),
      });
      continue;
    }
    if (!existing.mintedAt && from === ZERO_ADDRESS) {
      existing.mintedAt = nullableText(transfer.timestamp);
    }
    if (!existing.metadata && metadata) existing.metadata = metadata;
    if (!existing.imageUrl) existing.imageUrl = nullableText(instance?.image_url);
    if (!existing.tokenUri) existing.tokenUri = tokenUriFromInstance(instance);
  }
  return [...byToken.values()];
}

async function fillMissingMetadata(
  network: NetworkDefinition,
  candidates: CandidateToken[],
): Promise<void> {
  const missingUri = candidates.filter((candidate) => !candidate.tokenUri);
  if (missingUri.length) {
    const uris = await rpcRead(
      network.rpcUrl,
      missingUri.map((candidate) =>
        encodeFunctionData({
          abi: poapAbi,
          functionName: "tokenURI",
          args: [BigInt(candidate.tokenId)],
        }),
      ),
    );
    uris.forEach((result, index) => {
      if (!result) return;
      const uri = decodeFunctionResult({
        abi: poapAbi,
        functionName: "tokenURI",
        data: result,
      });
      missingUri[index].tokenUri = safePoapMetadataUrl(uri);
    });
  }

  await Promise.all(
    candidates.map(async (candidate) => {
      if (candidate.metadata || !candidate.tokenUri) return;
      try {
        const response = await fetch(candidate.tokenUri, {
          headers: { Accept: "application/json" },
        });
        if (!response.ok) return;
        const metadata = (await response.json()) as BlockscoutMetadata;
        if (isMetadata(metadata)) candidate.metadata = metadata;
      } catch {
        // A missing metadata response must not hide a token whose ownership was
        // independently confirmed onchain.
      }
    }),
  );
}

function toHolding(network: NetworkDefinition, candidate: CandidateToken): LegacyPoapHolding {
  const metadata = candidate.metadata;
  const attributes = attributeMap(metadata?.attributes);
  const tokenUri = candidate.tokenUri;
  const dropId = parseDropId(tokenUri) ?? parseDropId(nullableText(metadata?.external_url));
  const startDate = normalizePoapDate(attributes.get("startDate")) ?? candidate.mintedAt ?? "";
  const year = numeric(metadata?.year) ?? yearFromDate(startDate);
  return {
    chainId: network.chainId,
    network: network.network,
    contractAddress: POAP_CONTRACT,
    poapId: Number(candidate.tokenId),
    dropId,
    title: text(metadata?.name) ?? `POAP #${candidate.tokenId}`,
    description: nullableText(metadata?.description),
    imageUrl:
      nullableText(metadata?.image_url) ??
      nullableText(metadata?.image) ??
      candidate.imageUrl ??
      "",
    startDate,
    city: nullableText(attributes.get("city")),
    country: nullableText(attributes.get("country")),
    eventUrl: nullableText(attributes.get("eventURL")),
    year,
    mintedAt: candidate.mintedAt,
    transactionHash: candidate.transactionHash,
    explorerUrl: `${network.explorerOrigin}/token/${POAP_CONTRACT}/instance/${candidate.tokenId}`,
  };
}

function tokenUriFromInstance(
  instance: NonNullable<BlockscoutTransfer["total"]>["token_instance"],
): string | null {
  return safePoapMetadataUrl(nullableText(instance?.external_app_url));
}

function safePoapMetadataUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "api.poap.tech") return null;
    if (!/^\/metadata\/\d+\/\d+$/.test(url.pathname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseDropId(value: string | null): number | null {
  if (!value) return null;
  const match = /\/metadata\/(\d+)\/\d+(?:$|[?#])/.exec(value);
  return match ? Number(match[1]) : null;
}

function attributeMap(value: unknown): Map<string, unknown> {
  const result = new Map<string, unknown>();
  if (!Array.isArray(value)) return result;
  value.forEach((attribute) => {
    if (!attribute || typeof attribute !== "object") return;
    const record = attribute as { trait_type?: unknown; value?: unknown };
    if (typeof record.trait_type === "string") result.set(record.trait_type, record.value);
  });
  return result;
}

function normalizePoapDate(value: unknown): string | null {
  const raw = nullableText(value);
  if (!raw) return null;
  const parsed = new Date(`${raw} 00:00:00 UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function yearFromDate(value: string): number | null {
  const match = /^(\d{4})-/.exec(value);
  return match ? Number(match[1]) : null;
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("POAP balance is too large.");
  return Number(value);
}

async function rpcRead(rpcUrl: string, calls: Hex[]): Promise<Array<Hex | null>> {
  if (!calls.length) return [];
  const chunks: Array<Array<{ data: Hex; id: number }>> = [];
  calls.forEach((data, index) => {
    const chunkIndex = Math.floor(index / MAX_RPC_BATCH_SIZE);
    const chunk = chunks[chunkIndex] ?? [];
    chunk.push({ data, id: index + 1 });
    chunks[chunkIndex] = chunk;
  });
  const payloads = await Promise.all(
    chunks.map(async (chunk) => {
      const requests = chunk.map(({ data, id }) => ({
        jsonrpc: "2.0",
        id,
        method: "eth_call",
        params: [{ to: POAP_CONTRACT, data }, "latest"],
      }));
      const response = await fetch(rpcUrl, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(requests.length === 1 ? requests[0] : requests),
      });
      if (!response.ok) throw new Error(`RPC returned ${response.status}.`);
      const payload = (await response.json()) as unknown;
      if (Array.isArray(payload)) {
        return payload as Array<{ id?: unknown; result?: unknown; error?: unknown }>;
      }
      if (payload && typeof payload === "object") {
        return [payload as { id?: unknown; result?: unknown; error?: unknown }];
      }
      throw new Error("RPC response is invalid.");
    }),
  );
  const payload = payloads.flat();
  const byId = new Map(
    payload.map((item) => {
      const id =
        typeof item.id === "number"
          ? item.id
          : typeof item.id === "string" && /^\d+$/.test(item.id)
            ? Number(item.id)
            : -1;
      return [id, item] as const;
    }),
  );
  return calls.map((_, index) => {
    const item = byId.get(index + 1);
    return typeof item?.result === "string" && /^0x[0-9a-f]*$/i.test(item.result)
      ? (item.result as Hex)
      : null;
  });
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableText(value: unknown): string | null {
  return text(value);
}

function isMetadata(value: unknown): value is BlockscoutMetadata {
  return Boolean(value && typeof value === "object");
}

function dateValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
