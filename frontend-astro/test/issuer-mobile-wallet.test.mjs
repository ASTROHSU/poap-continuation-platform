import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createMobilePairing } from "../src/lib/issuer-mobile-wallet.ts";
import { requireOwnerWallet, ISSUER_OWNER } from "../src/lib/issuer-wallet.ts";

const options = {
  projectId: "a".repeat(32),
  origin: "https://admin.poap.blocktrend.today",
  onUri() {},
};
function mockProvider() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    accounts: [ISSUER_OWNER],
    chainId: 8453,
    session: undefined,
    requests: [],
    connects: 0,
    disconnects: 0,
    aborts: 0,
    signer: {
      abortPairingAttempt() {
        emitter.aborts++;
      },
    },
    async connect() {
      this.connects++;
      this.emit("display_uri", "wc:1234abcd@2?relay-protocol=irn&symKey=do-not-log");
      this.session = {};
    },
    async disconnect() {
      this.disconnects++;
      this.session = undefined;
      this.emit("disconnect");
    },
    async request(args) {
      this.requests.push(args);
      return "0xhash";
    },
  });
}

test("missing project configuration never initializes a provider", async () => {
  let called = false;
  await assert.rejects(
    createMobilePairing({ ...options, projectId: "" }, async () => {
      called = true;
    }),
    /設定/,
  );
  assert.equal(called, false);
});

test("QR pairing and owner verification never sign, switch chains, or send a transaction", async () => {
  const provider = mockProvider(),
    uris = [];
  const pairing = await createMobilePairing(
    { ...options, onUri: (uri) => uris.push(uri) },
    async () => provider,
  );
  assert.equal(provider.connects, 0);
  const wallet = await pairing.connect();
  assert.equal(uris.length, 1);
  assert.equal(provider.listenerCount("display_uri"), 0);
  assert.equal(await requireOwnerWallet(wallet.provider, true), ISSUER_OWNER);
  assert.deepEqual(provider.requests, []);
  await assert.rejects(wallet.provider.request({ method: "personal_sign" }), /未允許/);
  assert.deepEqual(provider.requests, []);
});

test("a mobile wallet with the wrong account or chain cannot pass owner verification", async () => {
  const provider = mockProvider();
  const wallet = await (await createMobilePairing(options, async () => provider)).connect();
  provider.accounts = ["0x0000000000000000000000000000000000000001"];
  await assert.rejects(requireOwnerWallet(wallet.provider, true), /owner/);
  provider.accounts = [ISSUER_OWNER];
  provider.chainId = 1;
  await assert.rejects(requireOwnerWallet(wallet.provider, true), /Base/);
  assert.deepEqual(provider.requests, []);
});

test("restored sessions are used only after an explicit connect and can be disconnected", async () => {
  const provider = mockProvider();
  provider.session = {};
  const pairing = await createMobilePairing(options, async () => provider);
  const wallet = await pairing.connect();
  assert.equal(provider.connects, 0);
  await pairing.disconnect();
  await assert.rejects(wallet.provider.request({ method: "eth_accounts" }), /斷線/);
  assert.equal(provider.disconnects, 1);
});

test("cancelled pairing cannot silently reconnect after a late phone approval", async () => {
  const provider = mockProvider();
  let accept;
  provider.connect = () =>
    new Promise((resolve) => {
      accept = () => {
        provider.session = {};
        resolve();
      };
    });
  const pairing = await createMobilePairing(options, async () => provider);
  const connecting = pairing.connect();
  await assert.rejects(pairing.connect(), /重複/);
  await pairing.cancel();
  await assert.rejects(connecting, /取消/);
  accept();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(provider.disconnects, 1);
  assert.equal(provider.session, undefined);
  assert.equal(provider.listenerCount("display_uri"), 0);
  assert.deepEqual(provider.requests, []);
});

test("wallet change events reach the issuance guard and requests remain exact", async () => {
  const provider = mockProvider();
  const wallet = await (await createMobilePairing(options, async () => provider)).connect();
  let changes = 0;
  const changed = () => changes++;
  wallet.provider.on("accountsChanged", changed);
  provider.emit("accountsChanged", []);
  assert.equal(changes, 1);
  wallet.provider.removeListener("accountsChanged", changed);
  provider.emit("accountsChanged", []);
  assert.equal(changes, 1);
  const tx = {
    from: ISSUER_OWNER,
    to: "0x9375b610859b1a5feea3c7c7c45fc20712f506cb",
    value: "0x0",
    data: "0x1234",
    chainId: "0x2105",
  };
  assert.equal(
    await wallet.provider.request({ method: "eth_sendTransaction", params: [tx] }),
    "0xhash",
  );
  assert.deepEqual(provider.requests, [{ method: "eth_sendTransaction", params: [tx] }]);
});
