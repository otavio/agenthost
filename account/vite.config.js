import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

// Must match APEX_HOST in worker/wrangler.jsonc (override via APEX_HOST when you
// self-host on another domain). The dashboard lives on account.{APEX_HOST}.
const APEX_HOST = process.env.APEX_HOST || "agenthost.page";

// Built to account/dist → copied to public/account/. The Worker's account host
// maps root-absolute asset paths under /account/.
export default defineConfig({
  plugins: [svelte()],
  base: "/",
  build: { outDir: "dist", emptyOutDir: true },
  // In local dev, proxy the API to the running worker with the ?__host override.
  // DEV_MODE takes the signed-in email from DEV_ACCOUNT_EMAIL.
  server: {
    proxy: {
      "/account/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
        rewrite: (path) => path + (path.includes("?") ? "&" : "?") + `__host=account.${APEX_HOST}`,
      },
    },
  },
});
