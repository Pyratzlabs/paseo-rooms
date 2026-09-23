import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createRelay, type Relay } from "../src/relay/relay.js";
import {
  createRouteOwnership,
  routeTokenForSecret,
} from "../src/relay/route-ownership.js";

async function host(
  relay: Relay,
  key?: string,
  forwarded?: string,
): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/host`, {
    headers: {
      ...(key ? { "x-relay-key": key } : {}),
      ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
    },
  });
  await once(socket, "open");
  return socket;
}
async function claim(socket: WebSocket, route: object) {
  const response = once(socket, "message");
  socket.send(
    JSON.stringify({ v: 1, type: "register", tokens: [], routes: [route] }),
  );
  return JSON.parse(String((await response)[0]));
}
async function rejected(relay: Relay, key?: string, forwarded?: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${relay.port}/host`, {
    headers: {
      ...(key ? { "x-relay-key": key } : {}),
      ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
    },
  });
  socket.on("error", () => {});
  return new Promise<number>((resolve) =>
    socket.on("unexpected-response", (_, response) => {
      response.resume();
      socket.terminate();
      resolve(response.statusCode!);
    }),
  );
}

test("configuration fails closed and ownership secrets are canonical", () => {
  assert.throws(() => createRelay({}), /RELAY_KEY/);
  assert.throws(
    () => createRelay({ authMode: "invalid" as "open" }),
    /AUTH_MODE/,
  );
  assert.throws(
    () => createRelay({ authMode: "open", limits: { maxHosts: 0 } }),
    /limit/,
  );
  assert.equal(routeTokenForSecret("x"), null);
  const ownership = createRouteOwnership();
  assert.equal(ownership.token.length, 45);
  assert.equal(routeTokenForSecret(ownership.ownershipSecret), ownership.token);
});

test("open discovery, ownership rejection, disconnect and restart continuity", async () => {
  let relay = await createRelay({ port: 0, authMode: "open", log: () => {} });
  try {
    const capabilities = await (
      await fetch(`http://127.0.0.1:${relay.port}/.well-known/paseo-rooms`)
    ).json();
    assert.equal(capabilities.registration, "open");
    assert.equal(capabilities.registrationAck, true);
    const first = await host(relay);
    const second = await host(relay);
    const ownership = createRouteOwnership();
    const route = { ...ownership, protocol: 2 };
    assert.equal(
      (await claim(first, { token: "A".repeat(43), protocol: 2 })).reason,
      "ownership",
    );
    assert.equal((await claim(first, route)).type, "registered");
    assert.equal(
      (await claim(second, { token: route.token, protocol: 2 })).reason,
      "ownership",
    );
    assert.equal((await claim(second, route)).type, "register_rejected");
    first.terminate();
    await once(first, "close");
    // A ping orders the next claim after server teardown processing.
    const pong = once(second, "pong");
    second.ping();
    await pong;
    assert.equal((await claim(second, route)).type, "registered");
    await relay.close();
    relay = await createRelay({ port: 0, authMode: "open", log: () => {} });
    const restarted = await host(relay);
    assert.equal(
      (await claim(restarted, { token: route.token, protocol: 2 })).reason,
      "ownership",
    );
    assert.equal((await claim(restarted, route)).type, "registered");
  } finally {
    await relay.close();
  }
});

test("key mode retains legacy routes but protects ownership namespace from downgrade", async () => {
  const relay = await createRelay({
    port: 0,
    relayKey: "private",
    log: () => {},
  });
  try {
    assert.equal(await rejected(relay), 401);
    assert.equal(await rejected(relay, "wrong"), 401);
    const owner = await host(relay, "private");
    assert.equal(
      (await claim(owner, { token: "A".repeat(43), protocol: 2 })).type,
      "registered",
    );
    const route = createRouteOwnership();
    assert.equal(
      (await claim(owner, { ...route, protocol: 1 })).reason,
      "ownership",
    );
    assert.equal(
      (await claim(owner, { ...route, protocol: 2 })).type,
      "registered",
    );
  } finally {
    await relay.close();
  }
});

test("cumulative route and host limits cannot be bypassed by batches or forged forwarding", async () => {
  const relay = await createRelay({
    port: 0,
    authMode: "open",
    log: () => {},
    limits: { maxRoutesPerHost: 1, maxHostsPerSource: 1 },
  });
  try {
    const owner = await host(relay);
    assert.equal(
      (await claim(owner, { ...createRouteOwnership(), protocol: 2 })).type,
      "registered",
    );
    assert.equal(
      (await claim(owner, { ...createRouteOwnership(), protocol: 2 })).reason,
      "capacity",
    );
    assert.equal(await rejected(relay, undefined, "192.0.2.1"), 503);
  } finally {
    await relay.close();
  }
});

test("failed host attempts consume admission budget and shutdown blocks admissions", async () => {
  const relay = await createRelay({
    port: 0,
    relayKey: "private",
    log: () => {},
    limits: { attemptsPerMinute: 2 },
  });
  try {
    assert.equal(await rejected(relay, "wrong"), 401);
    assert.equal(await rejected(relay, "wrong"), 401);
    assert.equal(await rejected(relay, "private"), 429);
  } finally {
    await relay.close();
  }
  const stopped = await createRelay({
    port: 0,
    authMode: "open",
    admissionEnabled: false,
    log: () => {},
  });
  try {
    assert.equal(await rejected(stopped), 503);
  } finally {
    await stopped.close();
  }
});

test("message budgets terminate flooding hosts", async () => {
  const relay = await createRelay({
    port: 0,
    authMode: "open",
    log: () => {},
    limits: { messagesPerMinute: 2 },
  });
  try {
    const owner = await host(relay);
    const closed = once(owner, "close");
    owner.send("{}");
    owner.send("{}");
    owner.send("{}");
    await closed;
  } finally {
    await relay.close();
  }
});

test("browser capacity and idle lifetime release admission slots", async () => {
  const relay = await createRelay({
    port: 0,
    authMode: "open",
    log: () => {},
    limits: { maxBrowsersPerRoute: 1, browserIdleMs: 40 },
  });
  try {
    const owner = await host(relay);
    const route = createRouteOwnership();
    await claim(owner, { ...route, protocol: 2 });
    const url = `ws://127.0.0.1:${relay.port}/v2/rooms/${route.token}/ws`;
    const browser = new WebSocket(url);
    await once(browser, "open");
    const closed = once(browser, "close");
    const extra = new WebSocket(url);
    extra.on("error", () => {});
    const status = await new Promise<number>((resolve) =>
      extra.on("unexpected-response", (_, response) => {
        response.resume();
        extra.terminate();
        resolve(response.statusCode!);
      }),
    );
    assert.equal(status, 503);
    await closed;
    const replacement = new WebSocket(url);
    await once(replacement, "open");
    replacement.terminate();
  } finally {
    await relay.close();
  }
});

test("only configured immediate proxies can supply a single forwarded source", async () => {
  const relay = await createRelay({
    port: 0,
    authMode: "open",
    log: () => {},
    trustedProxyAddresses: ["::ffff:127.0.0.1", "127.0.0.1"],
    limits: { maxHostsPerSource: 1 },
  });
  try {
    await host(relay, undefined, "192.0.2.1");
    await host(relay, undefined, "192.0.2.2");
    assert.equal(await rejected(relay, undefined, "192.0.2.1"), 503);
    await host(relay, undefined, "192.0.2.3, 192.0.2.4");
    assert.equal(await rejected(relay), 503);
  } finally {
    await relay.close();
  }
});

test("empty hosts have a bounded idle lifetime", async () => {
  const relay = await createRelay({
    port: 0,
    authMode: "open",
    log: () => {},
    limits: { emptyHostIdleMs: 30 },
  });
  try {
    const idle = await host(relay);
    await once(idle, "close");
  } finally {
    await relay.close();
  }
});

test("guest aggregate flooding does not disconnect the victim host or its other routes", async () => {
  const relay = await createRelay({
    port: 0,
    authMode: "open",
    log: () => {},
    limits: { messagesPerMinute: 3 },
  });
  try {
    const owner = await host(relay);
    const route = createRouteOwnership();
    await claim(owner, { ...route, protocol: 2 });
    const other = createRouteOwnership();
    await claim(owner, { ...other, protocol: 2 });
    const url = `ws://127.0.0.1:${relay.port}/v2/rooms/${route.token}/ws`;
    const attackers = [new WebSocket(url), new WebSocket(url)];
    await Promise.all(attackers.map((socket) => once(socket, "open")));
    const record = JSON.stringify({ v: 2, type: "handshake", data: "YQ" });
    attackers[0].send(record);
    attackers[0].send(record);
    const closed = once(attackers[1], "close");
    attackers[1].send(record);
    attackers[1].send(record);
    await closed;
    assert.equal(owner.readyState, WebSocket.OPEN);
    assert.equal(
      (await claim(owner, { ...other, protocol: 2 })).type,
      "registered",
    );
    attackers[0].terminate();
  } finally {
    await relay.close();
  }
});

test("global saturation preserves host liveness and registration control", async () => {
  const relay = await createRelay({
    port: 0,
    authMode: "open",
    log: () => {},
    pingIntervalMs: 10,
    limits: { totalBytesPerMinute: 1 },
  });
  try {
    const owner = await host(relay);
    owner.on("message", (raw) => {
      const frame = JSON.parse(String(raw));
      if (frame.type === "ping")
        owner.send(JSON.stringify({ v: 1, type: "pong", t: frame.t }));
    });
    const route = createRouteOwnership();
    await claim(owner, { ...route, protocol: 2 });
    const browser = new WebSocket(
      `ws://127.0.0.1:${relay.port}/v2/rooms/${route.token}/ws`,
    );
    await once(browser, "open");
    const closed = once(browser, "close");
    browser.send(JSON.stringify({ v: 2, type: "handshake", data: "YQ" }));
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 70));
    assert.equal(owner.readyState, WebSocket.OPEN);
  } finally {
    await relay.close();
  }
});
