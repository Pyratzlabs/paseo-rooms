---
sidebar_position: 3
---

# Run your own relay

Run a relay you control when you want to choose the operator and hosting location for the public routing service. This is useful for team infrastructure and reduces reliance on the shared Pyratz Labs deployment.

You can host **both the relay and the browser frontend**. The default deployment below serves the bundled frontend from the relay's domain. Alternatively, serve the frontend from a static host you control and select it independently in the plugin.

Encrypted room channels protect payloads between the browser and host runtime. The JavaScript delivered to the browser must still be trusted: an operator who changes that code could read content before encryption. Hosting both services puts code delivery and routing under your organisation's control; it does not remove trust in your administrators, host machines, or room participants. See [Security and privacy](../explanation/security-and-privacy).

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

## Connect through the Paseo plugin

1. Open **Share session**, then **Advanced settings**.
2. Set **Relay for new links** to `wss://rooms.example.com` (without `/host`).
3. Set **Open room with** to **Custom client** and enter `https://rooms.example.com` for the bundled frontend.
4. Keep **Automatic discovery** selected. A private relay asks for its registration key; an open relay does not.
5. Create a **new** link. Check its client hostname and confirm the selected relay when the browser asks.

The host opens the outbound connection and registers its room routes. It reconnects and re-registers after a relay restart. Neither the frontend nor the relay receives the Paseo daemon credential or the host's `route → agent` mapping. A private relay's registration key controls who can register hosts; it is separate from a room's invitation secret and encryption keys.

The standalone room server can also connect with `RELAY_URL=wss://rooms.example.com/host` and, for private relays, `RELAY_KEY`. The plugin manages that runtime automatically, so plugin users do not need to start a second server.

## Host the frontend separately

Use a static origin you control, for example `https://rooms-ui.example.com`:

```bash
npm ci --ignore-scripts --no-audit --no-fund
VITE_PASEO_ROOMS_RELAY_ORIGIN=https://rooms.example.com npm run build:web
mkdir -p /tmp/rooms-static
cp apps/relay-web/public/room.html /tmp/rooms-static/index.html
cp apps/relay-web/public/room.html /tmp/rooms-static/404.html
cp -R apps/relay-web/public/assets /tmp/rooms-static/assets
```

Publish `/tmp/rooms-static/` through your chosen HTTPS static host. Configure an SPA fallback that serves `index.html` for `/r/*`; `404.html` is the fallback used by GitHub Pages. Other hosts may require a rewrite rule rather than that filename. Keep `/assets/*` available at the origin root.

In the plugin, keep your relay selected and set **Custom client** to `https://rooms-ui.example.com`. Create a fresh link and verify a second browser can load history and exchange a message. The client build contains no conversation data or daemon credential; those arrive only over the room channel after invitation validation.

You can instead keep the published GitHub Pages client and use only your relay, but that is **not** a fully self-hosted delivery model. For full control, both selected origins must be under your administration. Existing invitations retain their chosen client and relay; configuration changes affect new links only.

## Operate safely

For private relays, protect `RELAY_KEY` like an infrastructure credential. Anyone who holds it can register a host connection to the relay; rotate it if it may have leaked. For either mode, keep the server patched, restrict deployment access, and use TLS. Open relays also require monitoring of public registration capacity and abuse limits.
