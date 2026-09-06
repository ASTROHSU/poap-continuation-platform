import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import vercel from "@astrojs/vercel";
import tailwindcss from "@tailwindcss/vite";

if (
  process.env.VERCEL_ENV === "production" &&
  (process.env.ADMIN_GATEWAY_SECRET || "").length < 32
) {
  throw new Error("Production requires ADMIN_GATEWAY_SECRET shared with the admin gateway.");
}

export default defineConfig({
  output: "server",
  adapter: vercel(),
  integrations: [react()],
  vite: {
    plugins: [tailwindcss()],
  },
});
