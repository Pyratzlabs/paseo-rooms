import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";
import * as pluginSdk from "@getpaseo/plugin";
import { WebSocket } from "ws";
import { createRouteOwnership } from "../../relay-web/src/relay/route-ownership";
import type * as Handlers from "../share.server";

const require = createRequire(import.meta.url);

test("plugin sharing discovers real relays, remembers only admitted keys, and forgets legacy fallback", async () => {
  const config = mkdtempSync(path.join(os.tmpdir(), "rooms-share-flow-"));
  const previous = { ...process.env };
  const bodies: Array<Record<string, unknown>> = [];
  const privateKey = "private-admission-only-test-key";
  const adminToken = "local-admin-only-test-token";
  // Load the separate relay runtime without pulling its Node-only source graph
  // into the React Native plugin's TypeScript compilation.
  const relayModule = new URL(
    "../../relay-web/src/relay/relay.ts",
    import.meta.url,
  ).href;
  const { createRelay } = (await import(relayModule)) as {
    createRelay(options: {
      port: number;
      authMode: "open" | "key";
      relayKey?: string;
      log: (line: string) => void;
    }): Promise<{ port: number; close(): Promise<void> }>;
  };
  const relays: Awaited<ReturnType<typeof createRelay>>[] = [];
  const local = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${adminToken}`);
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as Record<string, unknown>;
    bodies.push(body);
    const route = createRouteOwnership();
    const ws = new WebSocket(`${body.relayOrigin}/host`, {
      headers:
        typeof body.relayKey === "string"
          ? { "x-relay-key": body.relayKey }
          : {},
    });
    try {
      await once(ws, "open");
      const ack = once(ws, "message");
      ws.send(
        JSON.stringify({
          v: 1,
          type: "register",
          tokens: [],
          routes: [{ ...route, protocol: 2 }],
        }),
      );
      const [message] = await ack;
      assert.equal(JSON.parse(String(message)).type, "registered");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          token: route.token,
          url: `https://client.example/r/${route.token}#invitation`,
        }),
      );
    } catch {
      res.writeHead(403);
      res.end();
    } finally {
      ws.close();
    }
  });
  try {
    for (const key of [
      "PASEO_ROOMS_RELAY_KEY",
      "RELAY_KEY",
      "PASEO_ROOMS_RELAY_URL",
      "RELAY_URL",
      "PASEO_ROOMS_PUBLIC_URL",
      "PUBLIC_BASE_URL",
    ])
      delete process.env[key];
    process.env.XDG_CONFIG_HOME = config;
    const open = await createRelay({
      port: 0,
      authMode: "open",
      log: () => {},
    });
    relays.push(open);
    const privateRelay = await createRelay({
      port: 0,
      authMode: "key",
      relayKey: privateKey,
      log: () => {},
    });
    relays.push(privateRelay);
    const openOrigin = `ws://127.0.0.1:${open.port}`;
    const privateOrigin = `ws://127.0.0.1:${privateRelay.port}`;
    local.listen(0, "127.0.0.1");
    await once(local, "listening");
    const address = local.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const output = await build({
      entryPoints: [path.resolve(import.meta.dirname, "../share.server.ts")],
      absWorkingDir: path.resolve(import.meta.dirname, "../../.."),
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      packages: "external",
      plugins: [
        {
          name: "managed-runtime-fixture",
          setup(build) {
            build.onResolve({ filter: /^\.\/runtime\.server$/ }, () => ({
              path: "managed-runtime-fixture",
              external: true,
            }));
          },
        },
      ],
    });
    const code = output.outputFiles[0]!.text;
    const load = (): typeof Handlers => {
      const module = { exports: {} };
      new Function("require", "module", "exports", code)(
        (name: string) => {
          if (name === "managed-runtime-fixture")
            return {
              configuredRelayOrigin: () => privateOrigin,
              ensureManagedRoomServer: async () => ({
                baseUrl,
                adminToken,
                started: false,
              }),
            };
          if (name === "@getpaseo/plugin") return pluginSdk;
          return require(name);
        },
        module,
        module.exports,
      );
      return module.exports as typeof Handlers;
    };
    let handlers = load();
    assert.equal((await handlers.relayStatus({})).hasSavedKey, false);
    await assert.rejects(
      handlers.shareSession({
        agentId: "agent",
        relayKey: "wrong-key",
        rememberKey: true,
      }),
      /room creation failed \(403\)/,
    );
    assert.equal(
      (await handlers.relayStatus({})).hasSavedKey,
      false,
      "failed admission cannot save a key",
    );
    const first = await handlers.shareSession({
      agentId: "agent",
      relayKey: privateKey,
      rememberKey: true,
    });
    handlers = load(); // New module and credential adapter, same persisted configuration.
    const status = await handlers.relayStatus({});
    assert.deepEqual(status, {
      relayOrigin: privateOrigin,
      registration: "key",
      hasSavedKey: true,
      keySource: "saved",
      rememberSupported: true,
    });
    const second = await handlers.shareSession({ agentId: "agent" });
    assert.equal(
      bodies.at(-1)?.relayKey,
      privateKey,
      "persisted credential admits another host connection",
    );
    assert.doesNotMatch(
      JSON.stringify([first, second, status]),
      new RegExp(`${privateKey}|${adminToken}|ownershipSecret`),
    );

    // A deliberately malformed store proves open mode does not even read it.
    const filename = path.join(config, "paseo-rooms", "relay-credentials.json");
    const saved = readFileSync(filename, "utf8");
    writeFileSync(filename, "not JSON and must not be read");
    assert.equal(
      (await handlers.relayStatus({ relayOrigin: openOrigin })).registration,
      "open",
    );
    await handlers.shareSession({
      agentId: "agent",
      relayOrigin: openOrigin,
      relayKey: privateKey,
      rememberKey: true,
    });
    assert.equal(
      Object.hasOwn(bodies.at(-1)!, "relayKey"),
      false,
      "even an explicitly supplied private key is omitted for an open relay",
    );
    assert.equal(
      readFileSync(filename, "utf8"),
      "not JSON and must not be read",
    );
    writeFileSync(filename, saved);

    writeFileSync(
      path.join(config, "paseo-rooms.env"),
      `RELAY_URL=${privateOrigin}/host\nRELAY_KEY=${privateKey}\n`,
    );
    await handlers.forgetRelayKey({ relayOrigin: privateOrigin });
    handlers = load();
    assert.equal((await handlers.relayStatus({})).keySource, "none");
    const requestCount = bodies.length;
    await assert.rejects(
      handlers.shareSession({ agentId: "agent" }),
      /requires a registration key/,
    );
    assert.equal(
      bodies.length,
      requestCount,
      "forgotten legacy key cannot reach a host admission request",
    );
  } finally {
    local.closeAllConnections();
    if (local.listening)
      await new Promise<void>((resolve) => local.close(() => resolve()));
    for (const relay of relays) await relay.close();
    for (const key of Object.keys(process.env))
      if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    rmSync(config, { recursive: true, force: true });
  }
});
