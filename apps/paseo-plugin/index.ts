import type { PluginContext } from "@getpaseo/plugin";
import { SharePanel } from "./main.client";
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

/**
 * The compiler splits this entry point in two: `plugin.handle` survives only in
 * the server bundle and `plugin.add*` only in the client bundle, and the
 * `./*.server` / `./*.client` imports are stripped from the opposite bundle.
 * That is what keeps the admin token out of anything the UI can see, so keep
 * every registration below as a plain top-level statement.
 */
export default function contribute(plugin: PluginContext) {
  plugin.handle(shareSessionRpc, shareSession);
  plugin.handle(listShareSessionsRpc, listShareSessions);
  plugin.handle(revokeShareSessionRpc, revokeShareSession);
  plugin.addWorkspacePanel({
    id: "share-session",
    title: "Share session",
    icon: "Share2",
    context: "agent",
    Component: SharePanel,
  });
  plugin.addCommandCenterItem({
    id: "share-session",
    title: "Share session",
    icon: "Share2",
    keywords: ["share", "room", "link", "collaborate"],
    context: "agent",
    onSelect({ openPanel }) {
      openPanel("share-session");
    },
  });
  return async () => {
    await closeManagedRoomServer();
  };
}
