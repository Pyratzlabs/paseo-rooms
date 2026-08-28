import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginAgentPanelProps, useAgent, useRpc } from "@getpaseo/plugin";
import React, { useCallback, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { z } from "zod";
import { listShareSessionsRpc, revokeShareSessionRpc, shareSessionRpc } from "./share.shared";

const ThemeSchema = z.object({
  colors: z.object({
    surface0: z.string(),
    foreground: z.string(),
    foregroundMuted: z.string(),
    accent: z.string(),
    accentForeground: z.string(),
    statusDanger: z.string(),
  }),
});

export function SharePanel({ theme, agentId }: PluginAgentPanelProps) {
  const { colors } = ThemeSchema.parse(theme);
  const agent = useAgent(agentId, ({ title, status }) => ({ title, status }));
  const callShare = useRpc(shareSessionRpc);
  const listShares = useRpc(listShareSessionsRpc);
  const revokeShare = useRpc(revokeShareSessionRpc);
  const queryClient = useQueryClient();
  const sharesQuery = useQuery({
    queryKey: ["share-sessions", agentId],
    queryFn: () => listShares({ agentId }),
  });
  const shareMutation = useMutation({
    mutationFn: callShare,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["share-sessions", agentId] }),
  });
  const revokeMutation = useMutation({
    mutationFn: revokeShare,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["share-sessions", agentId] }),
  });
  const [confirmingToken, setConfirmingToken] = useState<string | null>(null);
  const error = sharesQuery.error ?? shareMutation.error ?? revokeMutation.error;

  const styles = useMemo(
    () => ({
      screen: { flex: 1, padding: 24, gap: 16, backgroundColor: colors.surface0 },
      title: { color: colors.foreground, fontSize: 20 },
      detail: { color: colors.foregroundMuted },
      url: { color: colors.foreground, fontSize: 16 },
      room: { gap: 6, padding: 12, borderRadius: 10, backgroundColor: colors.surface0 },
      button: { padding: 14, borderRadius: 10, backgroundColor: colors.accent },
      buttonText: { color: colors.accentForeground, textAlign: "center" as const },
      revoke: { color: colors.statusDanger, paddingVertical: 6 },
      error: { color: colors.statusDanger },
    }),
    [colors],
  );

  const handleShare = useCallback(() => {
    shareMutation.mutate({ agentId, label: agent?.title ?? undefined });
  }, [shareMutation, agentId, agent?.title]);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Share session</Text>
      <Text style={styles.detail}>{agent?.title ?? agentId}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create a share link for this agent"
        onPress={handleShare}
        style={styles.button}
      >
        <Text style={styles.buttonText}>
          {shareMutation.isPending ? "Minting link…" : "Create share link"}
        </Text>
      </Pressable>
      {sharesQuery.isLoading ? <Text style={styles.detail}>Loading share links…</Text> : null}
      {sharesQuery.data?.rooms.length ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.detail}>Active links</Text>
          {sharesQuery.data.rooms.map((room) => (
            <View key={room.token} style={styles.room}>
              <Text style={styles.detail}>{room.label}</Text>
              {/* Selectable so the URL can be copied by hand — the plugin API
                  exposes no clipboard or toast surface. */}
              <Text selectable style={styles.url}>{room.url}</Text>
              {confirmingToken === room.token ? (
                <View style={{ gap: 6 }}>
                  <Text style={styles.detail}>Anyone using this link will lose access.</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Confirm revoking link for ${room.label}`}
                    disabled={revokeMutation.isPending}
                    onPress={() => {
                      revokeMutation.mutate({ agentId, token: room.token });
                      setConfirmingToken(null);
                    }}
                  >
                    <Text style={styles.revoke}>
                      {revokeMutation.isPending ? "Revoking link…" : "Confirm revoke"}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Cancel revoking link for ${room.label}`}
                    disabled={revokeMutation.isPending}
                    onPress={() => setConfirmingToken(null)}
                  >
                    <Text style={styles.detail}>Cancel</Text>
                  </Pressable>
                </View>
              ) : (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Revoke link for ${room.label}`}
                  disabled={revokeMutation.isPending}
                  onPress={() => setConfirmingToken(room.token)}
                >
                  <Text style={styles.revoke}>Revoke link</Text>
                </Pressable>
              )}
            </View>
          ))}
        </View>
      ) : sharesQuery.isSuccess ? (
        <Text style={styles.detail}>No active links yet.</Text>
      ) : null}
      {shareMutation.data?.startedServer ? (
        <Text style={styles.detail}>(the local room server was started for you)</Text>
      ) : null}
      {error ? (
        <Text style={styles.error}>
          {error instanceof Error ? error.message : "The share link operation failed. Please try again."}
        </Text>
      ) : null}
    </View>
  );
}
