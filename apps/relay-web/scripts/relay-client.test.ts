import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket } from "ws";
import { createRelay } from "../src/relay/relay.js";
import { startRelayClient, type RelayClient, type RoomSocket } from "../src/relay-client.js";

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
    handleRequest: async () => ({ status: 404, headers: {}, body: Buffer.alloc(0) }),
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
