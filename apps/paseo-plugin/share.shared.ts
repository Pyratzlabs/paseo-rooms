import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const SharedRoomSchema = z.object({
  token: z.string(),
  url: z.string(),
  label: z.string(),
  createdAt: z.string(),
});

/**
 * Mint a share link for one agent. Only the resulting public room URL crosses
 * back to the client — the admin token never leaves the server bundle.
 */
export const shareSessionRpc = defineRpc({
  // Plugin RPC names must match /^[a-z][a-z0-9._-]*$/ (lowercase only).
  name: "share-session",
  input: z.object({
    agentId: z.string().min(1),
    label: z.string().optional(),
    relayOrigin: z.string().max(512).optional(),
    /** Trusted local IPC only; never returned from this RPC. */
    relayKey: z.string().min(1).max(4096).optional(),
  }),
  output: z.object({
    url: z.string(),
    token: z.string(),
    /** True when this call had to boot the local room server itself. */
    startedServer: z.boolean(),
  }),
});

/** List the persisted links that belong to one focused agent. */
export const listShareSessionsRpc = defineRpc({
  name: "list-share-sessions",
  input: z.object({ agentId: z.string().min(1) }),
  output: z.object({ rooms: z.array(SharedRoomSchema) }),
});

/** Permanently invalidate one share link. */
export const revokeShareSessionRpc = defineRpc({
  name: "revoke-share-session",
  input: z.object({ agentId: z.string().min(1), token: z.string().min(1) }),
  output: z.object({ ok: z.literal(true) }),
});
