import { SharePanel } from "./apps/paseo-plugin/main.client";
import { closeManagedRoomServer } from "./apps/paseo-plugin/runtime.server";
import {
  listShareSessions,
  revokeShareSession,
  shareSession,
} from "./apps/paseo-plugin/share.server";
import {
  listShareSessionsRpc,
  revokeShareSessionRpc,
  shareSessionRpc,
} from "./apps/paseo-plugin/share.shared";

// Paseo independently compiles this root entry into server and client bundles.
// Keep its context structural so the installable root has no bare dependency on
// the SDK owned by the nested plugin workspace.
interface PaseoRoomsPluginContext {
  handle(contract: unknown, handler: unknown): void;
  addWorkspacePanel(contribution: {
    id: string;
    title: string;
    icon: string;
    context: "agent";
    Component: unknown;
  }): void;
  addCommandCenterItem(contribution: {
    id: string;
    title: string;
    icon: string;
    keywords: string[];
    context: "agent";
    onSelect(context: { openPanel(id: string): void }): void | Promise<void>;
  }): void;
}

/**
 * Paseo builds separate client and server bundles from this root entry point.
 * Keeping registrations here lets its `.client` and `.server` boundary plugin
 * remove the incompatible imports from the opposite bundle.
 */
export default function paseoRooms(plugin: PaseoRoomsPluginContext) {
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
