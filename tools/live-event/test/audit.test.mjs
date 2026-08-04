import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildEventAuditSql } from "../audit.mjs";

const owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const transactionHash = `0x${"1".padStart(64, "0")}`;

test("event audit reconciles claims, indexed transfers, supply, and cursor lag", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  for (const migration of [
    "0001_schema.sql",
    "0002_claim_modes.sql",
    "0003_mint_authorizations.sql",
    "0004_email_reservations.sql",
    "0005_chain_indexer.sql",
  ]) {
    database.exec(
      await readFile(resolve(import.meta.dirname, `../../../migrations/live/${migration}`), "utf8"),
    );
  }
  database.exec(await readFile(resolve(import.meta.dirname, "../../../fixtures/live.sql"), "utf8"));
  database.exec(`
    UPDATE live_events
    SET contract_start_block = 100
    WHERE slug = 'email-demo';

    UPDATE live_claim_codes
    SET
      claimed_by = '${owner}',
      claimed_at = '2026-07-31T12:00:00.000Z',
      minted_tx_hash = '${transactionHash}',
      minted_at = '2026-07-31T12:01:00.000Z'
    WHERE code_hash = '477282b99231857ce63ddea34579def3d49a44afdd6182d2f17893831d66cec0';

    INSERT INTO live_chain_events (
      chain_id, contract_address, transaction_hash, log_index, sub_index,
      block_number, token_id, from_address, to_address, value
    ) VALUES (
      84532,
      '0x1111111111111111111111111111111111111111',
      '${transactionHash}',
      0,
      0,
      101,
      '2',
      '0x0000000000000000000000000000000000000000',
      '${owner}',
      1
    );

    UPDATE live_chain_cursors
    SET next_block = 106, last_finalized_block = 105,
        last_synced_at = '2026-07-31T12:02:00.000Z'
    WHERE chain_id = 84532;
  `);

  const row = database.prepare(buildEventAuditSql("email-demo")).get();
  assert.deepEqual(
    {
      slots: row.slots,
      walletBound: row.wallet_bound,
      pendingMint: row.pending_mint,
      mintedClaims: row.minted_claims,
      waitingForIndex: row.minted_waiting_for_index,
      currentHolders: row.current_holders,
      currentSupply: row.current_supply,
      indexedTransfers: row.indexed_transfers,
      lag: row.indexer_lag_blocks,
    },
    {
      slots: 2,
      walletBound: 1,
      pendingMint: 0,
      mintedClaims: 1,
      waitingForIndex: 0,
      currentHolders: 1,
      currentSupply: 1,
      indexedTransfers: 1,
      lag: 0,
    },
  );
  assert.equal(row.last_synced_at, "2026-07-31T12:02:00.000Z");
  assert.equal(database.prepare(buildEventAuditSql("missing-'event")).get(), undefined);
  assert.doesNotMatch(buildEventAuditSql("email-demo"), /email_ciphertext|email_iv/i);
  database.close();
});
