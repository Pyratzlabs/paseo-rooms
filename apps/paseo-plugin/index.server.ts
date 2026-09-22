import type { PluginServerContext } from "@getpaseo/plugin/server";
import { closeManagedRoomServer } from "./runtime.server";
import {
  listShareSessions,
  revokeShareSession,
  shareSession,
} from "./share.server";
import {
  listShareSessionsRpc,
  revokeShareSessionRpc,
  shareSessionRpc,
} from "./share.shared";

export default function contribute(plugin: PluginServerContext) {
  plugin.handle(shareSessionRpc, shareSession);
  plugin.handle(listShareSessionsRpc, listShareSessions);
  plugin.handle(revokeShareSessionRpc, revokeShareSession);
  return closeManagedRoomServer;
}
