# Phase 2：Base Sepolia 真實鑄造操作手冊

本階段採「協會 relayer 代付 Gas」方案。領取者連接自己的錢包只為確認收件地址；
平台簽發 15 分鐘有效的 EIP-712 授權，再由協會 relayer 送出 Base Sepolia 交易。
平台不持有收藏者私鑰，收藏者不需準備 ETH 或在錢包簽署鑄造交易。

15 GB 歷史快照不在本流程內。Phase 2 只建立 2026 年 7 月之後的新發行系統。

## 已完成的系統能力

- 自有 ERC-1155 `AssociationBadges` 合約，一個活動對應一個 token ID。
- 合約限制最大供應量、活動開關、每地址一次、nonce 防重播與授權期限。
- 合約 owner、Worker claim signer 與付 Gas 的 relayer 分離。
- 活動圖片與 metadata 可上傳到協會自己的 R2，並由同一網域的 `/media/` 路徑提供。
- 領取碼換取短效 EIP-712 授權；交易失敗時可重取同一資格，不會先消耗鏈上名額。
- 前端連接錢包取得收件地址；後端鎖定同一筆領取後由 relayer 送出交易，前端等待 receipt 並寫回 tx hash。
- Worker 會從 Base Sepolia RPC 驗證 receipt 內的 ERC-1155 `TransferSingle`，不直接相信瀏覽器回報。
- 收藏頁可顯示 `reserved`、`ready` 與 `minted` 狀態。

## 上測試網前需要準備

1. 協會自己的 Cloudflare account、D1、R2 與 Workers 網址。
2. 一個只用於部署／管理合約的錢包，內有少量 Base Sepolia ETH。
3. 一個與管理錢包不同的 Worker claim signer。
4. 一個只放少量 Base ETH、專門代付 Gas 的 relayer。
5. 第一場測試活動的圖片、文字、最大發行量與 token ID。

目前 repo 的 Cloudflare database UUID 仍是佔位值；沒有替換為自己的資源前，不可直接正式部署。

## 1. 建立獨立 claim signer 與 relayer

在專案根目錄執行：

```bash
npm run secrets:prepare
```

它會在 Git ignore 的 `build/secrets/` 建立：

```text
worker-secrets.production.json
mint-signer-address.txt
mint-relayer-address.txt
```

檔案權限為 `0600`，再次執行也不會覆寫既有金鑰。補上 Resend key 後，以 bulk secret
指令把兩把私鑰與 Email secrets 一起存入 Cloudflare：

```bash
npm run pilot:secrets:upload
```

合約部署只需要 `mint-signer-address.txt` 的公開地址。把足以完成本場名額的少量測試 ETH
轉入 `mint-relayer-address.txt`；signer 不需持有 ETH。

## 2. 準備 Cloudflare 資源

把 `wrangler.jsonc` 的 `LIVE_DB` UUID、R2 bucket 與其他佔位資源換成協會自己的資源，
然後套用遠端 migration：

```bash
npx wrangler d1 migrations apply LIVE_DB --remote
```

先部署一次，取得固定的 HTTPS 網址：

```bash
npm run deploy
```

NFT metadata 與圖片會由：

```text
https://你的網域/media/live/events/{slug}/metadata.json
https://你的網域/media/live/events/{slug}/artwork.{ext}
```

公開讀取。

## 3. 準備活動、QR 與媒體

在活動 JSON 中使用正式網址，例如：

```json
{
  "imageUrl": "https://你的網域/media/live/events/first-test/artwork.png",
  "imageFile": "./first-test.png",
  "chainId": 84532,
  "publicBaseUrl": "https://你的網域"
}
```

產生發行包：

```bash
npm run event:prepare -- --event events/first-test.json
```

發行包現在包含：

```text
metadata.json
artwork.png
load-event.sql
claim-links.csv
qr-index.html
qr/
```

上傳公開媒體；遠端操作必須再次確認 slug：

```bash
npm run event:media -- \
  --bundle build/events/first-test \
  --bucket association-poap-archive \
  --target remote \
  --confirm-remote first-test
```

確認兩個 HTTPS 網址都能直接讀取，且 `metadata.json` 的 `image` 指向正確圖片。

## 4. 部署 ERC-1155 合約

在 `contracts/` 安裝依賴，並把部署錢包私鑰放入 Hardhat 加密 keystore：

```bash
cd contracts
npm ci
npx hardhat keystore set BASE_SEPOLIA_PRIVATE_KEY
```

準備兩個公開地址後部署：

```bash
CONTRACT_OWNER_ADDRESS=0x管理錢包 \
CLAIM_SIGNER_ADDRESS=0x簽章地址 \
npm run deploy:base-sepolia
```

輸出會包含合約地址、transaction hash 與區塊。部署者、owner、claim signer 可以是不同地址；
MVP 可讓部署者與 owner 相同，但 claim signer 必須獨立。

## 5. 在合約與 D1 建立同一場活動

先在合約建立 token ID：

```bash
CONTRACT_ADDRESS=0x合約地址 \
TOKEN_ID=1 \
MAX_SUPPLY=100 \
METADATA_URI=https://你的網域/media/live/events/first-test/metadata.json \
npm run event:create:base-sepolia
```

回到專案根目錄，載入活動資格並寫入鏈上識別：

```bash
npm run event:load -- \
  --bundle build/events/first-test \
  --slug first-test \
  --target remote \
  --confirm-remote first-test \
  --config wrangler.pilot.jsonc

npm run event:chain -- \
  --slug first-test \
  --contract 0x合約地址 \
  --token-id 1 \
  --start-block 12345678 \
  --chain-id 84532 \
  --target remote \
  --confirm-remote first-test \
  --config wrangler.pilot.jsonc
```

`--start-block` 使用合約部署指令輸出的 `blockNumber`。它讓 Phase 3 indexer 能從合約
誕生的區塊完整重播所有 mint 與 transfer，不能省略或填成目前區塊。

活動以 `draft` 載入。完成 `event:chain` 與 `event:audit` 後，再以同一個 Pilot config 執行
`event:status --set published`，不可在合約座標尚未寫入前公開 mint links。

## 6. 真實驗收

使用 `claim-links.csv` 的第一條網址：

1. 手機或桌面瀏覽器開啟領取頁。
2. 連接測試錢包並確認收件地址。
3. 確認錢包不要求切換網路、簽署鑄造交易或支付 Gas。
4. 等待協會 relayer 送出交易，頁面顯示「Base Sepolia 鑄造完成」。
5. 點擊 Explorer 連結確認交易。
6. 打開 `/address/0x你的地址`，確認同一項目顯示 `minted`。

至少用 10 個測試地址重複上述流程，並額外驗證：

- 同一地址不能重複鑄造同一 token ID。
- 同一 nonce 不能重播。
- 第 11 次或超過 `maxSupply` 時合約拒絕。
- 拒絕錢包連接、relayer 餘額不足或 RPC 中斷後，原領取資格仍可重試。
- 關閉活動後，新資格無法取得授權。
- Worker 收到偽造 tx hash 時不會寫成 `minted`。

## Phase 2 完成定義

程式與本機自動測試完成，不等於 Phase 2 通過。只有在協會自己的 Cloudflare 環境與
Base Sepolia 上完成 10 地址真實鑄造，保存合約地址與 10 筆 transaction hash，才能把
Phase 2 標記為 Done 並進入 Base 主網 Phase 3。
