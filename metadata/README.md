# Metadata

這個目錄保存可公開、可重現的 ERC-1155 metadata。正式發布前請確認：

- `image`、`animation_url`、`external_url` 與 `external_link` 都是完整的 HTTPS URL；
- 公開 URL 不含活動領取碼或其他秘密；
- 活動日期使用 Unix timestamp 時以 UTC 為準；
- R2 上的正式 JSON 與這裡的版本一致。

`events/*.json` 是單一 token ID 的 metadata；`association-badges.json` 是可升級合約透過
ERC-7572 `contractURI()` 提供的 collection-level metadata。
