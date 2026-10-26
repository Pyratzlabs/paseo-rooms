import assert from "node:assert/strict";
import { build } from "esbuild";
import test from "node:test";

// Exercise the adapter with a public SDK handle. Any attempt to create a
// separate internal permission client fails instead of hiding behind a mock.
const bundle = await build({
  stdin: {
    contents:
      'export * from "./paseo.ts"; export { calls, clearPending, instances, deferConnection } from "@getpaseo/client";',
    resolveDir: new URL("../src/", import.meta.url).pathname,
    loader: "ts",
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  plugins: [
    {
      name: "public-paseo-client",
      setup(builder) {
        builder.onResolve({ filter: /^@getpaseo\/client/ }, ({ path }) => ({
          path,
          namespace: "sdk",
        }));
        builder.onLoad({ filter: /.*/, namespace: "sdk" }, ({ path }) => ({
          contents:
            path === "@getpaseo/client"
              ? `
          export const calls = [];
          export const instances = [];
          let deferred = false;
          export function deferConnection() { deferred = true; }
          export let pending = [{ id: "question", kind: "question", title: "Choose", actions: [{ id: "yes", label: "Yes", behavior: "allow" }] }];
          export function createPaseoClient() {
            calls.push("create");
            // SDK close stops transport retries without settling connect().
            const connection = deferred ? new Promise(() => {}) : Promise.resolve();
            const instance = { closed: false, connect: () => connection, close: async () => {
              if (instance.closed) return;
              instance.closed = true;
              calls.push("close");
            }, agents: { ref: () => ({
              refresh: async () => ({ agent: { pendingPermissions: pending } }),
              send: async (text, options) => { calls.push({ text, options }); },
              respondToPermission: async (options) => { calls.push(options); }
            }) } };
            instances.push(instance);
            return instance;
          }
          export function clearPending() { pending = []; }
        `
              : `export class DaemonClient { constructor() { throw new Error("Internal permission client must not be used"); } }`,
          loader: "js",
        }));
      },
    },
  ],
});
// The SDK fixture exports are deliberately accessed through the bundled module.
const source = bundle.outputFiles[0].text;
const adapter = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

test("answers questions through the public agent handle and reuses its connection", async () => {
  assert.equal(
    await adapter.answerRoomQuestion("agent", "question", { actionId: "yes" }),
    true,
  );
  assert.deepEqual(adapter.calls, [
    "create",
    {
      requestId: "question",
      response: { behavior: "allow", selectedActionId: "yes" },
    },
  ]);
  assert.equal(
    await adapter.answerRoomQuestion("agent", "question", {
      actionId: "invalid",
    }),
    false,
  );
  adapter.clearPending();
  assert.equal(
    await adapter.answerRoomQuestion("agent", "question", { actionId: "yes" }),
    false,
  );
  assert.equal(
    adapter.calls.length,
    2,
    "invalid or stale answers never reach the daemon",
  );
  await adapter.closePaseoConnections();
  assert.equal(adapter.calls.at(-1), "close");
});

test("forwards original image bytes and a supplied message ID through the public SDK handle", async () => {
  const options = {
    messageId: "room-message-id",
    images: [{ data: "AQID", mimeType: "image/png" }],
  };
  await adapter.sendToAgent("agent", "[Alice]\ncaption", options);
  assert.deepEqual(adapter.calls.at(-1), { text: "[Alice]\ncaption", options });
  await adapter.closePaseoConnections();
});

test("shutdown closes pending SDK connections and cancels retries", async () => {
  adapter.deferConnection();
  for (let attempt = 0; attempt < 2; attempt++) {
    const connecting = adapter.ensureConnected();
    const rejected = assert.rejects(
      connecting,
      /closed during connection|daemon connection stopped/,
    );
    const instance = adapter.instances.at(-1);
    assert.equal(instance.closed, false);
    await adapter.closePaseoConnections();
    assert.equal(
      instance.closed,
      true,
      "the in-flight SDK client must be closed",
    );
    await rejected;
  }
  assert.equal(
    adapter.instances.every((instance) => instance.closed),
    true,
  );
});
