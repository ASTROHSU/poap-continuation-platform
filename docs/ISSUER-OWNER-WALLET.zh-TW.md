# 本人錢包發行（2026 年 11–12 月）

入口：在 Safari 或 Chrome 開啟 `https://admin.poap.blocktrend.today/`，
使用原本的 Passkey 與管理者登入，再選擇活動。
Safari 可按「連接手機 Rabby」，以手機 Rabby 的 WalletConnect 掃描 QR Code；
Chrome 可同樣連接手機，或選擇 Rabby 擴充套件。手機不需要登入管理後台。
瀏覽器須支援 Web Locks 與本機儲存。
不依賴 ChatGPT 內建瀏覽器，也不要求匯出、輸入或上傳私鑰／助記詞。

1. 按「連接手機 Rabby」並在手機允許連線，或選擇已安裝的錢包擴充套件。
2. 在「已連接或瀏覽器內的錢包」選擇錢包，按「連接並核對 owner」。
3. 按「核對發行資料」，確認名稱、圖片、Token、200 份、正式 metadata、Base 8453、合約與 owner。
4. 按「本人確認發行」，親自在 Rabby 核對並確認交易、支付 Gas。
5. 取得 hash 後按「查核交易」。至少兩個區塊確認且回執、發送者、完整 calldata、EventConfigured 與鏈上設定相符，才顯示已發行。

管理登入用 Magic；簽名只使用明確選擇的本人錢包。管理者 Email 登入不代表持有 owner。
EIP-6963 discovery 只列出錢包，不自動索取帳戶、切鏈或送交易。錢包事件會使先前核對失效。

## 手機連線設定

在此專案擁有者的 Reown Dashboard 建立專案，設定允許來源
`https://admin.poap.blocktrend.today`。建置環境設置公開識別碼
`PUBLIC_WALLETCONNECT_PROJECT_ID`，重新建置後部署；缺少設定時手機按鈕停用，既有擴充套件仍可用。
Reown 的本機來源永遠允許，因此本機 QR 成功不能代表正式來源已放行。
發布前須另外檢查正式 admin origin 的 Relay 握手，不能以移除來源檢查、偽造本機來源或取消後台登入來處理 403。
允許來源變更可能需要 15 分鐘生效。未取得 QR 的初始化在 15 秒後結束等待並顯示重試／來源設定提示；
QR 出現後不限制使用者掃描時間，也不替簽署交易設定此逾時。
不得使用其他網站或範例的 Project ID。這個識別碼可以放前端，但任何管理憑證仍不得公開。

WalletConnect SDK 僅在本人點擊時載入，要求 Base 8453 與 `eth_sendTransaction`；
不要求個人訊息或 typed-data 簽名，關閉 SDK 遙測。QR Code 在本機產生，
包含配對金鑰的 URI 不記錄、不上傳、不寫入交易日誌。
可取消配對與斷線；取消後才到達的手機核准不會連入。斷線、帳戶或網路變更會清除已核對狀態，
既有交易日誌仍保留，避免重送。

本次範圍僅四場，固定對應 Token 10–13。已發行的 Token 10 禁止重送，不改動原本已發布活動、資格或素材。
其他 Token 已占用、metadata 不符、owner 變更、錯鏈、錯帳戶、唯讀節點或模擬失敗，一律停止。

跨分頁 Web Lock 與本機交易日誌阻止重複點擊、重整後重送。日誌只記錄公開交易 hash 與階段，不保存憑證或錢包權限。
4001 本人取消可重新核對；未知送出錯誤、未取得 hash 或缺回執都不當作失敗重送。先在本人錢包查核，再同步平台。
本機儲存不可用或瀏覽器不支援 Web Locks 時停止發行。

## 發行與領取分開

此版是本人簽名入口，沒有新增伺服器 signer 或後端發行端點。
既有管理 API 不允許客戶端直接替換 Token／合約，也沒有以真實回執為依據、原子建立資格及共用 QR 的同步 API。
因此成功時明確顯示「鏈上已確認，平台待同步」，不自動切 published，不宣稱已可領取。
由已授權的營運流程重新從鏈上查證後，才補 D1 座標、資格與 QR，對帳並發布；未到開放期仍保留原日期限制。
不呼叫 claims、relay 或 mints 端點做驗證。

## 驗證

`cd frontend-astro && npm run build` 包含模擬錢包與回執測試、Astro 型別檢查、建置和既有私有路由打包測試。
測試不連接真實錢包、不簽名、不發交易。正式錢包彈窗與本人確認由使用者驗收。

瀏覽器測試：在 `frontend-astro` 執行
`node node_modules/vite/bin/vite.js --config test/browser/vite.config.mjs`，
另執行 `node test/browser/mobile-wallet.mjs`（需 Playwright 與 Chromium/WebKit）。
測試載入真實發行元件，但以模擬配對 provider 取代手機；禁止所有外網請求，
驗證 QR 顯示、owner 核對、取消與斷線，不發送真實交易。測試 Project ID 只存在測試設定。

參考：

- https://eips.ethereum.org/EIPS/eip-6963
- https://eips.ethereum.org/EIPS/eip-1193
