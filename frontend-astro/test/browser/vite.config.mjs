import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("./", import.meta.url));
export default defineConfig({
  root,
  cacheDir: fileURLToPath(new URL("../../../.cache/issuer-wallet-browser", import.meta.url)),
  plugins: [tailwindcss()],
  esbuild: { jsx: "automatic" },
  define: { "import.meta.env.PUBLIC_WALLETCONNECT_PROJECT_ID": JSON.stringify("a".repeat(32)) },
  server: {
    host: "127.0.0.1",
    port: 4317,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] },
  },
});
