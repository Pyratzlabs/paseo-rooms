/**
 * Relay protocol v1 conformance test: an in-process relay, a fake laptop
 * (raw ws client speaking the protocol) and a fake browser (fetch + ws).
 * Run: node --import tsx --test scripts/relay-protocol.test.ts
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";
import { createRelay, type Relay } from "../src/relay/relay.js";
import {
  frameRoutes,
  MAX_HOST_CONTROL_BYTES,
  MAX_REGISTERED_ROUTES,
  matchPublicRoute,
  parseLaptopFrame,
  parseV2OuterRecord,
} from "../src/relay/protocol.js";

const RELAY_KEY = "test-relay-key";
const V2_TOKEN = "A".repeat(43);
const V2_INVALID_TOKEN = "B".repeat(43);

let relay: Relay | null = null;
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
  await relay?.close();
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
  private waiters: Array<{
    match: (f: Frame) => boolean;
    resolve: (f: Frame) => void;
  }> = [];
  /** Set to have the laptop answer http_request frames automatically. */
  autoRespond:
    | ((f: Frame) => {
        status: number;
        headers: Record<string, string>;
        body: string;
      })
    | null = null;
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
      if (
        frame.type === "ws_event" &&
        this.echoWs &&
        frame.event === "message"
      ) {
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
    const ws = new WebSocket(`ws://127.0.0.1:${relay!.port}/host`, {
      headers: { "x-relay-key": key },
    });
    const laptop = new FakeLaptop(ws);
    return new Promise((resolve, reject) => {
      ws.once("open", () => resolve(laptop));
      ws.once("error", reject);
      ws.once("unexpected-response", (_req, res) => {
        reject(
          Object.assign(new Error(`unexpected response ${res.statusCode}`), {
            status: res.statusCode,
          }),
        );
      });
    });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  register(...tokens: string[]): void {
    this.send({ v: 1, type: "register", tokens });
  }

  registerRoutes(...routes: Array<{ token: string; protocol: 1 | 2 }>): void {
    this.send({ v: 1, type: "register", tokens: [], routes });
  }

  waitFor(match: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const existing = this.received.find(match);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("timed out waiting for frame")),
        timeoutMs,
      );
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
  const ws = new WebSocket(
    `ws://127.0.0.1:${relay!.port}/api/rooms/${token}/ws`,
  );
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => {
      reject(
        Object.assign(new Error(`unexpected response ${res.statusCode}`), {
          status: res.statusCode,
        }),
      );
    });
  });
}

function openV2BrowserWs(token: string): Promise<WebSocket> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${relay!.port}/v2/rooms/${token}/ws`,
  );
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => {
      reject(
        Object.assign(new Error(`unexpected response ${res.statusCode}`), {
          status: res.statusCode,
        }),
      );
    });
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<string> {
  return nextFrame(ws, timeoutMs).then((frame) => frame.data);
}

function nextFrame(
  ws: WebSocket,
  timeoutMs = 3000,
): Promise<{ data: string; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for ws message")),
      timeoutMs,
    );
    ws.once("message", (data, isBinary) => {
      clearTimeout(timer);
      resolve({ data: data.toString(), isBinary });
    });
  });
}

function waitClose(ws: WebSocket, timeoutMs = 3000): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("timed out waiting for close")),
      timeoutMs,
    );
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ---- tests -----------------------------------------------------------------

test("protocol parser validates registered routes and v2 outer records", () => {
  assert.deepEqual(matchPublicRoute(`/v2/rooms/${V2_TOKEN}/ws`, true), {
    kind: "ws",
    token: V2_TOKEN,
    protocol: 2,
  });
  assert.equal(matchPublicRoute("/v2/rooms/short/ws", true), null);
  assert.equal(matchPublicRoute("/v2/rooms/bad.route/ws", true), null);
  assert.equal(matchPublicRoute("/api/rooms/bad.route", false), null);
  assert.equal(
    parseLaptopFrame(
      JSON.stringify({
        v: 1,
        type: "register",
        routes: Array.from({ length: MAX_REGISTERED_ROUTES + 1 }, () => ({
          token: V2_TOKEN,
          protocol: 2,
        })),
      }),
    ),
    null,
  );
  assert.equal(parseLaptopFrame("x".repeat(MAX_HOST_CONTROL_BYTES + 1)), null);

  assert.deepEqual(
    parseLaptopFrame(
      JSON.stringify({
        v: 1,
        type: "register",
        tokens: ["legacy-token"],
        routes: [{ token: V2_TOKEN, protocol: 2 }],
      }),
    ),
    {
      v: 1,
      type: "register",
      tokens: ["legacy-token"],
      routes: [{ token: V2_TOKEN, protocol: 2 }],
    },
  );
  assert.deepEqual(
    frameRoutes({
      v: 1,
      type: "register",
      tokens: ["legacy-token"],
      routes: [{ token: V2_TOKEN, protocol: 2 }],
    }),
    [
      { token: "legacy-token", protocol: 1 },
      { token: V2_TOKEN, protocol: 2 },
    ],
  );
  assert.equal(
    parseLaptopFrame(
      JSON.stringify({
        v: 1,
        type: "register",
        tokens: ["legacy-token"],
        routes: [{ token: "legacy-token", protocol: 1 }],
      }),
    ),
    null,
  );
  assert.equal(
    parseLaptopFrame(
      JSON.stringify({
        v: 1,
        type: "register",
        routes: [{ token: "bad.route", protocol: 2 }],
      }),
    ),
    null,
  );
  assert.equal(
    parseV2OuterRecord(JSON.stringify({ v: 2, type: "secure", data: "" })),
    null,
  );
  assert.equal(
    parseV2OuterRecord('{"v":2,"type":"secure","data":"YWJjZA","extra":true}'),
    null,
  );
  assert.equal(
    parseV2OuterRecord(
      '{"v":2,"type":"secure","data":"YWJjZA","data":"YWJjZA"}',
    ),
    null,
  );
  assert.equal(
    parseV2OuterRecord('{ "v":2,"type":"secure","data":"YWJjZA" }'),
    null,
  );
  assert.equal(
    parseV2OuterRecord(
      JSON.stringify({
        v: 2,
        type: "secure",
        data: Buffer.alloc(64 * 1024 + 1).toString("base64url"),
      }),
    ),
    null,
  );

  assert.deepEqual(
    parseV2OuterRecord(
      JSON.stringify({ v: 2, type: "secure", data: "YWJjZA" }),
    ),
    {
      v: 2,
      type: "secure",
      data: "YWJjZA",
    },
  );
  assert.equal(
    parseV2OuterRecord(
      JSON.stringify({ v: 2, type: "secure", data: "YWJjZA==" }),
    ),
    null,
  );
  assert.equal(
    parseV2OuterRecord(
      JSON.stringify({ v: 2, type: "unknown", data: "YWJjZA" }),
    ),
    null,
  );
  assert.equal(
    parseV2OuterRecord(
      JSON.stringify({ v: 2, type: "group", data: "YWJjZA" }),
    ),
    null,
  );
});

test("register + full http round-trip", async () => {
  const laptop = await FakeLaptop.connect();
  laptop.register("tok-http");
  laptop.autoRespond = (f) => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      method: f.method,
      path: f.path,
      echo: Buffer.from(String(f.bodyB64), "base64").toString(),
    }),
  });

  await settle();

  const res = await fetch(`${base}/api/rooms/tok-http/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "1.2.3.4",
      "x-secret": "nope",
    },
    body: JSON.stringify({ message: "hi" }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/json");
  const body = (await res.json()) as {
    method: string;
    path: string;
    echo: string;
  };
  assert.equal(body.method, "POST");
  assert.equal(body.path, "/api/rooms/tok-http/messages");
  assert.equal(body.echo, JSON.stringify({ message: "hi" }));

  const forwarded = laptop.received.find((f) => f.type === "http_request") as
    { headers: Record<string, string> } | undefined;
  assert.ok(forwarded);
  // only content-type and x-forwarded-for cross the relay
  assert.deepEqual(Object.keys(forwarded.headers).sort(), [
    "content-type",
    "x-forwarded-for",
  ]);

  // Presentation is served by the public relay, not relayed to the laptop.
  const landing = await fetch(`${base}/`);
  assert.equal(landing.status, 200);
  assert.match(
    await landing.text(),
    /Bring a second engineer into the conversation/,
  );

  const forwardedBeforeStatic = laptop.received.filter(
    (f) => f.type === "http_request",
  ).length;
  const page = await fetch(`${base}/r/tok-http`);
  assert.equal(page.status, 200);
  const pageHtml = await page.text();
  assert.match(pageHtml, /src="\/assets\/room-/);
  assert.equal(
    laptop.received.filter((f) => f.type === "http_request").length,
    forwardedBeforeStatic,
  );

  const assetPath = pageHtml.match(/src="(\/assets\/room-[^"]+)"/)?.[1];
  assert.ok(assetPath, "built room shell must reference a public Vite asset");
  const asset = await fetch(`${base}${assetPath}`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  assert.equal(
    laptop.received.filter((f) => f.type === "http_request").length,
    forwardedBeforeStatic,
  );

  const font = await fetch(`${base}/landing/made-tommy-medium.woff2`);
  assert.equal(font.status, 200);
  assert.equal(font.headers.get("content-type"), "font/woff2");

  laptop.close();
  await waitClose(laptop.ws);
});

test("ws relay in both directions", async () => {
  const laptop = await FakeLaptop.connect();
  laptop.register("tok-ws");
  laptop.echoWs = true;
  await settle();

  const browser = await openBrowserWs("tok-ws");
  const open = await laptop.waitFor(
    (f) => f.type === "ws_event" && f.event === "open",
  );
  assert.equal(open.path, "/api/rooms/tok-ws/ws");
  const id = open.id;

  // browser -> laptop -> browser
  browser.send("hello");
  const echo = await nextFrame(browser);
  assert.equal(echo.data, "echo:hello");
  assert.equal(
    echo.isBinary,
    false,
    "room updates must reach browsers as text frames",
  );

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
  await laptop.waitFor(
    (f) => f.type === "ws_event" && f.event === "close" && f.id === id,
  );

  laptop.close();
  await waitClose(laptop.ws);
});

test("unknown room capabilities are 404 while public presentation remains available", async () => {
  assert.equal((await fetch(`${base}/api/rooms/nope`)).status, 404);
  assert.equal((await fetch(`${base}/r/nope`)).status, 404);
  assert.equal(
    (await fetch(`${base}/api/rooms`, { method: "POST", body: "{}" })).status,
    404,
  );
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/host`)).status, 404);

  const shortV2 = await openV2BrowserWs("short").then(
    () => null,
    (e: { status?: number }) => e,
  );
  assert.equal(shortV2?.status, 404);

  const err = await openBrowserWs("nope").then(
    () => null,
    (e: { status?: number }) => e,
  );
  assert.equal(err?.status, 404);
});

test("v2 routes serve only the shell and opaque v2 websocket", async () => {
  const laptop = await FakeLaptop.connect();
  laptop.registerRoutes({ token: V2_TOKEN, protocol: 2 });
  await settle();

  const page = await fetch(`${base}/r/${V2_TOKEN}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /src="\/assets\/room-/);

  assert.equal((await fetch(`${base}/api/rooms/${V2_TOKEN}`)).status, 404);
  assert.equal(
    (await fetch(`${base}/api/rooms/${V2_TOKEN}/history`)).status,
    404,
  );
  assert.equal(
    laptop.received.filter((f) => f.type === "http_request").length,
    0,
  );

  const v1Ws = await openBrowserWs(V2_TOKEN).then(
    () => null,
    (e: { status?: number }) => e,
  );
  assert.equal(v1Ws?.status, 404);

  const browser = await openV2BrowserWs(V2_TOKEN);
  const open = await laptop.waitFor(
    (f) => f.type === "ws_event" && f.event === "open",
  );
  assert.equal(open.path, `/v2/rooms/${V2_TOKEN}/ws`);
  const id = String(open.id);

  const valid = JSON.stringify({ v: 2, type: "handshake", data: "YWJjZA" });
  browser.send(valid);
  const forwarded = await laptop.waitFor(
    (f) => f.type === "ws_event" && f.event === "message" && f.id === id,
  );
  assert.equal(
    Buffer.from(String(forwarded.dataB64), "base64").toString("utf8"),
    valid,
  );

  laptop.send({
    v: 1,
    type: "ws_event",
    id,
    event: "message",
    dataB64: Buffer.from(valid).toString("base64"),
  });
  const echoed = await nextFrame(browser);
  assert.equal(echoed.data, valid);
  assert.equal(echoed.isBinary, false);

  browser.close();
  laptop.close();
  await waitClose(laptop.ws);
});

test("v2 websocket rejects binary and malformed outer records", async () => {
  const laptop = await FakeLaptop.connect();
  laptop.registerRoutes({ token: V2_INVALID_TOKEN, protocol: 2 });
  await settle();

  const malformed = await openV2BrowserWs(V2_INVALID_TOKEN);
  const malformedOpen = await laptop.waitFor(
    (f) => f.type === "ws_event" && f.event === "open",
  );
  malformed.send(
    JSON.stringify({ v: 2, type: "handshake", data: "not padded+" }),
  );
  await waitClose(malformed);
  await settle();
  assert.equal(
    laptop.received.some(
      (f) =>
        f.type === "ws_event" &&
        f.event === "message" &&
        f.id === malformedOpen.id,
    ),
    false,
  );

  const binary = await openV2BrowserWs(V2_INVALID_TOKEN);
  const binaryOpen = await laptop.waitFor(
    (f) =>
      f.type === "ws_event" && f.event === "open" && f.id !== malformedOpen.id,
  );
  binary.send(Buffer.from("binary"));
  await waitClose(binary);
  await settle();
  assert.equal(
    laptop.received.some(
      (f) =>
        f.type === "ws_event" &&
        f.event === "message" &&
        f.id === binaryOpen.id,
    ),
    false,
  );

  laptop.close();
  await waitClose(laptop.ws);
});

test("bad relay key is rejected with 401", async () => {
  const bad = await FakeLaptop.connect("wrong-key").then(
    () => null,
    (e: { status?: number }) => e,
  );
  assert.equal(bad?.status, 401);

  const ws = new WebSocket(`ws://127.0.0.1:${relay!.port}/host`); // no header at all
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
  assert.equal(
    await (await fetch(`${base}/api/rooms/tok-claim`)).text(),
    "first",
  );

  const second = await FakeLaptop.connect();
  second.register("tok-claim");
  const rejected = await second.waitFor((f) => f.type === "register_rejected");
  assert.equal(rejected.token, "tok-claim");

  // routing is unchanged: the first connection still owns the token
  second.autoRespond = () => ({ status: 200, headers: {}, body: "second" });
  await settle();
  assert.equal(
    await (await fetch(`${base}/api/rooms/tok-claim`)).text(),
    "first",
  );

  // re-registering on the SAME connection is fine
  first.register("tok-claim");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(
    first.received.filter((f) => f.type === "register_rejected").length,
    0,
  );

  // once the owner dies, the claim is released
  first.close();
  await waitClose(first.ws);
  second.register("tok-claim");
  await settle();
  assert.equal(
    await (await fetch(`${base}/api/rooms/tok-claim`)).text(),
    "second",
  );

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
