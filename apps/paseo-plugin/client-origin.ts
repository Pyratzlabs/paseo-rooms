export const DEFAULT_CLIENT_ORIGIN = "https://paseo-rooms-9eb268.gitlab.io";

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

export function normalizeClientOrigin(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
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
    if (client.protocol !== "http:" && client.protocol !== "https:")
      return null;
    return `${client.origin}${room.pathname}${room.search}${room.hash}`;
  } catch {
    return null;
  }
}
