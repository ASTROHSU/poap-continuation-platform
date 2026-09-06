# Gas monitoring and usage accounting

The existing one-minute Worker cron calls the monitor independently of mint recovery.
Production enables it; other deployments default to disabled. D1 leases prevent
concurrent runs and durable notification state suppresses repeated warnings.

- Check every 15 minutes (one minute while receipt history is catching up or after errors).
- Low: balance <= max(0.0002 ETH, 100 times the recent successful sponsored transaction mean).
- Critical: balance <= max(0.00002 ETH, 10 times that mean).
- Mean uses complete successful receipts from the last 30 days, minimum five samples.
- First low/critical warning and escalation send immediately on the next check; repeat
  unresolved warnings at most once per 24 hours. Recovery requires 125% of the low
  threshold. Estimates do not reserve queued transactions or guarantee future gas prices.
- RPC failure preserves previous state and retries. It does not claim recovery.
- Telegram requires BOTH `TELEGRAM_GAS_BOT_TOKEN` and `TELEGRAM_GAS_CHAT_ID` secrets.
  Until configured, collection and the authenticated admin report work; no alert is sent.
- No automated funding, third-party scheduler, new bot server, or new dependencies.

## Telegram setup

Use an existing designated bot/group or create a bot with the official Telegram
BotFather. The recipient must start the bot or add it to the intended group. Save
its token and exact chat ID in the pilot Worker's Cloudflare secrets (not Git, logs,
or ordinary chat messages). Bot usernames are not private chat IDs. Explicitly
verify the destination with the owner before a delivery test. The mobile Cloudflare
Worker Settings > Variables and Secrets page can store these without a desktop.

The Telegram Bot API receives one sendDocument request containing a compact summary
and UTF-8 CSV. Only an HTTP success plus `ok:true` marks delivery. An ambiguous
network timeout or a state write failure after delivery can cause a duplicate on
retry (at-least-once delivery; Telegram has no idempotency key). Known delivery
failure leaves state unchanged and retries on the next minute. Missing credentials
are visible in the admin report, not represented as a working notification channel.

## Accounting and coverage

Base receipt cost is `gasUsed * effectiveGasPrice + l1Fee`, plus any explicit
operator fee. Unknown required fields are incomplete, never zero. Integers remain
BigInt / decimal text until display; optional TWD figures use the current spot rate,
not the historical exchange rate.

The receipt ledger seeds from mint jobs and indexed Base mint logs. Each submitted
replacement hash is retained from this release onward. Fees count once per unique
transaction and only for the configured relayer; known reverted transactions also
cost gas. Historical failed hashes overwritten before this release cannot be
reconstructed from these tables, and unrelated wallet transfers are outside this
report. Recipient wallet counts, minted units, and transaction counts differ.

Dates come from finalized block timestamps in Asia/Taipei, not indexer insertion
time. Event comparisons use the event date currently registered in the database;
this is not proof the event actually took place that day. Event/day CSV rows show
units, distinct wallets and distinct mint transactions. A batched transaction can
appear in multiple event groups, so do not sum group transaction counts to infer
unique total transactions. Receipt completeness and indexing timestamps are retained
in the admin API. Public API access remains denied; Access + Magic are required.

## Release and verification

Apply `0012_gas_monitor.sql` before deploying the code that writes receipt hashes.
Commit the complete clean source, run `npm run test:gas`, `npm run test:admin`,
`npm run check:pilot`, and the Astro build; use the existing deploy commands.
The additive schema is compatible with the previous Worker if rollback is needed.
Monitor health is inspectable in `gas_monitor_state` (`report_json`, `last_error_at`,
`notified_at`) and the authenticated `/api/admin/issuer/gas` response.

## Historical indexer incident found during validation

On September 6 the receipt ledger exposed one successful mint missing from the
usage index. Both Base cursors had stopped on September 1. Production cron logs
showed eth_getLogs rejected: "Archive requests require a personal token."
Balance and receipt reads still worked; mint RPC health did not prove historical
indexing worked.

BASE_MAINNET_INDEXER_RPC_URL selects an independently verified historical RPC
for the existing indexer. Production uses https://mainnet.base.org and 1,900-block
chunks, resuming the saved cursor without skipping blocks. Mint and balance RPC
selection is unchanged. This public endpoint has no SLA; persistent rate limits
require replacing this setting with a dedicated archive-capable endpoint.
Reports display the oldest Base cursor synchronization time and explicitly
exclude not-yet-indexed mint units.
