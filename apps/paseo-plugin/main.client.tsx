import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type PluginAgentPanelProps,
  useAgent,
  useRpc,
} from "@getpaseo/plugin/client";
import React, { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { z } from "zod";
import {
  CLIENT_ORIGIN_PRESETS,
  DEFAULT_CLIENT_ORIGIN,
  DEFAULT_RELAY_ORIGIN,
  normalizeClientOrigin,
  normalizeRelayOrigin,
  rebaseRoomUrl,
  type ClientOriginChoice,
} from "./client-origin";
import {
  forgetRelayKeyRpc,
  relayStatusRpc,
  listShareSessionsRpc,
  revokeShareSessionRpc,
  shareSessionRpc,
} from "./share.shared";

const CLIENT_ORIGIN_PREFERENCE_KEY = "paseo-rooms.client-origin";
const RELAY_PREFERENCE_KEY = "paseo-rooms.relay-origin";
const RELAY_MODE_PREFERENCE_KEY = "paseo-rooms.relay-mode";

function loadClientOriginPreference(): {
  choice: ClientOriginChoice;
  customOrigin: string;
} {
  try {
    const raw = localStorage.getItem(CLIENT_ORIGIN_PREFERENCE_KEY);
    if (!raw) return { choice: "gitlab", customOrigin: "" };
    const value = JSON.parse(raw) as {
      choice?: unknown;
      customOrigin?: unknown;
    };
    if (
      (value.choice === "pyratz" ||
        value.choice === "gitlab" ||
        value.choice === "custom") &&
      (typeof value.customOrigin === "string" ||
        value.customOrigin === undefined)
    ) {
      return { choice: value.choice, customOrigin: value.customOrigin ?? "" };
    }
  } catch {
    // Storage is optional in plugin webviews and must never block sharing.
  }
  return { choice: "gitlab", customOrigin: "" };
}

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
  const inspectRelay = useRpc(relayStatusRpc);
  const forgetKey = useRpc(forgetRelayKeyRpc);
  const queryClient = useQueryClient();
  const sharesQuery = useQuery({
    queryKey: ["share-sessions", agentId],
    queryFn: () => listShares({ agentId }),
  });
  const revokeMutation = useMutation({
    mutationFn: revokeShare,
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: ["share-sessions", agentId],
      }),
  });
  const [confirmingToken, setConfirmingToken] = useState<string | null>(null);
  const [{ choice: clientChoice, customOrigin }, setClientOriginPreference] =
    useState(loadClientOriginPreference);
  const [isClientMenuOpen, setClientMenuOpen] = useState(false);
  const [relayOrigin, setRelayOrigin] = useState(() => {
    try {
      return localStorage.getItem(RELAY_PREFERENCE_KEY) ?? DEFAULT_RELAY_ORIGIN;
    } catch {
      return DEFAULT_RELAY_ORIGIN;
    }
  });
  const [relayKey, setRelayKey] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const [rememberKey, setRememberKey] = useState(true);
  const [relayMode, setRelayMode] = useState<"auto" | "legacy-key">(() => {
    try {
      return localStorage.getItem(RELAY_MODE_PREFERENCE_KEY) === "legacy-key"
        ? "legacy-key"
        : "auto";
    } catch {
      return "auto";
    }
  });

  const selectedPreset = CLIENT_ORIGIN_PRESETS.find(
    (preset) => preset.id === clientChoice,
  )!;
  const normalizedCustomOrigin = normalizeClientOrigin(customOrigin);
  const selectedClientOrigin =
    clientChoice === "custom"
      ? normalizedCustomOrigin
      : clientChoice === "pyratz"
        ? CLIENT_ORIGIN_PRESETS[0].origin
        : DEFAULT_CLIENT_ORIGIN;
  const customOriginError =
    clientChoice === "custom" && customOrigin.trim() && !normalizedCustomOrigin;
  const normalizedRelayOrigin = normalizeRelayOrigin(
    relayOrigin.trim() || DEFAULT_RELAY_ORIGIN,
  );
  const relayOriginError = relayOrigin.trim() && !normalizedRelayOrigin;
  const relaySelection =
    normalizedRelayOrigin === DEFAULT_RELAY_ORIGIN
      ? {}
      : { relayOrigin: normalizedRelayOrigin ?? undefined };
  const statusKey = ["relay-status", normalizedRelayOrigin, relayMode];
  const relayQuery = useQuery({
    queryKey: statusKey,
    queryFn: () => inspectRelay({ ...relaySelection, relayMode }),
    enabled: Boolean(normalizedRelayOrigin),
    retry: false,
    staleTime: 30_000,
  });
  const policy = relayQuery.data;
  const needsKey = policy?.registration === "key" && !policy.hasSavedKey;
  const shareMutation = useMutation({
    mutationFn: callShare,
    onSuccess: () => {
      setRelayKey("");
      void queryClient.invalidateQueries({
        queryKey: ["share-sessions", agentId],
      });
      void queryClient.invalidateQueries({ queryKey: ["relay-status"] });
    },
  });
  const forgetMutation = useMutation({
    mutationFn: forgetKey,
    onSuccess: () => {
      setRelayKey("");
      void queryClient.invalidateQueries({ queryKey: ["relay-status"] });
    },
  });
  const error =
    sharesQuery.error ??
    shareMutation.error ??
    revokeMutation.error ??
    forgetMutation.error;

  const updateClientOriginPreference = useCallback(
    (next: { choice: ClientOriginChoice; customOrigin: string }) => {
      setClientOriginPreference(next);
      try {
        localStorage.setItem(
          CLIENT_ORIGIN_PREFERENCE_KEY,
          JSON.stringify(next),
        );
      } catch {
        // The current panel session remains usable if storage is unavailable.
      }
    },
    [],
  );

  const styles = useMemo(
    () => ({
      screen: {
        padding: 24,
        gap: 16,
        backgroundColor: colors.surface0,
      },
      title: { color: colors.foreground, fontSize: 20 },
      detail: { color: colors.foregroundMuted },
      url: { color: colors.foreground, fontSize: 16, flexShrink: 1 },
      room: {
        gap: 6,
        padding: 12,
        borderRadius: 10,
        backgroundColor: colors.surface0,
      },
      button: { padding: 14, borderRadius: 10, backgroundColor: colors.accent },
      buttonText: {
        color: colors.accentForeground,
        textAlign: "center" as const,
      },
      revoke: { color: colors.statusDanger, paddingVertical: 6 },
      error: { color: colors.statusDanger },
      picker: {
        gap: 6,
        padding: 12,
        borderRadius: 10,
        backgroundColor: colors.surface0,
      },
      pickerOption: { paddingVertical: 8 },
      pickerOptionSelected: { color: colors.accent },
      input: {
        color: colors.foreground,
        borderWidth: 1,
        borderColor: colors.foregroundMuted,
        borderRadius: 8,
        padding: 10,
      },
    }),
    [colors],
  );

  const handleShare = () => {
    if (!normalizedRelayOrigin || !policy || (needsKey && !relayKey)) return;
    shareMutation.mutate({
      agentId,
      label: agent?.title ?? undefined,
      ...relaySelection,
      relayMode,
      ...(policy.registration === "key" && relayKey
        ? { relayKey, rememberKey: rememberKey && policy.rememberSupported }
        : {}),
    });
  };

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.screen}>
      <Text style={styles.title}>Share session</Text>
      <Text style={styles.detail}>{agent?.title ?? agentId}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Advanced sharing settings"
        accessibilityState={{ expanded: advanced }}
        onPress={() => setAdvanced(!advanced)}
      >
        <Text style={styles.detail}>
          {advanced ? "▾" : "▸"} Advanced settings
        </Text>
      </Pressable>
      {advanced ? (
        <>
          <View style={styles.picker}>
            <Text style={styles.detail}>Open room with</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose room client"
              onPress={() => setClientMenuOpen((open) => !open)}
            >
              <Text style={styles.url}>{selectedPreset.label} ▾</Text>
            </Pressable>
            {isClientMenuOpen ? (
              <View>
                {CLIENT_ORIGIN_PRESETS.map((preset) => (
                  <Pressable
                    key={preset.id}
                    accessibilityRole="radio"
                    accessibilityState={{
                      selected: preset.id === clientChoice,
                    }}
                    accessibilityLabel={`Use ${preset.label} room client`}
                    onPress={() => {
                      updateClientOriginPreference({
                        choice: preset.id,
                        customOrigin,
                      });
                      setClientMenuOpen(false);
                    }}
                    style={styles.pickerOption}
                  >
                    <Text
                      style={
                        preset.id === clientChoice
                          ? styles.pickerOptionSelected
                          : styles.detail
                      }
                    >
                      {preset.id === clientChoice ? "✓ " : ""}
                      {preset.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {clientChoice === "custom" ? (
              <>
                <TextInput
                  accessibilityLabel="Custom room client URL"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  onChangeText={(value) =>
                    updateClientOriginPreference({
                      choice: "custom",
                      customOrigin: value,
                    })
                  }
                  placeholder="https://rooms.example.com"
                  placeholderTextColor={colors.foregroundMuted}
                  style={styles.input}
                  value={customOrigin}
                />
                {customOriginError ? (
                  <Text style={styles.error}>
                    Enter an HTTPS URL, or an HTTP loopback URL for local
                    testing.
                  </Text>
                ) : null}
              </>
            ) : null}
          </View>
          <View style={styles.picker}>
            <Text style={styles.detail}>Relay for new links</Text>
            <TextInput
              accessibilityLabel="Relay endpoint for new rooms"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={(value) => {
                setRelayOrigin(value);
                setRelayKey("");
                try {
                  localStorage.setItem(RELAY_PREFERENCE_KEY, value);
                } catch {
                  // Preference persistence is optional.
                }
              }}
              placeholder="Default relay (configured on this machine)"
              placeholderTextColor={colors.foregroundMuted}
              style={styles.input}
              value={relayOrigin}
            />
            {relayOriginError ? (
              <Text style={styles.error}>
                Enter a WSS URL, or a WS loopback URL for local testing.
              </Text>
            ) : null}
            <Text style={styles.detail}>Relay access</Text>
            {(["auto", "legacy-key"] as const).map((mode) => (
              <Pressable
                key={mode}
                accessibilityRole="radio"
                accessibilityState={{ selected: relayMode === mode }}
                onPress={() => {
                  setRelayMode(mode);
                  setRelayKey("");
                  try {
                    localStorage.setItem(RELAY_MODE_PREFERENCE_KEY, mode);
                  } catch {
                    /* Optional preference. */
                  }
                }}
              >
                <Text
                  style={
                    relayMode === mode
                      ? styles.pickerOptionSelected
                      : styles.detail
                  }
                >
                  {relayMode === mode ? "✓ " : ""}
                  {mode === "auto"
                    ? "Automatic discovery"
                    : "Legacy private relay"}
                </Text>
              </Pressable>
            ))}
            <Text style={styles.detail}>
              Use legacy mode only for an older relay that requires a
              registration key. Settings affect new links only.
            </Text>
          </View>
        </>
      ) : null}
      {relayQuery.isPending && normalizedRelayOrigin ? (
        <Text style={styles.detail}>Checking relay access…</Text>
      ) : null}
      {relayQuery.error ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.error}>
            Could not discover relay access. Check the address in Advanced
            settings. For an older private relay, select Legacy private relay.
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => void relayQuery.refetch()}
          >
            <Text style={styles.detail}>Retry relay discovery</Text>
          </Pressable>
        </View>
      ) : null}
      {policy?.registration === "open" ? (
        <Text style={styles.detail}>
          Public relay · no registration key needed.
        </Text>
      ) : null}
      {policy?.registration === "key" ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.detail}>
            {policy.hasSavedKey
              ? "Private relay · key available on this machine."
              : "This private relay requires a registration key from its operator."}
          </Text>
          {(!policy.hasSavedKey || advanced) &&
          policy.keySource !== "environment" ? (
            <>
              <TextInput
                accessibilityLabel="Relay registration key"
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={setRelayKey}
                placeholder={
                  policy.hasSavedKey
                    ? "Replacement key (optional)"
                    : "Registration key"
                }
                placeholderTextColor={colors.foregroundMuted}
                secureTextEntry
                style={styles.input}
                value={relayKey}
              />
              {policy.rememberSupported ? (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: rememberKey }}
                  onPress={() => setRememberKey(!rememberKey)}
                >
                  <Text style={styles.detail}>
                    {rememberKey ? "☑" : "☐"} Remember key on this machine
                  </Text>
                </Pressable>
              ) : (
                <Text style={styles.detail}>
                  Enter the key when creating a link. Secure saving is
                  unavailable on this platform.
                </Text>
              )}
            </>
          ) : null}
          {advanced && policy.hasSavedKey ? (
            policy.keySource === "environment" ? (
              <Text style={styles.detail}>
                This key is managed by the machine configuration.
              </Text>
            ) : (
              <Pressable
                accessibilityRole="button"
                disabled={forgetMutation.isPending || shareMutation.isPending}
                onPress={() =>
                  forgetMutation.mutate({ relayOrigin: policy.relayOrigin })
                }
              >
                <Text style={styles.revoke}>Forget saved key</Text>
              </Pressable>
            )
          ) : null}
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Create a share link for this agent"
        disabled={
          !normalizedRelayOrigin ||
          !policy ||
          Boolean(needsKey && !relayKey) ||
          shareMutation.isPending ||
          forgetMutation.isPending
        }
        onPress={handleShare}
        style={styles.button}
      >
        <Text style={styles.buttonText}>
          {shareMutation.isPending ? "Minting link…" : "Create share link"}
        </Text>
      </Pressable>
      {sharesQuery.isLoading ? (
        <Text style={styles.detail}>Loading share links…</Text>
      ) : null}
      {sharesQuery.data?.rooms.length ? (
        <View style={{ gap: 8 }}>
          <Text style={styles.detail}>Active links</Text>
          {sharesQuery.data.rooms.map((room) => (
            <View key={room.token} style={styles.room}>
              <Text style={styles.detail}>{room.label}</Text>
              {/* Selectable so the URL can be copied by hand — the plugin API
                  exposes no clipboard or toast surface. */}
              <Text selectable style={styles.url}>
                {selectedClientOrigin
                  ? (rebaseRoomUrl(room.url, selectedClientOrigin) ?? room.url)
                  : room.url}
              </Text>
              {confirmingToken === room.token ? (
                <View style={{ gap: 6 }}>
                  <Text style={styles.detail}>
                    Anyone using this link will lose access.
                  </Text>
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
                      {revokeMutation.isPending
                        ? "Revoking link…"
                        : "Confirm revoke"}
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
        <Text style={styles.detail}>
          (the local room server was started for you)
        </Text>
      ) : null}
      {error ? (
        <Text style={styles.error}>
          {error instanceof Error
            ? error.message
            : "The share link operation failed. Please try again."}
        </Text>
      ) : null}
    </ScrollView>
  );
}
