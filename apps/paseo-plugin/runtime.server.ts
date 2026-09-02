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

let managed: Promise<StartedRoomServer> | null = null;

function configureLocalRuntime(): void {
  const port = Number(process.env.PASEO_ROOMS_PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("paseo-rooms: PASEO_ROOMS_PORT must be a valid TCP port");
  }
  const publicBaseUrl =
    process.env.PASEO_ROOMS_PUBLIC_URL ??
    process.env.PUBLIC_BASE_URL ??
    "https://paseo-rooms.pyratzlabs.fr";
  const publicUrl = new URL(publicBaseUrl);
  const relayUrl =
    process.env.PASEO_ROOMS_RELAY_URL ??
    process.env.RELAY_URL ??
    `${publicUrl.protocol === "https:" ? "wss:" : "ws:"}//${publicUrl.host}/host`;
  const relayKey = process.env.PASEO_ROOMS_RELAY_KEY ?? process.env.RELAY_KEY;
  if (!relayKey) {
    throw new Error(
      "paseo-rooms: PASEO_ROOMS_RELAY_KEY is required before sharing a room",
    );
  }
  process.env.PORT = String(port);
  process.env.BASE_URL = `http://127.0.0.1:${port}`;
  process.env.PUBLIC_BASE_URL = publicUrl.toString().replace(/\/$/, "");
  process.env.RELAY_URL = relayUrl;
  process.env.RELAY_KEY = relayKey;
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
