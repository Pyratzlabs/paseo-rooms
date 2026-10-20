#!/bin/sh
# Match hostLimitsFromEnvironment: decimal, positive, JavaScript-safe integers.
# Keep this independent of Node/npm so CI can reject bad settings before SSH.
set -eu

check_limit() {
  case "$2" in
    ''|*[!0-9]*) valid=false ;;
    *)
      # Every integer above MAX_SAFE_INTEGER rounds to at least 2^53, so this
      # numeric comparison also rejects values beyond awk's exact integer range.
      if LC_ALL=C awk -v value="$2" 'BEGIN { exit !(value > 0 && value <= 9007199254740991) }'; then
        valid=true
      else
        valid=false
      fi ;;
  esac
  if [ "$valid" = false ]; then
    echo "invalid $1: expected a positive safe integer" >&2
    exit 1
  fi
}

check_limit RELAY_MAX_HOSTS "${RELAY_MAX_HOSTS-256}"
check_limit RELAY_MAX_HOSTS_PER_SOURCE "${RELAY_MAX_HOSTS_PER_SOURCE-32}"
