import {
  createPublicClient,
  decodeEventLog,
  getAddress,
  http,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { associationBadgesAbi } from "../shared/association-badges";
import type { Bindings, D1ReadClient } from "./types";

const BLOCKS_PER_CHUNK = 1_900n;
const MAX_CHUNKS_PER_TARGET = 3;
const MAX_TRANSFERS_PER_CHUNK = 400;

export interface ChainIndexerTarget {
  chainId: number;
  contractAddress: Address;
  startBlock: bigint;
  nextBlock: bigint;
}

export interface RawChainLog {
  address: Address;
  blockNumber: bigint | null;
  logIndex: number | null;
  transactionHash: Hash | null;
  data: Hex;
  topics: readonly Hex[];
  removed?: boolean;
}

export interface ChainIndexerRpc {
  getChainId(): Promise<number>;
  getFinalizedBlockNumber(): Promise<bigint>;
  getLogs(input: { address: Address; fromBlock: bigint; toBlock: bigint }): Promise<RawChainLog[]>;
}

export interface IndexedTransfer {
  transactionHash: Hash;
  logIndex: number;
  subIndex: number;
  blockNumber: bigint;
  tokenId: string;
  fromAddress: Address;
  toAddress: Address;
  value: number;
}

export interface ChainIndexerRunResult {
  targets: number;
  chunks: number;
  transfers: number;
  failures: number;
}

interface CursorRow {
  chain_id: number;
  contract_address: Address;
  start_block: number;
  next_block: number;
}

interface TokenRow {
  token_id: string;
}

interface IndexerStatusRow {
  chain_id: number;
  contract_address: Address;
  start_block: number;
  next_block: number;
  last_finalized_block: number | null;
  last_synced_at: string | null;
  event_count: number;
  holder_count: number;
}

export interface ChainIndexerStatus {
  chainId: number;
  contractAddress: Address;
  startBlock: number;
  nextBlock: number;
  lastFinalizedBlock: number | null;
  lagBlocks: number | null;
  lastSyncedAt: string | null;
  indexedEvents: number;
  currentHolders: number;
}

export async function runLiveChainIndexer(
  env: Pick<Bindings, "LIVE_DB" | "BASE_RPC_URL" | "BASE_MAINNET_RPC_URL">,
  rpcFactory: (target: ChainIndexerTarget) => ChainIndexerRpc = (target) =>
    createChainIndexerRpc(rpcUrlForChain(env, target.chainId)),
): Promise<ChainIndexerRunResult> {
  const targets = await fetchChainIndexerTargets(env.LIVE_DB.withSession("first-primary"));
  let chunks = 0;
  let transfers = 0;
  let failures = 0;

  for (const initialTarget of targets) {
    let target = initialTarget;
    const rpc = rpcFactory(target);
    try {
      for (let index = 0; index < MAX_CHUNKS_PER_TARGET; index += 1) {
        const result = await syncChainIndexerChunk(env.LIVE_DB, target, rpc);
        if (!result) break;
        chunks += 1;
        transfers += result.transfers;
        target = { ...target, nextBlock: result.nextBlock };
        if (result.caughtUp) break;
      }
    } catch (error) {
      failures += 1;
      console.error("Live chain indexer target failed", {
        chainId: target.chainId,
        contractAddress: target.contractAddress,
        name: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }
  return { targets: targets.length, chunks, transfers, failures };
}

export async function fetchChainIndexerTargets(db: D1ReadClient): Promise<ChainIndexerTarget[]> {
  const result = await db
    .prepare(
      `SELECT chain_id, contract_address, start_block, next_block
       FROM live_chain_cursors
       ORDER BY chain_id, contract_address`,
    )
    .all<CursorRow>();
  return result.results.map((row) => ({
    chainId: row.chain_id,
    contractAddress: getAddress(row.contract_address),
    startBlock: BigInt(row.start_block),
    nextBlock: BigInt(row.next_block),
  }));
}

export async function syncChainIndexerChunk(
  db: D1Database,
  target: ChainIndexerTarget,
  rpc: ChainIndexerRpc,
): Promise<{ nextBlock: bigint; transfers: number; caughtUp: boolean } | null> {
  const actualChainId = await rpc.getChainId();
  if (actualChainId !== target.chainId) {
    throw new Error(`RPC chain ID mismatch for ${target.contractAddress}.`);
  }
  const finalizedBlock = await rpc.getFinalizedBlockNumber();
  if (target.nextBlock > finalizedBlock) return null;
  const toBlock =
    target.nextBlock + BLOCKS_PER_CHUNK - 1n < finalizedBlock
      ? target.nextBlock + BLOCKS_PER_CHUNK - 1n
      : finalizedBlock;
  const [logs, trackedTokenIds] = await Promise.all([
    rpc.getLogs({
      address: target.contractAddress,
      fromBlock: target.nextBlock,
      toBlock,
    }),
    fetchTrackedTokenIds(db, target),
  ]);
  const transfers = decodeTrackedTransfers(logs, trackedTokenIds);
  if (transfers.length > MAX_TRANSFERS_PER_CHUNK) {
    throw new Error(
      `Indexer chunk contains ${transfers.length} tracked transfers; reduce the block range.`,
    );
  }

  const statements = transfers.map((transfer) =>
    db
      .prepare(
        `INSERT OR IGNORE INTO live_chain_events (
           chain_id,
           contract_address,
           transaction_hash,
           log_index,
           sub_index,
           block_number,
           token_id,
           from_address,
           to_address,
           value
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        target.chainId,
        target.contractAddress.toLowerCase(),
        transfer.transactionHash.toLowerCase(),
        transfer.logIndex,
        transfer.subIndex,
        safeInteger(transfer.blockNumber, "block number"),
        transfer.tokenId,
        transfer.fromAddress.toLowerCase(),
        transfer.toAddress.toLowerCase(),
        transfer.value,
      ),
  );
  const nextBlock = toBlock + 1n;
  statements.push(
    db
      .prepare(
        `UPDATE live_chain_cursors
         SET next_block = ?, last_finalized_block = ?, last_synced_at = ?
         WHERE chain_id = ?
           AND contract_address = ?
           AND next_block = ?`,
      )
      .bind(
        safeInteger(nextBlock, "next block"),
        safeInteger(finalizedBlock, "finalized block"),
        new Date().toISOString(),
        target.chainId,
        target.contractAddress.toLowerCase(),
        safeInteger(target.nextBlock, "cursor block"),
      ),
  );
  const results = await db.batch(statements);
  const cursorResult = results.at(-1);
  if (!cursorResult || Number(cursorResult.meta.changes) !== 1) {
    throw new Error("Indexer cursor changed concurrently; retry the target.");
  }
  return {
    nextBlock,
    transfers: transfers.length,
    caughtUp: nextBlock > finalizedBlock,
  };
}

export function decodeTrackedTransfers(
  logs: RawChainLog[],
  trackedTokenIds: ReadonlySet<string>,
): IndexedTransfer[] {
  const transfers: IndexedTransfer[] = [];
  for (const log of logs) {
    if (
      log.removed ||
      log.blockNumber === null ||
      log.logIndex === null ||
      log.transactionHash === null
    ) {
      continue;
    }
    let decoded: ReturnType<typeof decodeEventLog<typeof associationBadgesAbi>>;
    try {
      if (log.topics.length === 0) continue;
      decoded = decodeEventLog({
        abi: associationBadgesAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
    } catch {
      continue;
    }
    if (decoded.eventName === "TransferSingle") {
      const tokenId = decoded.args.id.toString();
      if (!trackedTokenIds.has(tokenId)) continue;
      transfers.push({
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
        subIndex: 0,
        blockNumber: log.blockNumber,
        tokenId,
        fromAddress: getAddress(decoded.args.from),
        toAddress: getAddress(decoded.args.to),
        value: safeInteger(decoded.args.value, "transfer value"),
      });
      continue;
    }
    if (decoded.eventName === "TransferBatch") {
      if (decoded.args.ids.length !== decoded.args.values.length) {
        throw new Error("TransferBatch IDs and values have different lengths.");
      }
      decoded.args.ids.forEach((id, subIndex) => {
        const tokenId = id.toString();
        if (!trackedTokenIds.has(tokenId)) return;
        transfers.push({
          transactionHash: log.transactionHash as Hash,
          logIndex: log.logIndex as number,
          subIndex,
          blockNumber: log.blockNumber as bigint,
          tokenId,
          fromAddress: getAddress(decoded.args.from),
          toAddress: getAddress(decoded.args.to),
          value: safeInteger(decoded.args.values[subIndex] as bigint, "transfer value"),
        });
      });
    }
  }
  return transfers;
}

export async function fetchChainIndexerStatus(db: D1ReadClient): Promise<ChainIndexerStatus[]> {
  const result = await db
    .prepare(
      `SELECT
         cursors.chain_id,
         cursors.contract_address,
         cursors.start_block,
         cursors.next_block,
         cursors.last_finalized_block,
         cursors.last_synced_at,
         (
           SELECT COUNT(*) FROM live_chain_events events
           WHERE events.chain_id = cursors.chain_id
             AND events.contract_address = cursors.contract_address
         ) AS event_count,
         (
           SELECT COUNT(*) FROM live_token_balances balances
           WHERE balances.chain_id = cursors.chain_id
             AND balances.contract_address = cursors.contract_address
             AND balances.balance > 0
         ) AS holder_count
       FROM live_chain_cursors cursors
       ORDER BY cursors.chain_id, cursors.contract_address`,
    )
    .all<IndexerStatusRow>();
  return result.results.map((row) => ({
    chainId: row.chain_id,
    contractAddress: getAddress(row.contract_address),
    startBlock: row.start_block,
    nextBlock: row.next_block,
    lastFinalizedBlock: row.last_finalized_block,
    lagBlocks:
      row.last_finalized_block === null
        ? null
        : Math.max(0, row.last_finalized_block - row.next_block + 1),
    lastSyncedAt: row.last_synced_at,
    indexedEvents: row.event_count,
    currentHolders: row.holder_count,
  }));
}

function createChainIndexerRpc(rpcUrl: string): ChainIndexerRpc {
  const client = createPublicClient({ transport: http(rpcUrl) });
  return {
    getChainId: () => client.getChainId(),
    async getFinalizedBlockNumber() {
      const block = await client.getBlock({ blockTag: "finalized" });
      if (block.number === null) throw new Error("Finalized block has no number.");
      return block.number;
    },
    getLogs: (input) => client.getLogs(input) as Promise<RawChainLog[]>,
  };
}

async function fetchTrackedTokenIds(
  db: D1ReadClient,
  target: ChainIndexerTarget,
): Promise<Set<string>> {
  const result = await db
    .prepare(
      `SELECT token_id
       FROM live_events
       WHERE chain_id = ?
         AND contract_address = ?
         AND token_id IS NOT NULL`,
    )
    .bind(target.chainId, target.contractAddress.toLowerCase())
    .all<TokenRow>();
  return new Set(result.results.map((row) => row.token_id));
}

function rpcUrlForChain(
  env: Pick<Bindings, "BASE_RPC_URL" | "BASE_MAINNET_RPC_URL">,
  chainId: number,
): string {
  if (chainId === 84532) return env.BASE_RPC_URL;
  if (chainId === 8453) return env.BASE_MAINNET_RPC_URL;
  throw new Error(`Unsupported chain ID ${chainId}.`);
}

function safeInteger(value: bigint, label: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} is outside the supported integer range.`);
  }
  return Number(value);
}
