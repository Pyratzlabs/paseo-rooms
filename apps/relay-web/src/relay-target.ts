const MAX_RELAY_ORIGIN_LENGTH = 512;

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

/**
 * Canonicalize a relay endpoint for both host registration and browser use.
 * Public relays must use TLS; plaintext is permitted only for local testing.
 */
export function normalizeRelayOrigin(value: string): string | null {
  if (value.length > MAX_RELAY_ORIGIN_LENGTH) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      return null;
    }
    const secure = url.protocol === "https:" || url.protocol === "wss:";
    const local =
      (url.protocol === "http:" || url.protocol === "ws:") &&
      isLoopbackHost(url.hostname);
    if (!secure && !local) return null;
    return `${secure ? "wss:" : "ws:"}//${url.host}`;
  } catch {
    return null;
  }
}

export function relayHostUrl(relayOrigin: string): string {
  return `${relayOrigin}/host`;
}

export function relayWebSocketUrl(relayOrigin: string, path: string): string {
  return new URL(path, relayOrigin).toString();
}

/**
 * Legacy (v1) rooms do not carry a relay target in their invite. Keeping them
 * on the configured relay avoids registering a token with a relay the browser
 * cannot subsequently discover.
 */
export function legacyRoomUsesConfiguredRelay(
  relayOrigin: string,
  configuredRelayOrigin: string | null,
): boolean {
  return relayOrigin === configuredRelayOrigin;
}

/**
 * A room relay client is keyed by both origin and host registration key. A
 * different key must never replace an active client's credentials: callers
 * should perform this check before allocating a room.
 */
export function relayKeyCompatibilityError(
  existingKey: string | undefined,
  requestedKey: string,
  activeRouteCount: number,
): string | null {
  if (
    existingKey !== undefined &&
    existingKey !== requestedKey &&
    activeRouteCount > 0
  ) {
    return "relay registration key changed while rooms are active; revoke those rooms or reload the plugin before changing it";
  }
  return null;
}
