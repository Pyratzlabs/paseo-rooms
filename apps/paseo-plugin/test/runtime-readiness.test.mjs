import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import test from "node:test";
const require = createRequire(import.meta.url);

async function fixture() {
  const { outputFiles } = await build({
    stdin: {
      contents:
        'export * from "./runtime.server.ts"; export { ready, rejectReady, closed } from "../relay-web/src/paseo.js";',
      resolveDir: new URL("../", import.meta.url).pathname,
      loader: "ts",
    },
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    plugins: [
      {
        name: "delayed-daemon",
        setup(builder) {
          builder.onResolve(
            { filter: /relay-web\/src\/(server|paseo)\.js$/ },
            ({ path }) => ({
              path: path.endsWith("paseo.js") ? "paseo.js" : "server.js",
              namespace: "fixture",
            }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "fixture" },
            ({ path }) => ({
              contents: path.endsWith("paseo.js")
                ? `
          export let ready, rejectReady;
          const connected = new Promise((resolve, reject) => { ready = resolve; rejectReady = reject; });
          export const ensureConnected = () => connected;
          export const closed = [];
        `
                : `
          import { closed } from "../relay-web/src/paseo.js";
          export const startLocalRoomServer = async () => ({ baseUrl: "http://127.0.0.1:3000", adminToken: "test", close: async () => { closed.push(true); } });
        `,
              loader: "js",
            }),
          );
        },
      },
    ],
  });
  const module = { exports: {} };
  new Function("require", "module", "exports", outputFiles[0].text)(
    require,
    module,
    module.exports,
  );
  return module.exports;
}

test("managed startup waits for daemon readiness before returning the server", async () => {
  const runtime = await fixture();
  let returned = false;
  const startup = runtime.ensureManagedRoomServer().then((server) => {
    returned = true;
    return server;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  runtime.ready();
  const server = await startup;
  assert.equal(server.started, true);
  await runtime.closeManagedRoomServer();
  assert.equal(runtime.closed.length, 1);
});

test("failed daemon startup closes the listener and clears managed state", async () => {
  const runtime = await fixture();
  const startup = runtime.ensureManagedRoomServer();
  runtime.rejectReady(new Error("authentication failed"));
  await assert.rejects(startup, /authentication failed/);
  assert.equal(runtime.closed.length, 1);
  await runtime.closeManagedRoomServer();
  assert.equal(runtime.closed.length, 1);
});

test("daemon readiness timeout closes the listener instead of hanging sharing", async (context) => {
  const runtime = await fixture();
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const startup = runtime.ensureManagedRoomServer();
  const rejection = assert.rejects(startup, /daemon connection timed out/);
  await new Promise((resolve) => setImmediate(resolve));
  context.mock.timers.tick(10_000);
  await rejection;
  assert.equal(runtime.closed.length, 1);
  await runtime.closeManagedRoomServer();
  assert.equal(runtime.closed.length, 1);
});
