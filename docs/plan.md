# paseo-rooms — implementation plan (relay + plugin)

**Historical plan:** this describes the original private, key-protected v1
relay. For current setup, see [Run your own relay](how-to/run-your-own-relay.md)
and [public/private registration](design/relay-host-enrollment.md). Open
relays accept protected v2 routes without a registration key; private relays
still require their operator's key. The v1 key requirements below describe
the legacy protocol, not a prerequisite for using the hosted public relay.

Target architecture (decided; do not re-litigate in slices):

```
Collaborator browser ── https://rooms.<domain>/r/<token>
                            │
                  VPS PUBLIC RELAY (landing + React UI + token routing)
                            ▲  single outbound WS per laptop ("host connection")
                            │
Dev laptop: ROOM SERVER (this repo, exists) ── localhost Paseo daemon ── agent
Dev laptop: PASEO PLUGIN "Share session" (starts room server, mints link)
```

Invariants that every slice must preserve:
- The daemon connection, admin token, and `token -> agentId` mapping live ONLY
  on the laptop. The relay never sees daemon credentials or agent ids.
- Browsers authenticate with the room token only; server-side resolution only.
- Paseo owns the conversation; no conversation storage outside Paseo.

Current state (all working, committed, 18/18 e2e green against a live daemon):
- `src/server.ts` room server (HTTP + WS fan-out), `src/paseo.ts` SDK wrapper,
  `src/rooms.ts` token store, `public/` chat UI, `scripts/share.ts` mint CLI,
  `scripts/e2e.ts` integration test. See `docs/design.md`.

---

## Relay protocol v1 (normative for slices 2 & 3)

Transport: one WebSocket from each laptop room server to the relay at
`wss://<relay>/host`, authenticated with header `x-relay-key: <RELAY_KEY>`
(shared secret from env on both sides; 401 close otherwise). JSON text frames.
Binary payloads are base64 inside JSON (fine at chat scale).

Laptop -> relay:
- `{v:1, type:"register", tokens:[string]}` — claim room tokens (idempotent,
  also sent in full on reconnect). Relay maps `token -> this connection`.
  If a token is already claimed by ANOTHER live connection, relay replies
  `{type:"register_rejected", token}` and does not remap.
- `{v:1, type:"unregister", tokens:[string]}`
- `{v:1, type:"http_response", id, status, headers:{[k]:v}, bodyB64}`
- `{v:1, type:"ws_event", id, event:"message"|"close", dataB64?}`
- `{v:1, type:"pong", t}`

Relay -> laptop:
- `{v:1, type:"http_request", id, method, path, headers:{[k]:v}, bodyB64}`
  (headers forwarded: content-type, x-forwarded-for only)
- `{v:1, type:"ws_event", id, event:"open"|"message"|"close", path?, dataB64?}`
- `{v:1, type:"ping", t}` every 30s; drop connection after 2 missed pongs.

Relay public routing (browser side):
- `GET /` serves the landing page. `GET /assets/*` and `/landing/*` serve
  public, immutable presentation assets that contain no room data or secrets.
- `GET /r/:token` serves the public room shell only when the token has a live
  laptop owner. Unknown/unmapped token -> 404.
- `ANY /api/rooms/:token(/...)$` and the WS upgrade
  `/api/rooms/:token/ws` are forwarded to the owner laptop.
- HTTP: forward dynamic room calls as `http_request`, await matching `http_response` (30s timeout
  -> 504). WS: forward frames both ways via `ws_event` with a fresh `id` per
  browser socket; laptop treats `open` like a new local room socket.
- Body size cap 256 KB, same as room server. No room creation via relay:
  `POST /api/rooms` (no token in path) is NOT routable — admin stays local.

Laptop room server dial-out mode (opt-in): env `RELAY_URL`, `RELAY_KEY`.
On boot and on room create/revoke, (re)register all tokens. Reconnect with
backoff (1s..30s, jitter) forever. Local HTTP listener keeps working as today.

---

## Slices

Each slice: files it may touch, acceptance criteria, and a self-contained
delegation prompt. Verification is run by the orchestrator (typecheck + e2e
against the live daemon + manual smoke).

### Slice 1 — harden the room server  [model: Sonnet]

Touch: `src/server.ts`, `src/rooms.ts`, `src/paseo.ts`, `scripts/share.ts`,
`public/room.html` (+ delete `public/room.js`), `scripts/e2e.ts` (extend only).
Do NOT create anything under `src/relay/` or touch `docs/`.

1. Inline `public/room.js` into a `<script>` in `room.html`; remove the
   `/room.js` route. The page must be a single self-contained file.
2. Boot resilience: if the daemon is unreachable at startup, retry with
   backoff instead of exiting; serve `503 {"error":"daemon unavailable"}` from
   API routes meanwhile. Add `GET /healthz` -> `{ok, daemonConnected}`.
3. Rate limit `POST /api/rooms/:token/messages`: max 10/min per token
   (in-memory sliding window) -> 429.
4. Revocation: `deleteRoom(token)` in rooms.ts; `npm run share -- --list` and
   `npm run share -- --revoke <token>` (talk to new admin endpoints
   `GET /api/rooms` and `DELETE /api/rooms/:token`, both requiring the admin
   bearer). Revoking closes that room's live sockets.
5. WS upgrade: reject if an Origin header is present and not same-host as
   BASE_URL (no Origin = non-browser client = allow).
6. Extend `scripts/e2e.ts`: healthz check, rate-limit check (11th message
   429s), revoke check (404 + socket closed after revoke).

Acceptance: `npm run typecheck` clean; `npm run e2e` fully green.

### Slice 2 — relay server  [model: Opus]

Touch: NEW files only: `src/relay/relay.ts` (entry), `src/relay/*.ts`,
`scripts/relay-protocol.test.ts` (or vitest if added — prefer `node:test`, no
new deps beyond what exists: `ws`). Do NOT modify any existing file except
adding `"relay": "tsx src/relay/relay.ts"` to package.json scripts.

Implement the relay per "Relay protocol v1" above. Env: `RELAY_PORT` (default
8080), `RELAY_KEY` (required). In-memory routing only (tokens re-register on
laptop reconnect; relay restart just drops routes until laptops reconnect).
Log one line per host connect/disconnect and per rejected register.
Include a protocol unit test using two in-process ws clients (one fake laptop,
one fake browser) covering: register + http round-trip, ws relay both
directions, unknown token 404, bad relay key rejected, laptop disconnect
-> 404 + browser sockets closed, register_rejected on double claim.

Acceptance: `npm run typecheck` clean; protocol test passes via
`node --import tsx --test scripts/relay-protocol.test.ts`.

### Slice 3 — room server dial-out + full-path e2e  [model: Opus]

Depends on slices 1+2. Touch: `src/relay-client.ts` (new), small wiring edits
in `src/server.ts`/`src/rooms.ts`, `scripts/e2e-relay.ts` (new), package.json
script `e2e:relay`.

Implement laptop dial-out per protocol v1: when `RELAY_URL` is set, maintain
the host connection (reconnect w/ backoff), register tokens on connect and on
create/revoke, and serve forwarded `http_request`/`ws_event` by dispatching
into the same handlers as local traffic (refactor handlers to be callable with
a plain {method, path, headers, body} shape rather than only http.IncomingMessage).
`scripts/e2e-relay.ts`: start relay on a random port in-process, run the same
scenario as `scripts/e2e.ts` but with ALL collaborator traffic going through
the relay's public port; plus: kill/restart the relay mid-test and assert the
laptop re-registers and traffic recovers.

Acceptance: typecheck clean; `npm run e2e` AND `npm run e2e:relay` green.

### Slice 4 — deploy assets  [model: Sonnet]

Touch: NEW files only: `deploy/Dockerfile.relay`, `deploy/compose.yml` (relay
+ Caddy with auto-TLS for `rooms.<domain>`), `deploy/deploy.sh` (rsync/ssh +
docker compose up -d), `deploy/README.md`, `.github/workflows/deploy.yml`
(on push to main: ssh deploy; secrets documented, workflow must be skippable
when secrets are absent), systemd unit example for the laptop room server.

Acceptance: `docker build -f deploy/Dockerfile.relay .` succeeds locally;
compose config validates (`docker compose -f deploy/compose.yml config`).

### Slice 5 — Paseo plugin "Share session"  [model: Opus]

New sibling directory `~/code/paseo-rooms-plugin` scaffolded with
`paseo plugin init`. Contribution: agent-context Command Center item
"Share session". Backend handler: ensure local room server is running (spawn
`npm start` in the paseo-rooms checkout if `/healthz` not answering), read
`data/admin-token`, POST `/api/rooms` with the focused `agentId`, return the
URL; UI shows it with a copy button (a minimal surface or just a toast —
whatever the scaffold makes easiest). Config (paseo-rooms path, BASE_URL) via
a small JSON config file next to the plugin.
This slice has real unknowns (scaffold realities vs docs) — the agent should
read the scaffold output and `paseo plugin` help, and report back what the API
actually allows rather than forcing the design.

Acceptance: `paseo plugin install` + reload succeeds; clicking the item on a
real agent yields a working share URL (orchestrator verifies manually).

---

## Orchestration notes

- Slices 1 and 2 are independent (disjoint files) — run in parallel.
- Slice 3 needs both merged. Slice 4 anytime after 2. Slice 5 anytime after 1.
- Verifier (orchestrator) runs after each slice: typecheck, e2e suites against
  the live daemon, plus a headless-Chromium screenshot of a real room page.
- Commit per slice with a short message; do not let subagents rewrite docs/.
