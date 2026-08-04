# 錢包建立與 Gas 代付決策

## MVP 決策

第一版不整合 Privy。公開環境預設仍採既有 Base 地址，但沒有錢包地址的收藏者所需的 Magic
Wallet PreGen 接點已完成並以 feature flag 關閉。

第一版的目標改成：

1. 收藏者提供既有 Base 地址。
2. 後端驗證領取碼或 Email reservation。
3. 協會的 relayer wallet 送出交易並支付 Gas。
4. NFT 直接鑄造到收藏者提供的地址。
5. 啟用 Magic Wallet PreGen 時沿用同一套領取與 relayer 流程。

## 為什麼停止 Privy

2026-08-02 的本機實測：

| 項目                 | Privy React SDK |                    Magic SDK |
| -------------------- | --------------: | ---------------------------: |
| 最小 minified bundle |       約 5.0 MB |                    約 103 KB |
| gzip                 |      約 1.57 MB |                     約 33 KB |
| 本機完整依賴樹       |       約 1.7 GB | 約 2.8 MB（Magic-only 測試） |

Privy 的功能完整，但會把許多目前不需要的外部錢包、WalletConnect、Smart Wallet 與跨鏈模組一起帶入。對單一發行人的 MVP 過重。

目前正式 build 中，Magic 被拆成 770.66 KB（gzip 229.92 KB）的延遲載入 chunk；首頁入口為
107.61 KB（gzip 33.59 KB）。使用者沒有點擊「開啟 Email 錢包」時，瀏覽器不會下載 Magic
chunk，因此不增加一般瀏覽與領取頁的初始負擔。

## Magic Wallet PreGen 的定位

Magic Wallet PreGen 很符合未來需求：後端可以先為 Email 建立 non-custodial EVM 地址，使用者日後用同一 Email 驗證後取得控制權。

但目前有兩個限制：

- Wallet PreGen 不是一般帳號開立即可用，需向 Magic 申請存取權。
- PreGen 只解決「Email 對應地址」，不會自動解決 Base Gas 代付；仍要接 Paymaster 或協會 relayer。

因此它是選配的地址建立器，不是第一階段的必要依賴。目前的完整啟用步驟見
[Magic Wallet PreGen 接入準備](./MAGIC-PREGEN-READINESS.zh-TW.md)。

## 第一版 relayer 設計

智慧合約新增 `claimFor(account, tokenId, deadline, nonce, signature)`：

- `account` 是真正收件地址。
- 後端仍簽發一次性 EIP-712 授權。
- 任何 relayer 都只能使用有效授權，不能任意鑄造。
- 協會 relayer wallet 送出交易並支付 Base Gas。
- 原本的 `claim()` 可保留作為收藏者自行送交易的故障備援。

後端必須處理：

- relayer 私鑰只放 Cloudflare Secret。
- 單一活動、單一 code、單一地址只能領一次。
- nonce 與交易重試不能重複鑄造。
- 每日交易數與 Gas 上限。
- relayer 餘額不足通知。
- 交易確認後才把 reservation 標記為 minted。

## 未來接入 Magic

取得 Magic Wallet PreGen 權限並開啟 feature flag 後：

```text
Email reservation
  → 後端向 Magic 建立 PreGen address
  → relayer 直接 mint 到該地址
  → 使用者日後以相同 Email claim wallet
```

合約、relayer 與索引器都不必改。收藏頁已能在功能開啟後自動使用 PreGen 地址鑄造，並延遲
載入 Magic SDK，讓使用者以相同 Email OTP 開啟錢包。
