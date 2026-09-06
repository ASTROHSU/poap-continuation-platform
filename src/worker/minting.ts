import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  fallback,
  getAddress,
  http,
  isAddressEqual,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  associationBadgeClaimTypes,
  associationBadgeDomain,
  associationBadgesAbi,
} from "../shared/association-badges";
import { supportedLiveChain } from "../shared/live-chains";
import type { LiveClaimRecord, LiveEventRecord } from "./live";

type MintEvent = Pick<LiveEventRecord, "chainId" | "contractAddress" | "tokenId">;
type RpcUrls = string | readonly string[];

function rpcTransport(rpcUrls: RpcUrls) {
  const urls = typeof rpcUrls === "string" ? [rpcUrls] : rpcUrls;
  const transports = urls.map((url) => http(url));
  return transports.length === 1 ? transports[0] : fallback(transports, { rank: false });
}

export interface MintAuthorization {
  chainId: number;
  contractAddress: Address;
  tokenId: string;
  account: Address;
  deadline: number;
  nonce: Hash;
  signature: Hex;
}

export async function signMintAuthorization(
  event: LiveEventRecord,
  claim: Pick<LiveClaimRecord, "claimedBy" | "mintAuthorizationDeadline" | "mintNonce">,
  privateKey: string,
): Promise<MintAuthorization | null> {
  if (!event.contractAddress || event.tokenId === null) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("MINT_SIGNER_PRIVATE_KEY is not configured.");
  }

  const account = privateKeyToAccount(privateKey as Hex);
  const contractAddress = getAddress(event.contractAddress);
  const collector = getAddress(claim.claimedBy);
  const tokenId = BigInt(event.tokenId);
  const signature = await account.signTypedData({
    domain: {
      ...associationBadgeDomain,
      chainId: event.chainId,
      verifyingContract: contractAddress,
    },
    types: associationBadgeClaimTypes,
    primaryType: "Claim",
    message: {
      account: collector,
      tokenId,
      deadline: BigInt(claim.mintAuthorizationDeadline),
      nonce: claim.mintNonce,
    },
  });

  return {
    chainId: event.chainId,
    contractAddress,
    tokenId: tokenId.toString(),
    account: collector,
    deadline: claim.mintAuthorizationDeadline,
    nonce: claim.mintNonce,
    signature,
  };
}

export function isExpiredMintAuthorizationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("AuthorizationExpired") || message.includes("0x3d91b05f");
}

export async function relayMintAuthorization(
  rpcUrls: RpcUrls,
  event: MintEvent,
  authorization: MintAuthorization,
  privateKey: string,
  transactionNonce?: number,
  feeBumpBps = 0,
): Promise<Hash> {
  if (!event.contractAddress || event.tokenId === null) {
    throw new Error("Onchain minting is not configured.");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("MINT_RELAYER_PRIVATE_KEY is not configured.");
  }

  const contractAddress = getAddress(event.contractAddress);
  if (
    authorization.chainId !== event.chainId ||
    !isAddressEqual(authorization.contractAddress, contractAddress) ||
    BigInt(authorization.tokenId) !== BigInt(event.tokenId)
  ) {
    throw new Error("Mint authorization does not match the live event.");
  }

  const chain = supportedLiveChain(event.chainId);
  if (!chain) throw new Error(`Unsupported live chain: ${event.chainId}`);
  const account = privateKeyToAccount(privateKey as Hex);
  const client = createWalletClient({
    account,
    chain,
    transport: rpcTransport(rpcUrls),
  });
  const feeOptions =
    transactionNonce === undefined
      ? {}
      : await transactionFeeOptions(rpcUrls, chain.id, Math.max(0, feeBumpBps));
  return client.writeContract({
    address: contractAddress,
    abi: associationBadgesAbi,
    functionName: "claimFor",
    args: [
      authorization.account,
      BigInt(authorization.tokenId),
      BigInt(authorization.deadline),
      authorization.nonce,
      authorization.signature,
    ],
    nonce: transactionNonce,
    ...feeOptions,
  });
}

async function transactionFeeOptions(rpcUrls: RpcUrls, chainId: number, feeBumpBps: number) {
  const chain = supportedLiveChain(chainId);
  if (!chain) throw new Error(`Unsupported live chain: ${chainId}`);
  const publicClient = createPublicClient({ chain, transport: rpcTransport(rpcUrls) });
  const fees = await publicClient.estimateFeesPerGas();
  const multiplier = 10_000n + BigInt(Math.min(feeBumpBps, 10_000));
  return {
    maxFeePerGas: (fees.maxFeePerGas * multiplier) / 10_000n,
    maxPriorityFeePerGas: (fees.maxPriorityFeePerGas * multiplier) / 10_000n,
  };
}

export function mintRelayerAddress(privateKey: string): Address {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("MINT_RELAYER_PRIVATE_KEY is not configured.");
  }
  return privateKeyToAccount(privateKey as Hex).address;
}

export async function pendingTransactionNonce(
  rpcUrls: RpcUrls,
  chainId: number,
  address: Address,
): Promise<number> {
  const chain = supportedLiveChain(chainId);
  if (!chain) throw new Error(`Unsupported live chain: ${chainId}`);
  const client = createPublicClient({ chain, transport: rpcTransport(rpcUrls) });
  return client.getTransactionCount({ address, blockTag: "pending" });
}

export async function hasMintedBadge(
  rpcUrls: RpcUrls,
  event: MintEvent,
  account: Address,
): Promise<boolean> {
  if (!event.contractAddress || event.tokenId === null) return false;
  const chain = supportedLiveChain(event.chainId);
  if (!chain) return false;
  const client = createPublicClient({ chain, transport: rpcTransport(rpcUrls) });
  return client.readContract({
    address: getAddress(event.contractAddress),
    abi: associationBadgesAbi,
    functionName: "hasClaimed",
    args: [BigInt(event.tokenId), account],
  });
}

export async function verifyMintTransaction(
  rpcUrls: RpcUrls,
  transactionHash: Hash,
  event: MintEvent,
  account: Address,
): Promise<"confirmed" | "pending" | "invalid"> {
  if (!event.contractAddress || event.tokenId === null) return "invalid";
  const client = createPublicClient({ transport: rpcTransport(rpcUrls) });
  let receipt: TransactionReceipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: transactionHash });
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "TransactionReceiptNotFoundError" ||
        error.message.toLowerCase().includes("not found"))
    ) {
      return "pending";
    }
    // Receipt providers can temporarily reject historical or finalized-block
    // reads even after accepting the relay transaction. Treat that as pending:
    // confirmation remains fail-closed until a provider returns a receipt whose
    // logs contain the exact contract, recipient, and token id.
    return "pending";
  }
  if (receipt.status !== "success") return "invalid";
  return receiptContainsMint(
    receipt,
    getAddress(event.contractAddress),
    account,
    BigInt(event.tokenId),
  )
    ? "confirmed"
    : "invalid";
}

export function receiptContainsMint(
  receipt: Pick<TransactionReceipt, "logs">,
  contractAddress: Address,
  account: Address,
  tokenId: bigint,
): boolean {
  for (const log of receipt.logs) {
    if (!isAddressEqual(log.address, contractAddress)) continue;
    try {
      const decoded = decodeEventLog({
        abi: associationBadgesAbi,
        eventName: "TransferSingle",
        data: log.data,
        topics: log.topics,
        strict: true,
      });
      if (
        isAddressEqual(decoded.args.from, zeroAddress) &&
        isAddressEqual(decoded.args.to, account) &&
        decoded.args.id === tokenId &&
        decoded.args.value === 1n
      ) {
        return true;
      }
    } catch {
      // Ignore unrelated logs emitted by the contract.
    }
  }
  return false;
}
