import type { PluginServerContext } from "@getpaseo/plugin/server";
import { closeManagedRoomServer } from "./runtime.server";
import {
  relayStatus,
  forgetRelayKey,
  listShareSessions,
  revokeShareSession,
  shareSession,
} from "./share.server";
import {
  relayStatusRpc,
  forgetRelayKeyRpc,
  listShareSessionsRpc,
  revokeShareSessionRpc,
  shareSessionRpc,
} from "./share.shared";

export default function contribute(plugin: PluginServerContext) {
  plugin.handle(relayStatusRpc, relayStatus);
  plugin.handle(forgetRelayKeyRpc, forgetRelayKey);
  plugin.handle(shareSessionRpc, shareSession);
  plugin.handle(listShareSessionsRpc, listShareSessions);
  plugin.handle(revokeShareSessionRpc, revokeShareSession);
  return closeManagedRoomServer;
}
