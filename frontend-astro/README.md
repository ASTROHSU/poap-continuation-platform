# POAP 留存計畫 Astro 前端

公開視覺層使用 Astro、Tailwind CSS v4 與 React islands。它會呼叫 Cloudflare Worker API，
呈現歷史 Archive 與新合約收藏，並提供 QR 領取、Magic Email OTP、ENS／地址領取與收藏頁。

## 開發

```bash
npm install
npm run dev
```

## 驗證

```bash
npm run check
npm run build
```

Worker API 位置由公開部署設定提供；任何 Magic Secret、錢包私鑰或 Cloudflare token 都不得放進
Astro 環境變數或瀏覽器 bundle。
