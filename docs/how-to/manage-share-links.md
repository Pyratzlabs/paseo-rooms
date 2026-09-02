---
sidebar_position: 2
---

# Manage share links

## Create a separate link per session

Create links from the relevant agent's **Share session** panel. A link identifies one room and one host-side Paseo session; it is not a global user account.

## Revoke access

Choose **Revoke link** in the same panel. Revocation removes the room from the host and unregisters its route from the relay. New visits receive an invalid-or-expired-link response; connected participants are disconnected.

## Treat links as secrets

The v2 URL includes an invite secret in its fragment. Browsers do not send URL fragments in HTTP requests, but anyone who receives the complete URL can join. Do not paste links into public tickets, logs, or screenshots. Create a new link rather than forwarding an old one.

## Understand restarts

Encrypted rooms are intentionally in-memory. Restarting the local room server or laptop invalidates their links. This limits the lifetime of transport keys and avoids persisting conversation access material.
