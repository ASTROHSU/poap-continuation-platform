import { applyD1Migrations, env, SELF, type D1Migration } from "cloudflare:test";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { beforeAll, describe, expect, it } from "vitest";
import { associationBadgesAbi } from "../src/shared/association-badges";
import {
  decodeTrackedTransfers,
  fetchChainIndexerStatus,
  fetchChainIndexerTargets,
  syncChainIndexerChunk,
  type ChainIndexerRpc,
  type RawChainLog,
} from "../src/worker/chain-indexer";
import { fetchLiveHoldings } from "../src/worker/live";
import type { Bindings } from "../src/worker/types";

interface TestBindings extends Bindings {
  TEST_LIVE_FIXTURE: string;
  TEST_LIVE_MIGRATIONS: D1Migration[];
}

const bindings = env as unknown as TestBindings;
const contract = getAddress("0x1111111111111111111111111111111111111111");
const firstOwner = getAddress("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
const currentOwner = getAddress("0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");

beforeAll(async () => {
  await applyD1Migrations(bindings.LIVE_DB, bindings.TEST_LIVE_MIGRATIONS);
  await executeSql(bindings.LIVE_DB, bindings.TEST_LIVE_FIXTURE);
  await bindings.LIVE_DB.prepare(
    `UPDATE live_events
     SET contract_start_block = 100
     WHERE slug = 'email-demo'`,
  ).run();
});

describe("finalized Base chain indexer", () => {
  it("projects mint and transfer events into current ownership", async () => {
    const [target] = await fetchChainIndexerTargets(bindings.LIVE_DB.withSession("first-primary"));
    expect(target).toMatchObject({
      chainId: 84532,
      contractAddress: contract,
      startBlock: 100n,
      nextBlock: 100n,
    });

    const rpc = fakeRpc(105n, [
      transferSingleLog({
        blockNumber: 101n,
        logIndex: 0,
        transactionHash: hash("1"),
        from: zeroAddress,
        to: firstOwner,
        tokenId: 2n,
      }),
      transferSingleLog({
        blockNumber: 104n,
        logIndex: 1,
        transactionHash: hash("2"),
        from: firstOwner,
        to: currentOwner,
        tokenId: 2n,
      }),
    ]);
    await expect(syncChainIndexerChunk(bindings.LIVE_DB, target, rpc)).resolves.toEqual({
      nextBlock: 106n,
      transfers: 2,
      caughtUp: true,
    });

    const balances = await bindings.LIVE_DB.prepare(
      `SELECT owner_address, balance
       FROM live_token_balances
       WHERE token_id = '2'
       ORDER BY owner_address`,
    ).all<{ owner_address: string; balance: number }>();
    expect(balances.results).toEqual([
      { owner_address: firstOwner.toLowerCase(), balance: 0 },
      { owner_address: currentOwner.toLowerCase(), balance: 1 },
    ]);

    await expect(
      fetchLiveHoldings(bindings.LIVE_DB.withSession("first-primary"), currentOwner.toLowerCase()),
    ).resolves.toMatchObject([
      {
        slug: "email-demo",
        mintStatus: "minted",
        ownershipSource: "chain-index",
        chainFinalizedBlock: 105,
      },
    ]);
    await expect(
      fetchLiveHoldings(bindings.LIVE_DB.withSession("first-primary"), firstOwner.toLowerCase()),
    ).resolves.toEqual([]);

    await expect(
      fetchChainIndexerStatus(bindings.LIVE_DB.withSession("first-primary")),
    ).resolves.toMatchObject([
      {
        chainId: 84532,
        nextBlock: 106,
        lastFinalizedBlock: 105,
        lagBlocks: 0,
        indexedEvents: 2,
        currentHolders: 1,
      },
    ]);
  });

  it("does not apply a duplicate journal row twice", async () => {
    const before = await balanceOf(currentOwner);
    const insert = () =>
      bindings.LIVE_DB.prepare(
        `INSERT OR IGNORE INTO live_chain_events (
         chain_id, contract_address, transaction_hash, log_index, sub_index,
         block_number, token_id, from_address, to_address, value
       ) VALUES (84532, ?, ?, 0, 0, 105, '2', ?, ?, 1)`,
      )
        .bind(contract.toLowerCase(), hash("4"), zeroAddress, currentOwner.toLowerCase())
        .run();
    expect((await insert()).meta.changes).toBeGreaterThan(0);
    expect((await insert()).meta.changes).toBe(0);
    await expect(balanceOf(currentOwner)).resolves.toBe(before + 1);
  });

  it("decodes tracked TransferBatch items and ignores unrelated token IDs", () => {
    const log = transferBatchLog({
      blockNumber: 110n,
      transactionHash: hash("3"),
      from: zeroAddress,
      to: currentOwner,
      tokenIds: [2n, 999n],
      values: [1n, 1n],
    });
    expect(decodeTrackedTransfers([log], new Set(["2"]))).toMatchObject([
      {
        tokenId: "2",
        subIndex: 0,
        fromAddress: zeroAddress,
        toAddress: currentOwner,
        value: 1,
      },
    ]);
  });

  it("keeps the cursor unchanged after an invalid transfer and resumes safely", async () => {
    const [target] = await fetchChainIndexerTargets(bindings.LIVE_DB.withSession("first-primary"));
    const invalidTransfer = fakeRpc(105n, [
      transferSingleLog({
        blockNumber: 101n,
        logIndex: 0,
        transactionHash: hash("5"),
        from: firstOwner,
        to: currentOwner,
        tokenId: 2n,
      }),
    ]);
    await expect(syncChainIndexerChunk(bindings.LIVE_DB, target, invalidTransfer)).rejects.toThrow(
      /source balance is insufficient/i,
    );
    await expect(cursorNextBlock()).resolves.toBe(100);

    const validHistory = fakeRpc(105n, [
      transferSingleLog({
        blockNumber: 100n,
        logIndex: 0,
        transactionHash: hash("6"),
        from: zeroAddress,
        to: firstOwner,
        tokenId: 2n,
      }),
      transferSingleLog({
        blockNumber: 101n,
        logIndex: 0,
        transactionHash: hash("5"),
        from: firstOwner,
        to: currentOwner,
        tokenId: 2n,
      }),
    ]);
    await expect(syncChainIndexerChunk(bindings.LIVE_DB, target, validHistory)).resolves.toEqual({
      nextBlock: 106n,
      transfers: 2,
      caughtUp: true,
    });
    await expect(cursorNextBlock()).resolves.toBe(106);
    await expect(balanceOf(currentOwner)).resolves.toBe(1);
  });

  it("exposes bounded public indexer health without query parameters", async () => {
    const response = await SELF.fetch("https://example.test/api/live/indexer/status");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=15, s-maxage=15");
    await expect(response.json()).resolves.toMatchObject({
      items: [
        {
          chainId: 84532,
          contractAddress: contract,
          startBlock: 100,
          nextBlock: 100,
          lastFinalizedBlock: null,
          lagBlocks: null,
          indexedEvents: 0,
          currentHolders: 0,
        },
      ],
    });

    const invalid = await SELF.fetch("https://example.test/api/live/indexer/status?verbose=true");
    expect(invalid.status).toBe(400);
  });
});

function fakeRpc(finalizedBlock: bigint, logs: RawChainLog[]): ChainIndexerRpc {
  return {
    async getChainId() {
      return 84532;
    },
    async getFinalizedBlockNumber() {
      return finalizedBlock;
    },
    async getLogs({ fromBlock, toBlock }) {
      return logs.filter(
        (log) =>
          log.blockNumber !== null && log.blockNumber >= fromBlock && log.blockNumber <= toBlock,
      );
    },
  };
}

function transferSingleLog(input: {
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hash;
  from: Address;
  to: Address;
  tokenId: bigint;
}): RawChainLog {
  return {
    address: contract,
    blockNumber: input.blockNumber,
    logIndex: input.logIndex,
    transactionHash: input.transactionHash,
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [input.tokenId, 1n]),
    topics: encodeEventTopics({
      abi: associationBadgesAbi,
      eventName: "TransferSingle",
      args: { operator: firstOwner, from: input.from, to: input.to },
    }),
  };
}

function transferBatchLog(input: {
  blockNumber: bigint;
  transactionHash: Hash;
  from: Address;
  to: Address;
  tokenIds: bigint[];
  values: bigint[];
}): RawChainLog {
  return {
    address: contract,
    blockNumber: input.blockNumber,
    logIndex: 0,
    transactionHash: input.transactionHash,
    data: encodeAbiParameters(
      [{ type: "uint256[]" }, { type: "uint256[]" }],
      [input.tokenIds, input.values],
    ),
    topics: encodeEventTopics({
      abi: associationBadgesAbi,
      eventName: "TransferBatch",
      args: { operator: firstOwner, from: input.from, to: input.to },
    }),
  };
}

function hash(lastNibble: string): Hash {
  return `0x${lastNibble.padStart(64, "0")}` as Hash;
}

async function balanceOf(owner: Address): Promise<number> {
  const row = await bindings.LIVE_DB.prepare(
    `SELECT balance FROM live_token_balances
     WHERE chain_id = 84532
       AND contract_address = ?
       AND token_id = '2'
       AND owner_address = ?`,
  )
    .bind(contract.toLowerCase(), owner.toLowerCase())
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

async function cursorNextBlock(): Promise<number> {
  const row = await bindings.LIVE_DB.prepare(
    `SELECT next_block
     FROM live_chain_cursors
     WHERE chain_id = 84532 AND contract_address = ?`,
  )
    .bind(contract.toLowerCase())
    .first<{ next_block: number }>();
  if (!row) throw new Error("Missing test chain cursor.");
  return row.next_block;
}

async function executeSql(db: D1Database, sql: string): Promise<void> {
  const statements = sql
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}
