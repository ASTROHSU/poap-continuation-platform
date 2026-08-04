# 明早只需要完成的四步

目標：把已通過本機測試的 live-only Pilot 接到自己的 Cloudflare、Email 與 Base Sepolia。
15 GB 歷史快照不在這四步內，也不會阻擋發行、Email 保留、鑄造與新收藏查詢。

## 第一步：接上 Cloudflare 與 Email

你需要親自登入 Cloudflare，並在自己的 account 建立：

- D1：`association-poap-live-pilot`
- R2：`association-poap-live-media-pilot`
- Workers 子網域或正式網域

接著在 Resend 驗證寄件網域並建立 API key。把 D1 ID、公開 HTTPS 網址、寄件 Email 填入
`wrangler.pilot.jsonc`；只把 Resend key 填入 Git ignore 的
`build/secrets/worker-secrets.production.json`。Mint signer、relayer 與 Email 加密 secrets
已經產生，不要重建或外傳。

## 第二步：準備 owner 與 relayer 的測試 Gas

準備一個由你控制的合約 owner／deployer 錢包，領取少量 Base Sepolia 測試 ETH，然後在
`contracts/` 執行：

```bash
npx hardhat keystore set BASE_SEPOLIA_PRIVATE_KEY
```

私鑰只輸入 Hardhat 加密 keystore，不貼進設定檔、聊天或 Git。Worker 的 claim signer 已與
owner 分離；公開 signer 地址在 `build/secrets/mint-signer-address.txt`，不需持有 ETH。

另外把少量 Base Sepolia 測試 ETH 轉入
`build/secrets/mint-relayer-address.txt` 所列的地址。這個 relayer 只負責替收藏者送出交易並
支付 Gas；第一場只有 10–30 個資格，因此最大測試支出由活動名額直接限制。

## 第三步：填第一場活動

編輯 `events/pilot.json`：名稱、說明、圖片、日期、開放／截止時間、10–30 個名額，以及與
`wrangler.pilot.jsonc` 完全相同的 `publicBaseUrl`。圖片放在本機專案內並由 `imageFile` 指向。

確認完成後執行：

```bash
npm run launch:preflight -- \
  --event events/pilot.json \
  --secrets build/secrets/worker-secrets.production.json

npm run check:pilot
npm run event:prepare -- --event events/pilot.json
```

所有檢查必須是 `✓`；發行包、原始 mint links 與 QR 位於 `build/events/{slug}/`，不得公開整份 CSV。

## 第四步：簽署部署並跑第一筆真實驗收

依序做：

1. 上傳 Worker secrets、套用 Pilot migration、部署 Worker。
2. 上傳活動 artwork 與 metadata。
3. 用 owner 錢包部署 ERC-1155 合約並建立第一個 token ID。
4. 以 `--config wrangler.pilot.jsonc` 把活動載入 D1、寫入合約座標與部署區塊；確認 audit 後才把活動切成 `published`。
5. 用一個內部 Email：保留 → 開 Magic Link → 綁既有錢包 → 協會代付 Gas 鑄造 → 地址收藏查詢；收藏者錢包不應跳出交易簽署。
6. 確認同一 link／地址不能重複、執行 `event:audit`，最後做一次 `live-db:backup`。

逐字指令與異常處理在 [Pilot 上線閘門](PILOT-LAUNCH-GATE.zh-TW.md) 與
[Phase 4 Runbook](PHASE-4-PILOT-RUNBOOK.zh-TW.md)。第一筆完整走通後，即可把其餘 9–29 個
mint links 交給已知測試者。
