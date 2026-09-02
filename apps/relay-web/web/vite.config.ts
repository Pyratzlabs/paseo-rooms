import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const e2eeSmoke = process.env.PASEO_E2EE_SMOKE === "1";

/**
 * The public relay owns the shared-room shell and its hashed Vite assets.
 * Dynamic room data still goes through the token-scoped API and WebSocket
 * routes, but the UI bundle itself is safe to cache at a public /assets path.
 */
export default defineConfig({
  root: import.meta.dirname,
  base: "/",
  // @getpaseo/relay's published browser export points to an unshipped source
  // file. Node resolves its built artifact through the `node` condition. Pin
  // Vite to that same published artifact in one audited compatibility seam.
  resolve: {
    alias: {
      "@getpaseo/relay/e2ee": require.resolve("@getpaseo/relay/e2ee"),
    },
  },
  plugins: [react()],
  build: {
    outDir: resolve(
      import.meta.dirname,
      e2eeSmoke ? "../.e2ee-smoke" : "../public",
    ),
    // Production assets share their output directory; the isolated smoke build
    // must start empty so a stale ignored artifact cannot satisfy its test.
    emptyOutDir: e2eeSmoke,
    rollupOptions: {
      input: resolve(
        import.meta.dirname,
        e2eeSmoke ? "src/e2ee-smoke.ts" : "room.html",
      ),
    },
  },
});
