import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { WebSocket } from "ws";

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));

async function fixture(port) {
  const previous = { ...process.env };
  const directory = await mkdtemp(path.join(os.tmpdir(), "rooms-port-"));
  for (const name of [
    "PASEO_ROOMS_PORT",
    "PASEO_ROOMS_PUBLIC_URL",
    "PASEO_ROOMS_CLIENT_URL",
    "PUBLIC_BASE_URL",
  ])
    delete process.env[name];
  Object.assign(process.env, {
    DATA_DIR: directory,
    PASEO_ROOMS_RELAY_URL: "",
    PASEO_ROOMS_CLIENT_URL: "https://rooms.example",
    PASEO_ROOMS_PUBLIC_DIR: path.join(root, "apps/relay-web/public"),
  });
  if (port !== undefined) process.env.PASEO_ROOMS_PORT = String(port);
  const built = await build({
    stdin: {
      contents:
        'export * from "./runtime.server.ts"; export { createLegacyRoom } from "../relay-web/src/rooms.js";',
      resolveDir: path.join(root, "apps/paseo-plugin"),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    plugins: [
      {
        name: "daemon-fixture",
        setup(builder) {
          builder.onResolve({ filter: /\/paseo\.js$/ }, () => ({
            path: "paseo",
            namespace: "fixture",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
            contents:
              'export const isConnected=()=>true;export const ensureConnected=async()=>{};export const closePaseoConnections=async()=>{};export const agentInfo=async()=>({title:"Fixture"});export const fetchFullHistory=async()=>[];export const listRoomQuestions=async()=>[];export const answerRoomQuestion=async()=>{};export const sendToAgent=async()=>{};export const subscribeAgent=async()=>()=>{};',
          }));
        },
      },
    ],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", built.outputFiles[0].text)(
    require,
    module,
    module.exports,
  );
  return {
    runtime: module.exports,
    async close() {
      try {
        await module.exports.closeManagedRoomServer();
      } finally {
        for (const name of Object.keys(process.env))
          if (!(name in previous)) delete process.env[name];
        Object.assign(process.env, previous);
        await rm(directory, { recursive: true, force: true });
      }
    },
  };
}

async function listener(port = 0, acceptExisting = false) {
  const server = createServer((_, response) =>
    response.end("development server"),
  );
  try {
    server.listen(port, "127.0.0.1");
    await once(server, "listening");
  } catch (error) {
    if (!acceptExisting || error.code !== "EADDRINUSE") throw error;
  }
  return server;
}

async function rejectOrigin(baseUrl, token, origin) {
  const socket = new WebSocket(
    `${baseUrl.replace("http", "ws")}/api/rooms/${token}/ws`,
    { origin },
  );
  socket.on("error", () => {});
  const [, response] = await once(socket, "unexpected-response");
  response.resume();
  socket.terminate();
  assert.equal(response.statusCode, 403);
}

for (const port of [undefined, 0]) {
  test(`plugin ${port === undefined ? "default" : "explicit zero"} uses a free port while 3000 is occupied`, async () => {
    const occupied = await listener(3000, true);
    const state = await fixture(port);
    try {
      const server = await state.runtime.ensureManagedRoomServer();
      assert.ok(Number(new URL(server.baseUrl).port) > 0);
      assert.notEqual(new URL(server.baseUrl).port, "3000");
      const health = await fetch(`${server.baseUrl}/healthz`);
      assert.equal(health.status, 200);
      const unauthorized = await fetch(`${server.baseUrl}/api/rooms`);
      assert.equal(unauthorized.status, 401);
      const rooms = await fetch(`${server.baseUrl}/api/rooms`, {
        headers: { authorization: `Bearer ${server.adminToken}` },
      });
      assert.equal(rooms.status, 200);
      const shared = await fetch(`${server.baseUrl}/api/rooms`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${server.adminToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId: "fixture" }),
      });
      assert.equal(shared.status, 201);
      assert.equal(
        new URL((await shared.json()).url).origin,
        "https://rooms.example",
      );
      if (occupied.listening) {
        assert.equal(
          await (await fetch("http://127.0.0.1:3000")).text(),
          "development server",
        );
      }
      await state.runtime.closeManagedRoomServer();
      const restarted = await state.runtime.ensureManagedRoomServer();
      assert.notEqual(new URL(restarted.baseUrl).port, "3000");
      assert.equal((await fetch(`${restarted.baseUrl}/healthz`)).status, 200);
    } finally {
      await state.close();
      if (occupied.listening)
        await new Promise((resolve) => occupied.close(resolve));
    }
  });
}

test("automatic ports accept their actual WebSocket origin and reject other origins", async () => {
  const state = await fixture(0);
  try {
    const server = await state.runtime.ensureManagedRoomServer();
    const room = state.runtime.createLegacyRoom("fixture", "Origin check");
    await rejectOrigin(server.baseUrl, room.token, "https://untrusted.example");
    await rejectOrigin(server.baseUrl, room.token, "http://127.0.0.1:0");
    const socket = new WebSocket(
      `${server.baseUrl.replace("http", "ws")}/api/rooms/${room.token}/ws`,
      { origin: server.baseUrl },
    );
    try {
      await once(socket, "open");
    } finally {
      socket.terminate();
    }
    await state.runtime.closeManagedRoomServer();
    const restarted = await state.runtime.ensureManagedRoomServer();
    if (restarted.baseUrl !== server.baseUrl) {
      await rejectOrigin(restarted.baseUrl, room.token, server.baseUrl);
    }
    const nextSocket = new WebSocket(
      `${restarted.baseUrl.replace("http", "ws")}/api/rooms/${room.token}/ws`,
      { origin: restarted.baseUrl },
    );
    try {
      await once(nextSocket, "open");
    } finally {
      nextSocket.terminate();
    }
  } finally {
    await state.close();
  }
});

test("an explicit fixed port is honored and an occupied override fails", async () => {
  const occupied = await listener();
  const port = occupied.address().port;
  const state = await fixture(port);
  try {
    await assert.rejects(state.runtime.ensureManagedRoomServer(), {
      code: "EADDRINUSE",
    });
    await new Promise((resolve) => occupied.close(resolve));
    const server = await state.runtime.ensureManagedRoomServer();
    assert.equal(Number(new URL(server.baseUrl).port), port);
    assert.equal((await fetch(`${server.baseUrl}/healthz`)).status, 200);
  } finally {
    await state.close();
    if (occupied.listening)
      await new Promise((resolve) => occupied.close(resolve));
  }
});

test("invalid port overrides are rejected", async () => {
  for (const port of ["", -1, 65536, 1.5, "invalid"]) {
    const state = await fixture(port);
    try {
      await assert.rejects(
        state.runtime.ensureManagedRoomServer(),
        /PASEO_ROOMS_PORT/,
      );
    } finally {
      await state.close();
    }
  }
});
