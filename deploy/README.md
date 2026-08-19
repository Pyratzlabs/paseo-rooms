# Deploying the relay

Only the relay (`src/relay/`) is deployed to a VPS. The room server and the
Paseo daemon always stay on developers' laptops — see `docs/plan.md`. The
laptop dials *out* to the relay; the relay never sees daemon credentials.

## VPS prerequisites

- A small VPS reachable on 80/443 (any provider).
- Docker Engine + the Docker Compose plugin (`docker compose version` works).
- A DNS **A record** for your rooms domain (e.g. `rooms.example.com`)
  pointing at the VPS's public IP. Caddy needs this to issue a TLS cert via
  Let's Encrypt (also needs 80/443 reachable from the internet).

## Env vars

| Var            | Used by         | Meaning                                                        |
|----------------|-----------------|------------------------------------------------------------------|
| `ROOMS_DOMAIN` | caddy, deploy.sh | Public domain the relay is served on, e.g. `rooms.example.com` |
| `RELAY_KEY`    | relay, deploy.sh | Shared secret laptops present in `x-relay-key` to register     |
| `RELAY_PORT`   | relay (compose sets this to `8080` internally) | Port the relay listens on inside its container |
| `SSH_TARGET`   | deploy.sh       | `user@host` (or an `~/.ssh/config` alias) for the VPS           |
| `REMOTE_DIR`   | deploy.sh (optional) | Remote checkout dir, default `~/paseo-rooms`               |
| `SSH_OPTS`     | deploy.sh (optional) | Extra ssh/rsync flags, e.g. `-i ~/.ssh/id_deploy`           |

`RELAY_KEY` and `ROOMS_DOMAIN` are never baked into the Docker image — they're
supplied at deploy time and written to a `.env` file next to `compose.yml` on
the VPS (`chmod 600`).

## First-time setup

1. Point DNS: create an A record for `ROOMS_DOMAIN` -> the VPS IP.
2. Pick a `RELAY_KEY` (any long random string — this is the shared secret
   between the relay and every laptop room server).
3. From your machine (or CI — see below), deploy:

   ```bash
   SSH_TARGET=deploy@vps.example.com \
   ROOMS_DOMAIN=rooms.example.com \
   RELAY_KEY=<long random secret> \
   bash deploy/deploy.sh
   ```

   This rsyncs `deploy/` and `src/relay/` to the VPS, writes `deploy/.env`
   there, runs `docker compose build && up -d` (relay + Caddy), and polls
   `https://$ROOMS_DOMAIN/` until it responds (Caddy's first TLS issuance can
   take up to a minute).

4. Re-running `deploy.sh` any time is safe — it's idempotent (rsync
   `--delete`, `docker compose up -d` reconciles).

## How the laptop connects

On each developer's laptop, run the room server in dial-out mode instead of
(or alongside) its local listener:

```bash
RELAY_URL=wss://rooms.example.com/host RELAY_KEY=<same secret as the VPS> npm start
```

The room server registers its share tokens with the relay on boot and on
every room create/revoke, and reconnects with backoff if the relay restarts.
See `deploy/paseo-rooms.service` for an example systemd **user** unit that
keeps this running in the background.

## Continuous deploy (GitHub Actions)

`.github/workflows/deploy.yml` deploys on every push to `main` by SSHing into
the VPS and running `deploy/deploy.sh`. It's a no-op (green, with a notice —
not a failure) until these repository secrets are set:

- `SSH_PRIVATE_KEY` — private key for a deploy user on the VPS (the matching
  public key must be in that user's `~/.ssh/authorized_keys`; the deploy user
  needs passwordless `docker` access, e.g. membership in the `docker` group)
- `SSH_TARGET` — e.g. `deploy@vps.example.com`
- `ROOMS_DOMAIN` — e.g. `rooms.example.com`
- `RELAY_KEY` — the shared secret (same value laptops use)

Add them under **Settings -> Secrets and variables -> Actions** in the GitHub
repo. Until they're all set, the workflow run shows a "Skipping deploy"
notice and succeeds.

## Health check

The relay has no `/healthz` endpoint (unknown paths just 404 — see
`src/relay/relay.ts`). `deploy.sh` and the workflow treat **any** HTTP
response from `https://$ROOMS_DOMAIN/` (including a 404) as "the relay is
up and Caddy's TLS is working."
