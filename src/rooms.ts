import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface Room {
  token: string;
  agentId: string;
  label: string;
  createdAt: string;
}

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const ROOMS_FILE = path.join(DATA_DIR, "rooms.json");
const ADMIN_TOKEN_FILE = path.join(DATA_DIR, "admin-token");

fs.mkdirSync(DATA_DIR, { recursive: true });

function loadRooms(): Map<string, Room> {
  try {
    const raw = JSON.parse(fs.readFileSync(ROOMS_FILE, "utf8")) as Room[];
    return new Map(raw.map((r) => [r.token, r]));
  } catch {
    return new Map();
  }
}

const rooms = loadRooms();

function persist(): void {
  fs.writeFileSync(ROOMS_FILE, JSON.stringify([...rooms.values()], null, 2), { mode: 0o600 });
}

export function createRoom(agentId: string, label: string): Room {
  const room: Room = {
    token: crypto.randomBytes(24).toString("base64url"),
    agentId,
    label,
    createdAt: new Date().toISOString(),
  };
  rooms.set(room.token, room);
  persist();
  return room;
}

export function getRoom(token: string): Room | undefined {
  return rooms.get(token);
}

export function listRooms(): Room[] {
  return [...rooms.values()];
}

export function deleteRoom(token: string): boolean {
  const existed = rooms.delete(token);
  if (existed) persist();
  return existed;
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
