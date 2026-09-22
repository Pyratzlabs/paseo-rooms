import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { SharePanel } from "./main.client";

export default function contribute(plugin: PluginClientContext): PluginCleanup {
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
  // Paseo requires a cleanup callback even when it owns all registrations.
  return () => {};
}
