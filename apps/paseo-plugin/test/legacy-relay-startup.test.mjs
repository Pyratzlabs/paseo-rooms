import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { createRelay } from "../../relay-web/src/relay/relay.ts";
import { RelayCredentialStore } from "../relay-credentials.server.ts";
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../../../", import.meta.url));

async function waitFor(check) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("startup condition did not settle");
}

test("plugin startup restores persisted legacy links from saved or dotenv keys without caching them in env", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "rooms-legacy-startup-"),
  );
  const previous = { ...process.env };
  const relay = await createRelay({
    port: 0,
    relayKey: "startup-test-key",
    log: () => {},
  });
  const origin = `ws://127.0.0.1:${relay.port}`;
  const config = path.join(directory, "config");
  const data = path.join(directory, "data");
  let runtime;
  let active;
  const oldError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args.join(" "));
  try {
    await mkdir(config);
    await mkdir(data);
    await writeFile(
      path.join(data, "rooms.json"),
      JSON.stringify([
        {
          token: "persisted-test-link",
          agentId: "fixture",
          label: "Legacy",
          createdAt: new Date().toISOString(),
          protocol: 1,
        },
      ]),
    );
    const probe = createServer();
    probe.listen(0, "127.0.0.1");
    await once(probe, "listening");
    const port = probe.address().port;
    await new Promise((r) => probe.close(r));
    for (const name of [
      "RELAY_KEY",
      "PASEO_ROOMS_RELAY_KEY",
      "PUBLIC_BASE_URL",
      "RELAY_URL",
      "RELAY_MODE",
    ])
      delete process.env[name];
    Object.assign(process.env, {
      PASEO_ROOMS_PORT: String(port),
      PASEO_ROOMS_RELAY_URL: `${origin}/host`,
      XDG_CONFIG_HOME: config,
      DATA_DIR: data,
      PASEO_ROOMS_PUBLIC_DIR: path.join(root, "apps/relay-web/public"),
    });
    const built = await build({
      entryPoints: [path.join(root, "apps/paseo-plugin/runtime.server.ts")],
      bundle: true,
      write: false,
      platform: "node",
      format: "cjs",
      packages: "external",
      plugins: [
        {
          name: "daemon-fixture",
          setup(b) {
            b.onResolve({ filter: /\/paseo\.js$/ }, () => ({
              path: "paseo",
              namespace: "fixture",
            }));
            b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
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
    runtime = module.exports;
    const store = new RelayCredentialStore({ configHome: config, env: {} });
    const roomStatus = async () =>
      (await fetch(`http://127.0.0.1:${relay.port}/r/persisted-test-link`))
        .status;
    for (const source of ["legacy", "saved"]) {
      if (source === "legacy")
        await writeFile(
          path.join(config, "paseo-rooms.env"),
          `RELAY_URL=${origin}/host\nRELAY_KEY=startup-test-key\n`,
        );
      else {
        store.save(origin, "startup-test-key");
        // Simulate the pre-discovery private relay with explicit compatibility mode.
        const original = relay.server.listeners("request");
        relay.server.removeAllListeners("request");
        relay.server.on("request", (req, res) => {
          if (req.url === "/.well-known/paseo-rooms") {
            res.writeHead(404);
            res.end();
          } else
            for (const listener of original)
              listener.call(relay.server, req, res);
        });
        process.env.RELAY_MODE = "legacy-key";
      }
      active = await runtime.ensureManagedRoomServer();
      await waitFor(async () => (await roomStatus()) === 200);
      assert.equal(
        process.env.RELAY_KEY,
        undefined,
        "resolved saved key must not be cached in environment",
      );
      await runtime.closeManagedRoomServer();
      active = null;
      await waitFor(async () => (await roomStatus()) === 404);
    }
    store.forget(origin);
    active = await runtime.ensureManagedRoomServer();
    await waitFor(() =>
      errors.some((e) =>
        e.includes("Unable to restore legacy relay registration"),
      ),
    );
    assert.equal(
      await roomStatus(),
      404,
      "forgotten key must not restore from stale environment or dotenv",
    );
    assert.equal(process.env.RELAY_KEY, undefined);
  } finally {
    if (active) await runtime.closeManagedRoomServer();
    console.error = oldError;
    await relay.close();
    for (const name of Object.keys(process.env))
      if (!(name in previous)) delete process.env[name];
    Object.assign(process.env, previous);
    await rm(directory, { recursive: true, force: true });
  }
});
