---
sidebar_position: 2
---

# Security and privacy

## Encrypted room transport

New rooms use protocol v2. Each browser establishes its own encrypted Paseo relay channel to the host laptop. The host uses a per-room Curve25519 keypair; the public key and a random invite secret are carried in the URL fragment. The fragment stays out of normal HTTP requests and is removed from browser history after the client has read it.

There is no shared group key in v2. The host encrypts each event separately for each participant. This means a participant cannot forge a host update merely because they can read room content. Application records also carry session IDs, monotonically increasing sequence numbers, random IDs, and replay checks.

The relay sees route IDs, connection metadata, timing, and ciphertext sizes. It can deny service, delay, drop, replay, or reorder traffic. It does not receive room messages, timeline content, host private keys, daemon credentials, or agent IDs.

## Trust the frontend that performs encryption

Encryption happens in the browser and the host runtime. An operator who controls the browser's JavaScript could modify it to capture the invite or messages before encryption. Encrypted room transport does not protect against a malicious client delivery origin.

The default GitHub Pages client is delivered independently from the relay. That separates the relay's routing role from the first page load, but users still trust the Pages deployment and its administrators. The same-origin client places both roles with the relay operator. A verifiable, version-pinned client delivery mechanism remains future work.

A team can [self-host both the relay and frontend](../how-to/run-your-own-relay), either on one domain or on separately managed origins. This replaces reliance on the public operators with reliance on the team's own code delivery and infrastructure. It preserves the same encrypted browser-to-host channels. It does not eliminate trust in client code, host machines, infrastructure administrators, or invited participants.

## How a browser joins

1. The host generates a room keypair and invite secret. The complete invitation includes the expected host public key and the secret after `#`.
2. The browser reads that fragment locally and establishes an encrypted channel to the expected host through the relay. No room content is released at this stage.
3. Inside that channel, the browser supplies the invite secret. The host checks it before allowing room operations, then sends the encrypted welcome. Successfully decrypting that welcome authenticates the host to the browser.
4. Each participant uses a separate channel. The host sends each authorised event to each participant; there is no shared group key that lets participants forge host updates.

These are application-level channels in addition to HTTPS/WSS. The host can read the room content and forwards contributions to the agent; Rooms does not change the agent provider's processing or retention policy. The relay can observe routing metadata or deny service even when payload encryption is intact.

## What each party can access

| Party                        | Access and responsibility                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Host runtime and Paseo agent | Room plaintext and the selected agent's history; the agent can use its permitted tools.                         |
| Relay                        | Ciphertext plus routes, connection metadata, sizes, and timing, assuming a trusted client. It can deny service. |
| Frontend delivery operator   | Controls the code that handles plaintext and the invitation in a browser. This origin must be trusted.          |
| Invited participant          | Room content and supported conversation actions. Their display name is not verified identity.                   |
| Agent provider               | Processes inputs according to the agent/provider configuration. Rooms encryption does not change that policy.   |

## Conversation access can lead to tool actions

A participant can prompt the shared agent and answer supported questions and approvals. The agent may then edit files, run commands, or use services under its host-side permissions. Room scoping prevents a direct, general daemon connection; it does not make an untrusted participant harmless. Invite trusted collaborators and review the agent’s tool permissions before sharing.

## What encryption does not change

The invite remains a bearer capability. Anyone with the full link can join while it is active. A display name is not identity verification. The protocol also does not provide forward secrecy if the host's per-room private key is later compromised, although keys disappear when the in-memory room is revoked or restarted.

For the normative record formats and precise guarantees, read the [protocol v2 reference](../protocol-v2).
