# paseo-rooms

Proof of concept: **share one Paseo coding-agent session with a collaborator via
a capability URL**, without giving them access to your Paseo daemon.

Two humans open the same `http://localhost:3000/r/<token>` link in separate
browsers, both see the agent's full conversation, both can send messages to the
same running agent, and replies stream live to everyone. The link grants access
to exactly one agent — nothing else on the daemon.

This monorepo keeps the deployed relay/web application and the companion Paseo
desktop plugin versioned and verified together:

- [`apps/relay-web`](apps/relay-web) — local room server, public relay, and
  browser UI. The VPS owns the landing page and browser bundle; laptops retain
  the live, room-specific Paseo authority.
- [`apps/paseo-plugin`](apps/paseo-plugin) — the desktop **Share session**
  extension that starts the local room server and manages its share links.

See [docs/design.md](docs/design.md) for the architecture, the Paseo APIs used,
plugin-system findings, and the security model.

## Prerequisites

- A running Paseo daemon (desktop app or `paseo` CLI) on
  `ws://127.0.0.1:6767/ws` (override with `PASEO_URL`, and `PASEO_PASSWORD` if
  your daemon requires it).
- Node.js ≥ 20.12.

## Run the demo

```bash
npm install
npm start                       # room server on http://localhost:3000
```

In a second terminal, pick an agent and mint a share link:

```bash
npm run share                   # lists your recent agents
npm run share -- <agent-id>     # id prefix is enough; prints the share URL
```

Then:

1. Open the printed `http://localhost:3000/r/<token>` in your browser.
2. Open the same URL in an incognito window (your "collaborator").
3. Both windows show the agent's existing history; enter different names and
   chat — messages are attributed as `[Name]` and go to the same Paseo agent,
   and replies stream to both windows. Reloading restores history from Paseo.

## Web frontend

The shared room is a React + TypeScript client built with Vite from
`apps/relay-web/web/`.
`npm start` builds it before starting the room server; use `npm run dev:web`
for frontend-only development and `npm run build:web` for a production build.
Vite's hashed assets are served by the public relay as `/assets/...`. They
contain UI code only; conversation data and actions remain capability-scoped at
`/api/rooms/<token>/...` and the room WebSocket. The generated
`apps/relay-web/public/room.html` is a build artifact; edit
`apps/relay-web/web/`.

## Test

With the daemon and the room server running:

```bash
npm run e2e
```

This creates a throwaway agent (Haiku by default, `E2E_PROVIDER`/`E2E_CWD` to
override), shares it, simulates two browsers over the public API/WebSocket, and
asserts the full PoC contract: history on join, live fan-out both ways, both
messages landing on the same agent timeline, reload-restores-history, invalid
tokens rejected, client-supplied `agent_id` ignored, agent id never exposed.
The agent is archived afterwards. `npm run typecheck` type-checks the code.

## State

- `data/rooms.json` — `share_token -> agent` mappings (the only state this
  service owns; the conversation lives in Paseo).
- `data/admin-token` — bearer token required to create rooms; the `share`
  script reads it locally. Collaborators never need it.

## Plugin

The Paseo plugin that adds a **Share session** action to the agent context
lives in [`apps/paseo-plugin`](apps/paseo-plugin). It boots the local room
server if it is not running, then mints a share URL for the focused agent.

For development, install the plugin from this checkout root:

```bash
paseo plugin install "$PWD"
paseo plugin reload paseo-rooms
```

Paseo 0.8.x is required: the plugin declares its supported version range and builds
separate client/server bundles from the monorepo sources. Check the command that will install the
plugin—not merely an older shell alias—with:

```bash
paseo --version
```

Paseo prepares, validates, and compiles the checkout before activation. The
plugin then runs the matching local room runtime in its own process; no
checkout-path setting, detached process, or systemd unit is required. The
first visit to **Share session** starts the loopback listener; plugin reload,
disable, update, and daemon shutdown stop it. A Git-hosted release channel and
package-management flow are planned, but are not the supported installation
path yet.
