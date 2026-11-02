import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const result = spawnSync("npm", ["run", "build:web"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PASEO_ROOMS_WEB_BASE: "/paseo-rooms/",
    VITE_PASEO_ROOMS_RELAY_ORIGIN:
      process.env.VITE_PASEO_ROOMS_RELAY_ORIGIN ??
      "https://paseo-rooms.pyratz.com",
  },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const output = path.join(root, ".pages-site");
const source = path.join(root, "apps/relay-web/public");
rmSync(output, { recursive: true, force: true });
mkdirSync(output);
// Explicit allowlist: never publish local data or host-side plugin artifacts.
cpSync(path.join(source, "room.html"), path.join(output, "index.html"));
cpSync(path.join(source, "room.html"), path.join(output, "404.html"));
cpSync(path.join(source, "assets"), path.join(output, "assets"), {
  recursive: true,
});
writeFileSync(path.join(output, ".nojekyll"), "");
