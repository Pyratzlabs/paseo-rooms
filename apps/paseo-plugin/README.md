# Paseo Rooms plugin

A Paseo plugin that adds a **Share session** action to the agent context. It
mints a public room URL for the focused agent using the local
[paseo-rooms](../paseo-rooms) room server.

## What it does

Backend handler (`share.server.ts`, server bundle only):

1. `GET <baseUrl>/healthz` — if the room server is not answering, spawn
   `npm start` in the paseo-rooms checkout, detached, and poll until healthy.
2. Read the admin token from `<roomsPath>/data/admin-token`.
3. `POST <baseUrl>/api/rooms` with `{ agentId, label }` and `Authorization:
Bearer <admin token>`.
4. Return `{ url, token, startedServer }`.

Client surface (`main.client.tsx`, client bundle only): an agent panel with a
button that calls the RPC and renders the resulting URL as selectable text.
The command center item "Share session" (agent context) opens that panel.

Only the resulting room URL crosses to the client. Paseo's plugin compiler
splits the entry point by target, so the admin token path, the `Bearer` header
and `node:child_process` are physically absent from the client bundle (verified
by compiling with `@getpaseo/server`'s `compilePlugin` and grepping both
bundles).

## Configuration

`paseo-rooms.config.json`:

| key                          | default                                        | meaning                         |
| ---------------------------- | ---------------------------------------------- | ------------------------------- |
| `roomsPath`                  | `/home/thomas/code/paseo-rooms/apps/relay-web` | room-server workspace           |
| `baseUrl`                    | `http://localhost:3000`                        | room server base URL            |
| `startCommand` / `startArgs` | `npm` / `["start"]`                            | how to boot the server          |
| `startTimeoutMs`             | `45000`                                        | how long to wait for `/healthz` |

**Caveat:** a Paseo plugin cannot locate its own directory at runtime. The
server half is bundled to CommonJS inside a wrapper function (no `__dirname`,
no `import.meta.url`) and the plugin subprocess is forked with no `cwd` and no
env var naming the plugin directory. So the config path is resolved from
absolute candidates, in order:

1. `$PASEO_ROOMS_CONFIG`
2. `$PASEO_ROOMS_PLUGIN_DIR/paseo-rooms.config.json`, defaulting to the
   `PLUGIN_DIR` constant at the top of `share.server.ts`
3. `~/.config/paseo-rooms/plugin.json`

If you clone this elsewhere, set `PASEO_ROOMS_PLUGIN_DIR` for the daemon or
edit that constant.

## Install

`paseo plugin` is unreleased — it is not in the published `@getpaseo/cli`
0.4.0. Run it from a checkout of the Paseo monorepo:

```sh
git clone --depth 1 https://github.com/getpaseo/paseo /tmp/paseo
cd /tmp/paseo && npm install --ignore-scripts && npm run build:server
node packages/cli/dist/index.js plugin install /home/thomas/code/paseo-rooms/apps/paseo-plugin
node packages/cli/dist/index.js plugin ls
```

This requires a daemon that advertises the `pluginManagement` feature in its
`server_info`. As of desktop app v0.17.1 (server 0.4.0) it advertises **no**
`plugin*` features at all, and the CLI refuses with
`Update the host to use plugin management.` Upgrade the daemon to a build with
plugin support before installing.

## Develop

```sh
npm install
npm run typecheck
```
