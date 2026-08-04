# POAP 流程對照與設計稽核

日期：2026-08-02
結論：核心收藏流程與 POAP 相同；基礎設施、鏈、合約與發行後台是刻意縮小或改成自主管理。

## 收藏者看到的主流程

```text
建立 Drop
  → 產生 mint link／QR Code
  → 收藏者開啟活動頁
  → A. 連接既有錢包並鑄造
     或
    B. 以 Email 驗證並保留，日後再綁定既有錢包鑄造
  → 交易確認
  → 以地址查看收藏
```

這個順序與 POAP 的公開流程一致。介面沿用 `Drop`、`mint link`、`Email 保留`、`鑄造`、
`收藏` 等使用者已熟悉的語意，不使用含糊的「先領取但其實尚未上鏈」描述。

## 哪些地方相同

| 能力         | POAP                        | 本系統                                            |
| ------------ | --------------------------- | ------------------------------------------------- |
| 活動單位     | Drop                        | 一個活動／Drop                                    |
| 發放資格     | mint link、QR               | 唯一或共用 mint link、QR                          |
| 當下有錢包   | 直接 mint                   | 連接既有 Base 錢包直接 mint                       |
| 當下沒有錢包 | Email reservation           | Email 驗證後 reservation                          |
| 日後處理     | 從 Email 收藏綁定錢包       | Magic Link 登入後綁定既有錢包                     |
| 防止重複     | 每個資格只能使用一次        | code hash、名額與合約一地址一次                   |
| 收藏查詢     | 地址／ENS／Email            | 地址；Email 顯示 reservation，鑄造後回地址收藏    |
| 活動追蹤     | Mints 與 Email Reservations | audit 同時對帳 reservation、mint、indexer、supply |

## 刻意不同的設計

| 差異                                 | 原因                                                | 是否保留                       |
| ------------------------------------ | --------------------------------------------------- | ------------------------------ |
| Base，而非原 POAP 使用的鏈與官方合約 | 官方發行服務停止後，需有可自行管理、費用低的發行層  | 保留                           |
| 自有 ERC-1155，一活動一 token ID     | 單一發行人、同活動同 metadata，部署與索引較簡單     | MVP 保留                       |
| 新發行品不是官方 POAP 合約上的 POAP  | 技術與來源必須如實呈現，不能冒充官方 POAP           | 永久保留來源區分               |
| 協會 relayer 送交易並代付 Gas        | 維持 POAP 式低摩擦體驗；Pilot 名額直接限制最大支出  | 保留；relayer 只存少量營運資金 |
| 不建立 Privy／託管錢包               | 只綁定收藏者既有錢包，不保管私鑰或助記詞            | 保留                           |
| 發行端使用 JSON＋CLI，沒有多人後台   | 目前只有一位發行人                                  | 保留到有第二位發行人           |
| 沒有 POAP 的審核／策展流程           | 私有單一發行人，不是開放式發行平台                  | 保留到開放外部發行             |
| Worker 只簽短效 EIP-712 授權         | 避免把 owner 私鑰放在網站，失敗可安全重試           | 保留                           |
| 歷史 POAP 與新 Base 資料分庫         | 官方快照必須唯讀；新資料會持續更新                  | 永久保留，前端合併             |
| 第一場只支援唯一／共用 QR            | 暫不做 NFC、地理限制、Secret word、Kiosk 等分發模式 | Pilot 保留                     |

## 名稱與前端原則

- 歷史官方資料可以稱為「POAP」。
- 2026 年 7 月後由自有 Base 合約發行的項目稱為「新收藏」或「數位紀念」。
- 兩者可以在同一收藏頁、相同卡片與操作節奏中呈現，但細節頁必須標示來源鏈與合約。
- Email reservation 不等於 NFT 已鑄造；只有 Base 交易成功後才顯示「已鑄造」。
- 鑄造後以錢包地址為所有權依據；Email 僅是保留資格與登入方式。

## 本次稽核已修正

1. 收藏者錢包只用來確認收件地址；`claimFor` 讓協會 relayer 送交易並支付 Gas，NFT 仍鑄造到已簽名的收藏者地址。
2. Pilot 活動載入、鏈上設定、狀態、對帳與備份可明確指定 `wrangler.pilot.jsonc`，避免操作錯資料庫。
3. 新活動預設以 `draft` 載入；只有媒體、合約、indexer 與對帳接妥後才手動 `published`。
4. Relayer 送出前先取得資料庫短期鎖並保存 transaction hash，避免連點造成重複 Gas 支出。
5. 新資料暫時無法讀取時，歷史收藏仍保持在頁面前段並可獨立使用。

## 尚未能由自動測試代替的驗收

- 真實 Cloudflare D1／R2／Worker 建立與網域設定。
- 真實 Resend 寄件網域、收信與手機開啟 Magic Link。
- Base Sepolia owner 錢包簽署、relayer Gas 與真實 transaction receipt。
- 不同實體錢包／手機的連接與拒絕連接測試；收藏者不應被要求切鏈或簽署鑄造交易。
- 10–30 人 Pilot、對帳、備份還原演練。
- 15 GB 歷史快照的 checksum、匯入筆數與圖片抽樣；此項可延後，不阻擋 Pilot。

## 官方流程參考

- [Email reservation](https://help.poap.xyz/hc/en-us/articles/9674214473485-How-does-reserving-a-POAP-with-my-email-work-)
- [建立 POAP Account 與日後綁定](https://help.poap.xyz/hc/en-us/articles/28180485782541-How-Do-I-Create-a-POAP-Account)
- [Mint link 分發](https://help.poap.xyz/hc/en-us/articles/27977705292045-How-to-Responsibly-Distribute-POAPs-via-Mint-Links)
- [POAP 用詞](https://help.poap.xyz/hc/en-us/articles/18607766574989-POAP-Glossary)
