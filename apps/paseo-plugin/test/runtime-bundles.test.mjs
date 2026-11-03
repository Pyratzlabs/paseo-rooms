import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { transform } from "esbuild";
import * as pluginSdk from "@getpaseo/plugin";
import { buildPlugin } from "../build.mjs";

const require = createRequire(import.meta.url);

test("runtime bundles activate independently and keep room authority server-side", async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), "rooms-plugin-"));
  try {
    await buildPlugin(output);
    const client = await readFile(
      path.join(output, "client/plugin.js"),
      "utf8",
    );
    const server = await readFile(
      path.join(output, "server/plugin.js"),
      "utf8",
    );
    assert.doesNotMatch(
      client,
      /node:|adminToken|startLocalRoomServer|PASEO_PASSWORD/,
    );
    assert.doesNotMatch(server, /react-native|SharePanel/);

    async function activate(source, context, overrides = {}) {
      const { code } = await transform(source, {
        format: "cjs",
        target: "node20",
      });
      const module = { exports: {} };
      const hostRequire = (name) => {
        if (Object.hasOwn(overrides, name)) return overrides[name];
        if (name === "@getpaseo/plugin") return pluginSdk;
        if (name === "react-native") return {};
        if (name === "@getpaseo/plugin/client") return {};
        return require(name);
      };
      new Function("require", "module", "exports", code)(
        hostRequire,
        module,
        module.exports,
      );
      return module.exports.default(context);
    }

    const panels = [];
    const commands = [];
    const clientCleanup = await activate(client, {
      addAgentPanel: (panel) => panels.push(panel),
      addCommandCenterItem: (command) => commands.push(command),
    });
    assert.equal(
      typeof clientCleanup,
      "function",
      "Paseo requires a client cleanup function before accepting any contributions",
    );
    assert.equal(panels[0].id, "share-session");
    assert.equal(typeof panels[0].Component, "function");
    let opened;
    commands[0].onSelect({
      openPanel: (id) => {
        opened = id;
      },
    });
    assert.equal(opened, "share-session");
    await clientCleanup();

    // Render the actual panel with host hooks, including a saved empty relay.
    const previousStorage = Object.getOwnPropertyDescriptor(
      globalThis,
      "localStorage",
    );
    try {
      for (const [relay, registration, saved, keyVisible, disabled] of [
        ["", "open", false, false, false],
        ["   ", "open", false, false, false],
        ["wss://paseo-rooms.pyratz.com", "key", true, false, false],
        ["wss://custom.example.com", "key", false, true, true],
        ["wss://custom.example.com", "open", false, false, false],
        ["wss://custom.example.com", "key", true, false, false],
        ["not a URL", null, false, false, true],
        ["wss://unavailable.example.com", null, false, false, true],
      ]) {
        Object.defineProperty(globalThis, "localStorage", {
          configurable: true,
          value: {
            getItem: (key) =>
              key === "paseo-rooms.relay-origin" ? relay : null,
          },
        });
        let Panel;
        await activate(
          client,
          {
            addAgentPanel: (panel) => {
              Panel = panel.Component;
            },
            addCommandCenterItem: () => {},
          },
          {
            react: {
              ...require("react"),
              useState: (initial) => [
                typeof initial === "function" ? initial() : initial,
                () => {},
              ],
              useMemo: (fn) => fn(),
              useCallback: (fn) => fn,
            },
            "react-native": {
              View: "View",
              ScrollView: "ScrollView",
              Text: "Text",
              TextInput: "TextInput",
              Pressable: "Pressable",
            },
            "@getpaseo/plugin/client": {
              useAgent: () => ({ title: "Smoke test" }),
              useRpc: () => async () => ({}),
            },
            "@tanstack/react-query": {
              useQuery: ({ queryKey }) =>
                queryKey[0] === "relay-status"
                  ? {
                      data: registration
                        ? {
                            registration,
                            hasSavedKey: saved,
                            rememberSupported: true,
                            relayOrigin: relay,
                            keySource: saved ? "saved" : "none",
                          }
                        : undefined,
                    }
                  : { data: { rooms: [] }, isSuccess: true },
              useMutation: () => ({}),
              useQueryClient: () => ({}),
            },
          },
        );
        const tree = Panel({
          params: { agentId: "test-agent" },
          theme: {
            colors: {
              surface0: "white",
              foreground: "black",
              foregroundMuted: "gray",
              accent: "green",
              accentForeground: "white",
              statusDanger: "red",
            },
          },
        });
        const nodes = [];
        function visit(node) {
          if (Array.isArray(node)) return node.forEach(visit);
          if (!node || typeof node !== "object") return;
          nodes.push(node);
          visit(node.props?.children);
        }
        visit(tree);
        assert.equal(
          nodes.some(
            (node) =>
              node.props?.accessibilityLabel === "Relay registration key",
          ),
          keyVisible,
          `key visibility for ${JSON.stringify(relay)}`,
        );
        const button = nodes.find(
          (node) =>
            node.props?.accessibilityLabel ===
            "Create a share link for this agent",
        );
        assert.equal(
          Boolean(button.props.disabled),
          disabled,
          `share enabled for ${JSON.stringify(relay)}`,
        );
      }
    } finally {
      if (previousStorage)
        Object.defineProperty(globalThis, "localStorage", previousStorage);
      else delete globalThis.localStorage;
    }

    const handlers = new Map();
    const cleanup = await activate(server, {
      handle: (contract, handler) => handlers.set(contract.name, handler),
    });
    assert.deepEqual(
      [...handlers.keys()].sort(),
      [
        "share-session",
        "list-share-sessions",
        "revoke-share-session",
        "relay-status",
        "forget-relay-key",
      ].sort(),
    );
    assert.equal(typeof cleanup, "function");
    await cleanup();
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
