import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    react(),
    cloudflare({ configPath: process.env.CLOUDFLARE_WRANGLER_CONFIG ?? "wrangler.jsonc" }),
  ],
  build: {
    // Keep production builds small and deterministic. Source maps for the full
    // archive client are expensive to generate and are not published.
    sourcemap: false,
  },
});
