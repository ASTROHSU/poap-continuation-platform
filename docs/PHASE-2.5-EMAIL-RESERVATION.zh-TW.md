# Phase 2.5：Email 預約與既有錢包綁定

這一層重現舊 POAP「先以 Email 保留，之後再決定錢包」的核心體驗，但不建立平台託管錢包：
收藏者驗證 Email 後取得一個鏈下保留名額，日後登入同一個 Email 收藏頁，連接任何自己控制的
Base 錢包並鑄造。

15 GB 歷史快照不參與此流程，也無法從快照還原舊 POAP 的個別 Email 預約；快照只有彙總數字。

## 已完成的流程

1. 收藏者從唯一連結或共用 QR 進入活動頁。
2. 選擇立即連接錢包，或輸入 Email 先保留。
3. 系統寄出 15 分鐘有效、只能使用一次的 Magic Link。
4. 開啟連結並驗證成功後，系統才原子性占用一個領取名額。
5. 收藏者可在 `/email/collection` 以 Email Magic Link 再次登入。
6. 點擊「綁定既有錢包並鑄造」，由收藏者自己的錢包送出 Base 交易。
7. Worker 驗證鏈上 receipt 後，才把紀錄標記為 `minted`。

不使用 Privy，也不替收藏者生成或保存私鑰。因此既有 Privy embedded wallet 不會因相同 Email
自動出現在新平台；收藏者可以連接任何能匯出、匯入或以一般錢包介面控制的既有地址。

## 資料與安全

- D1 不保存明文 Email，而是保存 HMAC-SHA-256 lookup key。
- Email 另以 AES-256-GCM 加密，金鑰只放 Cloudflare secret。
- Magic Link 與 Session 原始 token 不寫入 D1，只保存 SHA-256。
- Magic Link 單次使用、15 分鐘失效。
- Email Session 使用 `HttpOnly`、`SameSite=Lax` Cookie，7 天失效。
- Cookie 驗證後的寫入 API 檢查同源 `Origin`。
- Email 驗證成功前不占用名額，避免垃圾 Email 燒掉資格。
- 錢包在鏈上自行送交易，等同以交易簽章證明地址控制權。
- 第一次取得鏈上授權後即鎖定地址，避免舊授權仍有效時改綁而造成雙重鑄造。

## 本機設定

`wrangler.jsonc` 預設使用 `console` provider；只有 `localhost`、`127.0.0.1` 或 `.test` 網址
會在 API 回應顯示測試 Magic Link。

建立 `.dev.vars`，不要提交：

```dotenv
EMAIL_LOOKUP_SECRET=至少32字元的高熵隨機字串
EMAIL_DATA_KEY=base64編碼的32-byte隨機金鑰
MINT_SIGNER_PRIVATE_KEY=0x...
```

可用 OpenSSL 產生 Email 金鑰：

```bash
openssl rand -base64 32
openssl rand -hex 32
```

第一行可作為 `EMAIL_DATA_KEY`，第二行可作為 `EMAIL_LOOKUP_SECRET`。

## 正式寄信設定

1. 在 `wrangler.jsonc` 將 `PUBLIC_APP_URL` 改為正式 HTTPS origin。
2. 將 `EMAIL_PROVIDER` 改為 `resend`。
3. 將 `EMAIL_FROM` 改成已驗證網域的寄件者。
4. 設定 secrets：

```bash
npx wrangler secret put EMAIL_LOOKUP_SECRET
npx wrangler secret put EMAIL_DATA_KEY
npx wrangler secret put RESEND_API_KEY
```

寄信介面集中在 `src/worker/email.ts`。未來若不想依賴 Resend，可替換成其他供應商或自有 SMTP
bridge，而不必改預約、Session、錢包綁定或鏈上鑄造資料模型。

## 驗收

- 同一 Magic Link 第二次開啟回傳 `409`。
- 驗證成功前 `claimedCount` 不增加，成功後增加一次。
- D1 與應用 log 不出現明文 Email。
- 未登入不能讀取 Email 收藏。
- Email A 的 Session 不能讀取或綁定 Email B 的預約。
- 跨站 Origin 不能使用 Session 執行綁定或寫回鑄造。
- 綁定後可驗證 EIP-712 signer、地址、chain ID、contract 與 token ID。
- 錢包拒絕交易或網路中斷後，預約仍可重試。
- 正式環境 API 不回傳測試 Magic Link。
