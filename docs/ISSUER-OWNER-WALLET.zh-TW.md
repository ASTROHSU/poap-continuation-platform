# 本人錢包發行（2026 年 11–12 月）

入口：在自己已安裝 Rabby 的桌面瀏覽器開啟
`https://admin.poap.blocktrend.today/`，使用原本的管理登入，再選擇活動。
Trust Wallet 可使用有注入 EIP-1193 provider 且支援 Web Locks 的 DApp 瀏覽器。
不依賴 ChatGPT 內建瀏覽器，也不要求匯出、輸入或上傳私鑰／助記詞。

1. 在「本人錢包發行」選擇錢包，按「連接並核對 owner」。
2. 按「核對發行資料」，確認名稱、圖片、Token、200 份、正式 metadata、Base 8453、合約與 owner。
3. 按「本人確認發行」，親自在 Rabby 核對並確認交易、支付 Gas。
4. 取得 hash 後按「查核交易」。至少兩個區塊確認且回執、發送者、完整 calldata、EventConfigured 與鏈上設定相符，才顯示已發行。

管理登入用 Magic；簽名只使用明確選擇的注入式錢包。管理者 Email 登入不代表持有 owner。
EIP-6963 discovery 只列出錢包，不自動索取帳戶、切鏈或送交易。錢包事件會使先前核對失效。

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

參考：

- https://eips.ethereum.org/EIPS/eip-6963
- https://eips.ethereum.org/EIPS/eip-1193
