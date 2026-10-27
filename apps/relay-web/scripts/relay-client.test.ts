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

test("relay client rejects a readiness wait when the registration key is invalid", async () => {
  const relay = await createRelay({
    port: 0,
    relayKey: "correct-key",
    log: () => {},
  });
  const client = startRelayClient({
    url: `ws://127.0.0.1:${relay.port}/host`,
    key: "wrong-key",
    currentTokens: () => [],
    handleRequest: async () => ({
      status: 404,
      headers: {},
      body: Buffer.alloc(0),
    }),
    openSocket: async () => false,
    minBackoffMs: 10,
    maxBackoffMs: 20,
    log: () => {},
  });

  try {
    await assert.rejects(
      client.waitUntilConnected(500),
      /relay control connection (failed|closed)/,
    );
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

test(
  "multiplexed relay congestion bounds one producer while another room survives and sends",
  { timeout: 5000 },
  async () => {
    const relay = await createRelay({
      port: 0,
      relayKey: "isolated-output",
      pingIntervalMs: 60_000,
      log: () => {},
    });
    const hostUrl = `ws://127.0.0.1:${relay.port}/host`;
    const original = WebSocket.prototype.send;
    let host: WebSocket | undefined;
    let paused = false,
      aggregatePressure = false;
    const callbacks: Array<() => void> = [];
    let writes = 0;
    WebSocket.prototype.send = function (data, optionsOrCallback?, callback?) {
      const outgoing = this.url === hostUrl;
      if (outgoing) host = this;
      const done = (
        typeof optionsOrCallback === "function" ? optionsOrCallback : callback
      ) as ((error?: Error) => void) | undefined;
      const wrapped = (error?: Error) => {
        if (outgoing && paused) {
          callbacks.push(() => done?.(error));
        } else done?.(error);
      };
      if (outgoing && paused) writes++;
      return original.call(
        this,
        data,
        typeof optionsOrCallback === "object" ? optionsOrCallback : {},
        wrapped,
      );
    };
    const virtuals = new Map<string, RoomSocket>();
    const closed = new Set<string>();
    const client = startRelayClient({
      url: hostUrl,
      key: "isolated-output",
      currentTokens: () => ["noisy-room", "healthy-room"],
      handleRequest: async () => ({
        status: 404,
        headers: {},
        body: Buffer.alloc(0),
      }),
      openSocket: async (path, socket) => {
        const name = path.includes("noisy-room") ? "noisy" : "healthy";
        virtuals.set(name, socket);
        socket.onClose(() => closed.add(name));
        return true;
      },
      log: () => {},
    });
    let noisy: WebSocket | undefined, healthy: WebSocket | undefined;
    try {
      await client.waitUntilConnected();
      await waitFor(() => Boolean(host));
      noisy = new WebSocket(
        `ws://127.0.0.1:${relay.port}/api/rooms/noisy-room/ws`,
      );
      healthy = new WebSocket(
        `ws://127.0.0.1:${relay.port}/api/rooms/healthy-room/ws`,
      );
      await Promise.all(
        [noisy, healthy].map(
          (socket) =>
            new Promise<void>((resolve, reject) => {
              socket.once("open", resolve);
              socket.once("error", reject);
            }),
        ),
      );
      await waitFor(() => virtuals.size === 2);
      Object.defineProperty(host!, "bufferedAmount", {
        get: () => (aggregatePressure ? 600 * 1024 : 0),
      });
      paused = true;
      void virtuals.get("noisy")!.send("x".repeat(80 * 1024));
      await waitFor(() => callbacks.length === 1);
      aggregatePressure = true;
      assert.equal(
        virtuals.get("healthy")!.bufferedAmount,
        0,
        "shared transport backlog is not the healthy room's buffer",
      );
      for (let index = 0; index < 8; index++)
        void virtuals.get("noisy")!.send("x".repeat(80 * 1024));
      assert.ok(closed.has("noisy"));
      assert.ok(!closed.has("healthy"));
      assert.equal(
        writes,
        1,
        "producer close must not clear the outstanding physical write",
      );
      assert.equal(client.connected(), true);
      const received = new Promise<string>((resolve) =>
        healthy!.once("message", (data) => resolve(data.toString())),
      );
      const sent = virtuals.get("healthy")!.send("healthy reply");
      aggregatePressure = false;
      paused = false;
      for (const done of callbacks.splice(0)) done();
      await sent;
      assert.equal(await received, "healthy reply");
      assert.equal(healthy.readyState, WebSocket.OPEN);
      assert.ok(!closed.has("healthy"));
      assert.equal(client.connected(), true);
    } finally {
      paused = false;
      aggregatePressure = false;
      for (const done of callbacks.splice(0)) done();
      WebSocket.prototype.send = original;
      noisy?.terminate();
      healthy?.terminate();
      client.close();
      await relay.close();
    }
  },
);

test(
  "relay preserves a legal 300 KiB HTTP response and returns 503 when its serialized frame exceeds the control cap",
  { timeout: 5000 },
  async () => {
    const relay = new WebSocketServer({ port: 0, perMessageDeflate: false });
    await new Promise<void>((resolve) => relay.once("listening", resolve));
    const address = relay.address();
    assert.ok(typeof address === "object" && address);
    const responses = new Map<string, { status: number; bodyB64: string }>();
    let peer: WebSocket | undefined;
    relay.on("connection", (socket) => {
      peer = socket;
      socket.on("message", (data) => {
        const value = JSON.parse(data.toString()) as {
          type: string;
          id: string;
          status: number;
          bodyB64: string;
        };
        if (value.type === "http_response") responses.set(value.id, value);
      });
    });
    const body = Buffer.alloc(300 * 1024, 97);
    const client = startRelayClient({
      url: `ws://127.0.0.1:${address.port}/host`,
      currentTokens: () => [],
      openSocket: async () => false,
      handleRequest: async (request) => ({
        status: 200,
        headers: { "content-type": "application/octet-stream" },
        body: request.path === "/legal" ? body : Buffer.alloc(400 * 1024, 98),
      }),
      log: () => {},
    });
    try {
      await client.waitUntilConnected();
      await waitFor(() => Boolean(peer));
      for (const id of ["legal", "oversized"])
        peer!.send(
          JSON.stringify({
            v: 1,
            type: "http_request",
            id,
            method: "GET",
            path: `/${id}`,
            headers: {},
            bodyB64: "",
          }),
        );
      await waitFor(() => responses.size === 2);
      assert.equal(responses.get("legal")!.status, 200);
      assert.deepEqual(
        Buffer.from(responses.get("legal")!.bodyB64, "base64"),
        body,
      );
      assert.equal(responses.get("oversized")!.status, 503);
      assert.equal(client.connected(), true);
    } finally {
      client.close();
      for (const socket of relay.clients) socket.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  },
);
