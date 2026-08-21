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

## Continuous deploy (GitLab CI)

`.gitlab-ci.yml` type-checks and runs relay protocol tests on every push. On
`main`, it deploys the LAN relay using the project runner tagged
`paseo-rooms`. Configure these GitLab **Settings -> CI/CD -> Variables**:

- `DEPLOY_SSH_PRIVATE_KEY` — dedicated deploy key, preferably a *File* type
  variable. Add its public key to the deployment user's `authorized_keys`.
- `DEPLOY_SSH_KNOWN_HOSTS` — the target's pinned SSH host key(s), preferably a
  *File* type variable (obtain with `ssh-keyscan -H <host>` from a trusted
  network).
- `DEPLOY_SSH_TARGET` — e.g. `deployer@192.168.193.100`.
- `RELAY_KEY` — the shared relay secret, masked.
- `DEPLOY_REMOTE_DIR` — optional; defaults to `/home/deployer/paseo-rooms`.

The deploy job is omitted until all required variables are present. It updates
the same directory as the running relay, keeps `.env` out of rsync deletion,
rebuilds the LAN compose stack, and confirms that the local relay responds.

The current host already uses nginx-proxy on ports 80/443. The CI deployment
therefore intentionally uses `compose.lan.yml` and port 8080; do not set
`ROOMS_DOMAIN` or run the Caddy compose stack on that host unless the proxy
setup is migrated first.

## Health check

The relay has no `/healthz` endpoint (unknown paths just 404 — see
`src/relay/relay.ts`). `deploy.sh` and the workflow treat **any** HTTP
response from `https://$ROOMS_DOMAIN/` (including a 404) as "the relay is
up and Caddy's TLS is working."
