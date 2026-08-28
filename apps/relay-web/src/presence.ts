export interface RoomParticipant {
  id: string;
  name: string;
  role: "host" | "collaborator";
}

const host: RoomParticipant = { id: "host", name: "Host", role: "host" };

/** Keep public display names short and unable to imitate timeline markup. */
export function sanitizeParticipantName(raw: unknown): string | null {
  if (typeof raw !== "string" || /[\n\r]/.test(raw)) return null;
  const name = raw.replace(/[\[\]]/g, "").trim().slice(0, 40);
  return name.length > 0 ? name : null;
}

/** Parse the only browser-to-room live frame accepted by this feature. */
export function parsePresenceHello(raw: string): string | null {
  if (raw.length > 512) return null;
  try {
    const frame = JSON.parse(raw) as { type?: unknown; name?: unknown };
    return frame.type === "hello" ? sanitizeParticipantName(frame.name) : null;
  } catch {
    return null;
  }
}

/** In-memory, per-socket room presence. It is intentionally not identity/auth. */
export class RoomPresence<Socket extends object> {
  private nextId = 1;
  private participants = new Map<Socket, RoomParticipant>();

  join(socket: Socket, rawName: unknown): boolean {
    const name = sanitizeParticipantName(rawName);
    if (!name) return false;
    const existing = this.participants.get(socket);
    if (existing) return false;
    this.participants.set(socket, {
      id: `participant-${this.nextId++}`,
      name,
      role: "collaborator",
    });
    return true;
  }

  leave(socket: Socket): boolean {
    return this.participants.delete(socket);
  }

  list(): RoomParticipant[] {
    return [host, ...this.participants.values()];
  }
}
