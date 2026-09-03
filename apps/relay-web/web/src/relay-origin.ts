/// <reference types="vite/client" />

import { normalizeRelayOrigin } from "../../src/relay-target.js";

/**
 * The browser client can be served either by the relay itself or by a static
 * host such as GitLab Pages. Secure rooms always connect to the relay chosen
 * at build time; falling back to the page origin preserves the local and
 * relay-hosted development workflows.
 */
export function relayOriginFor(
  configuredOrigin: string | undefined,
  pageOrigin: string,
): string {
  const origin = new URL(configuredOrigin || pageOrigin, pageOrigin);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("Paseo Rooms relay origin must use http or https");
  }
  return origin.origin;
}

/** Validate an optional relay supplied by a v2 invite fragment. */
export function inviteRelayOrigin(value: string | null): string | null {
  return value ? normalizeRelayOrigin(value) : null;
}

export function relayWebSocketUrlFor(
  relayOrigin: string,
  path: string,
): string {
  const url = new URL(path, relayOrigin);
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "http:") url.protocol = "ws:";
  return url.toString();
}

export function relayOrigin(): string {
  return relayOriginFor(
    import.meta.env.VITE_PASEO_ROOMS_RELAY_ORIGIN,
    location.origin,
  );
}

export function relayWebSocketUrl(path: string): string {
  return relayWebSocketUrlFor(relayOrigin(), path);
}
