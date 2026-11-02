import { normalizeRelayOrigin as normalizeRoomRelayOrigin } from "../relay-web/src/relay-target";

export const DEFAULT_CLIENT_ORIGIN = "https://pyratzlabs.github.io/paseo-rooms";
export const DEFAULT_RELAY_ORIGIN = "wss://paseo-rooms.pyratz.com";

export const CLIENT_ORIGIN_PRESETS = [
  {
    id: "pyratz" as const,
    label: "Pyratz Labs",
    origin: "https://paseo-rooms.pyratz.com",
  },
  {
    id: "github" as const,
    label: "GitHub Pages",
    origin: DEFAULT_CLIENT_ORIGIN,
  },
  { id: "custom" as const, label: "Custom client" },
] as const;

export type ClientOriginChoice = (typeof CLIENT_ORIGIN_PRESETS)[number]["id"];

export const normalizeRelayOrigin = normalizeRoomRelayOrigin;

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}

export function normalizeClientUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHost(url.hostname))
    ) {
      return null;
    }
    if (url.username || url.password || url.search || url.hash) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/** Keep room capabilities and their chosen relay while changing the UI base URL. */
export function rebaseRoomUrl(
  roomUrl: string,
  clientUrl: string,
): string | null {
  try {
    const room = new URL(roomUrl);
    const client = normalizeClientUrl(clientUrl);
    const route = room.pathname.match(/\/r\/[^/]+\/?$/)?.[0];
    if (!client || !route) return null;
    return `${client}${route}${room.search}${room.hash}`;
  } catch {
    return null;
  }
}

/** Migrate the retired Pages preset without changing deliberately custom URLs. */
export function parseClientOriginPreference(raw: string | null): {
  choice: ClientOriginChoice;
  customOrigin: string;
} {
  const fallback = { choice: "github" as const, customOrigin: "" };
  if (!raw) return fallback;
  try {
    const value = JSON.parse(raw) as {
      choice?: unknown;
      customOrigin?: unknown;
    };
    if (!value || typeof value !== "object") return fallback;
    const choice = value.choice === "gitlab" ? "github" : value.choice;
    if (
      (choice === "github" || choice === "pyratz" || choice === "custom") &&
      (value.customOrigin === undefined ||
        typeof value.customOrigin === "string")
    )
      return { choice, customOrigin: value.customOrigin ?? "" };
  } catch {
    // Missing or malformed browser preferences must not block sharing.
  }
  return fallback;
}
