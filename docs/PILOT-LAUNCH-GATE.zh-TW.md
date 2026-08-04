# Pilot 上線閘門：自動完成與本人操作的分界

這份清單把第一場 10–30 人 Base Sepolia Pilot 壓縮成一條可重複執行的路徑。15 GB
歷史快照不在此路徑內；`wrangler.pilot.jsonc` 使用 `live-only` 模式，只需要一個 Live D1
和一個存放新活動圖片的 R2 bucket。

## 已由程式完成

- Live-only 首頁、領取頁、Email 保留收藏、既有錢包綁定與錢包收藏查詢。
- 單一發行人的活動 JSON、唯一連結、PNG／SVG QR 與資料庫載入檔產生器。
- Base Sepolia ERC-1155 鑄造、協會 relayer 代付 Gas、交易 receipt 驗證、finalized indexer 與目前持有人 projection。
- Email Magic Link、Email 加密保存、日後綁定錢包、安全重試與過期資料清理。
- 活動對帳、Live D1 備份、支援／隱私頁與 Pilot Runbook。
- 不覆寫的正式 secrets 產生器與 fail-closed 上線檢查。
- 與四個歷史 D1 完全分離的 Cloudflare Pilot 設定。

## 一次性本機準備

已經產生的 `build/secrets/` 必須視為機密。若在另一台機器重新開始，才執行：

```bash
npm run secrets:prepare
```

這會產生彼此分離的 Mint signer 與 relayer、Email HMAC secret、Email AES-256 key，
以及等待填入 Resend key 的 secrets JSON。工具遇到既有檔案會拒絕覆寫。

複製活動模板，不要直接反覆改同一場已發出的活動：

```bash
cp events/pilot-template.json events/pilot.json
```

## 非本人不能安全代替的資料

1. Cloudflare account 與要使用的正式／測試網域。
2. 已驗證寄件網域的 `EMAIL_FROM`，以及 Resend API key。
3. 合約 owner 錢包地址、Base Sepolia 簽名，以及 owner 與 relayer 所需的少量測試 ETH。
4. 第一場活動的正式名稱、圖片、日期、領取期限與 10–30 人名額。

填妥以下位置：

- `wrangler.pilot.jsonc`：LIVE_DB ID、`PUBLIC_APP_URL`、`EMAIL_FROM`。
- `events/pilot.json`：活動內容、圖片、日期與同一個 `publicBaseUrl`。
- `build/secrets/worker-secrets.production.json`：只補上 `RESEND_API_KEY`。

不要把 secrets 檔、私鑰、完整 Magic Link 或未使用的領取連結貼進 issue、聊天或 Git。

## 唯一的上線順序

```bash
# 1. 所有 ✗ 都必須消失
npm run launch:preflight -- \
  --event events/pilot.json \
  --secrets build/secrets/worker-secrets.production.json

# 2. 建置與 Cloudflare dry-run
npm run check:pilot

# 3. 上傳 secrets、套 migration、部署
npm run pilot:secrets:upload
npm run pilot:db:migrate
npm run deploy:pilot

# 4. 產生活動包、圖片、唯一 mint links 與 QR
npm run event:prepare -- --event events/pilot.json
```

上傳媒體：

```bash
npm run event:media -- \
  --bundle build/events/first-pilot \
  --bucket association-poap-live-media-pilot \
  --target remote \
  --confirm-remote first-pilot
```

接著依 `PHASE-2-BASE-SEPOLIA.zh-TW.md` 部署合約、建立 token ID，記下合約地址與部署
`blockNumber`。活動會先以 `draft` 載入；每一個 Pilot D1 指令都必須明確指定 Pilot config：

```bash
npm run event:load -- \
  --bundle build/events/first-pilot \
  --slug first-pilot \
  --target remote \
  --confirm-remote first-pilot \
  --config wrangler.pilot.jsonc

npm run event:chain -- \
  --slug first-pilot \
  --contract 0x你的合約地址 \
  --token-id 1 \
  --start-block 部署輸出的區塊 \
  --chain-id 84532 \
  --target remote \
  --confirm-remote first-pilot \
  --config wrangler.pilot.jsonc

npm run event:audit -- \
  --slug first-pilot \
  --target remote \
  --confirm-remote first-pilot \
  --config wrangler.pilot.jsonc

npm run event:status -- \
  --slug first-pilot \
  --set published \
  --target remote \
  --confirm-remote first-pilot \
  --config wrangler.pilot.jsonc
```

只有 audit 正確後才執行最後一個 publish 指令。任何遠端操作都必須提供工具要求的 slug
確認字串；省略 `--config wrangler.pilot.jsonc` 會被視為操作另一個環境。

## 上線後最小驗收

用一個內部 Email 和一個 Base Sepolia 錢包完整走一次：

1. 開活動唯一連結，選 Email 保留。
2. 從信件 Magic Link 登入 Email 收藏。
3. 綁定既有錢包；確認收藏者不需簽署交易，由協會 relayer 支付 Gas 並完成 Base Sepolia 鑄造。
4. 等待 finalized indexer 後，以 `/address/0x…` 查到該枚收藏。
5. 再開同一領取連結，確認不能重複占用名額。
6. 再次以 Pilot config 執行 `event:audit`，確認 reservation、mint、indexer 與 supply 一致。
7. 執行下列備份，並依 Phase 4 Runbook 在空白 D1 做還原演練：

   ```bash
   npm run live-db:backup -- \
     --target remote \
     --confirm-remote LIVE_DB \
     --config wrangler.pilot.jsonc
   ```

只有以上全部通過，才把連結交給 10–30 名 Pilot 參與者。

## 歷史快照何時接

回家拿到 15 GB 檔案後，再切換到 `wrangler.jsonc` 的 `combined` 模式，匯入 Catalog、
Holdings、Collections、Moments 與 artwork。Live D1、活動網址、合約與新收藏不需重做；
前端屆時改為同時讀取歷史與 Live 資料。
