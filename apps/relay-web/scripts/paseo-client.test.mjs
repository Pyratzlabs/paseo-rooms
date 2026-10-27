import assert from "node:assert/strict";
import { build } from "esbuild";
import test from "node:test";

// Exercise the adapter with a public SDK handle. Any attempt to create a
// separate internal permission client fails instead of hiding behind a mock.
const bundle = await build({
  stdin: {
    contents:
      'export * from "./paseo.ts"; export { calls, clearPending, instances, deferConnection, dispatchBehavior } from "@getpaseo/client";',
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
          let deferredSend = false, deferredClose = false;
          export function dispatchBehavior({ connect = false, send = false, close = false } = {}) { deferred = connect; deferredSend = send; deferredClose = close; }
          export function deferConnection() { deferred = true; }
          export let pending = [{ id: "question", kind: "question", title: "Choose", actions: [{ id: "yes", label: "Yes", behavior: "allow" }] }];
          export function createPaseoClient(config) {
            calls.push("create");
            // SDK close stops transport retries without settling connect().
            let releaseConnection, accept;
            const connection = deferred ? new Promise(resolve => { releaseConnection = resolve; }) : Promise.resolve();
            const delivery = deferredSend ? new Promise(resolve => { accept = resolve; }) : Promise.resolve();
            const stallClose = deferredClose;
            const instance = { config, sendCount: 0, releaseConnection: () => releaseConnection?.(), accept: () => accept?.(), closed: false, connect: () => connection, close: async () => {
              if (instance.closed) return;
              instance.closed = true;
              calls.push("close");
              if (stallClose) await new Promise(() => {});
            }, agents: { ref: () => ({
              refresh: async () => ({ agent: { pendingPermissions: pending } }),
              send: async (text, options) => { instance.sendCount++; calls.push({ text, options }); await delivery; },
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

test("abortable sends own a private client and preserve the shared room connection", async () => {
  await adapter.getAgentHandle("agent");
  const shared = adapter.instances.at(-1);
  const controller = new AbortController();
  const options = {
    messageId: "private-dispatch",
    images: [{ data: "AQID", mimeType: "image/png" }],
  };
  try {
    await adapter.sendToAgent("agent", "caption", options, controller.signal);
    const isolated = adapter.instances.at(-1);
    assert.notEqual(isolated, shared);
    assert.equal(isolated.config.url, shared.config.url);
    assert.equal(isolated.config.password, shared.config.password);
    assert.equal(isolated.config.reconnect.enabled, false);
    assert.equal(isolated.sendCount, 1);
    assert.equal(isolated.closed, true);
    assert.equal(shared.closed, false);
    assert.deepEqual(
      adapter.calls
        .filter((value) => value?.options?.messageId === options.messageId)
        .at(-1),
      { text: "caption", options },
    );
  } finally {
    await adapter.closePaseoConnections();
  }
});

test("aborting a stalled private connection settles even if SDK close stalls and late connect never dispatches", async () => {
  adapter.dispatchBehavior({ connect: true, close: true });
  const controller = new AbortController();
  try {
    const sending = adapter.sendToAgent(
      "agent",
      "must not send",
      { messageId: "late-connect" },
      controller.signal,
    );
    const rejected = assert.rejects(sending, /message_send_aborted/);
    const isolated = adapter.instances.at(-1);
    controller.abort();
    await rejected;
    assert.equal(isolated.closed, true);
    isolated.releaseConnection();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(isolated.sendCount, 0);
    const count = adapter.instances.length;
    await assert.rejects(
      adapter.sendToAgent(
        "agent",
        "never connect",
        undefined,
        AbortSignal.abort(),
      ),
      /message_send_aborted/,
    );
    assert.equal(adapter.instances.length, count);
  } finally {
    adapter.dispatchBehavior();
    await adapter.closePaseoConnections();
  }
});

test("abort and managed shutdown cancel pending private SDK sends without waiting for their responses", async () => {
  adapter.dispatchBehavior({ send: true, close: true });
  try {
    for (const managed of [false, true]) {
      const controller = new AbortController();
      const sending = adapter.sendToAgent(
        "agent",
        "pending",
        { messageId: "pending" },
        controller.signal,
      );
      const rejected = assert.rejects(sending, /message_send_aborted/);
      await new Promise((resolve) => setImmediate(resolve));
      const isolated = adapter.instances.at(-1);
      assert.equal(isolated.sendCount, 1);
      if (managed) await adapter.closePaseoConnections();
      else controller.abort();
      await rejected;
      assert.equal(isolated.closed, true);
      isolated.accept();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(isolated.sendCount, 1);
    }
  } finally {
    adapter.dispatchBehavior();
    await adapter.closePaseoConnections();
  }
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
