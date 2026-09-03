import { normalizeRelayOrigin as normalizeRoomRelayOrigin } from "../relay-web/src/relay-target";

export const DEFAULT_CLIENT_ORIGIN = "https://paseo-rooms-9eb268.gitlab.io";
export const DEFAULT_RELAY_ORIGIN = "wss://paseo-rooms.pyratzlabs.fr";

export const CLIENT_ORIGIN_PRESETS = [
  {
    id: "pyratz" as const,
    label: "Pyratz Labs",
    origin: "https://paseo-rooms.pyratzlabs.fr",
  },
  {
    id: "gitlab" as const,
    label: "GitLab Pages",
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

export function normalizeClientOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && isLoopbackHost(url.hostname))
    ) {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

/** Keep the route and fragment capability intact while changing only its UI host. */
export function rebaseRoomUrl(
  roomUrl: string,
  clientOrigin: string,
): string | null {
  try {
    const room = new URL(roomUrl);
    const client = new URL(clientOrigin);
    if (!normalizeClientOrigin(client.origin)) return null;
    return `${client.origin}${room.pathname}${room.search}${room.hash}`;
  } catch {
    return null;
  }
}
