import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  exportPublicKey,
  generateKeyPair,
  type KeyPair,
} from "./paseo-e2ee.js";

export interface Room {
  token: string;
  agentId: string;
  label: string;
  createdAt: string;
  protocol: 1;
}

export interface SecureRoom {
  token: string;
  agentId: string;
  label: string;
  createdAt: string;
  protocol: 2;
  inviteSecret: string;
  hostPublicKey: string;
  hostKeyPair: KeyPair;
  seenJoinAttemptIds: string[];
  seenClientRecordIds: string[];
}

export type AnyRoom = Room | SecureRoom;

export interface PublicRoom {
  token: string;
  agentId: string;
  label: string;
  createdAt: string;
  protocol: 1 | 2;
}

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, "admin-token");

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadRooms(): Map<string, Room> {
  try {
    const raw = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8")) as Array<
      Omit<Room, "protocol"> & { protocol?: 1 }
    >;
    return new Map(raw.map((r) => [r.token, { ...r, protocol: 1 as const }]));
  } catch {
    return new Map();
  }
}

const rooms = loadRooms();
const secureRooms = new Map<string, SecureRoom>();

function persist(): void {
  fs.writeFileSync(
    ROOMS_FILE,
    JSON.stringify([...rooms.values()].map(toPublicRoom), null, 2),
    { mode: 0o600 },
  );
}

export function createRoom(agentId: string, label: string): SecureRoom {
  const hostKeyPair = generateKeyPair();
  const room: SecureRoom = {
    token: crypto.randomBytes(32).toString("base64url"),
    agentId,
    label,
    createdAt: new Date().toISOString(),
    protocol: 2,
    inviteSecret: crypto.randomBytes(32).toString("base64url"),
    hostPublicKey: exportPublicKey(hostKeyPair.publicKey),
    hostKeyPair,
    seenJoinAttemptIds: [],
    seenClientRecordIds: [],
  };
  secureRooms.set(room.token, room);
  return room;
}

export function getRoom(token: string): AnyRoom | undefined {
  return secureRooms.get(token) ?? rooms.get(token);
}

export function getSecureRoom(token: string): SecureRoom | undefined {
  return secureRooms.get(token);
}

export function isSecureRoom(room: AnyRoom): room is SecureRoom {
  return room.protocol === 2;
}

export function toPublicRoom(room: AnyRoom): PublicRoom {
  return {
    token: room.token,
    agentId: room.agentId,
    label: room.label,
    createdAt: room.createdAt,
    protocol: room.protocol,
  };
}

export function publicRoomUrl(room: AnyRoom, baseUrl: string): string {
  const url = `${baseUrl}/r/${room.token}`;
  if (!isSecureRoom(room)) return url;
  return `${url}#v=2&i=${encodeURIComponent(room.inviteSecret)}&hp=${encodeURIComponent(room.hostPublicKey)}`;
}

export function listRooms(): AnyRoom[] {
  return [...rooms.values(), ...secureRooms.values()];
}

export function relayTokens(): string[] {
  return [...rooms.keys()];
}

export function relayRoutes(): Array<{ token: string; protocol: 2 }> {
  return [...secureRooms.keys()].map((token) => ({
    token,
    protocol: 2 as const,
  }));
}

export function deleteRoom(token: string): boolean {
  const deletedSecure = secureRooms.delete(token);
  const deletedLegacy = rooms.delete(token);
  if (deletedLegacy) persist();
  return deletedSecure || deletedLegacy;
}

export function getAdminToken(): string {
  try {
    const token = fs.readFileSync(ADMIN_TOKEN_FILE, "utf8").trim();
    if (token) return token;
  } catch {
    /* first run */
  }
  const token = crypto.randomBytes(24).toString("base64url");
  fs.writeFileSync(ADMIN_TOKEN_FILE, token + "\n", { mode: 0o600 });
  return token;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
