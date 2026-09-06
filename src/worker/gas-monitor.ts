import { formatEther, parseEther } from "viem";
import { mintRelayerAddress } from "./minting";
import { baseMainnetRpcUrl } from "./rpc-config";
import type { Bindings } from "./types";

const CHAIN = 8453;
const ZERO = "0x0000000000000000000000000000000000000000";
const MINUTE = 60_000;
const DAY = 86_400_000;
type Level = "healthy" | "low" | "critical";
interface ReceiptRow {
  transaction_hash: string;
  payer: string | null;
  occurred_at: string | null;
  success: number | null;
  fee_wei: string | null;
}
interface MintRow {
  transaction_hash: string;
  recipient: string;
  units: number;
  slug: string;
  title: string;
  starts_at: string | null;
}
interface Totals {
  units: number;
  wallets: number;
  transactions: number;
  paidTransactions: number;
  failedTransactions: number;
  feeWei: string;
  averageWei: string | null;
}
export interface GasReport {
  at: string;
  relayer: string;
  balanceWei: string;
  level: Level;
  lowWei: string;
  criticalWei: string;
  estimatedMints: number | null;
  pendingJobs: number;
  failedJobs: number;
  missingReceipts: number;
  incompleteFees: number;
  indexerSyncedAt: string | null;
  periods: { days7: Totals; days30: Totals; all: Totals };
  breakdown: Array<{
    date: string;
    event: string;
    slug: string;
    scheduledDate: string;
    eventDay: string;
    units: number;
    wallets: number;
    transactions: number;
  }>;
  twdPerEth: number | null;
}

// Base receipts include L2 execution + L1 publication fees. Preserve an explicit
// operatorFee if supplied; unknown nonzero operator parameters are incomplete,
// never silently reported as zero. https://docs.base.org/specifications/transactions/network-fees
export function receiptFeeWei(r: Record<string, unknown>): bigint | null {
  const quantity = (value: unknown): bigint | null =>
    typeof value === "string" && /^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value) ? BigInt(value) : null;
  const gas = quantity(r.gasUsed),
    price = quantity(r.effectiveGasPrice),
    l1 = quantity(r.l1Fee);
  if (gas === null || price === null || l1 === null) return null;
  let operator = quantity(r.operatorFee);
  if (operator === null) {
    if (
      [r.operatorFeeScalar, r.operatorFeeConstant].some(
        (v) => v !== undefined && quantity(v) !== 0n,
      )
    )
      return null;
    operator = 0n;
  }
  return gas * price + l1 + operator;
}

export function taipeiDate(value: string): string {
  const n = Date.parse(value);
  return Number.isFinite(n) ? new Date(n + 8 * 3_600_000).toISOString().slice(0, 10) : "未知";
}

export function alertLevel(
  balance: bigint,
  average: bigint | null,
  previous: Level,
  low: bigint,
  critical: bigint,
): Level {
  const lowLimit = average && average * 100n > low ? average * 100n : low;
  const criticalLimit = average && average * 10n > critical ? average * 10n : critical;
  if (balance <= criticalLimit) return "critical";
  if (balance <= lowLimit || (previous !== "healthy" && balance < (lowLimit * 125n) / 100n))
    return "low";
  return "healthy";
}

export function notificationDue(
  level: Level,
  previous: Level,
  lastSent: number,
  now: number,
): boolean {
  if (level === "healthy") return previous !== "healthy";
  if (previous === "healthy" || (level === "critical" && previous !== "critical")) return true;
  return now - lastSent >= DAY;
}

async function rpcBatch(
  url: string,
  calls: Array<[string, unknown[]]>,
): Promise<Array<any | null>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      calls.map(([method, params], id) => ({ jsonrpc: "2.0", id, method, params })),
    ),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("gas_rpc_unavailable");
  const results = (await response.json()) as Array<{
    id: number;
    result?: unknown;
    error?: unknown;
  }>;
  if (!Array.isArray(results)) throw new Error("gas_rpc_invalid_response");
  return calls.map((_, id) => results.find((r) => r.id === id && !r.error)?.result ?? null);
}

async function backfill(env: Bindings, rpc: string, now: number, finalized: bigint) {
  await env.LIVE_DB.batch([
    env.LIVE_DB.prepare(
      `INSERT OR IGNORE INTO gas_receipts (chain_id, transaction_hash, discovered_at)
      SELECT chain_id, lower(transaction_hash), CAST(strftime('%s', created_at) AS INTEGER) * 1000 FROM live_mint_jobs
      WHERE chain_id = ? AND transaction_hash IS NOT NULL`,
    ).bind(CHAIN),
    env.LIVE_DB.prepare(
      `INSERT OR IGNORE INTO gas_receipts (chain_id, transaction_hash, discovered_at)
      SELECT chain_id, transaction_hash, CAST(strftime('%s', indexed_at) AS INTEGER) * 1000 FROM live_chain_events WHERE chain_id = ? AND from_address = ?`,
    ).bind(CHAIN, ZERO),
  ]);
  const { results: pending } = await env.LIVE_DB.prepare(
    `SELECT transaction_hash FROM gas_receipts
    WHERE chain_id = ? AND (occurred_at IS NULL OR fee_wei IS NULL) AND next_check_at <= ?
    ORDER BY next_check_at, discovered_at DESC, transaction_hash LIMIT 10`,
  )
    .bind(CHAIN, now)
    .all<{ transaction_hash: string }>();
  if (!pending.length) return;
  const receipts = await rpcBatch(
    rpc,
    pending.map((r) => ["eth_getTransactionReceipt", [r.transaction_hash]]),
  );
  const blocks = [
    ...new Set(
      receipts
        .filter((r) => r?.blockNumber && BigInt(r.blockNumber) <= finalized)
        .map((r) => r.blockNumber as string),
    ),
  ];
  const blockResults = blocks.length
    ? await rpcBatch(
        rpc,
        blocks.map((b) => ["eth_getBlockByNumber", [b, false]]),
      )
    : [];
  await env.LIVE_DB.batch(
    pending.map((row, i) => {
      const r = receipts[i];
      const block = r && blockResults[blocks.indexOf(r.blockNumber)];
      if (
        !r ||
        !block?.timestamp ||
        r.transactionHash?.toLowerCase() !== row.transaction_hash ||
        !/^0x[0-9a-f]{40}$/i.test(r.from || "") ||
        !["0x0", "0x1"].includes(r.status)
      ) {
        return env.LIVE_DB.prepare(
          `UPDATE gas_receipts SET next_check_at = ? WHERE chain_id = ? AND transaction_hash = ?`,
        ).bind(now + 15 * MINUTE, CHAIN, row.transaction_hash);
      }
      return env.LIVE_DB.prepare(
        `UPDATE gas_receipts SET payer = ?, block_number = ?, occurred_at = ?,
      success = ?, fee_wei = ?, next_check_at = ? WHERE chain_id = ? AND transaction_hash = ?`,
      ).bind(
        r.from.toLowerCase(),
        Number(BigInt(r.blockNumber)),
        new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(),
        r.status === "0x1" ? 1 : 0,
        receiptFeeWei(r)?.toString() ?? null,
        now + 60 * MINUTE,
        CHAIN,
        row.transaction_hash,
      );
    }),
  );
}

export function summarize(
  receipts: ReceiptRow[],
  mints: MintRow[],
  relayer: string,
  since: number,
): Totals {
  const transactions = new Set(
    receipts
      .filter((r) => since === 0 || (r.occurred_at && Date.parse(r.occurred_at) >= since))
      .map((r) => r.transaction_hash),
  );
  const rows = mints.filter((m) => transactions.has(m.transaction_hash));
  const paid = receipts.filter(
    (r) => transactions.has(r.transaction_hash) && r.payer === relayer && r.fee_wei !== null,
  );
  const fees = paid.reduce((sum, r) => sum + BigInt(r.fee_wei!), 0n);
  return {
    units: rows.reduce((sum, r) => sum + r.units, 0),
    wallets: new Set(rows.map((r) => r.recipient)).size,
    transactions: new Set(rows.map((r) => r.transaction_hash)).size,
    paidTransactions: paid.length,
    failedTransactions: paid.filter((r) => r.success === 0).length,
    feeWei: fees.toString(),
    averageWei: paid.length ? (fees / BigInt(paid.length)).toString() : null,
  };
}

async function collectReport(
  env: Bindings,
  relayer: string,
  balance: bigint,
  previous: Level,
  now: number,
): Promise<GasReport> {
  const [receipts, mints, jobs, cursor] = await Promise.all([
    env.LIVE_DB.prepare(
      `SELECT transaction_hash,payer,occurred_at,success,fee_wei FROM gas_receipts WHERE chain_id = ?`,
    )
      .bind(CHAIN)
      .all<ReceiptRow>(),
    env.LIVE_DB.prepare(
      `SELECT c.transaction_hash, c.to_address AS recipient, c.value AS units,
      COALESCE(e.slug, 'unmapped') AS slug, COALESCE(e.title, '未對應活動') AS title, e.starts_at
      FROM live_chain_events c LEFT JOIN live_events e ON e.chain_id = c.chain_id
      AND e.contract_address = c.contract_address AND e.token_id = c.token_id
      WHERE c.chain_id = ? AND c.from_address = ?`,
    )
      .bind(CHAIN, ZERO)
      .all<MintRow>(),
    env.LIVE_DB.prepare(
      `SELECT status,COUNT(*) AS count FROM live_mint_jobs WHERE chain_id = ? GROUP BY status`,
    )
      .bind(CHAIN)
      .all<{ status: string; count: number }>(),
    env.LIVE_DB.prepare(
      `SELECT MIN(last_synced_at) AS synced FROM live_chain_cursors WHERE chain_id = ?`,
    )
      .bind(CHAIN)
      .first<{ synced: string | null }>(),
  ]);
  const periods = {
    days7: summarize(receipts.results, mints.results, relayer, now - 7 * DAY),
    days30: summarize(receipts.results, mints.results, relayer, now - 30 * DAY),
    all: summarize(receipts.results, mints.results, relayer, 0),
  };
  // Only complete successful receipts inform the remaining-mints estimate.
  const recent = receipts.results.filter(
    (r) =>
      r.payer === relayer &&
      r.success === 1 &&
      r.fee_wei !== null &&
      r.occurred_at &&
      Date.parse(r.occurred_at) >= now - 30 * DAY,
  );
  const average =
    recent.length >= 5
      ? recent.reduce((sum, r) => sum + BigInt(r.fee_wei!), 0n) / BigInt(recent.length)
      : null;
  const low = parseEther(env.GAS_MONITOR_LOW_ETH || "0.0002");
  const critical = parseEther(env.GAS_MONITOR_CRITICAL_ETH || "0.00002");
  if (critical <= 0n || low <= critical) throw new Error("gas_threshold_invalid");
  const dates = new Map(receipts.results.map((r) => [r.transaction_hash, r.occurred_at]));
  const groups = new Map<
    string,
    {
      date: string;
      event: string;
      slug: string;
      scheduledDate: string;
      units: number;
      wallets: Set<string>;
      txs: Set<string>;
    }
  >();
  for (const mint of mints.results) {
    const date = dates.get(mint.transaction_hash);
    const day = date ? taipeiDate(date) : "待補收據";
    const key = `${day}:${mint.slug}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        date: day,
        event: mint.title,
        slug: mint.slug,
        scheduledDate: mint.starts_at ? taipeiDate(mint.starts_at) : "未知",
        units: 0,
        wallets: new Set(),
        txs: new Set(),
      };
      groups.set(key, group);
    }
    group.units += mint.units;
    group.wallets.add(mint.recipient);
    group.txs.add(mint.transaction_hash);
  }
  let twdPerEth: number | null = null;
  try {
    const response = await fetch("https://api.coinbase.com/v2/prices/ETH-TWD/spot", {
      signal: AbortSignal.timeout(3000),
    });
    const price = (await response.json()) as { data?: { amount?: string; currency?: string } };
    const value = Number(price.data?.amount);
    if (response.ok && price.data?.currency === "TWD" && value > 0 && Number.isFinite(value))
      twdPerEth = value;
  } catch {
    /* Pricing failure must not stop ETH alerts. */
  }
  return {
    at: new Date(now).toISOString(),
    relayer,
    balanceWei: balance.toString(),
    level: alertLevel(balance, average, previous, low, critical),
    lowWei: low.toString(),
    criticalWei: critical.toString(),
    estimatedMints: average && average > 0n ? Number(balance / average) : null,
    pendingJobs: jobs.results
      .filter((j) => !["confirmed", "failed"].includes(j.status))
      .reduce((s, j) => s + j.count, 0),
    failedJobs: jobs.results.find((j) => j.status === "failed")?.count ?? 0,
    missingReceipts: receipts.results.filter((r) => !r.occurred_at).length,
    incompleteFees: receipts.results.filter((r) => r.occurred_at && r.fee_wei === null).length,
    indexerSyncedAt: cursor?.synced ?? null,
    periods,
    breakdown: [...groups.values()]
      .map((g) => ({
        date: g.date,
        event: g.event,
        slug: g.slug,
        scheduledDate: g.scheduledDate,
        eventDay:
          g.date === "待補收據" || g.scheduledDate === "未知"
            ? "未知"
            : g.date === g.scheduledDate
              ? "登錄活動日"
              : "非登錄活動日",
        units: g.units,
        wallets: g.wallets.size,
        transactions: g.txs.size,
      }))
      .sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug)),
    twdPerEth,
  };
}

function money(wei: string, report: GasReport): string {
  const eth = formatEther(BigInt(wei));
  return `${eth} ETH${report.twdPerEth ? `（約 NT$${(Number(eth) * report.twdPerEth).toFixed(2)}）` : ""}`;
}
export function gasCaption(report: GasReport, recovery = true): string {
  const labels = {
    healthy: recovery ? "✅ Gas 補款後已恢復" : "✅ Gas 餘額正常",
    low: "⚠️ Gas 餘額偏低，請安排補款",
    critical: "🚨 Gas 嚴重不足，請盡快補款",
  };
  const lines = [
    labels[report.level],
    `Base 主網 · ${report.at}`,
    `餘額：${money(report.balanceWei, report)}`,
    `按近30天均值約可鑄造：${report.estimatedMints ?? "樣本不足"}筆（未扣待處理交易）`,
    `待處理 ${report.pendingJobs} 筆／失敗 ${report.failedJobs} 筆`,
    `索引最近同步（最舊合約）：${report.indexerSyncedAt ?? "未知"}；尚未索引的鑄造不含在份數中。`,
  ];
  for (const [label, p] of [
    ["近7天", report.periods.days7],
    ["近30天", report.periods.days30],
    ["全部已索引紀錄", report.periods.all],
  ] as const) {
    lines.push(`${label}：${p.units}份／${p.wallets}個收件錢包／${p.transactions}筆鑄造交易`);
  }
  const p = report.periods.all;
  lines.push(
    `本錢包已知鑄造費：${money(p.feeWei, report)}`,
    `平均每筆實付：${p.averageWei ? money(p.averageWei, report) : "尚無資料"}（${p.paidTransactions}筆，含${p.failedTransactions}筆失敗）`,
    `收據待補 ${report.missingReceipts} 筆；費用欄位不完整 ${report.incompleteFees} 筆。`,
    "附件：依實際上鏈日與活動分組；日期對照系統目前登錄的活動日。",
    `補款地址（Base ETH）：${report.relayer}`,
    `https://basescan.org/address/${report.relayer}`,
    "台幣依通知時匯價估算；不含未記錄的舊失敗交易或其他轉帳。系統不會自動補款。",
  );
  return lines.join("\n");
}
export function gasCsv(report: GasReport): string {
  const cell = (v: unknown) => {
    let s = String(v);
    if (/^[=+@\-\t\r]/.test(s)) s = "'" + s;
    return `"${s.replaceAll('"', '""')}"`;
  };
  return (
    "\ufeff" +
    [
      [
        "上鏈日期(台灣)",
        "活動",
        "活動代號",
        "份數",
        "收件錢包數",
        "交易數",
        "目前登錄活動日",
        "日期對照",
      ],
      ...report.breakdown.map((r) => [
        r.date,
        r.event,
        r.slug,
        r.units,
        r.wallets,
        r.transactions,
        r.scheduledDate,
        r.eventDay,
      ]),
    ]
      .map((row) => row.map(cell).join(","))
      .join("\r\n")
  );
}

export function gasTelegramCaption(report: GasReport): string {
  const p = report.periods.all;
  const eth = (wei: string) => Number(formatEther(BigInt(wei))).toPrecision(6);
  const label = {
    healthy: "✅ Gas 餘額已恢復",
    low: "⚠️ Gas 餘額偏低，請安排補款",
    critical: "🚨 Gas 嚴重不足，請盡快補款",
  }[report.level];
  return [
    label,
    `Base 主網 · ${report.at}`,
    `餘額 ${eth(report.balanceWei)} ETH；近30天均值估計尚可 ${report.estimatedMints ?? "未知"} 筆（未扣待處理）`,
    ...(
      [
        ["近7天", report.periods.days7],
        ["近30天", report.periods.days30],
        ["全部已索引", p],
      ] as const
    ).map(([label, t]) => `${label}：${t.units}份／${t.wallets}錢包／${t.transactions}筆鑄造交易`),
    `本錢包已知鑄造費 ${eth(p.feeWei)} ETH；平均 ${p.averageWei ? eth(p.averageWei) : "未知"} ETH／筆（${p.paidTransactions}筆，含${p.failedTransactions}筆失敗）`,
    report.twdPerEth && p.averageWei
      ? `平均約 NT$${(Number(formatEther(BigInt(p.averageWei))) * report.twdPerEth).toFixed(4)}／筆（本次匯價）`
      : "台幣匯價暫無資料",
    `工作待處理 ${report.pendingJobs}／失敗 ${report.failedJobs}；收據待補 ${report.missingReceipts}／費用不完整 ${report.incompleteFees}`,
    `索引最近同步（最舊合約）：${report.indexerSyncedAt ?? "未知"}；未索引份數不計。`,
    "CSV：活動、台灣上鏈日期及是否符合目前登錄活動日。",
    `補款地址（Base ETH）：${report.relayer}`,
    "估計不保證可用筆數；不含未記錄的舊失敗交易或其他轉帳。不會自動補款。",
  ].join("\n");
}

async function sendTelegram(env: Bindings, report: GasReport): Promise<void> {
  const form = new FormData();
  form.set("chat_id", env.TELEGRAM_GAS_CHAT_ID!);
  // One Telegram delivery contains both the summary and attachment; a second
  // request would create a partial-success retry that repeats the warning.
  form.set("caption", gasTelegramCaption(report));
  form.set(
    "document",
    new Blob([gasCsv(report)], { type: "text/csv;charset=utf-8" }),
    `gas-usage-${taipeiDate(report.at)}.csv`,
  );
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_GAS_BOT_TOKEN}/sendDocument`,
    { method: "POST", body: form, signal: AbortSignal.timeout(10_000) },
  );
  const result = (await response.json()) as { ok?: boolean };
  if (!response.ok || result.ok !== true) throw new Error("gas_telegram_delivery_failed");
}

export async function runGasMonitor(env: Bindings, now = Date.now()): Promise<{ status: string }> {
  if (env.GAS_MONITOR_ENABLED !== "true") return { status: "disabled" };
  const relayer = mintRelayerAddress(env.MINT_RELAYER_PRIVATE_KEY).toLowerCase();
  const owner = crypto.randomUUID();
  const started = Date.now();
  await env.LIVE_DB.prepare(
    `INSERT OR IGNORE INTO gas_monitor_state (chain_id, relayer) VALUES (?, ?)`,
  )
    .bind(CHAIN, relayer)
    .run();
  const claim = await env.LIVE_DB.prepare(
    `UPDATE gas_monitor_state SET lease_owner = ?, lease_until = ?
    WHERE chain_id = ? AND relayer = ? AND next_check_at <= ? AND lease_until <= ?`,
  )
    .bind(owner, now + 5 * MINUTE, CHAIN, relayer, now, now)
    .run();
  if (!claim.meta.changes) return { status: "not_due" };
  try {
    const state = await env.LIVE_DB.prepare(
      `SELECT notified_level, notified_at FROM gas_monitor_state WHERE chain_id = ? AND relayer = ?`,
    )
      .bind(CHAIN, relayer)
      .first<{ notified_level: Level; notified_at: number }>();
    const rpc = baseMainnetRpcUrl(env);
    const [balanceHex, finalized] = await rpcBatch(rpc, [
      ["eth_getBalance", [relayer, "latest"]],
      ["eth_getBlockByNumber", ["finalized", false]],
    ]);
    if (typeof balanceHex !== "string" || !/^0x[0-9a-f]+$/i.test(balanceHex) || !finalized?.number)
      throw new Error("gas_balance_unknown");
    try {
      await backfill(env, rpc, now, BigInt(finalized.number));
    } catch {
      console.error("Gas receipt backfill incomplete; balance monitoring continues.");
    }
    const report = await collectReport(
      env,
      relayer,
      BigInt(balanceHex),
      state!.notified_level,
      now,
    );
    const configured = Boolean(env.TELEGRAM_GAS_BOT_TOKEN && env.TELEGRAM_GAS_CHAT_ID);
    let notified = false;
    if (
      configured &&
      notificationDue(report.level, state!.notified_level, state!.notified_at, now)
    ) {
      const fenceAt = now + Date.now() - started;
      const fence = await env.LIVE_DB.prepare(
        `UPDATE gas_monitor_state SET lease_until = ?
        WHERE chain_id = ? AND relayer = ? AND lease_owner = ? AND lease_until > ?`,
      )
        .bind(fenceAt + MINUTE, CHAIN, relayer, owner, fenceAt)
        .run();
      if (!fence.meta.changes) return { status: "superseded" };
      await sendTelegram(env, report);
      notified = true;
    }
    await env.LIVE_DB.prepare(
      `UPDATE gas_monitor_state SET report_json = ?, next_check_at = ?, lease_until = 0, lease_owner = NULL,
      last_error_at = NULL, notified_level = CASE WHEN ? THEN ? ELSE notified_level END,
      notified_at = CASE WHEN ? THEN ? ELSE notified_at END WHERE chain_id = ? AND relayer = ? AND lease_owner = ?`,
    )
      .bind(
        JSON.stringify(report),
        now + (report.missingReceipts ? MINUTE : 15 * MINUTE),
        notified ? 1 : 0,
        report.level,
        notified ? 1 : 0,
        now,
        CHAIN,
        relayer,
        owner,
      )
      .run();
    return {
      status: configured ? (notified ? "notified" : "healthy_or_suppressed") : "awaiting_telegram",
    };
  } catch {
    // Do not log exception messages: transport errors can contain RPC/Bot tokens.
    await env.LIVE_DB.prepare(
      `UPDATE gas_monitor_state SET last_error_at = ?, next_check_at = ?, lease_until = 0,
      lease_owner = NULL WHERE chain_id = ? AND relayer = ? AND lease_owner = ?`,
    )
      .bind(now, now + MINUTE, CHAIN, relayer, owner)
      .run();
    console.error("Gas monitor could not complete; prior notification state retained.");
    return { status: "retry" };
  }
}
