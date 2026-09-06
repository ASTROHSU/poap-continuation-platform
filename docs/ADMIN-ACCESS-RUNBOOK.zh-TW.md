# 底加活動管理：Cloudflare Access 保護

正式活動管理入口為 `https://admin.poap.blocktrend.today`。它連到獨立 Worker `titsia-issuer-admin`，並由 Cloudflare Access 置於應用程式之前。公開收藏與領取服務仍使用 `https://poap.blocktrend.today`，兩者互不開放管理權限。管理 API 仍會驗證 Magic 管理者身分，因此即使其中一層憑證外洩，也不能單獨修改活動。

## 信任邊界

```text
瀏覽器
  │ Cloudflare Access（帳號 + Passkey／安全金鑰）
  ▼
admin.poap.blocktrend.today
  │ 專用 Gateway 只轉送允許的管理 API headers
  ▼
Cloudflare Worker
  ├─ 驗證 Access JWT 的簽章、issuer、AUD、email allowlist
  ├─ 驗證 Magic DID token 與管理者 email allowlist
  └─ 修改 D1／R2，留下活動版本紀錄
```

公開網站 `poap.blocktrend.today` 不提供管理頁；直接造訪 `/issuer/manage` 會回覆 404。只有專用 Gateway 具備載入管理頁所需的伺服器端密鑰。

## Cloudflare Access 設定

1. 確認 `blocktrend.today` 已在同一 Cloudflare 帳號啟用，DNS 記錄已完整匯入且 nameserver 已切換至 Cloudflare。
2. 部署 `wrangler.admin.jsonc` 中的 `titsia-issuer-admin` Worker；設定會建立 `admin.poap.blocktrend.today` Custom Domain。
3. 在 Access application 的 Public hostname 加入 `admin.poap.blocktrend.today`，確認 Access 保護生效後再移除舊的 `workers.dev` destination。
4. 名稱使用「底加活動管理」，套用 reusable policy「僅限底加管理者」。
5. Session duration 建議 12 小時，關閉 App Launcher 顯示。
6. Identity provider 使用 Cloudflare，僅允許 Cloudflare account members。
7. Allow policy 只包含管理者帳號；不要設定 Bypass policy。
8. 在 application MFA 設定啟用 Independent MFA，只允許 `biometrics` 與 `security_key`。
9. 不要保護公開的 `association-poap-pilot` Worker。

Access 建立完成後，把 team domain、application AUD 與管理者 email 分別存成 Worker secrets：

```bash
npx wrangler secret put ACCESS_TEAM_DOMAIN --config wrangler.pilot.jsonc
npx wrangler secret put ACCESS_POLICY_AUD --config wrangler.pilot.jsonc
npx wrangler secret put ACCESS_ADMIN_EMAILS --config wrangler.pilot.jsonc
```

Magic Dashboard 也必須把 `https://admin.poap.blocktrend.today` 加入允許網域。不要把 Gateway secret、Magic secret、Access JWT 或私鑰放進 GitHub 或瀏覽器程式碼。

## 驗收

- 未登入造訪管理網域時，先看到 Cloudflare Access 登入頁。
- 沒有註冊 Passkey／安全金鑰時，Access 不應放行。
- 登入 Access 後，仍須以 Magic 管理者 Email 驗證。
- 公開網域的 `/issuer/manage` 會回覆 404；管理入口不會出現在公開網站。
- 直接呼叫 Worker 管理 API，沒有有效 Access JWT 時回覆 `401 access_required`。
- 非管理者 Access email 回覆 `403 access_forbidden`。
- 管理頁與 API 回應皆不得被快取或置入 iframe。

## 緊急撤銷

先在 Cloudflare Access policy 移除管理者或停用 application，再撤銷 Magic session／更換 Worker allowlist。Access 位於最外層，這一步可以立即阻止新的管理請求抵達應用程式。
