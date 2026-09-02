import type { output as ZodOutput } from "zod";
import {
  listShareSessionsRpc,
  revokeShareSessionRpc,
  shareSessionRpc,
} from "./share.shared";
import { ensureManagedRoomServer } from "./runtime.server";

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
  const server = await ensureManagedRoomServer();
  const res = await fetch(`${server.baseUrl}/api/rooms`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...authorization(server),
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
