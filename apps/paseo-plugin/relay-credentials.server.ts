import {
  constants,
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseEnv } from "node:util";
import { normalizeRelayOrigin } from "../relay-web/src/relay-target";

type Source = "environment" | "saved" | "legacy" | "none";
type Entries = Record<string, string | null>;
const MAX_ENTRIES = 128;
const MAX_BYTES = 600_000;

/** Legacy configuration alone may contain the host path. */
export function credentialOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.pathname === "/host") url.pathname = "/";
    return normalizeRelayOrigin(url.toString());
  } catch {
    return null;
  }
}

export function savedRelayKey(
  contents: string,
  relayUrl: string,
): string | undefined {
  const saved = parseEnv(contents);
  const origin = credentialOrigin(relayUrl);
  return origin &&
    saved.RELAY_URL &&
    saved.RELAY_KEY &&
    credentialOrigin(saved.RELAY_URL) === origin
    ? saved.RELAY_KEY
    : undefined;
}

export interface CredentialStoreOptions {
  configHome?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/** Unix-only persistence. Every mutation is synchronous, so local RPC writes serialize. */
export class RelayCredentialStore {
  readonly rememberSupported: boolean;
  private readonly root: string;
  private readonly directory: string;
  private readonly filename: string;
  private readonly env: NodeJS.ProcessEnv;
  constructor(options: CredentialStoreOptions = {}) {
    this.env = options.env ?? process.env;
    this.root =
      options.configHome ??
      this.env.XDG_CONFIG_HOME ??
      path.join(os.homedir(), ".config");
    this.directory = path.join(this.root, "paseo-rooms");
    this.filename = path.join(this.directory, "relay-credentials.json");
    this.rememberSupported = (options.platform ?? process.platform) !== "win32";
  }
  private origin(value: string): string {
    const origin = normalizeRelayOrigin(value);
    if (!origin) throw new Error("paseo-rooms: invalid relay origin");
    return origin;
  }
  private directoryReady(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const rootStat = lstatSync(this.root);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      rootStat.uid !== process.getuid?.() ||
      (rootStat.mode & 0o022) !== 0
    )
      throw new Error("unsafe configuration directory");
    try {
      mkdirSync(this.directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = lstatSync(this.directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.()
    )
      throw new Error("unsafe directory");
    const fd = openSync(
      this.directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fchmodSync(fd, 0o700);
    } finally {
      closeSync(fd);
    }
  }
  private read(): Entries {
    if (!this.rememberSupported) return Object.create(null) as Entries;
    try {
      this.directoryReady();
      let fd: number;
      try {
        fd = openSync(this.filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return Object.create(null) as Entries;
        throw error;
      }
      let data: unknown;
      try {
        const stat = fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          stat.nlink !== 1 ||
          stat.size > MAX_BYTES
        )
          throw new Error("unsafe file");
        fchmodSync(fd, 0o600);
        data = JSON.parse(readFileSync(fd, "utf8"));
      } finally {
        closeSync(fd);
      }
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error("invalid store");
      const entries = Object.entries(data);
      if (
        entries.length > MAX_ENTRIES ||
        entries.some(
          ([origin, key]) =>
            normalizeRelayOrigin(origin) !== origin ||
            (key !== null &&
              (typeof key !== "string" ||
                key.length === 0 ||
                key.length > 4096)),
        )
      )
        throw new Error("invalid store");
      return Object.assign(Object.create(null), data) as Entries;
    } catch {
      throw new Error("paseo-rooms: could not safely read relay credentials");
    }
  }
  private update(origin: string, key: string | null): void {
    if (!this.rememberSupported)
      throw new Error(
        "paseo-rooms: remembering relay keys is unavailable on this platform",
      );
    const entries = this.read();
    entries[origin] = key;
    if (Object.keys(entries).length > MAX_ENTRIES)
      throw new Error("paseo-rooms: saved relay limit reached");
    const serialized = JSON.stringify(entries);
    if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES)
      throw new Error("paseo-rooms: saved relay storage limit reached");
    const temporary = path.join(this.directory, `.credentials-${randomUUID()}`);
    try {
      const fd = openSync(
        temporary,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, serialized);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, this.filename);
    } catch {
      throw new Error("paseo-rooms: could not safely save relay credentials");
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  resolve(value: string): { key?: string; source: Source } {
    const origin = this.origin(value);
    const configured = this.env.PASEO_ROOMS_RELAY_URL ?? this.env.RELAY_URL;
    const environmentKey = this.env.PASEO_ROOMS_RELAY_KEY ?? this.env.RELAY_KEY;
    // An unscoped environment key applies only to the plugin's configured default.
    const configuredOrigin = configured
      ? credentialOrigin(configured)
      : credentialOrigin(
          this.env.PASEO_ROOMS_PUBLIC_URL ??
            this.env.PUBLIC_BASE_URL ??
            "https://paseo-rooms.pyratz.com",
        );
    if (environmentKey && configuredOrigin === origin)
      return { key: environmentKey, source: "environment" };
    const entries = this.read();
    if (Object.hasOwn(entries, origin))
      return entries[origin]
        ? { key: entries[origin]!, source: "saved" }
        : { source: "none" };
    let contents: string;
    try {
      contents = readFileSync(path.join(this.root, "paseo-rooms.env"), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { source: "none" };
      throw new Error("paseo-rooms: could not read saved relay configuration");
    }
    const key = savedRelayKey(contents, origin);
    return key ? { key, source: "legacy" } : { source: "none" };
  }
  save(value: string, key: string): void {
    if (!key || key.length > 4096)
      throw new Error("paseo-rooms: invalid relay key");
    this.update(this.origin(value), key);
  }
  forget(value: string): void {
    this.update(this.origin(value), null);
  }
}

export function readSavedRelayKey(relayUrl: string): string | undefined {
  const origin = credentialOrigin(relayUrl);
  return origin ? new RelayCredentialStore().resolve(origin).key : undefined;
}
