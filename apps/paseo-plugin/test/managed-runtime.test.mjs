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
    ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"],
    ["npm", "run", "verify:plugin-distribution"],
  ]);
  assert.match(entry, /export default function paseoRooms/);
  assert.match(entry, /apps\/paseo-plugin\/main\.client/);
  assert.match(entry, /apps\/paseo-plugin\/share\.server/);
  assert.equal(
    fs.existsSync(path.join(pluginRoot, "paseo-plugin.json")),
    false,
    "the nested source directory must not become a second, incomplete plugin root",
  );
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
  assert.match(runtime, /PASEO_ROOMS_PUBLIC_URL/);
  assert.match(runtime, /PASEO_ROOMS_RELAY_KEY is required/);
  assert.match(runtime, /close\(\)/);
  assert.match(localServer, /export async function startLocalRoomServer/);
  assert.match(localServer, /closePaseoConnections/);
  assert.match(localServer, /PUBLIC_BASE_URL/);
});
