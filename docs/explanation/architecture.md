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

The Paseo plugin runs on the host laptop. It starts the local room server when needed and asks it to create or revoke rooms. The local server alone holds the daemon connection, local admin token, agent identifier mapping, invite state, and room transport keys.

The public relay is a router, not a conversation database. It maps a public route ID to the host laptop's outbound connection and relays browser WebSocket records to it. It keeps routes in memory, so hosts re-register after a restart. The relay does not receive daemon credentials or agent IDs.

The agent timeline remains in Paseo. The local server reads its history and live updates, then fans authorised room events out to connected collaborators. Messages and structured decisions move in the other direction through a small host-side allowlist; browsers cannot select arbitrary agents or invoke arbitrary daemon operations.
