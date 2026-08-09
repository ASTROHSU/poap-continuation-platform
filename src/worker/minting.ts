import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
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
  claim: LiveClaimRecord,
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

export async function relayMintAuthorization(
  rpcUrl: string,
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
    transport: http(rpcUrl),
  });
  const feeOptions =
    transactionNonce === undefined
      ? {}
      : await transactionFeeOptions(rpcUrl, chain.id, Math.max(0, feeBumpBps));
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

async function transactionFeeOptions(rpcUrl: string, chainId: number, feeBumpBps: number) {
  const chain = supportedLiveChain(chainId);
  if (!chain) throw new Error(`Unsupported live chain: ${chainId}`);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
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
  rpcUrl: string,
  chainId: number,
  address: Address,
): Promise<number> {
  const chain = supportedLiveChain(chainId);
  if (!chain) throw new Error(`Unsupported live chain: ${chainId}`);
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  return client.getTransactionCount({ address, blockTag: "pending" });
}

export async function hasMintedBadge(
  rpcUrl: string,
  event: MintEvent,
  account: Address,
): Promise<boolean> {
  if (!event.contractAddress || event.tokenId === null) return false;
  const chain = supportedLiveChain(event.chainId);
  if (!chain) return false;
  const client = createPublicClient({ chain, transport: http(rpcUrl) });
  return client.readContract({
    address: getAddress(event.contractAddress),
    abi: associationBadgesAbi,
    functionName: "hasClaimed",
    args: [BigInt(event.tokenId), account],
  });
}

export async function verifyMintTransaction(
  rpcUrl: string,
  transactionHash: Hash,
  event: MintEvent,
  account: Address,
): Promise<"confirmed" | "pending" | "invalid"> {
  if (!event.contractAddress || event.tokenId === null) return "invalid";
  const client = createPublicClient({ transport: http(rpcUrl) });
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
