import { createClientChannel } from "./paseo-e2ee.js";
import { relayWebSocketUrl } from "./relay-origin.js";
import type {
  RoomInfo,
  RoomParticipant,
  TimelineItem,
  StreamEvent,
} from "./api.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_APP_RECORD_BYTES = 64 * 1024;
const MAX_REPLAY_IDS = 512;

export interface SecureInvite {
  routeId: string;
  inviteSecret: string;
  hostPublicKey: string;
}

export interface SecureWelcome {
  room: RoomInfo;
  history: Array<{ item: TimelineItem }>;
  participants: RoomParticipant[];
  working: boolean;
}

export type SecureEvent =
  | { type: "presence"; participants: RoomParticipant[] }
  | { type: "stream"; event: StreamEvent; timestamp?: string };

interface SecureRecord {
  v: 2;
  sessionId: string;
  seq: number;
  id: string;
  kind: string;
  payload: unknown;
}

interface Handlers {
  onWelcome(welcome: SecureWelcome): void;
  onEvent(event: SecureEvent): void;
  onClose(): void;
  onError(error: Error): void;
}

export interface SecureRoomSession {
  sendMessage(message: string): Promise<void>;
  answer(questionId: string, actionId: string): Promise<void>;
  answerPrompts(questionId: string, answers: unknown[]): Promise<void>;
  close(): void;
}

export function secureInviteFromLocation(
  token: string | null,
): SecureInvite | null {
  if (!token || !location.hash) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  if (params.get("v") !== "2") return null;
  const inviteSecret = params.get("i");
  const hostPublicKey = params.get("hp");
  if (!inviteSecret || !hostPublicKey) return null;
  return { routeId: token, inviteSecret, hostPublicKey };
}

/** Remove invite material only after React has retained the parsed invite. */
export function hideSecureInviteFromLocation(): void {
  history.replaceState(null, "", location.pathname + location.search);
}

function encodeJson(value: unknown): ArrayBuffer {
  return textEncoder.encode(JSON.stringify(value)).buffer;
}

function decodeJson(data: string | ArrayBuffer): unknown {
  const raw = typeof data === "string" ? data : textDecoder.decode(data);
  if (new Blob([raw]).size > MAX_APP_RECORD_BYTES)
    throw new Error("secure room record too large");
  return JSON.parse(raw);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function rememberOnce(values: string[], value: string): boolean {
  if (values.includes(value)) return false;
  values.push(value);
  if (values.length > MAX_REPLAY_IDS)
    values.splice(0, values.length - MAX_REPLAY_IDS);
  return true;
}

function parseSecureRecord(data: string | ArrayBuffer): SecureRecord | null {
  const value = decodeJson(data);
  if (!isRecord(value)) return null;
  if (
    value.v !== 2 ||
    typeof value.sessionId !== "string" ||
    typeof value.seq !== "number" ||
    !Number.isSafeInteger(value.seq) ||
    typeof value.id !== "string" ||
    typeof value.kind !== "string"
  )
    return null;
  return {
    v: 2,
    sessionId: value.sessionId,
    seq: value.seq,
    id: value.id,
    kind: value.kind,
    payload: value.payload,
  };
}

function isParticipant(value: unknown): value is RoomParticipant {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.role === "host" || value.role === "collaborator")
  );
}

function isTimelineItem(value: unknown): value is TimelineItem {
  return isRecord(value) && typeof value.type === "string";
}

function isRoomInfo(value: unknown): value is RoomInfo {
  if (!isRecord(value)) return false;
  if (value.label !== undefined && typeof value.label !== "string")
    return false;
  if (value.createdAt !== undefined && typeof value.createdAt !== "string")
    return false;
  if (
    value.agent !== undefined &&
    value.agent !== null &&
    !isRecord(value.agent)
  )
    return false;
  if (value.questions !== undefined && !Array.isArray(value.questions))
    return false;
  return true;
}

function isStreamEvent(value: unknown): value is StreamEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "timeline") return isTimelineItem(value.item);
  if (
    value.type === "thread_started" ||
    value.type === "turn_started" ||
    value.type === "turn_completed" ||
    value.type === "turn_canceled"
  )
    return true;
  if (value.type === "turn_failed")
    return value.error === undefined || typeof value.error === "string";
  if (value.type === "permission_requested") return true;
  return (
    value.type === "permission_resolved" || value.type === "attention_required"
  );
}

function isKnownStreamEventType(type: string): boolean {
  return [
    "timeline",
    "thread_started",
    "turn_started",
    "turn_completed",
    "turn_canceled",
    "turn_failed",
    "permission_requested",
    "permission_resolved",
    "attention_required",
  ].includes(type);
}

function parseWelcome(payload: unknown): SecureWelcome | null {
  if (!isRecord(payload) || !isRoomInfo(payload.room)) return null;
  const history = Array.isArray(payload.history)
    ? payload.history.filter(
        (entry): entry is { item: TimelineItem } =>
          isRecord(entry) && isTimelineItem(entry.item),
      )
    : [];
  const participants = Array.isArray(payload.participants)
    ? payload.participants.filter(isParticipant)
    : [];
  return {
    room: payload.room,
    history,
    participants,
    working: payload.working === true,
  };
}

type ParsedSecureEvent = SecureEvent | "unsupported" | null;

/** Parse supported stream events while distinguishing bad data from new kinds. */
export function parseSecureStreamEvent(payload: unknown): ParsedSecureEvent {
  if (!isRecord(payload) || typeof payload.type !== "string") return null;
  if (payload.type === "presence" && Array.isArray(payload.participants)) {
    const participants = payload.participants.filter(isParticipant);
    if (participants.length !== payload.participants.length) return null;
    return {
      type: "presence",
      participants,
    };
  }
  if (payload.type === "stream" && isStreamEvent(payload.event)) {
    return {
      type: "stream",
      event: payload.event,
      ...(typeof payload.timestamp === "string"
        ? { timestamp: payload.timestamp }
        : {}),
    };
  }
  if (payload.type === "stream" && isRecord(payload.event)) {
    if (typeof payload.event.type !== "string") return null;
    return isKnownStreamEventType(payload.event.type) ? null : "unsupported";
  }
  return null;
}

async function openSocket(routeId: string): Promise<WebSocket> {
  const ws = new WebSocket(
    relayWebSocketUrl(`/v2/rooms/${encodeURIComponent(routeId)}/ws`),
  );
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener(
      "error",
      () => reject(new Error("secure room socket failed")),
      { once: true },
    );
  });
}

export async function connectSecureRoom(
  invite: SecureInvite,
  displayName: string,
  handlers: Handlers,
): Promise<SecureRoomSession> {
  const ws = await openSocket(invite.routeId);
  let sessionId: string | null = null;
  let expectedHostSeq = 1;
  let clientSeq = 0;
  const seenIds: string[] = [];

  const transport = {
    onmessage: null as
      | ((message: { data: string | ArrayBuffer; isBinary: boolean }) => void)
      | null,
    onclose: null as ((code: number, reason: string) => void) | null,
    onerror: null as ((error: Error) => void) | null,
    send(data: string | ArrayBuffer) {
      const bytes =
        typeof data === "string"
          ? textEncoder.encode(data)
          : new Uint8Array(data);
      ws.send(
        JSON.stringify({
          v: 2,
          type: typeof data === "string" ? "handshake" : "secure",
          data: toBase64Url(bytes),
        }),
      );
    },
    close(code?: number, reason?: string) {
      ws.close(code, reason);
    },
  };

  ws.addEventListener("message", (message) => {
    try {
      if (typeof message.data !== "string")
        throw new Error("binary outer frame");
      const outer = JSON.parse(message.data) as {
        v?: unknown;
        type?: unknown;
        data?: unknown;
      };
      if (
        outer.v !== 2 ||
        (outer.type !== "handshake" && outer.type !== "secure") ||
        typeof outer.data !== "string"
      )
        throw new Error("invalid outer frame");
      const raw = fromBase64Url(outer.data);
      transport.onmessage?.({
        data:
          outer.type === "handshake"
            ? textDecoder.decode(raw)
            : toArrayBuffer(raw),
        isBinary: outer.type === "secure",
      });
    } catch (error) {
      handlers.onError(
        error instanceof Error ? error : new Error(String(error)),
      );
      ws.close(1003, "invalid secure record");
    }
  });
  ws.addEventListener("close", () => {
    transport.onclose?.(1000, "closed");
    handlers.onClose();
  });
  ws.addEventListener("error", () => {
    transport.onerror?.(new Error("secure room socket error"));
  });

  const channel = await createClientChannel(transport, invite.hostPublicKey, {
    onmessage(data) {
      try {
        const record = parseSecureRecord(data);
        if (!record) throw new Error("invalid secure room record");
        if (sessionId && record.sessionId !== sessionId)
          throw new Error("wrong secure room session");
        if (record.seq !== expectedHostSeq || !rememberOnce(seenIds, record.id))
          throw new Error("replayed secure room record");
        expectedHostSeq += 1;

        if (record.kind === "welcome") {
          sessionId = record.sessionId;
          const welcome = parseWelcome(record.payload);
          if (!welcome) throw new Error("invalid secure welcome");
          handlers.onWelcome(welcome);
          return;
        }
        if (!sessionId) throw new Error("secure event before welcome");
        const event = parseSecureStreamEvent(record.payload);
        // Paseo can add timeline event kinds independently of this renderer.
        // They are authenticated by the room channel, so an event we do not
        // render must not tear down collaboration (and prevent sending) for
        // every connected guest. Malformed envelopes were already rejected by
        // parseSecureRecord above.
        if (event === null) throw new Error("invalid secure room event");
        if (event !== "unsupported") handlers.onEvent(event);
      } catch (error) {
        handlers.onError(
          error instanceof Error ? error : new Error(String(error)),
        );
        channel.close(1011, "invalid secure app record");
      }
    },
    onerror(error) {
      handlers.onError(error);
    },
  });

  await channel.send(
    encodeJson({
      v: 2,
      kind: "join",
      joinAttemptId: randomId(),
      inviteSecret: invite.inviteSecret,
      displayName,
      capabilities: { messages: true, questions: true },
    }),
  );

  async function send(kind: string, payload: unknown): Promise<void> {
    if (!sessionId) throw new Error("secure room is not ready");
    clientSeq += 1;
    await channel.send(
      encodeJson({
        v: 2,
        sessionId,
        seq: clientSeq,
        id: randomId(),
        kind,
        payload,
      }),
    );
  }

  return {
    sendMessage: (message) => send("message", { message }),
    answer: (questionId, actionId) => send("answer", { questionId, actionId }),
    answerPrompts: (questionId, answers) =>
      send("answer_prompts", { questionId, answers }),
    close: () => channel.close(),
  };
}
