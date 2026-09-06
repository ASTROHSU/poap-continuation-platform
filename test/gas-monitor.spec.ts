import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  alertLevel,
  notificationDue,
  receiptFeeWei,
  runGasMonitor,
  summarize,
  taipeiDate,
  gasCaption,
  gasCsv,
  gasTelegramCaption,
} from "../src/worker/gas-monitor";

const bindings = {
  ...env,
  GAS_MONITOR_ENABLED: "true",
  TELEGRAM_GAS_BOT_TOKEN: "test-token",
  TELEGRAM_GAS_CHAT_ID: "test-recipient",
  BASE_MAINNET_ALCHEMY_RPC_URL: "https://rpc.example.test",
} as any;
beforeAll(async () => applyD1Migrations(bindings.LIVE_DB, bindings.TEST_LIVE_MIGRATIONS));
afterEach(() => vi.restoreAllMocks());

function network(initialBalance: bigint) {
  const state = {
    balance: initialBalance,
    rpcFailure: false,
    deliveryFailure: false,
    messages: [] as string[],
    documents: 0,
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "https://rpc.example.test") {
      if (state.rpcFailure) throw new Error("provider unreachable");
      const calls = JSON.parse(String(init?.body));
      return Response.json(
        calls.map((call: any) => ({
          id: call.id,
          jsonrpc: "2.0",
          result:
            call.method === "eth_getBalance"
              ? `0x${state.balance.toString(16)}`
              : { number: "0x1000", timestamp: "0x60000000" },
        })),
      );
    }
    if (url.includes("coinbase.com"))
      return Response.json({ data: { amount: "65000", currency: "TWD" } });
    if (url.endsWith("sendDocument")) {
      state.messages.push(String((init?.body as FormData).get("caption")));
      state.documents++;
      return Response.json({ ok: !state.deliveryFailure });
    }
    throw new Error("Unexpected network request");
  });
  return state;
}
const LOW = 200_000_000_000_000n,
  CRITICAL = 20_000_000_000_000n;

describe("gas accounting and notification policy", () => {
  it("includes actual L1 cost, preserves integer precision and fails incomplete receipts closed", () => {
    expect(
      receiptFeeWei({ gasUsed: "0x2", effectiveGasPrice: "9007199254740993", l1Fee: "7" }),
    ).toBe(18014398509481993n);
    expect(receiptFeeWei({ gasUsed: "1", effectiveGasPrice: "2" })).toBeNull();
    expect(
      receiptFeeWei({ gasUsed: "1", effectiveGasPrice: "2", l1Fee: "3", operatorFeeScalar: "1" }),
    ).toBeNull();
    expect(
      receiptFeeWei({ gasUsed: "1", effectiveGasPrice: "2", l1Fee: "3", operatorFee: "4" }),
    ).toBe(9n);
  });
  it("deduplicates transaction costs across batch mint rows and separates sponsored costs", () => {
    const receipts = [
      {
        transaction_hash: "a",
        payer: "sponsor",
        occurred_at: "2026-09-06T00:00:00Z",
        success: 1,
        fee_wei: "9007199254740993",
      },
      {
        transaction_hash: "b",
        payer: "other",
        occurred_at: "2026-09-06T00:00:00Z",
        success: 1,
        fee_wei: "99",
      },
    ];
    const mints = ["alice", "bob"].map((recipient) => ({
      transaction_hash: "a",
      recipient,
      units: 1,
      slug: "test",
      title: "test",
      starts_at: null,
    }));
    expect(summarize(receipts, mints, "sponsor", 0)).toMatchObject({
      units: 2,
      wallets: 2,
      transactions: 1,
      paidTransactions: 1,
      feeWei: "9007199254740993",
    });
  });
  it("uses Taiwan calendar dates and keeps hysteresis after a warning", () => {
    expect(taipeiDate("2026-09-05T17:00:00Z")).toBe("2026-09-06");
    expect(taipeiDate("bad")).toBe("未知");
    expect(alertLevel(0n, null, "healthy", LOW, CRITICAL)).toBe("critical");
    expect(alertLevel(LOW + 1n, null, "low", LOW, CRITICAL)).toBe("low");
    expect(alertLevel(LOW * 2n, null, "low", LOW, CRITICAL)).toBe("healthy");
    expect(notificationDue("low", "low", 1000, 2000)).toBe(false);
    expect(notificationDue("critical", "low", 1000, 2000)).toBe(true);
    expect(notificationDue("low", "low", 1000, 86_401_000)).toBe(true);
    expect(notificationDue("healthy", "healthy", 0, 1000)).toBe(false);
  });
});

describe("durable scheduled gas monitor", () => {
  it("backfills a finalized receipt with its block date and actual L1-inclusive fee", async () => {
    const hash = "0x" + "a".repeat(64);
    await bindings.LIVE_DB.prepare(
      "INSERT INTO gas_receipts (chain_id, transaction_hash) VALUES (8453, ?)",
    )
      .bind(hash)
      .run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).includes("coinbase")) return Response.json({});
      const calls = JSON.parse(String(init?.body));
      return Response.json(
        calls.map((c: any) => ({
          id: c.id,
          result:
            c.method === "eth_getBalance"
              ? "0x10000000000000"
              : c.method === "eth_getTransactionReceipt"
                ? {
                    transactionHash: hash,
                    blockNumber: "0x1000",
                    from: "0x" + "1".repeat(40),
                    status: "0x1",
                    gasUsed: "0x2",
                    effectiveGasPrice: "0x3",
                    l1Fee: "0x5",
                  }
                : { number: "0x1000", timestamp: "0x60000000" },
        })),
      );
    });
    await runGasMonitor({ ...bindings, TELEGRAM_GAS_CHAT_ID: "" });
    const row = await bindings.LIVE_DB.prepare(
      "SELECT fee_wei, occurred_at FROM gas_receipts WHERE transaction_hash=?",
    )
      .bind(hash)
      .first();
    expect(row.fee_wei).toBe("11");
    expect(row.occurred_at).toBe(new Date(0x60000000 * 1000).toISOString());
  });

  it("sends a warning once, suppresses duplicates, escalates, and announces funding recovery", async () => {
    const n = network(LOW / 2n);
    const now = Date.now();
    expect(await runGasMonitor(bindings, now)).toEqual({ status: "notified" });
    expect(n.messages[0]).toContain("Gas 餘額偏低");
    expect(n.documents).toBe(1);
    expect(await runGasMonitor(bindings, now + 60_000)).toEqual({ status: "not_due" });
    await runGasMonitor(bindings, now + 16 * 60_000);
    expect(n.messages).toHaveLength(1);
    n.balance = 0n;
    await runGasMonitor(bindings, now + 32 * 60_000);
    expect(n.messages[1]).toContain("嚴重不足");
    n.balance = LOW * 3n;
    await runGasMonitor(bindings, now + 48 * 60_000);
    expect(n.messages[2]).toContain("已恢復");
    expect(n.messages.every((m) => m.length <= 1024)).toBe(true);
  });
  it("does not mark failed Telegram delivery as delivered and retries", async () => {
    const n = network(LOW / 2n);
    n.deliveryFailure = true;
    const now = Date.now();
    expect(await runGasMonitor(bindings, now)).toEqual({ status: "retry" });
    const state = await bindings.LIVE_DB.prepare(
      "SELECT notified_at FROM gas_monitor_state",
    ).first();
    expect(state.notified_at).toBe(0);
    n.deliveryFailure = false;
    expect(await runGasMonitor(bindings, now + 61_000)).toEqual({ status: "notified" });
  });
  it("does not send recovery on unknown balance and isolates monitoring from missing recipient", async () => {
    const n = network(LOW / 2n);
    const now = Date.now();
    await runGasMonitor(bindings, now);
    n.rpcFailure = true;
    expect(await runGasMonitor(bindings, now + 16 * 60_000)).toEqual({ status: "retry" });
    expect(n.messages).toHaveLength(1);
    n.rpcFailure = false;
    expect(
      await runGasMonitor({ ...bindings, TELEGRAM_GAS_CHAT_ID: "" }, now + 17 * 60_000),
    ).toEqual({ status: "awaiting_telegram" });
    expect(n.messages).toHaveLength(1);
  });
  it("atomically permits only one overlapping scheduled run", async () => {
    const n = network(LOW / 2n);
    const now = Date.now();
    const results = await Promise.all([runGasMonitor(bindings, now), runGasMonitor(bindings, now)]);
    expect(results.map((r) => r.status).sort()).toEqual(["not_due", "notified"]);
    expect(n.messages).toHaveLength(1);
    const row = await bindings.LIVE_DB.prepare("SELECT report_json FROM gas_monitor_state").first();
    const report = JSON.parse(row.report_json);
    report.breakdown = [
      {
        date: "2026-09-06",
        event: "=evil",
        slug: "x",
        units: 2,
        wallets: 2,
        transactions: 1,
        scheduledDate: "2026-09-06",
        eventDay: "登錄活動日",
      },
    ];
    expect(gasCsv(report)).toContain("'=evil");
    expect(gasTelegramCaption(report).length).toBeLessThanOrEqual(1024);
    expect(gasCaption(report)).toContain("系統不會自動補款");
  });
});
