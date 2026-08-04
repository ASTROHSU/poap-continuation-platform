# Magic Email 客製化接入

## 已準備完成

- 同網站風格的 OTP HTML：`docs/MAGIC-EMAIL-TEMPLATE.html`
- 前端支援 Magic `overrides.variation`
- Worker 可透過 `MAGIC_EMAIL_TEMPLATE_NAME` 公開已啟用的範本名稱
- 未設定範本名稱時仍使用 Magic 官方預設信件，不影響現有登入

## Magic 後台設定

1. 在 Magic Dashboard 的 **Customization → Branding** 設定：
   - App name：`POAP 留存計畫`
   - Primary color：`#7C72E2`
   - Theme：Light
2. 若帳號方案已開通自訂 Email 範本與自訂寄信服務：
   - 在 **Customization → Email** 建立範本。
   - 範本名稱建議使用 `poap-retention-zh-tw`。
   - 貼上 `docs/MAGIC-EMAIL-TEMPLATE.html` 的完整內容並發布。
3. 在 Cloudflare Worker 設定一般變數：

   ```text
   MAGIC_EMAIL_TEMPLATE_NAME=poap-retention-zh-tw
   ```

4. 重新部署 Worker。前端會從 `/api/app-config` 取得範本名稱，下一次 Magic OTP 登入即使用該版本。

## 寄信服務

完整自訂 HTML 需要 Magic 的自訂 Email provider。若使用 Resend SMTP，可在 Magic 支援的自訂 SMTP 設定中填入 Resend 提供的 SMTP host、port、username 與 API key；請勿把 SMTP 密碼或 Resend API key 寫入 GitHub。
