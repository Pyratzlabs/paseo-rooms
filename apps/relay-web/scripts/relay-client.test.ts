import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createRelay } from "../src/relay/relay.js";
import {
  startRelayClient,
  type RelayClient,
  type RoomSocket,
} from "../src/relay-client.js";

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 10);
  });
}

test("relay forwards browser socket messages to the virtual room socket", async () => {
  const relay = await createRelay({
    port: 0,
    relayKey: "presence-test-key",
    pingIntervalMs: 60_000,
    httpTimeoutMs: 2_000,
    log: () => {},
  });
  let virtual: RoomSocket | null = null;
  let resolveMessage: (data: string) => void = () => {};
  const received = new Promise<string>((resolve) => {
    resolveMessage = resolve;
  });
  const client: RelayClient = startRelayClient({
    url: `ws://127.0.0.1:${relay.port}/host`,
    key: "presence-test-key",
    currentTokens: () => ["presence-token"],
    handleRequest: async () => ({
      status: 404,
      headers: {},
      body: Buffer.alloc(0),
    }),
    openSocket: async (_path, socket) => {
      virtual = socket;
      socket.onMessage(resolveMessage);
      return true;
    },
    minBackoffMs: 10,
    maxBackoffMs: 20,
    log: () => {},
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const browser = new WebSocket(
      `ws://127.0.0.1:${relay.port}/api/rooms/presence-token/ws`,
    );
    await new Promise<void>((resolve, reject) => {
      browser.once("open", resolve);
      browser.once("error", reject);
    });
    await waitFor(() => virtual !== null);
    browser.send(JSON.stringify({ type: "hello", name: "Alice" }));
    assert.equal(await received, '{"type":"hello","name":"Alice"}');
    browser.close();
  } finally {
    client.close();
    await relay.close();
  }
});

test("relay client re-registers an explicit v2 route and accepts bounded opaque records", async () => {
  const relay = await createRelay({
    port: 0,
    relayKey: "v2-client-test-key",
    pingIntervalMs: 60_000,
    httpTimeoutMs: 2_000,
    log: () => {},
  });
  const routeId = "C".repeat(43);
  const legacyToken = "legacy-presence-token";
  let virtual: RoomSocket | null = null;
  let resolveMessage: (data: string) => void = () => {};
  const received = new Promise<string>((resolve) => {
    resolveMessage = resolve;
  });
  const client = startRelayClient({
    url: `ws://127.0.0.1:${relay.port}/host`,
    key: "v2-client-test-key",
    currentTokens: () => [legacyToken, routeId],
    currentRoutes: () => [{ token: routeId, protocol: 2 }],
    handleRequest: async () => ({
      status: 404,
      headers: {},
      body: Buffer.alloc(0),
    }),
    openSocket: async (_path, socket) => {
      virtual = socket;
      socket.onMessage(resolveMessage);
      return true;
    },
    minBackoffMs: 10,
    maxBackoffMs: 20,
    log: () => {},
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const legacyPage = await fetch(
      `http://127.0.0.1:${relay.port}/r/${legacyToken}`,
    );
    assert.equal(legacyPage.status, 200);

    const browser = new WebSocket(
      `ws://127.0.0.1:${relay.port}/v2/rooms/${routeId}/ws`,
    );
    await new Promise<void>((resolve, reject) => {
      browser.once("open", resolve);
      browser.once("error", reject);
    });
    await waitFor(() => virtual !== null);
    const record = JSON.stringify({ v: 2, type: "handshake", data: "YWJjZA" });
    browser.send(record);
    assert.equal(await received, record);
    browser.close();
  } finally {
    client.close();
    await relay.close();
  }
});

test("relay client fails closed when a relay injects an invalid v2 record", async () => {
  const routeId = "D".repeat(43);
  const relay = new WebSocketServer({ port: 0, perMessageDeflate: false });
  await new Promise<void>((resolve) => relay.once("listening", resolve));
  const address = relay.address();
  assert.equal(typeof address, "object");
  if (typeof address !== "object" || address === null)
    throw new Error("missing relay address");

  relay.on("connection", (ws) => {
    ws.send(
      JSON.stringify({
        v: 1,
        type: "ws_event",
        id: "malicious-v2-socket",
        event: "open",
        path: `/v2/rooms/${routeId}/ws`,
      }),
    );
    ws.send(
      JSON.stringify({
        v: 1,
        type: "ws_event",
        id: "malicious-v2-socket",
        event: "message",
        dataB64: Buffer.from("not a v2 wrapper").toString("base64"),
      }),
    );
  });

  let messages = 0;
  let closed = false;
  const client = startRelayClient({
    url: `ws://127.0.0.1:${address.port}/host`,
    key: "ignored-by-malicious-relay",
    currentTokens: () => [],
    currentRoutes: () => [{ token: routeId, protocol: 2 }],
    handleRequest: async () => ({
      status: 404,
      headers: {},
      body: Buffer.alloc(0),
    }),
    openSocket: async (_path, socket) => {
      socket.onMessage(() => messages++);
      socket.onClose(() => {
        closed = true;
      });
      return true;
    },
    minBackoffMs: 10,
    maxBackoffMs: 20,
    log: () => {},
  });

  try {
    await waitFor(() => closed);
    assert.equal(messages, 0);
  } finally {
    client.close();
    await new Promise<void>((resolve) => relay.close(() => resolve()));
  }
});
