import { createClientChannel } from "./paseo-e2ee.js";
import { inviteRelayOrigin, relayWebSocketUrl } from "./relay-origin.js";
import type {
  RoomInfo,
  RoomParticipant,
  TimelineItem,
  StreamEvent,
} from "./api.js";
import {
  IMAGE_CAPABILITY,
  IMAGE_CHUNK_BYTES,
  MAX_IMAGE_BYTES,
  MAX_MESSAGE_BYTES,
  IMAGE_REQUEST_TIMEOUT_MS,
  isObject,
  validId,
  isRoomImage,
  type RoomImage,
  type UploadedImage,
  type SubmissionReceipt,
} from "../../shared/room-attachments.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_APP_RECORD_BYTES = 64 * 1024;
const MAX_REPLAY_IDS = 512;

export interface SecureInvite {
  routeId: string;
  inviteSecret: string;
  hostPublicKey: string;
  relayOrigin?: string;
}

export interface SecureWelcome {
  room: RoomInfo;
  history: Array<{ item: TimelineItem }>;
  participants: RoomParticipant[];
  working: boolean;
  images: boolean;
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
  sendImageMessage(
    message: string,
    file: File | null,
    submissionKey: string,
    progress: (value: number) => void,
  ): Promise<SubmissionReceipt>;
  readImage(image: RoomImage, signal?: AbortSignal): Promise<Blob>;
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
  const explicitRelay = params.get("relay");
  const relayOrigin = inviteRelayOrigin(explicitRelay);
  if (explicitRelay && !relayOrigin) return null;
  return {
    routeId: token,
    inviteSecret,
    hostPublicKey,
    relayOrigin: relayOrigin ?? undefined,
  };
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
    images:
      isObject(payload.capabilities) &&
      payload.capabilities[IMAGE_CAPABILITY] === true,
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

async function openSocket(
  routeId: string,
  relayOrigin?: string,
): Promise<WebSocket> {
  const ws = new WebSocket(
    relayOrigin
      ? `${relayOrigin}/v2/rooms/${encodeURIComponent(routeId)}/ws`
      : relayWebSocketUrl(`/v2/rooms/${encodeURIComponent(routeId)}/ws`),
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
  const ws = await openSocket(invite.routeId, invite.relayOrigin);
  let sessionId: string | null = null;
  let expectedHostSeq = 1;
  let clientSeq = 0;
  const seenIds: string[] = [];
  let imageSupport = false;
  let closed = false;
  let outgoing = Promise.resolve();
  let queued = 0;
  const requests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const rejectRequests = () => {
    closed = true;
    for (const r of requests.values()) {
      clearTimeout(r.timer);
      r.reject(new Error("connection_closed"));
    }
    requests.clear();
  };

  const transport = {
    onmessage: null as
      | ((message: { data: string | ArrayBuffer; isBinary: boolean }) => void)
      | null,
    onclose: null as ((code: number, reason: string) => void) | null,
    onerror: null as ((error: Error) => void) | null,
    send(data: string | ArrayBuffer) {
      if (ws.bufferedAmount > 256 * 1024) throw new Error("connection_busy");
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
    rejectRequests();
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
          imageSupport = welcome.images;
          handlers.onWelcome(welcome);
          return;
        }
        if (!sessionId) throw new Error("secure event before welcome");
        if (record.kind === "response") {
          if (
            !isObject(record.payload) ||
            !validId(record.payload.requestId) ||
            typeof record.payload.ok !== "boolean"
          )
            throw new Error("invalid response");
          const pending = requests.get(record.payload.requestId);
          if (!pending) return;
          requests.delete(record.payload.requestId);
          clearTimeout(pending.timer);
          if (record.payload.ok) pending.resolve(record.payload.value);
          else
            pending.reject(
              new Error(
                typeof record.payload.code === "string"
                  ? record.payload.code
                  : "request_failed",
              ),
            );
          return;
        }
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
      capabilities: {
        messages: true,
        questions: true,
        [IMAGE_CAPABILITY]: true,
      },
    }),
  );

  async function send(kind: string, payload: unknown): Promise<void> {
    if (!sessionId || closed) throw new Error("secure room is not ready");
    if (queued >= 4) throw new Error("connection_busy");
    queued++;
    const next = outgoing.then(async () => {
      if (closed) throw new Error("connection_closed");
      const encoded = encodeJson({
        v: 2,
        sessionId,
        seq: clientSeq + 1,
        id: randomId(),
        kind,
        payload,
      });
      if (encoded.byteLength > MAX_APP_RECORD_BYTES)
        throw new Error("message_too_large");
      clientSeq += 1;
      try {
        await channel.send(encoded);
      } catch (cause) {
        rejectRequests();
        channel.close();
        throw cause;
      }
    });
    outgoing = next.catch(() => {});
    try {
      await next;
    } finally {
      queued--;
    }
  }

  async function request(
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<unknown> {
    if (!imageSupport) throw new Error("images_unsupported");
    if (requests.size >= 4) throw new Error("connection_busy");
    const requestId = randomId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        requests.delete(requestId);
        reject(new Error("request_timeout"));
      }, IMAGE_REQUEST_TIMEOUT_MS);
      requests.set(requestId, { resolve, reject, timer });
      void send(kind, { ...payload, requestId }).catch((error) => {
        const pending = requests.get(requestId);
        if (!pending) return;
        requests.delete(requestId);
        clearTimeout(timer);
        reject(error);
      });
    });
  }
  function receipt(value: unknown): SubmissionReceipt {
    if (
      !isObject(value) ||
      !validId(value.submissionKey) ||
      !validId(value.messageId) ||
      !["pending", "accepted", "rejected", "unknown"].includes(
        String(value.status),
      )
    )
      throw new Error("invalid_receipt");
    return value as unknown as SubmissionReceipt;
  }
  async function sendImageMessage(
    message: string,
    file: File | null,
    submissionKey: string,
    progress: (value: number) => void,
  ): Promise<SubmissionReceipt> {
    if (textEncoder.encode(message).length > MAX_MESSAGE_BYTES)
      throw new Error("message_too_large");
    try {
      return receipt(await request("submission_status", { submissionKey }));
    } catch (cause) {
      if (!(cause instanceof Error) || cause.message !== "submission_missing")
        throw cause;
    }
    let uploaded: UploadedImage | undefined;
    if (file) {
      if (file.size < 1 || file.size > MAX_IMAGE_BYTES)
        throw new Error("invalid_image");
      const start = await request("image_begin", {
        mimeType: file.type,
        byteLength: file.size,
      });
      if (
        !isObject(start) ||
        !validId(start.imageId) ||
        !validId(start.capability)
      )
        throw new Error("invalid_upload");
      const auth = { imageId: start.imageId, capability: start.capability };
      try {
        const raw = new Uint8Array(await file.arrayBuffer());
        for (let offset = 0; offset < raw.length; offset += IMAGE_CHUNK_BYTES) {
          const chunk = raw.subarray(offset, offset + IMAGE_CHUNK_BYTES);
          let binary = "";
          for (const byte of chunk) binary += String.fromCharCode(byte);
          const response = await request("image_chunk", {
            ...auth,
            offset,
            data: btoa(binary),
          });
          if (!isObject(response) || response.offset !== offset + chunk.length)
            throw new Error("invalid_upload");
          progress(Math.round(((offset + chunk.length) / raw.length) * 100));
        }
        const value = await request("image_finish", auth);
        if (
          !isObject(value) ||
          !isRoomImage(value.image) ||
          value.capability !== auth.capability
        )
          throw new Error("invalid_upload");
        uploaded = { image: value.image, capability: auth.capability };
      } catch (cause) {
        void request("image_cancel", auth).catch(() => {});
        throw cause;
      }
    }
    try {
      return receipt(
        await request("message", {
          message,
          submissionKey,
          ...(uploaded
            ? { imageId: uploaded.image.id, capability: uploaded.capability }
            : {}),
        }),
      );
    } catch (cause) {
      if (uploaded)
        void request("image_cancel", {
          imageId: uploaded.image.id,
          capability: uploaded.capability,
        }).catch(() => {});
      throw cause;
    }
  }
  async function readImage(
    image: RoomImage,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    for (
      let offset = 0;
      offset < image.byteLength;
      offset += IMAGE_CHUNK_BYTES
    ) {
      if (signal?.aborted) throw new Error("cancelled");
      const value = await request("image_read", { imageId: image.id, offset });
      if (
        !isObject(value) ||
        value.imageId !== image.id ||
        value.offset !== offset ||
        value.byteLength !== image.byteLength ||
        typeof value.data !== "string" ||
        value.data.length > (IMAGE_CHUNK_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          value.data,
        )
      )
        throw new Error("invalid_image_chunk");
      const bytes = Uint8Array.from(atob(value.data), (char) =>
        char.charCodeAt(0),
      );
      if (
        bytes.length !== Math.min(IMAGE_CHUNK_BYTES, image.byteLength - offset)
      )
        throw new Error("invalid_image_chunk");
      chunks.push(bytes);
    }
    if (signal?.aborted) throw new Error("cancelled");
    return new Blob(chunks, { type: image.mimeType });
  }

  return {
    sendMessage: (message) => send("message", { message }),
    sendImageMessage,
    readImage,
    answer: (questionId, actionId) => send("answer", { questionId, actionId }),
    answerPrompts: (questionId, answers) =>
      send("answer_prompts", { questionId, answers }),
    close: () => {
      rejectRequests();
      channel.close();
    },
  };
}
