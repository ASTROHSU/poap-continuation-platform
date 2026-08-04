# 開源發布檢查表

這份清單用於第一次公開 GitHub repository，以及之後每次準備公開大型部署變更時。

## Git 不應收錄

- `.dev.vars`、`.env*`、Vercel 本機環境檔。
- `wrangler.pilot.jsonc` 等正式 Cloudflare resource ID 與部署設定。
- 活動 access code、唯一領取連結清單與 `events/*.local.json`。
- 私鑰、Resend／Magic secret、備份解密金鑰與 relayer keystore。
- `archive.zip`、SQLite、Artwork、匯入報告與 D1／R2 備份。
- 合約 artifacts、cache、deployment output 與本機依賴資料夾。

公開設定請從 `.dev.vars.example`、`events/pilot-template.json` 與
`wrangler.pilot.example.jsonc` 複製後，在本機填入實際內容。

## GitHub repository 設定

1. 建立新的 repository；不要把這個 fork 推回 Glory Lab 的上游 repository。
2. 將 Glory Lab repository 保留為名稱為 `upstream` 的唯讀參考 remote。
3. 啟用 Dependabot alerts、private vulnerability reporting、secret scanning 與 push protection。
4. 保護 `main`，要求 `Worker and archive browser`、`Astro frontend`、`Smart contracts`
   三個 CI job 通過後才能合併。
5. 關閉不必要的 GitHub Actions 寫入權限；CI 預設只授予 `contents: read`。

## 發布前本機驗證

```bash
npm ci
npm run format:check
npm run typecheck
npm test
npm run build

cd frontend-astro
npm ci
npm run build

cd ../contracts
npm ci
npm test
```

接著確認 `git status --short`、`git diff --check`，並檢查所有 Git 候選檔案沒有大型資料、
憑證或私鑰。智慧合約、Cloudflare Worker 與正式站的部署仍應分開操作；推送 GitHub
不等於部署正式環境。

## 資料與媒體

MIT License 只涵蓋程式碼與文件。POAP 歷史資料、活動 Artwork、POAP／POAPin 標誌與
第三方商標不會因為放在同一個專案就自動變成 MIT。公開前請依
[ASSETS-LICENSE.md](../ASSETS-LICENSE.md) 與
[資料與授權政策](data-and-licensing.md) 確認來源、授權與移除聯絡方式。

## 若曾誤提交秘密

不要只刪除檔案或改寫最新 commit。先撤銷／輪替受影響的金鑰，再清理完整 Git 歷史，
最後檢查 fork、Actions logs、release artifacts 與快取是否仍保留舊值。
