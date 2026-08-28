import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * The public relay owns the shared-room shell and its hashed Vite assets.
 * Dynamic room data still goes through the token-scoped API and WebSocket
 * routes, but the UI bundle itself is safe to cache at a public /assets path.
 */
export default defineConfig({
  root: import.meta.dirname,
  base: "/",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "../public"),
    emptyOutDir: false,
    rollupOptions: { input: resolve(import.meta.dirname, "room.html") },
  },
});
