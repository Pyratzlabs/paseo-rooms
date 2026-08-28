import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { output as ZodOutput } from "zod";
import {
  listShareSessionsRpc,
  revokeShareSessionRpc,
  shareSessionRpc,
} from "./share.shared";

/**
 * Runtime notes (verified against the Paseo plugin compiler):
 *
 * - The server half of a plugin is bundled to CommonJS and evaluated inside a
 *   wrapper function, so neither `__dirname` nor `import.meta.url` is available.
 * - The plugin subprocess is forked without `cwd` and without any env var
 *   naming the plugin directory, so a plugin genuinely cannot locate its own
 *   files at runtime.
 *
 * Consequence: the config file cannot be found "relatively". We resolve it from
 * an explicit list of absolute candidates instead. `paseo-rooms.config.json`
 * shipped next to this file is still the source of truth — it is just reached
 * via PLUGIN_DIR below (or the PASEO_ROOMS_PLUGIN_DIR / PASEO_ROOMS_CONFIG env
 * overrides) rather than via module-relative resolution.
 */
const PLUGIN_DIR = "/home/thomas/code/paseo-rooms/apps/paseo-plugin";

// Plugin RPCs run only inside the trusted local Paseo desktop host. The
// framework does not provide a caller identity to handlers, so `agentId` is a
// local panel selector, not an authorization credential. Do not reuse these
// handlers for remotely callable RPCs without an authenticated ownership
// boundary.

interface RoomsConfig {
  roomsPath: string;
  baseUrl: string;
  startCommand: string;
  startArgs: string[];
  startTimeoutMs: number;
}

const DEFAULT_CONFIG: RoomsConfig = {
  roomsPath: "/home/thomas/code/paseo-rooms/apps/relay-web",
  baseUrl: "http://localhost:3000",
  startCommand: "npm",
  startArgs: ["start"],
  startTimeoutMs: 45_000,
};

function configCandidates(): string[] {
  const candidates: string[] = [];
  const explicit = process.env.PASEO_ROOMS_CONFIG;
  if (explicit) candidates.push(explicit);
  const pluginDir = process.env.PASEO_ROOMS_PLUGIN_DIR ?? PLUGIN_DIR;
  candidates.push(path.join(pluginDir, "paseo-rooms.config.json"));
  candidates.push(
    path.join(os.homedir(), ".config", "paseo-rooms", "plugin.json"),
  );
  return candidates;
}

export function loadConfig(): RoomsConfig {
  for (const candidate of configCandidates()) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(
        readFileSync(candidate, "utf8"),
      ) as Partial<RoomsConfig>;
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch (error) {
      throw new Error(
        `paseo-rooms: config at ${candidate} is not valid JSON: ${describe(error)}`,
      );
    }
  }
  return DEFAULT_CONFIG;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isHealthy(baseUrl: string, timeoutMs = 1500): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/healthz`, {
      signal: controller.signal,
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean };
    return body.ok === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Boot the room server detached so it outlives both this RPC and the plugin
 * subprocess, then wait for /healthz to answer.
 */
async function startRoomServer(config: RoomsConfig): Promise<void> {
  if (!existsSync(config.roomsPath)) {
    throw new Error(`paseo-rooms: checkout not found at ${config.roomsPath}`);
  }
  const child = spawn(config.startCommand, config.startArgs, {
    cwd: config.roomsPath,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, BASE_URL: config.baseUrl },
  });
  child.on("error", () => undefined);
  child.unref();

  const deadline = Date.now() + config.startTimeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await isHealthy(config.baseUrl)) return;
  }
  throw new Error(
    `paseo-rooms: room server did not become healthy at ${config.baseUrl} within ${config.startTimeoutMs}ms`,
  );
}

function readAdminToken(config: RoomsConfig): string {
  const tokenPath = path.join(config.roomsPath, "data", "admin-token");
  if (!existsSync(tokenPath)) {
    throw new Error(`paseo-rooms: admin token missing at ${tokenPath}`);
  }
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!token)
    throw new Error(`paseo-rooms: admin token at ${tokenPath} is empty`);
  return token;
}

async function ensureRoomServer(config: RoomsConfig): Promise<boolean> {
  if (await isHealthy(config.baseUrl)) return false;
  await startRoomServer(config);
  return true;
}

function authorization(config: RoomsConfig): HeadersInit {
  return { authorization: `Bearer ${readAdminToken(config)}` };
}

function failure(operation: string, res: Response): never {
  throw new Error(`paseo-rooms: ${operation} failed (${res.status})`);
}

export async function shareSession(
  input: ZodOutput<typeof shareSessionRpc.input>,
): Promise<{ url: string; token: string; startedServer: boolean }> {
  const config = loadConfig();
  const startedServer = await ensureRoomServer(config);

  // Read the admin token only after the server is up: `npm start` mints it on
  // first boot, so reading earlier can race an initial run.
  const res = await fetch(`${config.baseUrl}/api/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authorization(config),
    },
    body: JSON.stringify(
      input.label
        ? { agentId: input.agentId, label: input.label }
        : { agentId: input.agentId },
    ),
  });

  if (!res.ok) failure("room creation", res);

  const body = (await res.json()) as { url?: string; token?: string };
  if (!body.url || !body.token) {
    throw new Error("paseo-rooms: room server returned no url");
  }
  return { url: body.url, token: body.token, startedServer };
}

export async function listShareSessions(
  input: ZodOutput<typeof listShareSessionsRpc.input>,
): Promise<ZodOutput<typeof listShareSessionsRpc.output>> {
  const config = loadConfig();
  await ensureRoomServer(config);
  const res = await fetch(`${config.baseUrl}/api/rooms`, {
    headers: authorization(config),
  });
  if (!res.ok) failure("room listing", res);
  const body = (await res.json()) as {
    rooms?: Array<{
      agentId?: unknown;
      token?: unknown;
      url?: unknown;
      label?: unknown;
      createdAt?: unknown;
    }>;
  };
  const rooms = (body.rooms ?? []).flatMap((room) => {
    if (
      room.agentId !== input.agentId ||
      typeof room.token !== "string" ||
      typeof room.url !== "string" ||
      typeof room.label !== "string" ||
      typeof room.createdAt !== "string"
    ) {
      return [];
    }
    return [
      {
        token: room.token,
        url: room.url,
        label: room.label,
        createdAt: room.createdAt,
      },
    ];
  });
  return { rooms };
}

export async function revokeShareSession(
  input: ZodOutput<typeof revokeShareSessionRpc.input>,
): Promise<ZodOutput<typeof revokeShareSessionRpc.output>> {
  const config = loadConfig();
  await ensureRoomServer(config);
  const listed = await fetch(`${config.baseUrl}/api/rooms`, {
    headers: authorization(config),
  });
  if (!listed.ok) failure("room listing", listed);
  const body = (await listed.json()) as {
    rooms?: Array<{ token?: unknown; agentId?: unknown }>;
  };
  if (
    !body.rooms?.some(
      (room) => room.token === input.token && room.agentId === input.agentId,
    )
  ) {
    throw new Error("paseo-rooms: share link does not belong to this agent");
  }
  const res = await fetch(
    `${config.baseUrl}/api/rooms/${encodeURIComponent(input.token)}`,
    {
      method: "DELETE",
      headers: authorization(config),
    },
  );
  if (!res.ok && res.status !== 404) failure("room revocation", res);
  return { ok: true };
}
