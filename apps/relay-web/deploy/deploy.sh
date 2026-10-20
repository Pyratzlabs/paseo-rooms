#!/usr/bin/env bash
# Idempotent deploy of the public relay + Caddy to the VPS named by SSH_TARGET.
# The VPS serves the landing page and React room bundle; the room server and
# Paseo daemon stay on developers' laptops (see docs/plan.md).
#
# Required env:
#   SSH_TARGET   e.g. deploy@1.2.3.4  (or an entry in ~/.ssh/config)
#   ROOMS_DOMAIN e.g. rooms.example.com
#   RELAY_KEY    required only when RELAY_AUTH_MODE=key
#
# Optional env:
#   RELAY_AUTH_MODE open or key (default: key)
#   RELAY_MAX_HOSTS total host budget (default: 256)
#   RELAY_MAX_HOSTS_PER_SOURCE host budget per source IP (default: 32)
#   RELAY_TRUSTED_PROXY_ADDRESSES exact immediate proxy IPs, comma-separated
#   SSH_OPTS       extra ssh/rsync options, e.g. "-i ~/.ssh/id_deploy"
#   REMOTE_DIR     remote checkout dir (default: ~/paseo-rooms)
#
# What it does:
#   1. build the public UI and rsync deploy/, src/relay/, and public/ to the VPS
#   2. write/refresh a .env file next to compose.yml on the VPS
#   3. `docker compose build && up -d`
#   4. verify discovery advertises the requested registration mode over HTTPS

set -euo pipefail

fail() {
  echo "deploy.sh: $*" >&2
  exit 1
}

[[ -n "${SSH_TARGET:-}" ]] || fail "SSH_TARGET is required (e.g. deploy@1.2.3.4)"
[[ -n "${ROOMS_DOMAIN:-}" ]] || fail "ROOMS_DOMAIN is required (e.g. rooms.example.com)"
RELAY_AUTH_MODE="${RELAY_AUTH_MODE:-key}"
case "$RELAY_AUTH_MODE" in
  open) ;;
  key) [[ -n "${RELAY_KEY:-}" ]] || fail "RELAY_KEY is required in key mode" ;;
  *) fail "RELAY_AUTH_MODE must be open or key" ;;
esac

REMOTE_DIR="${REMOTE_DIR:-~/paseo-rooms}"
SSH_OPTS="${SSH_OPTS:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "==> Ensuring remote directory exists: $REMOTE_DIR"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$SSH_TARGET" "mkdir -p '$REMOTE_DIR/deploy' '$REMOTE_DIR/src/relay' '$REMOTE_DIR/public'"

echo "==> Building public documentation and the room UI"
(cd "$REPO_ROOT/../.." && npm run build:docs)
(cd "$REPO_ROOT" && npm run build:web)

echo "==> Syncing deploy assets, public UI, and relay source to $SSH_TARGET:$REMOTE_DIR"
# shellcheck disable=SC2086
rsync -az --delete -e "ssh $SSH_OPTS" \
  "$REPO_ROOT/deploy/" "$SSH_TARGET:$REMOTE_DIR/deploy/" \
  --exclude 'deploy.sh' --exclude 'README.md' --exclude 'paseo-rooms.service'

# shellcheck disable=SC2086
rsync -az --delete -e "ssh $SSH_OPTS" \
  "$REPO_ROOT/src/relay/" "$SSH_TARGET:$REMOTE_DIR/src/relay/"

# shellcheck disable=SC2086
rsync -az --delete -e "ssh $SSH_OPTS" \
  "$REPO_ROOT/public/" "$SSH_TARGET:$REMOTE_DIR/public/"

echo "==> Writing remote .env"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$SSH_TARGET" "cat > '$REMOTE_DIR/deploy/.env'" <<EOF
RELAY_AUTH_MODE=$RELAY_AUTH_MODE
RELAY_KEY=${RELAY_KEY:-}
ROOMS_DOMAIN=$ROOMS_DOMAIN
RELAY_MAX_HOSTS=${RELAY_MAX_HOSTS:-256}
RELAY_MAX_HOSTS_PER_SOURCE=${RELAY_MAX_HOSTS_PER_SOURCE:-32}
RELAY_TRUSTED_PROXY_ADDRESSES=${RELAY_TRUSTED_PROXY_ADDRESSES:-}
EOF
# shellcheck disable=SC2086
ssh $SSH_OPTS "$SSH_TARGET" "chmod 600 '$REMOTE_DIR/deploy/.env'"

echo "==> docker compose build + up -d"
# shellcheck disable=SC2086
ssh $SSH_OPTS "$SSH_TARGET" "cd '$REMOTE_DIR/deploy' && docker compose --env-file .env -f compose.yml build && docker compose --env-file .env -f compose.yml up -d"

echo "==> Waiting for https://$ROOMS_DOMAIN/.well-known/paseo-rooms to advertise $RELAY_AUTH_MODE registration (TLS issuance can take a moment)"
attempts=0
max_attempts=30
until curl -fsS --connect-timeout 5 --max-time 10 "https://$ROOMS_DOMAIN/.well-known/paseo-rooms" 2>/dev/null | node -e '
  try {
    const policy = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    process.exit(policy.registration === process.argv[1] ? 0 : 1);
  } catch {
    process.exit(1);
  }
' "$RELAY_AUTH_MODE"; do
  attempts=$((attempts + 1))
  if [[ "$attempts" -ge "$max_attempts" ]]; then
    fail "relay did not advertise registration mode $RELAY_AUTH_MODE at https://$ROOMS_DOMAIN/.well-known/paseo-rooms after $max_attempts attempts"
  fi
  sleep 2
done

echo "==> Relay registration mode verified: $RELAY_AUTH_MODE"
echo "==> Deploy complete"
