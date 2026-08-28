# Paseo Rooms — design note

Goal: let two humans, in separate browsers, share the history and conversational
control of one existing Paseo coding-agent session **without** sharing access to
the whole Paseo daemon.

## Paseo APIs used

Everything is built on the official TypeScript SDK, **`@getpaseo/client`**
(v0.4.0, same protocol the Paseo apps use), talking to the local daemon at
`ws://127.0.0.1:6767/ws`:

| Need | SDK call |
| --- | --- |
| Attach to an existing agent | `client.agents.ref(agentId)` |
| List agents (room creation) | `client.agents.list()` |
| Full persisted history | `agent.timeline.refetch({ direction: "tail" \| "before", cursor, projection: "projected" })` — cursor-paginated |
| Live events | `agent.timeline.subscribe(handler)` — `agent_stream` events: `timeline` items (user/assistant messages, reasoning, tool calls, todos) plus `turn_started/completed/failed/canceled` |
| Send a message | `agent.send(text)` |

Paseo's daemon owns the timeline and it is authoritative: page reload re-fetches
history from Paseo, this service keeps **no conversation database**. The only
state the service owns is `data/rooms.json`: `share_token -> { agentId, label }`,
plus an admin token.

Key protocol facts discovered from source (`packages/protocol/src/messages.ts`):

- Live assistant messages arrive in **pieces**; clients concatenate consecutive
  `assistant_message` items. History fetched with `projection: "projected"`
  comes back pre-merged (`assistant_merge` collapse), so history and live
  rendering converge.
- `user_message` timeline items carry only `text` (+ message ids) — **no author
  metadata field** exists in the protocol. Human attribution is therefore done
  by prefixing the text with `[Name]\n`. Because the prefix lives in the
  timeline itself, both browsers (and the underlying agent) see who spoke, for
  free.

## Architecture

```
Browser A / Browser B
         |
         v
Public relay (VPS)
  - landing page               GET /
  - React room shell + assets  GET /r/<token>, /assets/*
  - dynamic token routing      /api/rooms/<token>/* and room WS
         |
         | one outbound host connection per laptop
         v
Laptop room server
  - room info/history/live fan-out/message send
  - create/revoke room (ADMIN, local only)
  - token -> agentId mapping and privileged Paseo connection
         |
         v
Paseo daemon (127.0.0.1:6767) ── the shared Codex/Claude agent
```

The public UI bundle contains no room data, agent IDs, daemon credentials, or
admin token, so it can be immutable and publicly cached. The relay serves the
room shell only for a live registered token; every data/action request is still
checked by both the relay route table and the laptop's room mapping.

One `@getpaseo/client` connection is shared by all rooms on a laptop. Per room, the server
holds one `timeline.subscribe` and fans events out to every connected browser
socket. Browsers never receive daemon credentials, agent ids, or any way to
name an agent: the server resolves `token -> agentId` internally and the
message endpoint accepts only `{ message, name }`.

## Security / trust boundary

- **Privileged edge**: only the server process talks to the daemon (localhost;
  supports `PASEO_PASSWORD` bearer auth if the daemon requires it).
- **Capability tokens**: 24 random bytes, base64url (~192 bits) per room; an
  invalid token 404s every endpoint. Tokens map to exactly one agent.
- **No client-controlled agent selection**: `agent_id` in a request body is
  ignored; the room's mapping is the only routing authority.
- **Admin surface**: room creation requires a separate admin bearer token
  generated on first start (`data/admin-token`, mode 0600) — the share CLI
  reads it locally. Collaborators holding a room token cannot mint rooms.
- Non-goals for the PoC: TLS, rate limiting, revocation UI, participant auth.
  A room token is a bearer capability; anyone with the URL is "in".

This matters because Paseo itself has **no per-client scoping**: any client
that authenticates to the daemon (pairing link / password) gets full control of
every agent, workspace and — via agents — the filesystem. Sharing daemon
credentials is therefore not an option; this proxy is the smallest thing that
creates a narrower capability.

## Plugin system findings

The plugin API (`paseo plugin init/install/reload`, docs under
/docs/plugins) is real and fairly capable:

- Plugins contribute **agent-scoped Command Center items** and **agent panels**
  (they receive `agentId` for the focused agent) — so a native
  "Share session" action is expressible today.
- Plugin **backend handlers run unsandboxed on the daemon machine** and receive
  the same `PaseoApi` as the SDK, so a plugin backend could mint a room token
  and hand the URL back to the UI.
- Limitations: plugin UI code gets agent *snapshots* (id/title/status), not
  timelines; and plugins are RPC handlers, not long-lived HTTP servers, so the
  room web service itself must remain a companion process (which a plugin
  backend could spawn/manage).

Conclusion: PoC as a standalone service (this repo) is the right first step;
a later thin plugin can add the "Share session" button and call this service's
admin API. No Paseo core changes are required for that; a *fully* native
feature (rooms served by the daemon itself, scoped viewer tokens in the
protocol) would need upstream changes in `packages/server`.

## What would need to change for production

- TLS + a real hostname (today: plain HTTP on localhost).
- Token lifecycle: expiry, revocation, per-participant identity instead of a
  free-text name field.
- Turn-taking policy for concurrent sends (currently: Paseo's default
  `sendMessage` behavior — messages during an active turn are delivered
  to the provider/queued by the daemon).
- Permission requests (`permission_requested` events) surfaced to the room, and
  a policy for who may approve them (currently the room UI shows them but the
  host approves from their own Paseo app).
- Reconnect hardening: the server re-syncs by refetching history on browser
  reconnect; daemon-connection loss relies on the SDK's auto-reconnect.
- Rate limiting / abuse controls on the message endpoint.
