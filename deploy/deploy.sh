#!/usr/bin/env bash
# Idempotent deploy of the relay + Caddy to the VPS named by SSH_TARGET.
# Only the relay is deployed here — the room server and Paseo daemon stay on
# developers' laptops (see docs/plan.md).
#
# Required env:
#   SSH_TARGET   e.g. deploy@1.2.3.4  (or an entry in ~/.ssh/config)
#   ROOMS_DOMAIN e.g. rooms.example.com
#   RELAY_KEY    shared secret between the relay and laptop room servers
#
# Optional env:
#   SSH_OPTS       extra ssh/rsync options, e.g. "-i ~/.ssh/id_deploy"
#   REMOTE_DIR     remote checkout dir (default: ~/paseo-rooms)
#
# What it does:
#   1. rsync the repo subset the relay needs (deploy/ + src/relay/) to the VPS
#   2. write/refresh a .env file next to compose.yml on the VPS
#   3. `docker compose build && up -d`
#   4. curl the relay's public URL and confirm it responds at all (the relay
#      has no /healthz; any HTTP response, even 404, means it's up)

set -euo pipefail

fail() {
  echo "deploy.sh: $*" >&2
  exit 1
}

[[ -n "${SSH_TARGET:-}" ]] || fail "SSH_TARGET is required (e.g. deploy@1.2.3.4)"
[[ -n "${ROOMS_DOMAIN:-}" ]] || fail "ROOMS_DOMAIN is required (e.g. rooms.example.com)"
[[ -n "${RELAY_KEY:-}" ]] || fail "RELAY_KEY is required (shared secret for the relay)"

REMOTE_DIR="${REMOTE_DIR:-~/paseo-rooms}"
SSH_OPTS="${SSH_OPTS:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Ensuring remote directory exists: $REMOTE_DIR"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$SSH_TARGET" "mkdir -p '$REMOTE_DIR/deploy' '$REMOTE_DIR/src/relay'"

echo "==> Syncing deploy assets and relay source to $SSH_TARGET:$REMOTE_DIR"
# shellcheck disable=SC2086
rsync -az --delete -e "ssh $SSH_OPTS" \
  "$REPO_ROOT/deploy/" "$SSH_TARGET:$REMOTE_DIR/deploy/" \
  --exclude 'deploy.sh' --exclude 'README.md' --exclude 'paseo-rooms.service'

# shellcheck disable=SC2086
rsync -az --delete -e "ssh $SSH_OPTS" \
  "$REPO_ROOT/src/relay/" "$SSH_TARGET:$REMOTE_DIR/src/relay/"

echo "==> Writing remote .env"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$SSH_TARGET" "cat > '$REMOTE_DIR/deploy/.env'" <<EOF
RELAY_KEY=$RELAY_KEY
ROOMS_DOMAIN=$ROOMS_DOMAIN
EOF
# shellcheck disable=SC2086
ssh $SSH_OPTS "$SSH_TARGET" "chmod 600 '$REMOTE_DIR/deploy/.env'"

echo "==> docker compose build + up -d"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$SSH_TARGET" "cd '$REMOTE_DIR/deploy' && docker compose --env-file .env -f compose.yml build && docker compose --env-file .env -f compose.yml up -d"

echo "==> Waiting for https://$ROOMS_DOMAIN/ to respond (TLS issuance can take a moment)"
attempts=0
max_attempts=30
until curl -fsS -o /dev/null -w '%{http_code}' "https://$ROOMS_DOMAIN/" 2>/dev/null | grep -qE '^[0-9]{3}$'; do
  attempts=$((attempts + 1))
  if [[ "$attempts" -ge "$max_attempts" ]]; then
    fail "relay did not respond at https://$ROOMS_DOMAIN/ after $max_attempts attempts"
  fi
  sleep 2
done

status="$(curl -sS -o /dev/null -w '%{http_code}' "https://$ROOMS_DOMAIN/" || true)"
echo "==> Relay responded with HTTP $status (any response, including 404, means it's up)"
echo "==> Deploy complete"
