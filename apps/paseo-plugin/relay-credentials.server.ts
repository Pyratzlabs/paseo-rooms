import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

/** Never forward a saved relay credential to a different endpoint. */
export function savedRelayKey(
  contents: string,
  relayUrl: string,
): string | undefined {
  const saved = parseEnv(contents);
  if (!saved.RELAY_URL || !saved.RELAY_KEY) return undefined;
  try {
    if (new URL(saved.RELAY_URL).href !== new URL(relayUrl).href)
      return undefined;
  } catch {
    return undefined;
  }
  return saved.RELAY_KEY;
}

export function readSavedRelayKey(relayUrl: string): string | undefined {
  const filename = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "paseo-rooms.env",
  );
  let contents: string;
  try {
    contents = readFileSync(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("paseo-rooms: could not read saved relay configuration");
  }
  // Parse data only; never source a shell file or import its other settings.
  return savedRelayKey(contents, relayUrl);
}
