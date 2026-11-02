---
sidebar_position: 1
---

# Architecture

Paseo Rooms shares one existing agent conversation. The host keeps the connection to Paseo; participants receive a narrower set of room operations.

<div className="rooms-diagram" role="region" aria-label="Room architecture diagram; scroll horizontally on small screens" tabIndex={0}>
  <img src="/docs/img/diagrams/room-architecture.svg" alt="Browser participants use a trusted static client and encrypted channels through a public relay. The host plugin runtime connects outward to that relay and uses the local SDK to reach the Paseo daemon and shared agent." />
</div>

<p className="rooms-diagram-hint">Scroll sideways to explore the diagram, or open it full-size below.</p>

[Open the full diagram](/img/diagrams/room-architecture.svg).

## The plugin brings sharing to the session

The **Share session** panel belongs to Paseo's plugin system. Its daemon-side code starts the local room runtime on first use and creates or revokes rooms for the selected agent. The runtime holds the local admin token, agent mapping, invite state, and room keys. The daemon owns the agent timeline; Rooms reads history and subscribes to live events through the official `@getpaseo/client` SDK.

Plugin reload, update, disable, or daemon shutdown stops the managed listener. Encrypted rooms are held in process memory and disappear when the plugin process exits. A managed stop/start in the same process can retain room state; do not rely on that to preserve links across a reload.

## The relay connects browsers to the host

The laptop establishes an outbound WebSocket connection. There is no need to expose the Paseo daemon or a laptop port to the public internet. A public relay maps an opaque room route to that host connection and forwards records. Hosts register their routes again after a relay restart or network outage.

Each participant has its own encrypted channel to the host. The relay sees routing metadata and traffic sizes, but not the room payloads under the trusted-client assumptions described in [Security and privacy](security-and-privacy). It does not hold a conversation database or daemon credentials.

Messages and supported structured decisions pass through a host-side allowlist. A browser cannot choose an arbitrary agent ID or call arbitrary daemon operations. A message can nevertheless lead the shared agent to use tools on its host, subject to that agent's permissions.

## Browser delivery and relay routing are separate

By default, room links open the independently published GitLab Pages client. The configured product site, documentation, and default relay use `paseo-rooms.pyratz.com`. The **Pyratz Labs** client preset serves the room UI from the relay origin instead. A custom client and a custom relay can also be selected independently.

The invite fragment carries the relay chosen for the room, so changing a default does not rewrite an existing link. A client asks for confirmation before connecting to a relay other than its configured default. A static host needs an SPA fallback for `/r/<route-id>`.

Separating the client origin from the relay separates their delivery responsibilities; it is not a substitute for trusting the code served by the client origin.

## Images follow the same room boundary

A participant's image travels over encrypted room records to the host. The host validates it, keeps it in bounded, room-owned memory, and forwards its original bytes to the selected agent. Other participants fetch it through their encrypted channels. There is no public image URL or arbitrary host-file download endpoint.

Rooms correlates its own uploaded images with the agent timeline by message ID. Images uploaded directly through Paseo's composer are not imported into Rooms. The [first-room tutorial](../tutorials/share-your-first-room#send-an-image) describes the supported formats, limits, delivery states, and retention.
