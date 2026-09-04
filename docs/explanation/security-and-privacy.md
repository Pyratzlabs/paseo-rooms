---
sidebar_position: 2
---

# Security and privacy

## Encrypted room transport

New rooms use protocol v2. Each browser establishes its own encrypted Paseo relay channel to the host laptop. The host uses a per-room Curve25519 keypair; the public key and a random invite secret are carried in the URL fragment. The fragment stays out of normal HTTP requests and is removed from browser history after the client has read it.

There is no shared group key in v2. The host encrypts each event separately for each participant. This means a participant cannot forge a host update merely because they can read room content. Application records also carry session IDs, monotonically increasing sequence numbers, random IDs, and replay checks.

The relay sees route IDs, connection metadata, timing, and ciphertext sizes. It can deny service, delay, drop, replay, or reorder traffic. It does not receive room messages, timeline content, host private keys, daemon credentials, or agent IDs.

## Current limitation

The same-origin relay client is controlled by its relay operator, who could alter that client before encryption starts. Therefore, describe that deployment as **encrypted payload transport**, not as protection from a malicious relay operator. Selecting the GitLab Pages client or a separately administered custom client separates the client delivery origin from the relay, but users must still decide that client origin is trustworthy. A verifiable, version-pinned client delivery mechanism is explicitly postponed work.

## What encryption does not change

The invite remains a bearer capability. Anyone with the full link can join while it is active. A display name is not identity verification. The protocol also does not provide forward secrecy if the host's per-room private key is later compromised, although keys disappear when the in-memory room is revoked or restarted.

For the normative record formats and precise guarantees, read the [protocol v2 reference](../protocol-v2).
