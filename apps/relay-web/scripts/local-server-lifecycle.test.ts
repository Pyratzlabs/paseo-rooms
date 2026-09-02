import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dataDirectory = await fs.mkdtemp(
  path.join(os.tmpdir(), "paseo-rooms-test-"),
);
process.env.PORT = "0";
process.env.BASE_URL = "http://127.0.0.1:0";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:0";
process.env.DATA_DIR = dataDirectory;

const { startLocalRoomServer } = await import("../src/server.js");

test.after(async () => {
  await fs.rm(dataDirectory, { recursive: true, force: true });
});

test("a managed local room server can start, close, and start again", async () => {
  const first = await startLocalRoomServer({ connectDaemon: false });
  const firstHealth = await fetch(`${first.baseUrl}/healthz`);
  assert.equal(firstHealth.status, 200);
  await first.close();
  await first.close();

  const second = await startLocalRoomServer({ connectDaemon: false });
  const secondHealth = await fetch(`${second.baseUrl}/healthz`);
  assert.equal(secondHealth.status, 200);
  await second.close();
});
