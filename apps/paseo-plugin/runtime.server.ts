import os from "node:os";
import path from "node:path";

interface StartedRoomServer {
  baseUrl: string;
  adminToken: string;
  close(): Promise<void>;
}

export interface ManagedRoomServer {
  baseUrl: string;
  adminToken: string;
  started: boolean;
}

const DEFAULT_RELAY_PUBLIC_URL = "https://paseo-rooms.pyratzlabs.fr";
const DEFAULT_CLIENT_URL = "https://paseo-rooms-9eb268.gitlab.io";

let managed: Promise<StartedRoomServer> | null = null;

function configureLocalRuntime(): void {
  const port = Number(process.env.PASEO_ROOMS_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("paseo-rooms: PASEO_ROOMS_PORT must be a valid TCP port");
  }
  // PASEO_ROOMS_PUBLIC_URL is retained as the public relay origin for
  // compatibility. PASEO_ROOMS_CLIENT_URL controls the static client origin
  // emitted in new links, allowing GitLab Pages to serve the UI separately.
  const configuredRelayPublicBaseUrl =
    process.env.PASEO_ROOMS_PUBLIC_URL ?? process.env.PUBLIC_BASE_URL;
  const relayPublicBaseUrl =
    configuredRelayPublicBaseUrl ?? DEFAULT_RELAY_PUBLIC_URL;
  const relayPublicUrl = new URL(relayPublicBaseUrl);
  const clientUrl = new URL(
    process.env.PASEO_ROOMS_CLIENT_URL ??
      // A custom relay normally owns its client too. The hosted default uses
      // the independently deployable GitLab Pages client.
      (configuredRelayPublicBaseUrl ? relayPublicBaseUrl : DEFAULT_CLIENT_URL),
  );
  const relayUrl =
    process.env.PASEO_ROOMS_RELAY_URL ??
    process.env.RELAY_URL ??
    `${relayPublicUrl.protocol === "https:" ? "wss:" : "ws:"}//${relayPublicUrl.host}/host`;
  const relayKey = process.env.PASEO_ROOMS_RELAY_KEY ?? process.env.RELAY_KEY;
  if (!relayKey) {
    throw new Error(
      "paseo-rooms: PASEO_ROOMS_RELAY_KEY is required before sharing a room",
    );
  }
  process.env.PORT = String(port);
  process.env.BASE_URL = `http://127.0.0.1:${port}`;
  process.env.PUBLIC_BASE_URL = clientUrl.toString().replace(/\/$/, "");
  process.env.RELAY_URL = relayUrl;
  process.env.RELAY_KEY = relayKey;
  // Paseo evaluates plugin server code rather than loading its ESM files
  // directly, so import.meta.url cannot identify the plugin checkout. Plugin
  // commands run from that checkout; pass the public assets explicitly before
  // importing the shared room server.
  process.env.PASEO_ROOMS_PUBLIC_DIR ??= path.join(
    process.cwd(),
    "apps",
    "relay-web",
    "public",
  );
  process.env.DATA_DIR ??= path.join(
    process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo"),
    "paseo-rooms",
  );
}

/**
 * The plugin imports the relay lifecycle from this same Git revision. Dynamic
 * import is intentional: the room server reads its loopback/data settings at
 * module load, after we have established safe plugin-owned defaults.
 */
export async function ensureManagedRoomServer(): Promise<ManagedRoomServer> {
  const started = managed === null;
  if (!managed) {
    configureLocalRuntime();
    managed = import("../relay-web/src/server.js")
      .then(({ startLocalRoomServer }) => startLocalRoomServer())
      .catch((error) => {
        managed = null;
        console.error("paseo-rooms local server failed to start", error);
        throw error;
      });
  }
  const server = await managed;
  return { baseUrl: server.baseUrl, adminToken: server.adminToken, started };
}

export async function closeManagedRoomServer(): Promise<void> {
  if (!managed) return;
  const active = managed;
  managed = null;
  const server = await active;
  await server.close();
}
