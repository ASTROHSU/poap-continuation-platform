# POAP 延續平台 Roadmap

狀態：Phase 4 維運實作完成，等待 Cloudflare、Email、Base Sepolia 與 10–30 人 Pilot
規劃日期：2026-07-31
原則：每個 Phase 都必須產生一個可親自驗證的結果，未通過驗收閘門前不進入下一階段。

## Roadmap 總覽

| Phase | 成果                               | 需要 15 GB 快照 | 狀態                                        |
| ----- | ---------------------------------- | --------------: | ------------------------------------------- |
| 0     | 可執行的端到端骨架                 |              否 | **Done**                                    |
| 1     | 可建立活動、產生領取連結與 QR Code |              否 | **Done**                                    |
| 2     | Base 測試網真實鑄造                |              否 | **Live Test Pending**                       |
| 2.5   | Email 預約與日後綁定既有錢包       |              否 | **Live Test Pending**                       |
| 3     | Base 主網鑄造與新收藏查詢          |              否 | **Implementation Done · Live Test Pending** |
| 4     | 小規模正式活動與維運驗證           |              否 | **Implementation Done · Pilot Pending**     |
| 5     | 匯入歷史 POAP 快照並合併資料       |          **是** | Deferred                                    |
| 6     | 統一視覺、品牌化與正式公開上線     |              是 | Not Started                                 |

建議順序：

```text
Phase 0  骨架
   ↓
Phase 1  活動＋連結＋QR
   ↓
Phase 2  Base Sepolia 真實鑄造
   ↓
Phase 2.5  Email 預約＋既有錢包綁定
   ↓
Phase 3  Base 主網＋新收藏瀏覽器
   ↓
Phase 4  小規模正式活動
   ↓
Phase 5  接入 15 GB 歷史快照
   ↓
Phase 6  新舊視覺統一＋正式上線
```

Phase 1–4 只處理 2026 年 7 月之後的新系統，不依賴歷史 ZIP、POAP.in API 或 POAP.in 的 Cloudflare 資源。

---

## Phase 0：可執行的垂直骨架

狀態：**Done**

### 目的

證明新發行資料可以獨立存在，領取網址可以安全地綁定地址，而且前端已有合併新舊資料的接口。

### 已完成

- Fork POAPin Archive，保留 MIT 授權與原始出處。
- React、Hono Worker、D1、R2 的本機與部署骨架。
- 獨立 `LIVE_DB`，不改寫歷史 Archive。
- 活動 JSON 範例與命令列產生器。
- 產生一次性領取網址 CSV。
- 公開領取頁。
- 收藏者輸入 `0x` 地址並建立待鑄造紀錄。
- 領取碼只保存 SHA-256 digest。
- 單一條件式資料庫更新，避免同一碼併發或重複領取。
- 地址頁可同時查詢歷史 Holdings 與 Live Holdings。
- 新項目顯示「待批次鑄造」或「已鑄造」。
- Claim API 自動測試、完整上游測試、production build 與 Cloudflare dry-run。
- 移除 `poap.in` 正式網域 route，Cloudflare binding 改為自有資源佔位名稱。

### Phase 0 還沒有

- 沒有產生 QR Code 圖檔。
- 沒有部署 Base 智慧合約。
- 領取成功只是資料庫登記，還沒有 NFT。
- 沒有自動寄 Email。
- 沒有匯入 15 GB 快照。
- 沒有正式品牌與最終視覺。
- 沒有正式部署到自己的 Cloudflare account。

### 已通過驗證

- 有效領取碼第一次成功。
- 同一碼第二次使用回傳 `409`。
- 登記後可透過地址 API 查到新紀念章。
- Live 資料包含領取時間與鑄造狀態。
- 型別檢查、建置、部署 dry-run 與測試通過。

---

## Phase 1：活動建立、領取連結與 QR Code

狀態：**Done**

### 使用者完成後能做什麼

發行人提供圖片、標題、說明、日期、領取期限與數量，執行一個指令後得到：

- 活動資料匯入檔。
- 指定數量的一次性領取網址。
- 每個網址對應的 QR Code。
- 可交給 Email、講義或現場立牌使用的清單。
- 本機預覽頁。

本 Phase 的「發行」是建立活動與發放資格，還沒有鏈上 NFT。

### 已完成

- 完成活動 JSON schema 與錯誤訊息。
- 圖片格式、尺寸與檔案大小檢查。
- 產生單張 QR Code PNG／SVG。
- 產生可列印的 QR Code 索引頁。
- 支援一個共用 QR 或每人一個唯一 QR 兩種模式。
- 活動暫停、關閉與領取期限。
- 匯出未使用／已使用領取碼統計。
- 把手動 SQL 指令包成一個安全的發行指令。
- 遠端寫入要求再次確認活動 slug。
- 預設拒絕覆寫既有發行包。
- 原始領取碼與 QR 發行包位於 Git ignore 的 `build/events/`。

### 已通過驗收

- 從空白活動 JSON 到產生 10 個連結與 10 張 QR，耗時小於 5 分鐘。
- 手機掃 QR 能開啟正確活動頁。
- 錯誤、缺少、過期、已使用的碼都有明確訊息。
- 10 個有效碼只能成功登記 10 次，不產生重複紀錄。
- 活動關閉後所有未使用碼均不可再領取。
- QR 與原始領取碼不進 Git。
- 10 張 QR 的實際產生時間遠低於 5 分鐘。
- QR PNG 已由 macOS Vision 解碼，結果為正確的 `/claim/mvp-demo` 網址。
- 實際載入本機 D1 後，10 個連結成功登記 10 次，第 11 次重用回傳 `409`。
- 統計指令正確顯示 `used: 10`、`unused: 0`。
- 狀態指令可將活動切為 `draft`、`published` 或 `closed`。

### 回歸驗證

- Phase 0 的地址登記與合併 API 仍全部通過。
- 重新執行活動產生器不會覆寫既有輸出。
- 活動 A 的碼不能用於活動 B。

### Phase 1 還沒有

- 領取成功仍是 D1 資格登記，不是鏈上 NFT。
- 沒有錢包連接與 Base 交易。
- 沒有 Email 寄送服務；CSV 可交給現有寄信流程。
- 沒有正式多人發行後台。

---

## Phase 2：Base Sepolia 真實鑄造

狀態：**Implementation Done · Live Test Pending**

### 使用者完成後能做什麼

從領取連結進入頁面後，可以在 Base Sepolia 實際鑄造一枚 ERC-1155 NFT；NFT 可在區塊瀏覽器看到，metadata 與圖片可正常讀取。

### 進入前決策

必須先選擇：

1. **收藏者自行送交易**：連接錢包並支付極低 Gas。最少後端、最符合自主管理。
2. **協會代付 Gas**：收藏者只確認地址，由 Relayer 送交易。體驗較接近舊 POAP，但需要熱錢包、nonce 管理與失敗重試。

Roadmap 預設先採方案 1；方案 2 可在 Phase 4 前追加。

### 已完成實作

- 自有 ERC-1155 合約。
- 一個活動對應一個 token ID。
- 最大供應量、停止發行與重複領取保護。
- Base Sepolia 部署腳本與合約驗證。
- R2 中的圖片與 metadata。
- 領取碼換取鏈上 claim authorization。
- 前端錢包連接、交易確認與失敗重試。
- 寫回 contract、token ID、tx hash 與 confirmed 狀態。

### 尚待外部環境驗收

- 建立協會自己的 Cloudflare D1、R2 與 Worker。
- 準備有測試 ETH 的 Base Sepolia 部署錢包。
- 部署並驗證合約。
- 用 10 個測試地址完成真實鑄造，保存 transaction hash。
- 通過下列驗收閘門後，才把 Phase 2 標記為 Done。

### 驗收閘門

- 10 個測試地址各能鑄造一次。
- 同一資格或同一地址不能重複鑄造同一活動。
- 超過最大供應量時合約拒絕。
- BaseScan 可看到合約、交易與持有人。
- NFT 圖片、名稱、說明與活動資料正確。
- 交易失敗後可以安全重試，不會消耗兩次資格。
- 發行管理權限只存在於指定管理錢包。

### 回歸驗證

- Phase 1 產生的舊領取網址仍可使用。
- 不連接錢包時，活動資料仍可正常瀏覽。
- Live DB 故障不會造成合約重複鑄造。

---

## Phase 2.5：Email 預約與既有錢包綁定

狀態：**Implementation Done · Live Test Pending**

### 使用者完成後能做什麼

收藏者不必當下準備錢包。可以先以 Email 驗證保留名額，日後再用 Magic Link 登入，
連接任何自己控制的 Base 錢包並完成鑄造。

### 已完成實作

- 15 分鐘有效、單次使用的 Email Magic Link。
- 驗證成功後才占用名額。
- 7 天 HttpOnly Email Session。
- Email 收藏頁與再次登入。
- 綁定既有錢包；首次取得授權後鎖定地址，避免舊授權重播。
- 使用原有 EIP-712 授權與 receipt 驗證完成鑄造。
- Email HMAC lookup、AES-256-GCM 加密與 token hash。
- 可替換的寄信 adapter；本機 console、正式環境 Resend。
- 登入防帳號枚舉、Session 寫入同源檢查與 Magic Link 防重播。

### 尚待外部環境驗收

- 驗證正式寄件網域並設定寄信 API secret。
- 以真實信箱完成寄送、垃圾信與手機開信測試。
- 配合 Phase 2，以 Base Sepolia 錢包完成至少 10 次端到端測試。

詳細設定與驗收見
[Phase 2.5 Email 預約手冊](PHASE-2.5-EMAIL-RESERVATION.zh-TW.md)。

---

## Phase 3：Base 主網與新收藏瀏覽器

狀態：**Implementation Done · Live Test Pending · Mainnet Gated**

### 使用者完成後能做什麼

正式領取連結可以在 Base 主網鑄造 NFT；輸入地址後，平台能查到目前真正持有的新紀念章。

### 已完成實作

- Worker 依活動 `chainId` 分流 Base Sepolia 與 Base mainnet RPC。
- 領取頁依活動自動切換或加入正確的 Base 網路。
- 交易驗證與 Explorer 連結不再寫死測試網。
- 同一份活動、Email 預約與收藏資料模型可直接承接 Base mainnet。
- 每分鐘 Cloudflare Cron 執行 finalized Base event indexer。
- 依合約保存部署區塊與續跑 cursor，每次最多掃 1,900 個區塊。
- 支援 ERC-1155 `TransferSingle`／`TransferBatch`、mint、transfer 與 burn。
- append-only 事件日誌去重，相同鏈上 log 重跑不重複計算。
- D1 batch 同時寫事件與前進 cursor；失敗整批回滾，下次從原區塊續跑。
- `live_token_balances` 投影目前持有人；轉移後收藏頁跟著更新。
- Indexer 尚未追上時沿用已鑄造 claim，追上 finalized chain 後才由鏈上資料接管。
- `/api/live/indexer/status` 提供 lag、同步時間、事件數與目前 holder 數。
- 自動測試涵蓋錯誤事件回滾、重複事件、batch transfer、續跑與 ownership API。

### 尚待外部環境驗收

- 建立協會自己的 Cloudflare D1、R2、Worker 與 Cron。
- 設定非公開共用額度的 production Base RPC。
- 在 Base Sepolia 執行真實 mint、transfer、暫停與恢復測試。
- 保存 10 地址 Phase 2／2.5 端到端驗收紀錄。
- 通過上述測試後，再部署 Base mainnet 合約並把管理權移到正式管理錢包或多簽。

正式部署仍必須等 Phase 2／2.5 在協會自己的 Cloudflare、寄信網域與 Base Sepolia
完成真實驗收，不能只因程式已支援主網就跳過測試網閘門。

操作、監控與復原見
[Phase 3 Base 鏈上索引手冊](PHASE-3-CHAIN-INDEXER.zh-TW.md)。

### 驗收閘門

- 由正式領取網址成功完成主網鑄造。
- 區塊確認後 60 秒內可在平台查到。
- 轉移 NFT 後，查詢結果反映新持有人。
- Indexer 暫停後可從最後區塊安全續跑。
- 重跑同步不會新增重複 holdings。
- 以 30 次測試鑄造估算實際 Gas 與 RPC 成本。

### 回歸驗證

- Sepolia 測試環境仍可獨立使用。
- Claim UI 不會因 indexer 暫時落後而誤報失敗。
- D1 資料可由鏈上事件重新建立。

---

## Phase 4：小規模正式活動與維運驗證

狀態：**Implementation Done · Pilot Pending**

### 使用者完成後能做什麼

在不接歷史快照的情況下，先以新系統完成一場 10–30 人的真實協會活動。

### 已完成實作

- `event:audit` 對帳名額、Email 保留、錢包綁定、鑄造、indexer 與目前鏈上供應量。
- `live-db:backup` 產生不覆寫、`0600` 權限的 SQL 與 SHA-256 manifest。
- D1 空白庫還原演練與 Time Travel 事故流程。
- 活動前、活動中、結束後的單一發行人 Runbook。
- Email、錢包、RPC、交易中斷、索引延遲與領取網址外洩的補救矩陣。
- `/help` 領取支援與最小隱私說明。
- 過期 Magic Link 與 Email Session 在 24 小時復原緩衝後自動清理。
- Pilot 報告模板與 95% 鑄造成功率定義。

### 尚待真實 Pilot

- 部署至自己的 Cloudflare account 與測試網域。
- 設定正式 Email 寄件網域、production RPC 與測試錢包。
- 手機、桌機與實際參與者常用錢包相容性。
- 10–30 人完成一場真實活動。
- 至少演練一次空白 D1 備份還原。
- 根據實際問題決定是否需要協會代付 Gas；第一場預設不加入。

完整操作見
[Phase 4 Pilot 操作與復原手冊](PHASE-4-PILOT-RUNBOOK.zh-TW.md)。

### 驗收閘門

- 真實活動領取成功率至少 95%。
- 發行人可獨立建立活動，不需修改程式碼。
- 至少演練一次資料庫備份與還原。
- 鑄造失敗者可以安全重試或人工補發。
- 網站 log 不包含原始領取碼或敏感 Email 內容。
- 一場活動結束後能對帳：連結數、登記數、成功鑄造數、失敗數。

### 回歸驗證

- 重新部署 Worker 不影響既有 NFT 與領取狀態。
- 換 RPC provider 後功能仍正常。
- 暫停 indexer 再恢復時，收藏不遺失。

---

## Phase 5：歷史 POAP 快照匯入與資料合併

狀態：Deferred，等取得 15 GB 檔案

### 可以延後的原因

Phase 1–4 使用獨立的 Live DB、R2 namespace、Base 合約與 indexer。歷史 Archive 只會作為第二個唯讀資料源接入，不會改變新系統的活動、領取或鑄造流程。

### 主要工作

- 驗證 `archive.zip` SHA-256。
- 盤點 `poap.sqlite` schema、筆數與圖片覆蓋率。
- 決定完整公開快照，或只公開協會確認過的 Drop allowlist。
- 將 Catalog 與 Holdings 匯入自己的 D1。
- 將歷史 artwork 匯入自己的 R2。
- 抽樣核對協會過往 Drop、地址與圖片。
- 歷史 API 與 Live API 統一成前端 view model。
- 清楚區分「2026 年快照持有」與「目前 Base 持有」。

### 驗收閘門

- ZIP checksum 與官方值一致。
- 匯入筆數、拒絕筆數與 artwork coverage 有完整報告。
- 隨機抽樣至少 30 個 Drop，metadata 與圖片正確。
- 抽樣至少 10 個協會收藏者地址，歷史結果符合原資料。
- 停用 `poap.in` 與其 media domain 後仍能完整瀏覽。
- Live 發行、領取與 Base 查詢測試全部維持通過。

### 回歸驗證

- 歷史匯入只能新增或替換 Archive snapshot，不改寫 Live DB。
- Archive 匯入失敗時，新系統仍可運作。
- Snapshot 日期在 API 與畫面中不會被誤認為即時所有權。

---

## Phase 6：統一視覺、品牌化與正式公開上線

狀態：Not Started

### 使用者完成後能看到什麼

歷史 POAP 與新 Base NFT 在同一套視覺、搜尋、活動頁與地址收藏頁呈現。一般使用者不必理解兩套後端，但系統仍會在必要處如實標示資料時間與鏈上狀態。

### 主要工作

- 確認協會正式名稱、Logo、色彩與網域。
- 統一歷史 Drop 與新 Event 的 card／detail view model。
- 統一搜尋、年份、活動類型與地址收藏頁。
- Claim、成功、失敗、pending 與 empty states。
- Mobile-first、無障礙與效能。
- 正式網域、SEO、分享卡與基本內容頁。
- 移除不需要的 POAPin Collections／Moments 重功能，或決定保留範圍。
- 上線清單、回滾版本與營運責任表。

### 驗收閘門

- 使用者從搜尋、活動頁、領取到收藏頁不需要跳到另一個產品。
- 手機完成領取與查詢的成功率至少 95%。
- 歷史與新內容使用相同視覺元件與排序規則。
- 畫面不誤稱快照為目前持有狀態。
- Lighthouse、無障礙、錯誤監控與核心瀏覽器測試達到上線標準。
- 使用自己的網域、D1、R2、合約、RPC 設定與備份；不依賴 POAP.in 運作。

---

## 現在／接下來／以後

### Now

- Phase 2／2.5／3：在協會自己的 Cloudflare、Email 與 Base Sepolia 完成真實驗收。
- Phase 4：依 Runbook 執行 10–30 人 Pilot、備份還原與最終對帳。

### Next

- Pilot 通過後，接入 15 GB 歷史快照。

### Later

- Phase 5：取得 15 GB 後匯入歷史快照。
- Phase 6：視覺統一與正式公開上線。

## Roadmap 變更規則

- 每個 Phase 完成時，先執行該 Phase 的驗收與所有前序回歸測試。
- 驗收失敗就留在原 Phase 修正，不以「之後再補」跨過閘門。
- 新需求若加入當前 Phase，必須同時說明刪除什麼，或接受 Phase 延長。
- 合約、資料 schema 與公開 API 的破壞性變更必須留下 migration 與回滾方案。
- Phase 5 的 15 GB 快照延後，不得阻擋 Phase 1–4。
