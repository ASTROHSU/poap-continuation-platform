// Run with the local Vite harness. All wallet and RPC traffic is mocked; no real wallet is connected.
import { chromium, webkit } from "playwright";
import assert from "node:assert/strict";

const mock = `
export async function createMobilePairing({onUri}) {
  let reject, approved = false;
  const listeners = new Map();
  const provider = {
    async request({method}) {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return ['0xb3492740f78c046b5bd6c6d4c188623bcecc36ac'];
      if (method === 'eth_chainId') return '0x2105';
      window.__transactionRequests = (window.__transactionRequests || 0) + 1;
      throw Error('No transactions in UI tests');
    },
    on(event,fn) { listeners.set(event,fn); },
    removeListener(event,fn) { if(listeners.get(event)===fn) listeners.delete(event); }
  };
  return {
    connect() { onUri('wc:'+'a'.repeat(64)+'@2?relay-protocol=irn&symKey='+'b'.repeat(64));
      return new Promise((resolve,r) => {reject=r;window.__approveRabby=()=>{approved=true;resolve({id:'rabby-mobile-walletconnect',name:'手機 Rabby（WalletConnect）',provider});};});
    },
    async cancel() { if(!approved) reject?.(new Error('已取消手機錢包連線')); listeners.get('disconnect')?.(); },
    async disconnect() { listeners.get('disconnect')?.(); }
  };
}`;

for (const [name, engine] of [
  ["chromium", chromium],
  ["webkit", webkit],
]) {
  const browser = await engine.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } });
    const errors = [],
      external = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      console.error(name, "page error:", error.message);
    });
    await page.route("**/src/lib/issuer-mobile-wallet.ts*", (route) =>
      route.fulfill({ contentType: "application/javascript", body: mock }),
    );
    await page.route("**/artwork.svg", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><circle cx="48" cy="48" r="46" fill="#1d497c"/><text x="48" y="53" fill="white" text-anchor="middle" font-size="16">TEST</text></svg>',
      }),
    );
    await page.route("https://**/*", (route) => {
      external.push(route.request().url());
      return route.abort();
    });
    await page.goto("http://127.0.0.1:4317/");
    await page.getByRole("button", { name: "連接手機 Rabby", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "本人確認發行", exact: true }).isEnabled(),
      false,
    );
    await page.getByRole("button", { name: "連接手機 Rabby", exact: true }).click();
    const qr = page.getByRole("img", { name: "請用手機 Rabby 掃描的 WalletConnect 連線 QR Code" });
    await qr.waitFor();
    assert.match(await qr.getAttribute("src"), /^data:image\/png;base64,/);
    assert.equal(await page.evaluate(() => window.__transactionRequests || 0), 0);
    await page.screenshot({
      path: new URL(`../../../../${name}-wallet-qr.png`, import.meta.url).pathname,
      fullPage: true,
    });
    await page.evaluate(() => window.__approveRabby());
    await page.getByRole("button", { name: "手機 Rabby 已連接", exact: true }).waitFor();
    await page.getByRole("button", { name: "連接並核對 owner", exact: true }).click();
    await page.getByText("已核對 owner：", { exact: false }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "本人確認發行", exact: true }).isEnabled(),
      false,
    );
    await page.getByRole("button", { name: "斷開手機錢包", exact: true }).click();
    await page.getByRole("button", { name: "連接手機 Rabby", exact: true }).waitFor();
    await page.getByRole("button", { name: "連接手機 Rabby", exact: true }).click();
    await qr.waitFor();
    await page.getByRole("button", { name: "取消連線", exact: true }).click();
    await page.getByRole("button", { name: "連接手機 Rabby", exact: true }).waitFor();
    assert.equal(
      await page.getByRole("button", { name: "連接手機 Rabby", exact: true }).isEnabled(),
      true,
    );
    assert.equal(await page.evaluate(() => window.__transactionRequests || 0), 0);
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    console.log(
      `${name}: QR rendered without injected wallet; phone owner verified; disconnect and cancel work; no external requests or transactions`,
    );
  } finally {
    await browser.close();
  }
}
