---
sidebar_position: 1
---

# Architecture

Paseo Rooms is deliberately split so that collaborators can join one agent conversation without receiving broad access to the host's machine.

```text
Collaborator browser
        │ encrypted room records
        ▼
Public relay and web application
        │ opaque routed records
        ▼
Host laptop room server
        │ localhost Paseo client connection
        ▼
Paseo daemon and agent
```

The Paseo plugin runs on the host laptop. On the first **Share session** use it
starts the local room server inside the plugin's daemon-side lifecycle and asks
it to create or revoke rooms. A plugin reload, update, disable, or daemon
shutdown closes that listener again. The local server alone holds the daemon
connection, local admin token, agent identifier mapping, invite state, and room
transport keys; no independent systemd service is involved.

The public relay is a router, not a conversation database. It maps a public route ID to the host laptop's outbound connection and relays browser WebSocket records to it. It keeps routes in memory, so hosts re-register after a restart. The relay does not receive daemon credentials or agent IDs.

## Browser client delivery

New public-room links use the v2 client published on GitLab Pages. Its build
records the public relay origin and connects there over WebSocket; it does not
need a relay-side HTTP API for secure rooms. The relay continues serving its
same-origin client for existing links and self-hosted deployments.

Hosts may set `PASEO_ROOMS_CLIENT_URL` to put the static-client origin in new
links while retaining `PASEO_ROOMS_PUBLIC_URL` as the relay origin. This split
lets an organisation host and audit the client independently, or keep the
default paired deployment. The Pages site supplies an SPA fallback so opaque
`/r/<route-id>` links still load the client.

The agent timeline remains in Paseo. The local server reads its history and live updates, then fans authorised room events out to connected collaborators. Messages and structured decisions move in the other direction through a small host-side allowlist; browsers cannot select arbitrary agents or invoke arbitrary daemon operations.
