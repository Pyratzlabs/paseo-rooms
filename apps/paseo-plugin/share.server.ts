import type { output as ZodOutput } from "zod";
import {
  relayStatusRpc,
  forgetRelayKeyRpc,
  listShareSessionsRpc,
  revokeShareSessionRpc,
  shareSessionRpc,
} from "./share.shared";
import {
  configuredRelayOrigin,
  ensureManagedRoomServer,
} from "./runtime.server";
import { normalizeRelayOrigin } from "../relay-web/src/relay-target";

import { RelayCredentialStore } from "./relay-credentials.server";
import { discoverRelayPolicy } from "../relay-web/src/relay-policy";

function selectedOrigin(input?: string): string {
  const origin =
    input === undefined ? configuredRelayOrigin() : normalizeRelayOrigin(input);
  if (!origin)
    throw new Error(
      "paseo-rooms: relay must use WSS, or WS only on a loopback address",
    );
  return origin;
}

async function policyFor(origin: string, mode?: "auto" | "legacy-key") {
  try {
    return await discoverRelayPolicy(origin, mode);
  } catch {
    throw new Error(
      "paseo-rooms: relay discovery failed. Check the relay address and connection. For an older private relay, select Legacy private in Advanced.",
    );
  }
}

export async function relayStatus(
  input: ZodOutput<typeof relayStatusRpc.input>,
): Promise<ZodOutput<typeof relayStatusRpc.output>> {
  const origin = selectedOrigin(input.relayOrigin);
  const policy = await policyFor(origin, input.relayMode);
  const store = new RelayCredentialStore();
  const credential =
    policy.registration === "key"
      ? store.resolve(origin)
      : { source: "none" as const };
  return {
    relayOrigin: origin,
    registration: policy.registration,
    hasSavedKey: Boolean("key" in credential && credential.key),
    keySource: credential.source,
    rememberSupported: store.rememberSupported,
  };
}

export async function forgetRelayKey(
  input: ZodOutput<typeof forgetRelayKeyRpc.input>,
): Promise<{ ok: true }> {
  new RelayCredentialStore().forget(selectedOrigin(input.relayOrigin));
  return { ok: true };
}

// Plugin RPCs run only inside the trusted local Paseo desktop host. The
// framework does not provide a caller identity to handlers, so `agentId` is a
// local panel selector, not an authorization credential. Do not reuse these
// handlers for remotely callable RPCs without an authenticated ownership
// boundary.

function authorization(server: { adminToken: string }): HeadersInit {
  return { authorization: `Bearer ${server.adminToken}` };
}

function failure(operation: string, res: Response): never {
  throw new Error(`paseo-rooms: ${operation} failed (${res.status})`);
}

export async function shareSession(
  input: ZodOutput<typeof shareSessionRpc.input>,
): Promise<{ url: string; token: string; startedServer: boolean }> {
  const relayOrigin = selectedOrigin(input.relayOrigin);
  const policy = await policyFor(relayOrigin, input.relayMode);
  const store = new RelayCredentialStore();
  const relayKey =
    policy.registration === "key"
      ? (input.relayKey ?? store.resolve(relayOrigin).key)
      : undefined;
  if (policy.registration === "key" && !relayKey)
    throw new Error(
      "paseo-rooms: this private relay requires a registration key",
    );
  if (input.rememberKey && input.relayKey && !store.rememberSupported)
    throw new Error(
      "paseo-rooms: remembering keys is unavailable on this platform; use a session-only key",
    );
  const server = await ensureManagedRoomServer();
  const res = await fetch(`${server.baseUrl}/api/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authorization(server),
    },
    body: JSON.stringify({
      agentId: input.agentId,
      ...(input.label ? { label: input.label } : {}),
      ...(relayOrigin ? { relayOrigin } : {}),
      ...(relayKey ? { relayKey } : {}),
      relayMode: input.relayMode ?? "auto",
    }),
  });

  if (!res.ok) failure("room creation", res);

  const body = (await res.json()) as { url?: string; token?: string };
  if (!body.url || !body.token) {
    throw new Error("paseo-rooms: room server returned no url");
  }
  if (policy.registration === "key" && input.rememberKey && input.relayKey) {
    try {
      store.save(relayOrigin, input.relayKey);
    } catch (error) {
      // A failed remember operation must not silently leave an unreported link.
      await fetch(
        `${server.baseUrl}/api/rooms/${encodeURIComponent(body.token)}`,
        { method: "DELETE", headers: authorization(server) },
      );
      throw error;
    }
  }
  return { url: body.url, token: body.token, startedServer: server.started };
}

export async function listShareSessions(
  input: ZodOutput<typeof listShareSessionsRpc.input>,
): Promise<ZodOutput<typeof listShareSessionsRpc.output>> {
  const server = await ensureManagedRoomServer();
  const res = await fetch(`${server.baseUrl}/api/rooms`, {
    headers: authorization(server),
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
  const server = await ensureManagedRoomServer();
  const listed = await fetch(`${server.baseUrl}/api/rooms`, {
    headers: authorization(server),
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
    `${server.baseUrl}/api/rooms/${encodeURIComponent(input.token)}`,
    {
      method: "DELETE",
      headers: authorization(server),
    },
  );
  if (!res.ok && res.status !== 404) failure("room revocation", res);
  return { ok: true };
}
