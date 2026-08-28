/**
 * Relay protocol v1 conformance test: an in-process relay, a fake laptop
 * (raw ws client speaking the protocol) and a fake browser (fetch + ws).
 * Run: node --import tsx --test scripts/relay-protocol.test.ts
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { createRelay, type Relay } from "../src/relay/relay.js";

const RELAY_KEY = "test-relay-key";

let relay: Relay;
let base: string;

before(async () => {
  relay = await createRelay({
    port: 0,
    relayKey: RELAY_KEY,
    pingIntervalMs: 60_000, // heartbeat is not under test; keep it out of the way
    httpTimeoutMs: 2_000,
    log: () => {},
  });
  base = `http://127.0.0.1:${relay.port}`;
});

after(async () => {
  await relay.close();
});

// ---- fake laptop -----------------------------------------------------------

interface Frame {
  type: string;
  [k: string]: unknown;
}

/** A laptop room server that echoes what the protocol asks of it. */
class FakeLaptop {
  readonly ws: WebSocket;
  readonly received: Frame[] = [];
  private waiters: Array<{ match: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];
  /** Set to have the laptop answer http_request frames automatically. */
  autoRespond: ((f: Frame) => { status: number; headers: Record<string, string>; body: string }) | null = null;
  /** Set to have the laptop echo ws_event messages back with a prefix. */
  echoWs = false;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (data) => {
      const frame = JSON.parse(data.toString()) as Frame;
      this.received.push(frame);
      for (const w of this.waiters.splice(0)) {
        if (w.match(frame)) w.resolve(frame);
        else this.waiters.push(w);
      }
      if (frame.type === "http_request" && this.autoRespond) {
        const { status, headers, body } = this.autoRespond(frame);
        this.send({
          v: 1,
          type: "http_response",
          id: frame.id,
          status,
          headers,
          bodyB64: Buffer.from(body).toString("base64"),
        });
      }
      if (frame.type === "ws_event" && this.echoWs && frame.event === "message") {
        const text = Buffer.from(String(frame.dataB64), "base64").toString();
        this.send({
          v: 1,
          type: "ws_event",
          id: frame.id,
          event: "message",
          dataB64: Buffer.from(`echo:${text}`).toString("base64"),
        });
      }
    });
  }

  static connect(key = RELAY_KEY): Promise<FakeLaptop> {
    const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/host`, {
      headers: { "x-relay-key": key },
    });
    const laptop = new FakeLaptop(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(laptop));
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => {
        reject(Object.assign(new Error(`unexpected response ${res.statusCode}`), { status: res.statusCode }));
      });
    });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  register(...tokens: string[]): void {
    this.send({ v: 1, type: "register", tokens });
  }

  waitFor(match: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const existing = this.received.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for frame")), timeoutMs);
      this.waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  close(): void {
    this.ws.close();
  }
}

/** Let queued frames (e.g. a register) reach the relay before asserting. */
function settle(ms = 50): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowserWs(token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/api/rooms/${token}/ws`);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => {
      reject(Object.assign(new Error(`unexpected response ${res.statusCode}`), { status: res.statusCode }));
    });
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return nextFrame(ws, timeoutMs).then((frame) => frame.data);
}

function nextFrame(ws: WebSocket, timeoutMs = 3000): Promise<{ data: string; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for ws message")), timeoutMs);
    ws.once("message", (data, isBinary) => {
      clearTimeout(timer);
      resolve({ data: data.toString(), isBinary });
    });
  });
}

function waitClose(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for close")), timeoutMs);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---- tests -----------------------------------------------------------------

test("register + full http round-trip", async () => {
  const laptop = await FakeLaptop.connect();
  laptop.register("tok-http");
  laptop.autoRespond = (f) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ method: f.method, path: f.path, echo: Buffer.from(String(f.bodyB64), "base64").toString() }),
  });

  await settle();

  const res = await fetch(`${base}/api/rooms/tok-http/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "1.2.3.4", "x-secret": "nope" },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  const body = (await res.json()) as { method: string; path: string; echo: string };
  assert.equal(body.method, "POST");
  assert.equal(body.path, "/api/rooms/tok-http/messages");
  assert.equal(body.echo, JSON.stringify({ message: "hi" }));

  const forwarded = laptop.received.find((f) => f.type === "http_request") as
    | { headers: Record<string, string> }
    | undefined;
  assert.ok(forwarded);
  // only content-type and x-forwarded-for cross the relay
  assert.deepEqual(Object.keys(forwarded.headers).sort(), ["content-type", "x-forwarded-for"]);

  // GET /r/<token> is routable too
  laptop.autoRespond = () => ({ status: 200, headers: { "content-type": "text/html" }, body: "<html>room</html>" });
  const page = await fetch(`${base}/r/tok-http`);
  assert.equal(page.status, 200);
  assert.equal(await page.text(), "<html>room</html>");

  const asset = await fetch(`${base}/r/tok-http/assets/room-test.js`);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "<html>room</html>");
  const assetRequest = laptop.received.find((f) => f.type === "http_request" && f.path === "/r/tok-http/assets/room-test.js");
  assert.ok(assetRequest, "token-scoped assets must route to their room host");

  laptop.close();
  await waitClose(laptop.ws);
});

test("ws relay in both directions", async () => {
  const laptop = await FakeLaptop.connect();
  laptop.register("tok-ws");
  laptop.echoWs = true;
  await settle();

  const browser = await openBrowserWs("tok-ws");
  const open = await laptop.waitFor((f) => f.type === "ws_event" && f.event === "open");
  assert.equal(open.path, "/api/rooms/tok-ws/ws");
  const id = open.id;

  // browser -> laptop -> browser
  browser.send("hello");
  const echo = await nextFrame(browser);
  assert.equal(echo.data, "echo:hello");
  assert.equal(echo.isBinary, false, "room updates must reach browsers as text frames");

  // laptop -> browser unprompted
  laptop.echoWs = false;
  laptop.send({
    v: 1,
    type: "ws_event",
    id,
    event: "message",
    dataB64: Buffer.from("push").toString("base64"),
  });
  assert.equal(await nextMessage(browser), "push");

  // browser close is reported to the laptop
  browser.close();
  await laptop.waitFor((f) => f.type === "ws_event" && f.event === "close" && f.id === id);

  laptop.close();
  await waitClose(laptop.ws);
});

test("unknown token is 404 on http and ws; untokened routes are not routable", async () => {
  assert.equal((await fetch(`${base}/api/rooms/nope`)).status, 404);
  assert.equal((await fetch(`${base}/r/nope`)).status, 404);
  assert.equal((await fetch(`${base}/r/nope/assets/room.js`)).status, 404);
  assert.equal((await fetch(`${base}/api/rooms`, { method: "POST", body: "{}" })).status, 404);
  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/host`)).status, 404);

  const err = await openBrowserWs("nope").then(
    () => null,
    (e: { status?: number }) => e,
  );
  assert.equal(err?.status, 404);
});

test("bad relay key is rejected with 401", async () => {
  const bad = await FakeLaptop.connect("wrong-key").then(
    () => null,
    (e: { status?: number }) => e,
  );
  assert.equal(bad?.status, 401);

  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/host`); // no header at all
  const missing = await new Promise<number | undefined>((resolve) => {
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode));
    ws.once("open", () => resolve(200));
    ws.once("error", () => resolve(undefined));
  });
  assert.equal(missing, 401);
});

test("laptop disconnect drops routes and closes browser sockets", async () => {
  const laptop = await FakeLaptop.connect();
  laptop.register("tok-gone");
  laptop.autoRespond = () => ({ status: 200, headers: {}, body: "ok" });
  await settle();

  const browser = await openBrowserWs("tok-gone");
  await laptop.waitFor((f) => f.type === "ws_event" && f.event === "open");
  assert.equal((await fetch(`${base}/api/rooms/tok-gone`)).status, 200);

  laptop.close();
  await waitClose(browser);
  assert.equal((await fetch(`${base}/api/rooms/tok-gone`)).status, 404);
});

test("double claim by a live connection is rejected", async () => {
  const first = await FakeLaptop.connect();
  first.register("tok-claim");
  first.autoRespond = () => ({ status: 200, headers: {}, body: "first" });
  await settle();
  assert.equal(await (await fetch(`${base}/api/rooms/tok-claim`)).text(), "first");

  const second = await FakeLaptop.connect();
  second.register("tok-claim");
  const rejected = await second.waitFor((f) => f.type === "register_rejected");
  assert.equal(rejected.token, "tok-claim");

  // routing is unchanged: the first connection still owns the token
  second.autoRespond = () => ({ status: 200, headers: {}, body: "second" });
  await settle();
  assert.equal(await (await fetch(`${base}/api/rooms/tok-claim`)).text(), "first");

  // re-registering on the SAME connection is fine
  first.register("tok-claim");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(first.received.filter((f) => f.type === "register_rejected").length, 0);

  // once the owner dies, the claim is released
  first.close();
  await waitClose(first.ws);
  second.register("tok-claim");
  await settle();
  assert.equal(await (await fetch(`${base}/api/rooms/tok-claim`)).text(), "second");

  second.close();
  await waitClose(second.ws);
});

test("no http_response within the timeout yields 504", async () => {
  const laptop = await FakeLaptop.connect(); // autoRespond left null: never answers
  laptop.register("tok-slow");
  await settle();
  const res = await fetch(`${base}/api/rooms/tok-slow`);
  assert.equal(res.status, 504);
  laptop.close();
  await waitClose(laptop.ws);
});
