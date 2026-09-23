import assert from "node:assert/strict";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createRelay } from "../src/relay/relay.js";
import { createRouteOwnership } from "../src/relay/route-ownership.js";
import { startRelayClient } from "../src/relay-client.js";
import { discoverRelayPolicy } from "../src/relay-policy.js";

const hooks = {
  currentTokens: () => [],
  openSocket: async () => true,
  handleRequest: async () => ({
    status: 404,
    headers: {},
    body: Buffer.alloc(0),
  }),
  log: () => {},
};
test("open relay admits a keyless host, confirms protected routes and rejects impostors", async () => {
  const relay = await createRelay({ port: 0, authMode: "open", log: () => {} });
  const origin = `ws://127.0.0.1:${relay.port}`;
  const route = { ...createRouteOwnership(), protocol: 2 as const };
  const client = startRelayClient({ ...hooks, url: `${origin}/host` });
  const other = startRelayClient({ ...hooks, url: `${origin}/host` });
  try {
    assert.equal((await discoverRelayPolicy(origin)).registration, "open");
    await Promise.all([
      client.waitUntilConnected(),
      other.waitUntilConnected(),
    ]);
    await client.registerRoutesConfirmed([route]);
    await assert.rejects(other.registerRoutesConfirmed([route]), /rejected/);
    await assert.rejects(
      other.registerRoutesConfirmed([
        {
          ...createRouteOwnership(),
          protocol: 2,
          ownershipSecret: route.ownershipSecret,
        },
      ]),
      /rejected/,
    );
    const browser = new WebSocket(`${origin}/v2/rooms/${route.token}/ws`);
    await new Promise<void>((resolve, reject) => {
      browser.once("open", resolve);
      browser.once("error", reject);
    });
    browser.close();
  } finally {
    client.close();
    other.close();
    await relay.close();
  }
});

test("missing ACK times out and failed routes are removed before reconnect", async () => {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const route = { ...createRouteOwnership(), protocol: 2 as const };
  const frames: Array<{ type: string; routes?: Array<{ token: string }> }> = [];
  let connections = 0;
  server.on("connection", (ws, req) => {
    connections++;
    assert.equal(req.headers["x-relay-key"], undefined);
    ws.on("message", (data) => frames.push(JSON.parse(data.toString())));
  });
  const client = startRelayClient({
    ...hooks,
    url: `ws://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`,
    currentRoutes: () => [route],
    minBackoffMs: 5,
    maxBackoffMs: 5,
  });
  try {
    await client.waitUntilConnected();
    await assert.rejects(
      client.registerRoutesConfirmed([route], 30),
      /Timed out/,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(frames.some((frame) => frame.type === "unregister"));
    const prior = frames.length;
    for (const ws of server.clients) ws.terminate();
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.ok(connections >= 2);
    assert.equal(
      frames.slice(prior).filter((frame) => frame.type === "register").length,
      0,
    );
    const pending = client.registerRoutesConfirmed([
      { ...createRouteOwnership(), protocol: 2 },
    ]);
    client.close();
    await assert.rejects(pending, /closed/);
  } finally {
    client.close();
    for (const ws of server.clients) ws.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("room API waits for relay admission, rolls back rejected routes, and preserves private legacy mode", async () => {
  const { build } = await import("esbuild");
  const { createRequire } = await import("node:module");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "rooms-host-access-"),
  );
  const oldData = process.env.DATA_DIR;
  const oldPort = process.env.PORT;
  process.env.DATA_DIR = directory;
  process.env.PORT = "0";
  const built = await build({
    stdin: {
      contents:
        'export * from "./server.ts"; export { listRooms } from "./rooms.ts";',
      resolveDir: (await import("node:url")).fileURLToPath(
        new URL("../src", import.meta.url),
      ),
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    plugins: [
      {
        name: "fake-daemon",
        setup(builder) {
          builder.onResolve({ filter: /\/paseo\.js$/ }, () => ({
            path: "paseo",
            namespace: "fake",
          }));
          builder.onLoad({ filter: /.*/, namespace: "fake" }, () => ({
            contents: `export const isConnected = () => true; export const agentInfo = async () => ({title: 'Fixture'}); export const closePaseoConnections = async () => {}; export const ensureConnected = async () => {}; export const fetchFullHistory = async () => []; export const listRoomQuestions = async () => []; export const answerRoomQuestion = async () => {}; export const sendToAgent = async () => {}; export const subscribeAgent = async () => () => {};`,
          }));
        },
      },
    ],
  });
  const module = {
    exports: {} as typeof import("../src/server.js") &
      Pick<typeof import("../src/rooms.js"), "listRooms">,
  };
  new Function("require", "module", "exports", built.outputFiles[0].text)(
    createRequire(import.meta.url),
    module,
    module.exports,
  );
  const runtime = await module.exports.startLocalRoomServer({
    connectDaemon: false,
  });
  if (oldData === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = oldData;
  if (oldPort === undefined) delete process.env.PORT;
  else process.env.PORT = oldPort;
  const relay = await createRelay({
    port: 0,
    authMode: "open",
    limits: { maxRoutesPerHost: 1 },
    log: () => {},
  });
  const origin = `ws://127.0.0.1:${relay.port}`;
  const request = async (body: object) =>
    module.exports.handleApiRequest({
      method: "POST",
      path: "/api/rooms",
      headers: { authorization: `Bearer ${runtime.adminToken}` },
      body: Buffer.from(JSON.stringify({ agentId: "fixture-agent", ...body })),
    });
  try {
    const first = await request({
      relayOrigin: origin,
      relayKey: "must-not-be-used",
    });
    assert.equal(first.status, 201, first.body.toString());
    const invite = JSON.parse(first.body.toString());
    assert.match(invite.token, /^o_/);
    const room = module.exports.listRooms()[0];
    assert.equal(room.protocol, 2);
    if (room.protocol !== 2) throw new Error("Expected secure room");
    assert.ok(room.ownershipSecret);
    assert.ok(!first.body.toString().includes(room.ownershipSecret));
    const second = await request({ relayOrigin: origin });
    assert.notEqual(second.status, 201);
    assert.equal(
      module.exports.listRooms().length,
      1,
      "rejected room must be rolled back",
    );
    await module.exports.handleApiRequest({
      method: "DELETE",
      path: `/api/rooms/${invite.token}`,
      headers: { authorization: `Bearer ${runtime.adminToken}` },
      body: Buffer.alloc(0),
    });
    const privateRelay = await createRelay({
      port: 0,
      relayKey: "private-test",
      log: () => {},
    });
    try {
      const privateOrigin = `ws://127.0.0.1:${privateRelay.port}`;
      assert.equal((await request({ relayOrigin: privateOrigin })).status, 400);
      const legacy = await request({
        relayOrigin: privateOrigin,
        relayMode: "legacy-key",
        relayKey: "private-test",
      });
      assert.equal(legacy.status, 201, legacy.body.toString());
      assert.match(
        JSON.parse(legacy.body.toString()).token,
        /^[A-Za-z0-9_-]{43}$/,
      );
    } finally {
      await privateRelay.close();
    }
  } finally {
    await runtime.close();
    await relay.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("reconnected protected routes retry after the old owner releases without dropping other rooms", async () => {
  const relay = await createRelay({ port: 0, authMode: "open", log: () => {} });
  const origin = `ws://127.0.0.1:${relay.port}`;
  const route = { ...createRouteOwnership(), protocol: 2 as const };
  const otherRoute = { ...createRouteOwnership(), protocol: 2 as const };
  const old = startRelayClient({ ...hooks, url: `${origin}/host` });
  let replacement: ReturnType<typeof startRelayClient> | undefined;
  let browser: WebSocket | undefined;
  let otherBrowser: WebSocket | undefined;
  let rejected!: () => void;
  const sawRejection = new Promise<void>((resolve) => {
    rejected = resolve;
  });
  let otherClosed = false;
  let recovered = false;
  try {
    await old.waitUntilConnected();
    await old.registerRoutesConfirmed([route]);
    replacement = startRelayClient({
      ...hooks,
      url: `${origin}/host`,
      currentRoutes: () => [route],
      openSocket: async (path) => {
        if (path.includes(route.token)) recovered = true;
        return true;
      },
      minBackoffMs: 5,
      maxBackoffMs: 20,
      log: (line) => {
        if (line.includes("rejected")) rejected();
      },
    });
    await replacement.waitUntilConnected();
    await sawRejection;
    await replacement.registerRoutesConfirmed([otherRoute]);
    otherBrowser = new WebSocket(`${origin}/v2/rooms/${otherRoute.token}/ws`);
    await new Promise<void>((resolve, reject) => {
      otherBrowser!.once("open", resolve);
      otherBrowser!.once("error", reject);
    });
    otherBrowser.on("close", () => {
      otherClosed = true;
    });
    old.close();
    // Observe actual successful routing; bounded polling avoids relying on retry timing.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const attempt = new WebSocket(`${origin}/v2/rooms/${route.token}/ws`);
      const accepted = await new Promise<boolean>((resolve) => {
        attempt.once("open", () => resolve(true));
        attempt.once("error", () => resolve(false));
      });
      if (accepted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (recovered) {
          browser = attempt;
          break;
        }
        attempt.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(browser, "replacement host must recover the route automatically");
    assert.equal(
      otherClosed,
      false,
      "retry must not interrupt another admitted route",
    );
  } finally {
    browser?.close();
    otherBrowser?.close();
    old.close();
    replacement?.close();
    await relay.close();
  }
});
