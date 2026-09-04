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

The browser client and the relay are independent choices. New public-room
links default to the v2 client on GitLab Pages and the Pyratz Labs relay. The
Share session panel can instead select the Pyratz Labs same-origin client, a
custom client origin, a custom relay origin, or both. A selected relay is
carried in the encrypted-room invite fragment, so compatible clients connect
to that route rather than assuming their own deployment's relay.

This split lets an organisation run its own relay while retaining a published
client, or independently host and audit its client while retaining the shared
relay. The static client must provide an SPA fallback so opaque
`/r/<route-id>` links load the application. A client confirms a custom relay
endpoint before it opens the encrypted channel.

The agent timeline remains in Paseo. The local server reads its history and live updates, then fans authorised room events out to connected collaborators. Messages and structured decisions move in the other direction through a small host-side allowlist; browsers cannot select arbitrary agents or invoke arbitrary daemon operations.
