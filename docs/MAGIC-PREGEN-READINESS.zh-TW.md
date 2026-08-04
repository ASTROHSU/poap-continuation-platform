# Magic Wallet PreGen 接入準備

## 現在的狀態

Magic PreGen 的程式接點已完成，但預設關閉：

```json
{
  "WALLET_PROVISIONING_MODE": "disabled",
  "MAGIC_PUBLISHABLE_API_KEY": ""
}
```

關閉時不會載入 Magic SDK、不會傳送 Email 給 Magic，也不會改變現有 Email reservation、
既有錢包綁定或協會 relayer 代付 Gas 的行為。

已準備完成的部分：

- `live_email_wallets` D1 資料表與 migration `0007_email_wallet_provisioning.sql`。
- Email 驗證成功後才呼叫供應商，未驗證 Email 不建立錢包。
- 每個 Email HMAC 只允許一個 Magic 地址。
- 兩分鐘 provisioning lease，避免雙擊或重試造成重複 API 呼叫。
- `provisioning`、`ready`、`failed` 狀態與安全重試。
- Magic 故障時 Email reservation 仍成立，不阻擋收藏者登入。
- `GET /api/live/email/wallet` 查詢狀態。
- `POST /api/live/email/wallet` 以相同、已驗證 Email 手動重試。
- `magic-sdk` 延遲載入函式；未啟用時不進入首頁初始 bundle。
- 收藏頁在錢包 ready 後直接使用 PreGen 地址綁定保留資格，由現有 relayer 鑄造。
- 使用者可在收藏頁輸入相同 Email，以 OTP 開啟錢包；前端會核對取得的地址。
- Launch preflight 的 Magic 條件檢查。

## 啟用時由帳號持有人完成

1. 在 Magic Dashboard 建立正式 App。
2. 向 Magic 申請 Wallet PreGen 權限，取得已核准的書面確認。
3. 取得 Publishable API Key 與 Secret Key。
4. 在 `wrangler.pilot.jsonc` 或正式 config 設定：

   ```json
   {
     "WALLET_PROVISIONING_MODE": "magic-pregen",
     "MAGIC_PUBLISHABLE_API_KEY": "pk_test_..."
   }
   ```

5. 在同一 config 的 `secrets.required` 加入 `MAGIC_SECRET_KEY`。
6. 將 `MAGIC_SECRET_KEY=sk_test_...` 加入 Cloudflare Secret，不要提交到 Git。
7. 套用 migration：

   ```bash
   npm run pilot:db:migrate
   ```

8. 執行：

   ```bash
   npm run launch:preflight
   npm run deploy:pilot
   ```

## 啟用後的流程

```text
Email reservation
  → 協會寄出驗證連結
  → Email 驗證成功
  → Worker 解密短期 challenge 中的 Email
  → Magic PreGen API 建立地址
  → D1 只長期保存 Email HMAC、地址與狀態
  → 現有 relayer 將 NFT mint 到 Magic 地址
  → 使用者日後用相同 Email OTP 認領 Magic wallet
```

Magic 只負責地址與使用者日後的錢包控制權。Gas 仍從協會 relayer 的 Base ETH 餘額扣除，
不需要 Magic Smart Account、Alchemy Paymaster 或第二套 Gas sponsorship。

## Pilot 驗收

先在 Base Sepolia 使用 10 個內部 Email：

1. 未驗證 Email 不應出現在 `live_email_wallets`。
2. 驗證後狀態應從 `provisioning` 進入 `ready`。
3. Magic Dashboard 與 D1 顯示的地址必須一致。
4. 同一 Email 重複驗證或重試不得產生第二個地址。
5. Relayer 鑄造後，NFT 必須在 PreGen 地址上。
6. 使用者以相同 Email OTP 登入後，Magic 回傳的地址必須一致。
7. Magic API 429 或 5xx 時，Email reservation 必須仍可查看，狀態應為 `failed` 且可重試。
8. 使用者不應持有 Base ETH，也不應被要求簽署鑄造交易。

## 關閉與復原

遇到 Magic 異常時只需把：

```json
"WALLET_PROVISIONING_MODE": "disabled"
```

重新部署。既有 reservation、已建立地址與鏈上 NFT 都不會被刪除；系統會回到「日後綁定既有
錢包」的原始流程。不要刪除 `live_email_wallets`，以免日後為同一 Email 重複建立地址。

## 上線前必須向 Magic 確認

- PreGen 權限是否涵蓋 Base Mainnet 與 Base Sepolia。
- 同一 Email 重複呼叫 PreGen API 是否保證回傳同一地址，以及網路逾時時的冪等性承諾。
- 未認領的 PreGen Wallet 是否計入 MAW。
- API rate limit、批次限制及故障 SLA。
- PreGen 是否有未公開的額外費用或最低方案要求。
- 使用者刪除帳號、換 Email、匯出錢包與遺失 Email 的處理方式。
- 個資處理、DPA、資料保存地區與刪除流程。
