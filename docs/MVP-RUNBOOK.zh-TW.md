# MVP 本機操作手冊

## 目前已經能做什麼

- 啟動 POAPin Archive 的本機 fixture。
- 用唯一領取連結登記一個 `0x` 地址。
- 產生唯一 QR 或多人共用 QR。
- 防止同一領取碼重複使用。
- 暫停、重新開放或關閉活動。
- 查詢活動的已用、未用與已鑄造統計。
- 在該地址頁同時顯示歷史 fixture 與新紀念章。
- 從活動 JSON 產生完整發行包。
- 在 Base Sepolia 以 ERC-1155 完成錢包鑄造。
- 驗證 receipt 後把 transaction hash 寫回收藏頁。
- 對帳一場活動從名額、Email、錢包、鑄造到鏈上目前供應量。
- 建立帶 SHA-256 manifest 的私有 LIVE_DB SQL 備份。

Base 合約與前端已完成本機實作；尚待在協會自己的 Cloudflare account 與 Base Sepolia
完成真實部署驗收。完整步驟見 `PHASE-2-BASE-SEPOLIA.zh-TW.md`。

## 啟動

需求：Node.js 22.13+、npm。

```bash
npm ci
npm run db:setup:local
npm run dev
```

開啟測試領取頁：

```text
http://localhost:5173/claim/mvp-demo?code=demo-claim-2026
```

輸入任何有效測試地址，例如：

```text
0x1111111111111111111111111111111111111111
```

成功後前往：

```text
http://localhost:5173/address/0x1111111111111111111111111111111111111111
```

同一個 demo code 只能用一次。需要重跑時，清除專案的本機 Wrangler state，再重新執行 `db:setup:local`；不要對正式資料庫做這個動作。

## 準備一場新活動

複製並修改 `events/mvp-demo.json`，接著執行：

```bash
npm run event:prepare -- --event events/mvp-demo.json
```

輸出：

```text
build/events/mvp-demo/
├── artwork.svg
├── load-event.sql
├── claim-links.csv
├── event-summary.json
├── metadata.json
├── qr-index.html
└── qr/
    ├── 001.png
    ├── 001.svg
    └── ...
```

`claimMode` 可設為：

```json
{
  "claimMode": "unique"
}
```

- `unique`：每個名額產生一條不同連結與 QR，適合 Email。
- `shared`：只產生一條共用連結與 QR，由後端名額池限制總人數，適合現場立牌。

若提供 `imageFile`，產生器會檢查實際格式、128–4096 像素尺寸與 10 MiB 上限。輸出目錄若已有檔案，指令會停止，不會覆寫先前的 bearer credentials。

載入本機，不必手動執行 SQL：

```bash
npm run event:load -- \
  --bundle build/events/mvp-demo \
  --slug mvp-demo \
  --target local
```

也可以在產生時直接載入：

```bash
npm run event:prepare -- \
  --event events/mvp-demo.json \
  --load local
```

正式環境必須明確指定並再次確認 slug：

```bash
npm run event:load -- \
  --bundle build/events/mvp-demo \
  --slug mvp-demo \
  --target remote \
  --confirm-remote mvp-demo
```

`claim-links.csv`、`qr-index.html` 與 `qr/` 都包含 bearer credentials，不可 commit，也不要放在公開雲端資料夾。

## 活動狀態與統計

暫停一場活動：

```bash
npm run event:status -- \
  --slug mvp-demo \
  --set draft \
  --target local
```

重新開放使用 `--set published`；永久關閉使用 `--set closed`。遠端操作同樣需要 `--target remote --confirm-remote mvp-demo`。

查詢名額：

```bash
npm run event:stats -- --slug mvp-demo --target local
```

輸出會列出：

- `slots`：產生的資格總數。
- `used`：已登記地址的數量。
- `unused`：尚未使用的數量。
- `minted`：Phase 2 之後已完成鏈上鑄造的數量。

完整活動對帳：

```bash
npm run event:audit -- --slug mvp-demo --target local
```

它會同時列出 Email 保留、已綁定錢包、待鑄造、已鑄造、等待 indexer、目前鏈上供應量、
holder 數與 indexer lag。Pilot 操作、備份與補救流程見
`PHASE-4-PILOT-RUNBOOK.zh-TW.md`。

本機 LIVE_DB 備份：

```bash
npm run live-db:backup -- --target local
```

## 接入 15 GB 快照

專案沿用上游 importer。先把 ZIP 解出的 `poap.sqlite` 與原始 `archive.zip` 絕對路徑記下來，再執行：

```bash
node tools/archive-import/cli.mjs \
  --database /absolute/path/to/poap.sqlite \
  --archive /absolute/path/to/archive.zip \
  --output /absolute/path/to/import-reports/2026-07-02-v1 \
  --source-url https://downloads.poaparchive.com/archive.zip \
  --expected-database-sha256 18a052ec76a0b38f492ade7ff62869ead4556cd66cd8020a8550da9aa0e6a506 \
  --expected-archive-sha256 046850de3bd4b3c6aa75c33c4a1a589b4ab176aacdd5986c1a824df803c07633 \
  --retrieved-at 2026-07-31T00:00:00Z \
  --media-base-url https://YOUR-MEDIA-DOMAIN.example
```

完整匯入會產生大量 SQL 與驗證檔，請先確認磁碟空間。詳細流程見 `tools/archive-import/README.md` 與 `docs/deployment.md`。

## 正式部署前

1. 在自己的 Cloudflare account 建立 D1 與 R2。
2. 替換 `wrangler.jsonc` 內的 database name、UUID、bucket 與 `MEDIA_BASE_URL`。
3. 保留空的 `routes`，直到自己的網域已確認。
4. 不要使用上游 Glory Lab 的 database ID、bucket 或 `poap.in` 網域。
5. 先在 Base Sepolia 驗證批次鑄造，再切 Base mainnet。
