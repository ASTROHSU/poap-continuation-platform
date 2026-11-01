import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import {
  discoverWallets,
  issuancePlan,
  issuerAbi,
  ISSUER_CONTRACT,
  ISSUER_OWNER,
  issueWithOwnerWallet,
  journalKey,
  loadJournal,
  requireOwnerWallet,
  reviewIssuance,
  verifyIssuanceReceipt,
} from "../src/lib/issuer-wallet.ts";

const event = {
  slug: "platform-operations-okx-bybit-2026-11",
  title: "11 月平台操作課",
  imageUrl: "/media/live/events/platform-operations-okx-bybit-2026-11/artwork.png",
  maxSupply: 200,
  chainId: 8453,
  tokenId: null,
  contractAddress: null,
};
const plan = issuancePlan(event);
const hash = `0x${"ab".repeat(32)}`;
const missing = () =>
  Object.assign(new Error("reverted"), { cause: { data: { errorName: "EventDoesNotExist" } } });
const metadata = async (url) => {
  assert.equal(url, new URL(plan.metadataUri).pathname);
  return Response.json({
    name: event.title,
    image: `https://poap.blocktrend.today${event.imageUrl}`,
  });
};
function storage() {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, value),
    removeItem: (key) => map.delete(key),
  };
}
function client(overrides = {}) {
  return {
    getChainId: async () => 8453,
    readContract: async (args) => {
      if (args.functionName === "owner") return ISSUER_OWNER;
      throw missing();
    },
    simulateContract: async () => ({}),
    ...overrides,
  };
}
function wallet(overrides = {}) {
  const calls = [];
  return {
    calls,
    request: async (args) => {
      calls.push(args);
      if (overrides[args.method]) return overrides[args.method](args);
      if (["eth_accounts", "eth_requestAccounts"].includes(args.method)) return [ISSUER_OWNER];
      if (args.method === "eth_chainId") return "0x2105";
      if (args.method === "eth_sendTransaction") return hash;
      throw Error("Unexpected wallet method");
    },
  };
}
const input = (provider, store, overrides = {}) => ({
  provider,
  client: client(),
  event,
  storage: store,
  isCurrent: () => true,
  loadMetadata: metadata,
  ...overrides,
});

test("all four fixed plans bind unique tokens and do not assign other activities", () => {
  for (const [slug, id] of [
    ["november-book-club-2026", 10],
    [event.slug, 11],
    ["december-book-club-2026", 12],
    ["platform-operations-firstrade-etoro-2026-12", 13],
  ]) {
    assert.equal(issuancePlan({ ...event, slug }).tokenId, id);
  }
  assert.equal(issuancePlan({ ...event, slug: "other" }), null);
  for (const change of [
    { maxSupply: 201 },
    { chainId: 1 },
    { tokenId: "10" },
    { contractAddress: ISSUER_OWNER },
  ]) {
    assert.throws(() => issuancePlan({ ...event, ...change }));
  }
});

test("provider discovery is explicit, deduplicated and never requests accounts", () => {
  const target = new EventTarget(),
    provider = wallet(),
    choices = [];
  target.ethereum = provider;
  const stop = discoverWallets(target, (choice) => choices.push(choice));
  const announce = new Event("eip6963:announceProvider");
  announce.detail = { info: { uuid: "rabby", name: "Rabby" }, provider };
  target.dispatchEvent(announce);
  assert.equal(choices.length, 1);
  assert.equal(provider.calls.length, 0);
  stop();
});

test("read-only wallet checks never request permissions; connect is deliberate", async () => {
  const provider = wallet();
  await requireOwnerWallet(provider);
  assert.equal(provider.calls[0].method, "eth_accounts");
  await requireOwnerWallet(provider, true);
  assert.equal(provider.calls[2].method, "eth_requestAccounts");
  await assert.rejects(requireOwnerWallet(wallet({ eth_chainId: () => "0x1" })), /Base/);
  await assert.rejects(
    requireOwnerWallet(wallet({ eth_accounts: () => [ISSUER_CONTRACT] })),
    /owner/,
  );
});

test("review fails closed on unreadable RPC, changed owner or metadata mismatch", async () => {
  await assert.rejects(
    reviewIssuance(
      client({
        readContract: async () => {
          throw Error("offline");
        },
      }),
      event,
      metadata,
    ),
    /offline/,
  );
  await assert.rejects(
    reviewIssuance(client({ readContract: async () => ISSUER_CONTRACT }), event, metadata),
    /owner/,
  );
  await assert.rejects(
    reviewIssuance(client(), event, async () =>
      Response.json({ name: "wrong", image: event.imageUrl }),
    ),
    /metadata/,
  );
  await assert.rejects(
    reviewIssuance(client({ getChainId: async () => 1 }), event, metadata),
    /網路/,
  );
});

test("already-issued matching token, including token10, is never sent again", async () => {
  const provider = wallet(),
    c = client({
      readContract: async (args) =>
        args.functionName === "owner" ? ISSUER_OWNER : [200n, true, plan.metadataUri],
    });
  assert.equal((await reviewIssuance(c, event, metadata)).issued, true);
  await assert.rejects(issueWithOwnerWallet(input(provider, storage(), { client: c })), /已發行/);
  assert.equal(provider.calls.length, 0);
  const nov = {
    ...event,
    slug: "november-book-club-2026",
    tokenId: "10",
    contractAddress: ISSUER_CONTRACT,
  };
  const p = issuancePlan(nov);
  const c10 = client({
    readContract: async (args) =>
      args.functionName === "owner" ? ISSUER_OWNER : [200n, true, p.metadataUri],
  });
  const m10 = async () => Response.json({ name: nov.title, image: nov.imageUrl });
  await assert.rejects(
    issueWithOwnerWallet(
      input(provider, storage(), { client: c10, event: nov, loadMetadata: m10 }),
    ),
    /已發行/,
  );
  assert.equal(provider.calls.length, 0);
});

test("existing token with other metadata blocks issuance", async () => {
  const c = client({
    readContract: async (args) =>
      args.functionName === "owner" ? ISSUER_OWNER : [200n, true, "https://wrong.test/"],
  });
  await assert.rejects(reviewIssuance(c, event, metadata), /其他活動/);
});

test("send only after fresh simulation, with exact zero-value parameters and no server", async () => {
  const provider = wallet(),
    store = storage();
  const journal = await issueWithOwnerWallet(input(provider, store));
  assert.equal(journal.hash, hash);
  const sends = provider.calls.filter((c) => c.method === "eth_sendTransaction");
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].params, [
    { from: ISSUER_OWNER, to: ISSUER_CONTRACT, chainId: "0x2105", value: "0x0", data: plan.data },
  ]);
  await assert.rejects(issueWithOwnerWallet(input(provider, store)), /禁止重送/);
});

test("simulation failure and wallet/account context changes never send", async () => {
  for (const overrides of [
    {
      client: client({
        simulateContract: async () => {
          throw Error("revert");
        },
      }),
    },
    { isCurrent: () => false },
  ]) {
    const provider = wallet();
    await assert.rejects(issueWithOwnerWallet(input(provider, storage(), overrides)));
    assert.equal(
      provider.calls.some((c) => c.method === "eth_sendTransaction"),
      false,
    );
  }
});

test("user cancellation can retry; uncertain errors and reload journals prohibit retry", async () => {
  const store = storage(),
    rejected = wallet({
      eth_sendTransaction: () => {
        throw Object.assign(Error("cancel"), { code: 4001 });
      },
    });
  await assert.rejects(issueWithOwnerWallet(input(rejected, store)));
  assert.equal(loadJournal(store, plan), null);
  const unknown = wallet({
    eth_sendTransaction: () => {
      throw Error("transport lost");
    },
  });
  await assert.rejects(issueWithOwnerWallet(input(unknown, store)));
  assert.equal(loadJournal(store, plan).phase, "uncertain");
  await assert.rejects(issueWithOwnerWallet(input(wallet(), store)), /禁止重送/);
  store.setItem(journalKey(plan), "malformed");
  assert.equal(loadJournal(store, plan).phase, "uncertain");
});

test("pending wallet request writes journal before send so second request cannot duplicate", async () => {
  const store = storage();
  let release, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const provider = wallet({
    eth_sendTransaction: () => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const first = issueWithOwnerWallet(input(provider, store));
  await started;
  await assert.rejects(issueWithOwnerWallet(input(provider, store)), /禁止重送/);
  release(hash);
  await first;
  assert.equal(provider.calls.filter((c) => c.method === "eth_sendTransaction").length, 1);
});

function receiptClient(change = {}) {
  const log = {
    address: ISSUER_CONTRACT,
    topics: encodeEventTopics({
      abi: issuerAbi,
      eventName: "EventConfigured",
      args: { tokenId: 11n },
    }),
    data: encodeAbiParameters([{ type: "uint256" }, { type: "string" }], [200n, plan.metadataUri]),
  };
  return client({
    getTransactionReceipt: async () => ({
      status: "success",
      to: ISSUER_CONTRACT,
      from: ISSUER_OWNER,
      blockNumber: 50n,
      logs: [log],
      ...change,
    }),
    getTransaction: async () => ({
      to: ISSUER_CONTRACT,
      from: ISSUER_OWNER,
      input: plan.data,
      value: 0n,
    }),
    getBlockNumber: async () => 51n,
  });
}
test("receipt must prove success, exact sender, target, calldata and matching event", async () => {
  assert.deepEqual(await verifyIssuanceReceipt(receiptClient(), plan, hash), {
    hash,
    blockNumber: "50",
  });
  for (const change of [
    { status: "reverted" },
    { from: ISSUER_CONTRACT },
    { to: ISSUER_OWNER },
    { logs: [] },
  ]) {
    await assert.rejects(verifyIssuanceReceipt(receiptClient(change), plan, hash));
  }
  const c = receiptClient();
  c.getTransaction = async () => ({
    to: ISSUER_CONTRACT,
    from: ISSUER_OWNER,
    input: "0x",
    value: 0n,
  });
  await assert.rejects(verifyIssuanceReceipt(c, plan, hash), /參數不符/);
});
test("unconfirmed or missing receipt never causes another transaction", async () => {
  const c = receiptClient();
  c.getBlockNumber = async () => 50n;
  await assert.rejects(verifyIssuanceReceipt(c, plan, hash), /勿重送/);
  c.getTransactionReceipt = async () => {
    throw Error("not found");
  };
  await assert.rejects(verifyIssuanceReceipt(c, plan, hash), /not found/);
});
