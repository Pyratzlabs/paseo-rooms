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

/**
 * An invite may select a custom relay, but a trusted static client must make
 * that destination visible and require an explicit user opt-in first.
 */
export function requiresCustomRelayConfirmation(
  inviteRelayOrigin: string | undefined,
  configuredRelayOrigin: string,
): boolean {
  return (
    inviteRelayOrigin !== undefined &&
    inviteRelayOrigin !== normalizeRelayOrigin(configuredRelayOrigin)
  );
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

export function configuredRelayTarget(): string {
  const target = normalizeRelayOrigin(relayOrigin());
  if (!target) throw new Error("Paseo Rooms relay target is invalid");
  return target;
}

export function relayWebSocketUrl(path: string): string {
  return relayWebSocketUrlFor(relayOrigin(), path);
}
