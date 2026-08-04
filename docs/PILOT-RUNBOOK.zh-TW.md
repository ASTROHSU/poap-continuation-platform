# 10–30 人 Pilot 操作與復原手冊

Pilot 的目標不是增加平台功能，而是證明一場真實活動能由單一發行人獨立完成：
建立活動、寄送或展示領取網址、鑄造、查詢、補救、對帳，以及備份與復原。

15 GB 歷史快照不在本階段內。Pilot 只使用 Live D1、協會自己的 R2、Base Sepolia
或通過測試後的 Base mainnet 合約。

## 領取入口不是公開功能

公開首頁可以展示活動與紀念圖，但不得連到領取頁，也不得把資格碼打包進公開 JavaScript。
領取頁只接受主辦單位在活動中提供的完整連結或 QR Code，並設定 `noindex`、`noarchive` 與
`no-referrer`。資格碼在瀏覽器首次讀取後只暫存在該分頁的 session storage，網址列會移除
`code`，降低截圖、複製網址或 referrer 意外外洩的機率。

`shared` 模式是一張共用 QR 搭配名額與期限，操作最接近現場 POAP，但拿到連結的人仍可在
名額用完前轉傳。需要逐人控制時改用 `unique`，為每位參與者產生一組只能使用一次的連結。
兩種模式都屬於 bearer credential；若要嚴格證明出席，必須再加參與者 Email allowlist 或
現場驗證流程，不能只靠「網址不公開」。

## 完成狀態

程式與文件已完成：

- 活動 JSON、媒體、領取連結與 QR 產生。
- Email 預約、既有錢包綁定與安全重試。
- Base ERC-1155 鑄造與 finalized event indexer。
- `event:audit` 端到端對帳。
- 私有 D1 SQL 備份與 SHA-256 manifest。
- 過期 Magic Link 與 Session 的自動清理。
- `/help` 領取支援與隱私頁。
- 異常補救與 Pilot 報告格式。

仍需真實環境完成：Cloudflare 資源、寄件網域、production RPC、錢包相容性、備份
還原演練，以及一場 10–30 人活動。

## Pilot 規模與成功定義

第一場只選一個活動、10–30 名已知參與者，不開放公開無上限領取。由協會 relayer 代付
Gas；總支出由已建立的領取資格數量直接限制。

通過條件：

- 至少 95%「已綁定錢包者」完成鑄造。
- 未成功者都能自行重試或由發行人確認原因。
- 活動結束能對上名額、預約、綁定、鑄造、索引與目前供應量。
- 完成一次匯出備份及一次空白測試資料庫還原演練。
- 正式 log、Pilot 報告與客服紀錄不包含 Email 明文、Magic Link、Session Cookie、私鑰或
  尚未使用的完整領取網址。

成功率公式：

```text
鑄造成功率 = minted_claims / wallet_bound × 100%
```

`waiting_for_wallet` 不算鑄造失敗，應另外列為「已保留但尚未開始錢包流程」。

## T–7 天：建立正式測試環境

1. 在協會 Cloudflare account 建立 Worker、LIVE_DB、R2 與測試網域。
2. 套用全部 Live migration：

   ```bash
   npx wrangler d1 migrations apply LIVE_DB --remote
   ```

3. 設定 `MINT_SIGNER_PRIVATE_KEY`、`MINT_RELAYER_PRIVATE_KEY`、`EMAIL_LOOKUP_SECRET`、
   `EMAIL_DATA_KEY`、`RESEND_API_KEY` 等 Worker secrets。
4. 把 `EMAIL_PROVIDER` 設成 `resend`，不可在公開環境使用 `console`。
5. 把 Base 公共 RPC 換成協會可更換的 production provider。
6. 部署 Worker 後確認 `/api/live/indexer/status` 可讀。
7. 開啟 `/help`，確認領取支援與隱私說明可公開瀏覽。

## T–3 天：建立 Pilot 活動

準備活動：

```bash
npm run event:prepare -- --event events/pilot.json
```

確認 `build/events/pilot/` 中的圖片、metadata、QR 與 `claim-links.csv`。這些輸出包含
bearer credentials，僅存放在加密或權限受控的位置。

接著依序：

1. 上傳媒體到自有 R2。
2. 部署／確認 Base 合約。
3. 在合約建立 token ID。
4. 載入活動資格。
5. 使用合約部署輸出的區塊設定 `--start-block`。
6. 先用內部錢包完整走一次 Email、鑄造與收藏查詢。

活動載入後立即執行第一次對帳：

```bash
npm run event:audit -- \
  --slug first-pilot \
  --target remote \
  --confirm-remote first-pilot \
  --config wrangler.pilot.jsonc
```

預期：`slots` 等於預定名額，其他領取與鑄造欄位均為 `0`，Indexer cursor 已存在。

## T–1 天：備份與還原演練

建立不覆寫的 D1 SQL 備份：

```bash
npm run live-db:backup -- \
  --target remote \
  --confirm-remote LIVE_DB \
  --config wrangler.pilot.jsonc
```

輸出位於 Git ignore 的 `build/backups/`：

```text
live-db-remote-{timestamp}.sql
live-db-remote-{timestamp}.sql.manifest.json
```

SQL 可能包含加密 Email、HMAC、公開錢包地址與領取狀態，仍視為敏感備份。檔案權限為
`0600`，應放入加密儲存，不寄信、不放公開 Drive。manifest 保存 byte length 與 SHA-256。

### 還原演練

只對新建的空白測試 D1 執行，不匯入既有 LIVE_DB：

```bash
npx wrangler d1 execute YOUR_EMPTY_RESTORE_DB \
  --remote \
  --file build/backups/live-db-remote-{timestamp}.sql
```

接著查詢 `live_events`、`live_claim_codes`、`live_chain_events` 與 `live_token_balances` 的
筆數，與正式庫的對帳輸出比對。演練完成後保留報告；是否刪除測試 D1 由 Cloudflare
管理介面另行決定。

D1 另有內建 Time Travel，可取得 bookmark 並回復到指定時間。這會覆寫正式資料庫，只能
在事故中、確認時間點並保存前一個 bookmark 後執行：

```bash
npx wrangler d1 time-travel info LIVE_DB
```

官方文件：

- [D1 import and export](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
- [D1 Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/)

R2 的新活動圖片與 metadata 可由本機 `build/events/{slug}/` 重新上傳；因此發行包本身也
必須納入協會備份。合約與鏈上事件不依賴 Cloudflare 備份。

## 活動當天

### 開始前

- `/api/live/indexer/status` 的 `lagBlocks` 為 `0`。
- 測試信能在手機收到並開啟正確網域。
- 活動頁圖片、名稱與時間正確。
- Base 網路與 Explorer 連結正確。
- Relayer 地址有足以完成全場名額的 Base ETH。
- `event:audit` 顯示預期 slots，沒有舊 claims。

### 進行中

每 10–15 分鐘或出現回報時執行：

```bash
npm run event:audit -- \
  --slug first-pilot \
  --target remote \
  --confirm-remote first-pilot \
  --config wrangler.pilot.jsonc
```

重點欄位：

| 欄位                       | 意義                                |
| -------------------------- | ----------------------------------- |
| `slots`                    | 發出的總資格數                      |
| `email_reserved`           | 已驗證 Email 並占用名額             |
| `waiting_for_wallet`       | 已保留但尚未綁錢包                  |
| `wallet_bound`             | 已綁定地址、已開始鑄造流程          |
| `pending_mint`             | 已綁定但尚未確認交易                |
| `minted_claims`            | receipt 已驗證並寫回                |
| `minted_waiting_for_index` | 已鑄造但 finalized indexer 尚未看到 |
| `current_supply`           | 鏈上 projection 的目前供應量        |
| `current_holders`          | 目前正餘額地址數                    |
| `indexer_lag_blocks`       | 尚未掃描的 finalized 區塊數         |

## 異常補救

| 情況               | 使用者處理                 | 發行人檢查                              |
| ------------------ | -------------------------- | --------------------------------------- |
| 沒收到 Email       | 等候數分鐘後重新送出       | 寄件網域、Resend 狀態、Email 拼字       |
| Magic Link 過期    | 重新要求一封               | 不人工轉傳舊 Magic Link                 |
| 錢包拒絕連接       | 回原頁重試                 | 不會送交易，名額仍應保留                |
| Relayer 餘額不足   | 稍後回原頁重試             | 補足 Base ETH，確認私鑰與 chain ID      |
| RPC 中斷           | 稍後回原頁重試             | 切換 RPC 後驗證 chain ID                |
| 交易成功但頁面中斷 | 回原頁，前端會接續 tx hash | Explorer receipt 與 `minted_claims`     |
| 已鑄造但收藏頁沒有 | 等待 finalized 與排程      | `minted_waiting_for_index`、lag、cursor |
| NFT 已轉移         | 查新錢包地址               | 轉移事件是否 finalized、目前 balance    |
| 領取網址外洩       | 立即關閉活動並重發剩餘資格 | 不公開原始 CSV；保留事件紀錄            |

人工協助只能要求活動 slug、公開錢包地址、transaction hash、錯誤代碼、時間與截圖。
不得要求私鑰、助記詞、Session Cookie、完整 Magic Link 或未使用領取網址。

## 活動結束

1. 將活動改為 `closed`，保留既有 Email reservation 的日後鑄造能力。
2. 等待 indexer `lagBlocks = 0`。
3. 執行最終 `event:audit`。
4. 建立活動後備份。
5. 完成下列報告：

```text
活動：
日期：
參與人數：
slots：
email_reserved：
waiting_for_wallet：
wallet_bound：
minted_claims：
minted_waiting_for_index：
current_supply：
鑄造成功率：
平均／最高完成時間：
Email 問題數：
錢包問題數：
RPC／Indexer 問題數：
人工補救數：
備份檔 SHA-256：
還原演練結果：
是否達到 95%：
下一場要修改的項目：
```

## Pilot 完成定義

程式、備份工具與手冊完成不等於 Pilot 通過。只有真實 10–30 人 Pilot 達到上述門檻、
保存去識別化對帳報告，並完成空白 D1 還原演練，才算完成 Pilot，並進入歷史
快照匯入。
