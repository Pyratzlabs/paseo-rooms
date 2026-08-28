import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * `./` keeps generated imports relative to the room document. The server adds
 * a token-scoped <base> element when it serves that document, so every asset
 * remains behind /r/:token rather than becoming a new public relay route.
 */
export default defineConfig({
  root: import.meta.dirname,
  base: "./",
  plugins: [react()],
  build: {
    outDir: resolve(import.meta.dirname, "../public"),
    emptyOutDir: false,
    rollupOptions: { input: resolve(import.meta.dirname, "room.html") },
  },
});
