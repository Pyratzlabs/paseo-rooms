import { normalizeRelayOrigin } from "./relay-target.js";

export type RelayMode = "auto" | "legacy-key";
export interface RelayPolicy {
  version: 1;
  registration: "open" | "key";
  roomProtocols: (1 | 2)[];
  routeOwnership?: "sha256-secret-v1";
  registrationAck: boolean;
}

/** Discovery never carries credentials and never follows a redirect. */
export async function discoverRelayPolicy(
  origin: string,
  mode: RelayMode = "auto",
): Promise<RelayPolicy> {
  const normalized = normalizeRelayOrigin(origin);
  if (!normalized) throw new Error("A valid relay origin is required");
  if (mode === "legacy-key") {
    return {
      version: 1,
      registration: "key",
      roomProtocols: [1, 2],
      registrationAck: false,
    };
  }
  if (mode !== "auto") throw new Error("Invalid relay mode");
  const url = normalized.replace(/^ws/, "http") + "/.well-known/paseo-rooms";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, {
      redirect: "error",
      signal: controller.signal,
      credentials: "omit",
    });
    if (!response.ok)
      throw new Error(
        "Relay discovery unavailable; select legacy private mode only for an older relay",
      );
    if (!response.body) throw new Error("Invalid relay capability response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 4096)
          throw new Error("Relay capability response is too large");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      !value ||
      value.version !== 1 ||
      (value.registration !== "open" && value.registration !== "key") ||
      !Array.isArray(value.roomProtocols) ||
      !value.roomProtocols.includes(2) ||
      value.roomProtocols.some((v: unknown) => v !== 1 && v !== 2) ||
      value.routeOwnership !== "sha256-secret-v1" ||
      value.registrationAck !== true
    ) {
      throw new Error("Unsupported relay capabilities");
    }
    return {
      version: 1,
      registration: value.registration,
      roomProtocols: value.roomProtocols as (1 | 2)[],
      routeOwnership: "sha256-secret-v1",
      registrationAck: true,
    };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("Relay discovery timed out");
    if (error instanceof SyntaxError)
      throw new Error("Invalid relay capability response");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
