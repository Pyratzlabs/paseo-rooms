import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const shared = fs.readFileSync(path.join(root, "share.shared.ts"), "utf8");
const server = fs.readFileSync(path.join(root, "share.server.ts"), "utf8");
const client = fs.readFileSync(path.join(root, "main.client.tsx"), "utf8");

test("the plugin exposes safe list and revoke share-session contracts", () => {
  assert.match(shared, /export const listShareSessionsRpc/);
  assert.match(shared, /export const revokeShareSessionRpc/);
  assert.match(shared, /createdAt/);
  assert.doesNotMatch(shared, /adminToken/);
});

test("the plugin filters listed rooms to the focused agent and revokes by token", () => {
  assert.match(server, /room\.agentId !== input\.agentId/);
  assert.match(
    server,
    /room\.token === input\.token && room\.agentId === input\.agentId/,
  );
  assert.match(server, /trusted local Paseo desktop host/);
  assert.match(server, /method: "DELETE"/);
  assert.match(
    server,
    /\/api\/rooms\/\$\{encodeURIComponent\(input\.token\)\}/,
  );
  assert.doesNotMatch(server, /await res\.text\(\)/);
});

test("the share panel renders persisted links and supports revocation", () => {
  assert.match(client, /useQuery/);
  assert.match(client, /listShareSessionsRpc/);
  assert.match(client, /revokeShareSessionRpc/);
  assert.match(client, /Revoke link/);
  assert.match(client, /Confirm revoke/);
  assert.match(client, /Cancel/);
  assert.match(client, /Open room with/);
  assert.match(client, /Custom room client URL/);
  assert.match(client, /rebaseRoomUrl/);
  assert.match(client, /localStorage/);
  assert.match(client, /Relay for new links/);
  assert.match(client, /Custom relay host registration key/);
  assert.match(client, /This affects new links only/);
  assert.match(client, /local server can use its configured/);
});
