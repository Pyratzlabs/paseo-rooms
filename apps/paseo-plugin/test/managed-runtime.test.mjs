import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const repositoryRoot = path.resolve(pluginRoot, "..", "..");

test("the repository root is an installable Paseo Rooms plugin", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "paseo-plugin.json"), "utf8"),
  );
  const entry = fs.readFileSync(path.join(repositoryRoot, "index.ts"), "utf8");

  assert.equal(manifest.id, "paseo-rooms");
  assert.deepEqual(manifest.build, [
    ["npm", "ci", "--ignore-scripts"],
    ["npm", "run", "verify:plugin-distribution"],
  ]);
  assert.match(entry, /apps\/paseo-plugin\/index/);
});

test("the plugin owns an in-process local room runtime", () => {
  const server = fs.readFileSync(
    path.join(pluginRoot, "share.server.ts"),
    "utf8",
  );
  const runtime = fs.readFileSync(
    path.join(pluginRoot, "runtime.server.ts"),
    "utf8",
  );
  const localServer = fs.readFileSync(
    path.join(repositoryRoot, "apps", "relay-web", "src", "server.ts"),
    "utf8",
  );

  assert.match(server, /ensureManagedRoomServer/);
  assert.doesNotMatch(server, /PLUGIN_DIR|roomsPath|startCommand|startArgs/);
  assert.match(runtime, /startLocalRoomServer/);
  assert.match(runtime, /127\.0\.0\.1/);
  assert.match(runtime, /close\(\)/);
  assert.match(localServer, /export async function startLocalRoomServer/);
});
