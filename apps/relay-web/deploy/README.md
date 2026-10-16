# Deploying the relay

The public deployment contains the relay (`src/relay/`) and the built landing
page/shared-room React bundle. The room server and Paseo daemon always stay on
developers' laptops — see `docs/plan.md`. The laptop dials _out_ to the relay;
the relay never sees daemon credentials.

## VPS prerequisites

- A small VPS reachable on 80/443 (any provider).
- Docker Engine + the Docker Compose plugin (`docker compose version` works).
- A DNS **A record** for your rooms domain (e.g. `rooms.example.com`)
  pointing at the VPS's public IP. Caddy needs this to issue a TLS cert via
  Let's Encrypt (also needs 80/443 reachable from the internet).

## Env vars

| Var               | Used by                                        | Meaning                                                        |
| ----------------- | ---------------------------------------------- | -------------------------------------------------------------- |
| `ROOMS_DOMAIN`    | caddy, deploy.sh                               | Public domain the relay is served on, e.g. `rooms.example.com` |
| `RELAY_AUTH_MODE` | relay, deploy.sh                               | `open` or `key`; Compose and deploy.sh default to `key`        |
| `RELAY_KEY`       | relay, deploy.sh                               | Required only in `key` mode                                    |
| `RELAY_PORT`      | relay (compose sets this to `8080` internally) | Port the relay listens on inside its container                 |
| `SSH_TARGET`      | deploy.sh                                      | `user@host` (or an `~/.ssh/config` alias) for the VPS          |
| `REMOTE_DIR`      | deploy.sh (optional)                           | Remote checkout dir, default `~/paseo-rooms`                   |
| `SSH_OPTS`        | deploy.sh (optional)                           | Extra ssh/rsync flags, e.g. `-i ~/.ssh/id_deploy`              |

`RELAY_KEY` and `ROOMS_DOMAIN` are never baked into the Docker image — they're
supplied at deploy time and written to a `.env` file next to `compose.yml` on
the VPS (`chmod 600`).

## First-time setup

1. Point DNS: create an A record for `ROOMS_DOMAIN` -> the VPS IP.
2. Choose `RELAY_AUTH_MODE=open` for public registration, or keep `key`
   and supply a long random `RELAY_KEY` for a private relay.
3. From your machine (or CI — see below), deploy an open relay without a key:

   ```bash
   SSH_TARGET=deploy@vps.example.com \
   ROOMS_DOMAIN=rooms.example.com \
   RELAY_AUTH_MODE=open \
   bash apps/relay-web/deploy/deploy.sh
   ```

   Or deploy a private relay that requires a registration key:

   ```bash
   SSH_TARGET=deploy@vps.example.com \
   ROOMS_DOMAIN=rooms.example.com \
   RELAY_AUTH_MODE=key \
   RELAY_KEY='replace-with-a-long-random-secret' \
   bash apps/relay-web/deploy/deploy.sh
   ```

   This builds the React client, then rsyncs `apps/relay-web/deploy/`,
   `apps/relay-web/src/relay/`, and `apps/relay-web/public/` to the VPS, writes `deploy/.env`
   there, runs `docker compose build && up -d` (relay + Caddy), and polls
   `https://$ROOMS_DOMAIN/` until it responds (Caddy's first TLS issuance can
   take up to a minute).

4. Re-running `deploy.sh` any time is safe — it's idempotent (rsync
   `--delete`, `docker compose up -d` reconciles).

## How the laptop connects

On each developer's laptop, run the room server in dial-out mode instead of
(or alongside) its local listener. For an open relay:

```bash
RELAY_URL=wss://rooms.example.com/host npm start
```

For a private relay, also set `RELAY_KEY` to the same secret as the VPS.

The room server registers its share tokens with the relay on boot and on
every room create/revoke, and reconnects with backoff if the relay restarts.
See `apps/relay-web/deploy/paseo-rooms.service` for an example systemd **user** unit that
keeps this running in the background.

## Continuous deploy (GitLab CI)

`.gitlab-ci.yml` type-checks and runs relay protocol tests on every push. On
`main`, it deploys the relay using the project runner tagged
`paseo-rooms`. Configure these GitLab **Settings -> CI/CD -> Variables**:

- `DEPLOY_SSH_PRIVATE_KEY` — dedicated deploy key, preferably a _File_ type
  variable. Add its public key to the deployment user's `authorized_keys`.
- `DEPLOY_SSH_KNOWN_HOSTS` — the target's pinned SSH host key(s), preferably a
  _File_ type variable (obtain with `ssh-keyscan -H <host>` from a trusted
  network).
- `DEPLOY_SSH_TARGET` — e.g. `deployer@192.168.193.100`.
- `RELAY_AUTH_MODE` — optional override (`open` or `key`). The hosted
  `paseo-rooms.pyratzlabs.fr` relay defaults to `open`; other domains and LAN
  deployments default to `key`.
- `RELAY_KEY` — the shared relay secret, masked; required only in `key` mode.
- `DEPLOY_REMOTE_DIR` — optional; defaults to `/home/deployer/paseo-rooms`.

The deploy job is omitted until all required variables are present. It updates
the same directory as the running relay, keeps `.env` out of rsync deletion,
rebuilds the chosen compose stack, and confirms that discovery reports the
expected registration mode.

The current host uses nginx-proxy on ports 80/443. With `ROOMS_DOMAIN` set,
CI uses `compose.proxy.yml` and joins its `web` network. Without a domain it
uses `compose.lan.yml`. Do not run the Caddy stack on the existing proxy host.
The proxy stack binds its raw HTTP port to `127.0.0.1:8080` for local health
checks. Public clients must use HTTPS/WSS through nginx-proxy; direct
LAN/ZeroTier links to the host's port 8080 are unavailable with this stack.
Use the separate `compose.lan.yml` setup when direct private-network access
is required.

## Health check

The relay has no `/healthz` endpoint. Both CI and `deploy.sh` check
`/.well-known/paseo-rooms` and the expected registration mode before reporting
deployment success. The manual script also verifies discovery through public HTTPS.

## Public and private registration

The relay defaults to `RELAY_AUTH_MODE=key`. A missing `RELAY_KEY` in this mode
fails startup. New relays expose `GET /.well-known/paseo-rooms` so the plugin
can discover whether a key is needed without transmitting any credentials.

An explicitly public relay can be exercised locally with:

```bash
RELAY_AUTH_MODE=open RELAY_PORT=8787 npm run relay
```

Select `ws://127.0.0.1:8787` under the plugin's Advanced settings. Public
connections send no registration key. Internet deployments must terminate TLS
and use a `wss://` origin. To deploy an open relay with any Compose file, set
`RELAY_AUTH_MODE=open` in its `.env`; no `RELAY_KEY` is required. Compose and
`deploy.sh` retain the private default. CI explicitly selects open mode for
the hosted Pyratz Labs domain, so later deployments preserve keyless access.

New room routes carry an independent ownership proof, so knowledge of a room
address does not permit registering it after its host disconnects or the relay
restarts. A new link is returned only after the relay confirms registration.
The invitation secret and encrypted room traffic remain separate from relay
access. Rooms themselves remain in memory and disappear when the laptop room
server restarts.

For an older relay without discovery, select **Legacy private relay** in
Advanced settings (standalone server: `RELAY_MODE=legacy-key`). Automatic
mode reports discovery failures instead of assuming an access policy.

Private relay keys can be entered once and remembered on Unix machines in an
owner-only configuration file. They are never stored in browser preferences.
The existing endpoint-matched `paseo-rooms.env` remains a migration source;
Forget suppresses that fallback. Environment-managed keys must be changed in
the machine configuration. Saving is unavailable on Windows until a supported
credential-store adapter is provided; keys can still be entered for use in the
current flow. Keys are saved only after a successful share operation.

Connection and traffic bounds are local safeguards, not a hosted capacity
benchmark. Measure expected concurrency and configure the reverse proxy's own
connection/traffic limits before opening production admission. Direct socket
addresses are authoritative unless proxy trust is explicitly configured; do
not trust arbitrary client-supplied forwarding headers.

Operator controls for the relay executable:

- `RELAY_AUTH_MODE=key|open` (default `key`).
- `RELAY_ADMISSION_ENABLED=false` temporarily rejects new admissions without
  revoking established rooms. Restart the relay to apply configuration changes.
- `RELAY_TRUSTED_PROXY_ADDRESSES` is a comma-separated list of exact immediate
  proxy IP addresses as seen by the relay socket. Trusted proxies must overwrite
  `X-Forwarded-For` with a single client IP; lists and untrusted headers are ignored.
  Without this setting, clients behind a proxy share its per-source limits.

Current built-in defaults include 256 hosts (32 per source), 1,024 guest sockets
(128 per source, 64 per room), 4,096 routes (256 per host), a 2 MiB outgoing
queue limit, and a five-minute guest idle timeout. `createRelay({ limits: ... })`
allows validated overrides for embedding/testing; the executable currently uses
these defaults. Hosting capacity and proxy-level denial-of-service controls
must be assessed separately before general availability.
