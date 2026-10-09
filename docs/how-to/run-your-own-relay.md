---
sidebar_position: 3
---

# Run your own relay

Run a relay you control when you want to choose the operator and hosting location for the public routing service. This is useful for team infrastructure and reduces reliance on the shared Pyratz Labs deployment.

Self-hosting does **not** by itself make the current web client independently trustworthy: today the relay also serves the room page and JavaScript. The encrypted transport keeps room payloads opaque to the relay after the client loads, but trusted static-client delivery is a planned milestone.

## Prerequisites

- A VPS with Docker Engine and Docker Compose.
- A DNS record for a domain you control.
- For a private relay, a long random `RELAY_KEY`, shared only with room servers you authorize. Open relays do not require a registration key.

## Deploy

From this repository, deploy a private relay (the manual deployment default):

```bash
SSH_TARGET=deployer@vps.example.com \
ROOMS_DOMAIN=rooms.example.com \
RELAY_AUTH_MODE=key \
RELAY_KEY='generate-a-long-random-secret' \
bash apps/relay-web/deploy/deploy.sh
```

To allow anyone to register their own rooms, deploy an open relay instead:

```bash
SSH_TARGET=deployer@vps.example.com \
ROOMS_DOMAIN=rooms.example.com \
RELAY_AUTH_MODE=open \
bash apps/relay-web/deploy/deploy.sh
```

Open registration does not grant access to other people's rooms: guests still need their room invitation.

The script builds the public web assets, transfers the relay and assets, starts the container stack, and waits for the public URL to answer. See `apps/relay-web/deploy/README.md` for environment variables and proxy alternatives.

## Connect a host laptop

Start the local room server in dial-out mode. For a private relay:

```bash
RELAY_URL=wss://rooms.example.com/host \
RELAY_KEY='the-same-secret' \
npm run start --workspace @paseo-rooms/relay-web
```

For an open relay, omit `RELAY_KEY`. In the Paseo plugin, select your relay origin and **Automatic discovery**; only private relays ask for their operator's key.

The laptop creates the outbound host connection and registers live room routes. It reconnects and re-registers after a relay restart. The relay never receives the Paseo daemon credential or the host's `token → agent` mapping.

## Operate safely

For private relays, protect `RELAY_KEY` like an infrastructure credential. Anyone who holds it can register a host connection to the relay; rotate it if it may have leaked. For either mode, keep the server patched, restrict deployment access, and use TLS. Open relays also require monitoring of public registration capacity and abuse limits.
