import crypto from "node:crypto";
import {
  createDaemonChannel,
  type EncryptedChannel,
  type Transport,
  type TransportMessage,
} from "./paseo-e2ee.js";
import {
  agentInfo,
  fetchFullHistory,
  listRoomQuestions,
  sendToAgent,
  subscribeAgent,
} from "./paseo.js";
import { publicStreamEvent } from "./public-events.js";
import {
  getRoom,
  isSecureRoom,
  timingSafeEqual,
  type AnyRoom,
  type SecureRoom,
} from "./rooms.js";
import { RoomPresence, sanitizeParticipantName } from "./presence.js";
import { parseV2OuterRecord, type V2OuterRecord } from "./relay/protocol.js";
import { type RoomSocket } from "./relay-client.js";
import type { RoomQuestionResponse } from "./questions.js";
import {
  IMAGE_CAPABILITY,
  isObject,
  validId,
} from "../shared/room-attachments.js";
import {
  beginImage,
  appendImage,
  finishImage,
  cancelImage,
  readImage,
  disconnectAttachments,
  decorateRoomItem,
  submitRoomMessage,
  submissionStatus,
} from "./room-attachments.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const MAX_APP_RECORD_BYTES = 64 * 1024;
const MAX_PENDING_APP_RECORDS = 4;
const MAX_PENDING_APP_BYTES = MAX_APP_RECORD_BYTES * 2;
const MAX_REPLAY_IDS = 512;
const MAX_PENDING_HANDSHAKES_PER_ROOM = 8;
const HANDSHAKE_TIMEOUT_MS = 10_000;

interface SecureLiveRoom {
  sessionId: string;
  clients: Set<SecureClient>;
  presence: RoomPresence<SecureClient>;
  unsubscribe: (() => void) | null;
  subscribing: Promise<void> | null;
}

interface SecureClient {
  socket: RoomSocket;
  channel: EncryptedChannel;
  room: SecureRoom;
  memberId: string;
  name: string;
  clientSeq: number;
  hostSeq: number;
  images: boolean;
  readWindow: number;
  readBytes: number;
  ready: boolean;
  closed: boolean;
  output: Promise<void>;
  outputCount: number;
  outputBytes: number;
  initializing: Array<{ kind: string; payload: unknown }>;
  initializingBytes: number;
  close(): void;
}

interface SecureRoomDependencies {
  agentInfo: typeof agentInfo;
  fetchFullHistory: typeof fetchFullHistory;
  listRoomQuestions: typeof listRoomQuestions;
  sendToAgent: typeof sendToAgent;
  subscribeAgent: typeof subscribeAgent;
}

const defaultDependencies: SecureRoomDependencies = {
  agentInfo,
  fetchFullHistory,
  listRoomQuestions,
  sendToAgent,
  subscribeAgent,
};

type JoinRecord = {
  v: 2;
  kind: "join";
  joinAttemptId: string;
  inviteSecret: string;
  displayName: string;
  capabilities?: unknown;
};

type ClientRecord = {
  v: 2;
  sessionId: string;
  seq: number;
  id: string;
  kind: string;
  payload: unknown;
};

const liveSecureRooms = new Map<string, SecureLiveRoom>();
const pendingHandshakes = new Map<string, number>();
const pendingSockets = new Map<string, Set<RoomSocket>>();
let totalQueuedInputs = 0;
let totalQueuedBytes = 0;

function randomId(): string {
  return crypto.randomBytes(16).toString("base64url");
}

function rememberOnce(values: string[], value: string): boolean {
  if (values.includes(value)) return false;
  values.push(value);
  if (values.length > MAX_REPLAY_IDS)
    values.splice(0, values.length - MAX_REPLAY_IDS);
  return true;
}

function encodeJson(value: unknown): ArrayBuffer {
  return textEncoder.encode(JSON.stringify(value)).buffer;
}

function decodeJson(data: string | ArrayBuffer): unknown {
  const raw = typeof data === "string" ? data : textDecoder.decode(data);
  if (Buffer.byteLength(raw, "utf8") > MAX_APP_RECORD_BYTES)
    throw new Error("app record too large");
  return JSON.parse(raw);
}

function recordByteLength(data: string | ArrayBuffer): number {
  return typeof data === "string"
    ? Buffer.byteLength(data, "utf8")
    : data.byteLength;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJoinRecord(data: string | ArrayBuffer): JoinRecord | null {
  try {
    const value = decodeJson(data);
    if (!isRecord(value)) return null;
    if (
      value.v !== 2 ||
      value.kind !== "join" ||
      typeof value.joinAttemptId !== "string" ||
      typeof value.inviteSecret !== "string" ||
      typeof value.displayName !== "string"
    )
      return null;
    return {
      v: 2,
      kind: "join",
      joinAttemptId: value.joinAttemptId,
      inviteSecret: value.inviteSecret,
      displayName: value.displayName,
      ...(value.capabilities !== undefined
        ? { capabilities: value.capabilities }
        : {}),
    };
  } catch {
    return null;
  }
}

function parseClientRecord(data: string | ArrayBuffer): ClientRecord | null {
  try {
    const value = decodeJson(data);
    if (!isRecord(value)) return null;
    if (
      value.v !== 2 ||
      typeof value.sessionId !== "string" ||
      typeof value.seq !== "number" ||
      !Number.isSafeInteger(value.seq) ||
      value.seq < 1 ||
      typeof value.id !== "string" ||
      typeof value.kind !== "string" ||
      ![
        "message",
        "answer",
        "answer_prompts",
        "image_begin",
        "image_chunk",
        "image_finish",
        "image_cancel",
        "image_read",
        "submission_status",
      ].includes(value.kind) ||
      value.id.length > 64
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
  } catch {
    return null;
  }
}

function payloadString(payload: unknown, key: string): string | null {
  return isRecord(payload) && typeof payload[key] === "string"
    ? payload[key]
    : null;
}

function payloadAnswers(
  payload: unknown,
): RoomQuestionResponse["answers"] | null {
  if (!isRecord(payload) || !Array.isArray(payload.answers)) return null;
  const answers: RoomQuestionResponse["answers"] = [];
  for (const answer of payload.answers) {
    if (
      !isRecord(answer) ||
      typeof answer.questionIndex !== "number" ||
      !Number.isSafeInteger(answer.questionIndex) ||
      answer.questionIndex < 0 ||
      !Array.isArray(answer.optionLabels) ||
      !answer.optionLabels.every(
        (label) => typeof label === "string" && label.length > 0,
      ) ||
      (answer.other !== undefined && typeof answer.other !== "string")
    ) {
      return null;
    }
    answers.push({
      questionIndex: answer.questionIndex,
      optionLabels: answer.optionLabels,
      ...(typeof answer.other === "string" ? { other: answer.other } : {}),
    });
  }
  return answers;
}

function secureTransport(socket: RoomSocket): Transport {
  return {
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      if ((socket.bufferedAmount ?? 0) > 256 * 1024) {
        socket.close(1013, "slow room connection");
        throw new Error("room connection busy");
      }
      const bytes =
        typeof data === "string"
          ? textEncoder.encode(data)
          : new Uint8Array(data);
      const type = typeof data === "string" ? "handshake" : "secure";
      socket.send(
        JSON.stringify({
          v: 2,
          type,
          data: Buffer.from(bytes).toString("base64url"),
        }),
      );
    },
    close(code, reason) {
      socket.close(code, reason);
    },
  };
}

function deliverOuterRecord(transport: Transport, record: V2OuterRecord): void {
  const bytes = Buffer.from(record.data, "base64url");
  const data =
    record.type === "handshake"
      ? textDecoder.decode(bytes)
      : bytes.buffer.slice(
          bytes.byteOffset,
          bytes.byteOffset + bytes.byteLength,
        );
  transport.onmessage?.({
    data,
    isBinary: record.type === "secure",
  } satisfies TransportMessage);
}

async function roomSnapshot(
  room: SecureRoom,
  participants: unknown[],
  deps: SecureRoomDependencies,
): Promise<Record<string, unknown>> {
  const info = await deps.agentInfo(room.agentId);
  return {
    room: {
      label: room.label,
      createdAt: room.createdAt,
      agent: info
        ? { title: info.title, status: info.status, provider: info.provider }
        : null,
      questions: await deps.listRoomQuestions(room.agentId),
    },
    history: (await deps.fetchFullHistory(room.agentId)).map((entry) => ({
      ...entry,
      item: decorateRoomItem(room, entry.item),
    })),
    participants,
    working: info?.status === "running",
  };
}

function getLiveSecureRoom(room: SecureRoom): SecureLiveRoom {
  let live = liveSecureRooms.get(room.token);
  if (!live) {
    live = {
      sessionId: randomId(),
      clients: new Set(),
      presence: new RoomPresence(),
      unsubscribe: null,
      subscribing: null,
    };
    liveSecureRooms.set(room.token, live);
  }
  return live;
}

async function sendSecure(
  live: SecureLiveRoom,
  client: SecureClient,
  kind: string,
  payload: unknown,
): Promise<void> {
  if (client.closed || getRoom(client.room.token) !== client.room)
    throw new Error("room closed");
  const bytes = encodeJson(payload).byteLength;
  if (client.outputCount >= 8 || client.outputBytes + bytes > 128 * 1024) {
    client.close();
    throw new Error("slow client");
  }
  client.outputCount++;
  client.outputBytes += bytes;
  const next = client.output.then(async () => {
    if (client.closed || getRoom(client.room.token) !== client.room)
      throw new Error("room closed");
    const record = {
      v: 2,
      sessionId: live.sessionId,
      seq: client.hostSeq + 1,
      id: randomId(),
      kind,
      payload,
    };
    const encoded = encodeJson(record);
    if (encoded.byteLength > MAX_APP_RECORD_BYTES)
      throw new Error("secure room record exceeds the protocol limit");
    client.hostSeq += 1;
    await client.channel.send(encoded);
  });
  client.output = next.catch(() => client.close());
  try {
    await next;
  } finally {
    client.outputCount--;
    client.outputBytes -= bytes;
  }
}

/**
 * The first encrypted record contains the room snapshot. A long-lived Paseo
 * timeline can exceed the v2 record limit, which used to make the *relay
 * control* WebSocket exceed its limit and drop every guest as the snapshot was
 * forwarded. Preserve the newest history that fits one authenticated v2
 * record; subsequent live events remain unaffected.
 */
function boundedWelcomePayload(
  live: SecureLiveRoom,
  client: SecureClient,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const history = Array.isArray(payload.history) ? payload.history : [];
  const fits = (start: number): boolean => {
    const candidate = {
      ...payload,
      history: history.slice(start),
      ...(start > 0 ? { historyTruncated: true } : {}),
    };
    return (
      encodeJson({
        v: 2,
        sessionId: live.sessionId,
        seq: client.hostSeq + 1,
        // A real record id has this fixed base64url length; use the same
        // shape while sizing so the test is conservative and deterministic.
        id: "x".repeat(22),
        kind: "welcome",
        payload: candidate,
      }).byteLength <= MAX_APP_RECORD_BYTES
    );
  };

  if (fits(0)) return payload;

  let low = 0;
  let high = history.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (fits(middle)) high = middle;
    else low = middle + 1;
  }
  return {
    ...payload,
    history: history.slice(low),
    historyTruncated: true,
  };
}

function broadcastSecure(
  live: SecureLiveRoom,
  kind: string,
  payload: unknown,
): void {
  for (const client of live.clients) {
    if (!client.ready) {
      const bytes = encodeJson(payload).byteLength;
      if (
        client.initializing.length >= 8 ||
        client.initializingBytes + bytes > 128 * 1024
      ) {
        client.close();
        continue;
      }
      client.initializing.push({ kind, payload });
      client.initializingBytes += bytes;
      continue;
    }
    void sendSecure(live, client, kind, payload).catch(() => client.close());
  }
}

async function handleClientRecord(
  live: SecureLiveRoom,
  client: SecureClient,
  record: ClientRecord,
  checkRateLimit: (token: string) => boolean,
  deps: SecureRoomDependencies,
  answerQuestion: (
    room: SecureRoom,
    questionId: string,
    payload: { actionId?: string; answers?: RoomQuestionResponse["answers"] },
  ) => Promise<boolean>,
): Promise<void> {
  if (record.sessionId !== live.sessionId) {
    client.close();
    return;
  }
  if (
    record.seq !== client.clientSeq + 1 ||
    !rememberOnce(client.room.seenClientRecordIds, record.id)
  ) {
    client.close();
    return;
  }
  client.clientSeq = record.seq;

  if (getRoom(client.room.token) !== client.room || client.closed) return;
  if (
    record.kind.startsWith("image_") ||
    record.kind === "submission_status" ||
    (record.kind === "message" &&
      isObject(record.payload) &&
      record.payload.submissionKey !== undefined)
  ) {
    if (
      !client.images ||
      !isObject(record.payload) ||
      !validId(record.payload.requestId)
    ) {
      client.close();
      return;
    }
    const requestId = record.payload.requestId;
    try {
      let value: unknown;
      switch (record.kind) {
        case "image_begin":
          value = beginImage(client.room, client.memberId, record.payload);
          break;
        case "image_chunk":
          value = appendImage(client.room, client.memberId, record.payload);
          break;
        case "image_finish":
          value = finishImage(client.room, client.memberId, record.payload);
          break;
        case "image_cancel":
          value = cancelImage(client.room, client.memberId, record.payload);
          break;
        case "image_read":
          if (Date.now() - client.readWindow > 60_000) {
            client.readWindow = Date.now();
            client.readBytes = 0;
          }
          if (client.readBytes >= 16 * 1024 * 1024)
            throw new Error("read_rate_limited");
          value = readImage(client.room, record.payload);
          client.readBytes += 24 * 1024;
          break;
        case "submission_status":
          value = submissionStatus(client.room, record.payload.submissionKey);
          break;
        default:
          value = await submitRoomMessage(
            client.room,
            client.memberId,
            client.name,
            record.payload,
            () => checkRateLimit(client.room.token),
            (text, options) =>
              deps.sendToAgent(client.room.agentId, text, options),
          );
      }
      if (!client.closed)
        await sendSecure(live, client, "response", {
          requestId,
          ok: true,
          value,
        });
    } catch (cause) {
      const code =
        cause instanceof Error && /^[a-z_]{1,40}$/.test(cause.message)
          ? cause.message
          : "request_failed";
      if (!client.closed)
        await sendSecure(live, client, "response", {
          requestId,
          ok: false,
          code,
        });
    }
    return;
  }

  if (record.kind === "message") {
    if (!checkRateLimit(client.room.token)) return;
    const message = payloadString(record.payload, "message")?.trim() ?? "";
    if (!message) return;
    await deps.sendToAgent(client.room.agentId, `[${client.name}]\n${message}`);
    return;
  }

  const questionId = payloadString(record.payload, "questionId");
  if (!questionId) return;
  if (record.kind === "answer") {
    const actionId = payloadString(record.payload, "actionId");
    if (actionId) await answerQuestion(client.room, questionId, { actionId });
    return;
  }
  const answers = payloadAnswers(record.payload);
  if (answers) {
    await answerQuestion(client.room, questionId, {
      answers,
    });
  }
}

export async function openSecureRoomSocket(
  requestPath: string,
  socket: RoomSocket,
  checkRateLimit: (token: string) => boolean,
  answerQuestion: (
    room: SecureRoom,
    questionId: string,
    payload: { actionId?: string; answers?: RoomQuestionResponse["answers"] },
  ) => Promise<boolean>,
  deps: SecureRoomDependencies = defaultDependencies,
): Promise<boolean> {
  const url = new URL(requestPath, "http://paseo-rooms.invalid");
  const match = url.pathname.match(/^\/v2\/rooms\/([^/]+)\/ws$/);
  const room = match ? getSecureRoomFromPath(match[1]) : undefined;
  if (!room) return false;

  const pendingCount = pendingHandshakes.get(room.token) ?? 0;
  const allClients = [...liveSecureRooms.values()].reduce(
    (sum, value) => sum + value.clients.size,
    0,
  );
  if (
    (liveSecureRooms.get(room.token)?.clients.size ?? 0) >= 32 ||
    allClients >= 128
  ) {
    socket.close(1013, "room busy");
    return true;
  }
  if (
    pendingCount >= MAX_PENDING_HANDSHAKES_PER_ROOM ||
    [...pendingHandshakes.values()].reduce((sum, count) => sum + count, 0) >=
      128
  ) {
    socket.close(1013, "room busy");
    return true;
  }
  pendingHandshakes.set(room.token, pendingCount + 1);
  const opening = pendingSockets.get(room.token) ?? new Set<RoomSocket>();
  opening.add(socket);
  pendingSockets.set(room.token, opening);
  let releasedPending = false;
  const handshakeTimeout = setTimeout(() => {
    if (!releasedPending) socket.close(1008, "handshake timeout");
  }, HANDSHAKE_TIMEOUT_MS);
  const releasePending = () => {
    if (releasedPending) return;
    releasedPending = true;
    clearTimeout(handshakeTimeout);
    opening.delete(socket);
    if (!opening.size) pendingSockets.delete(room.token);
    const remaining = (pendingHandshakes.get(room.token) ?? 1) - 1;
    if (remaining > 0) pendingHandshakes.set(room.token, remaining);
    else pendingHandshakes.delete(room.token);
  };

  const live = getLiveSecureRoom(room);
  const transport = secureTransport(socket);
  let client: SecureClient | null = null;
  let admissionStarted = false;
  let settleAdmission = () => {};
  const pending: Array<string | ArrayBuffer> = [];
  let pendingBytes = 0;
  const removeClient = () => {
    settleAdmission();
    const leaving = client;
    if (!leaving || !live.clients.delete(leaving)) return;
    leaving.closed = true;
    disconnectAttachments(room, leaving.memberId);
    if (live.presence.leave(leaving)) {
      broadcastSecure(live, "presence", {
        type: "presence",
        participants: live.presence.list(),
      });
    }
    if (live.clients.size === 0) {
      live.unsubscribe?.();
      live.unsubscribe = null;
      liveSecureRooms.delete(room.token);
    }
  };
  let onPlaintext = (data: string | ArrayBuffer): void => {
    const bytes = recordByteLength(data);
    if (
      pending.length >= MAX_PENDING_APP_RECORDS ||
      bytes > MAX_APP_RECORD_BYTES ||
      pendingBytes + bytes > MAX_PENDING_APP_BYTES
    ) {
      socket.close(1009, "too many pre-admission records");
      return;
    }
    pendingBytes += bytes;
    pending.push(data);
  };

  socket.onMessage((raw) => {
    try {
      const outer = parseV2OuterRecord(raw);
      if (!outer) {
        socket.close(1003, "invalid v2 record");
        return;
      }
      deliverOuterRecord(transport, outer);
    } catch {
      socket.close(1003, "invalid v2 record");
    }
  });
  socket.onClose(() => transport.onclose?.(1000, "closed"));
  socket.onClose(releasePending);
  socket.onClose(removeClient);

  let channel: EncryptedChannel;
  try {
    channel = await createDaemonChannel(transport, room.hostKeyPair, {
      onmessage(data) {
        onPlaintext(data);
      },
      onclose() {
        removeClient();
      },
      onerror() {
        client?.close();
      },
    });
  } catch (error) {
    releasePending();
    throw error;
  }
  const admit = async (data: string | ArrayBuffer): Promise<void> => {
    const join = parseJoinRecord(data);
    const name = sanitizeParticipantName(join?.displayName);
    if (
      !join ||
      !name ||
      !rememberOnce(room.seenJoinAttemptIds, join.joinAttemptId) ||
      !timingSafeEqual(join.inviteSecret, room.inviteSecret)
    ) {
      channel.close(1008, "unauthorized");
      return;
    }

    if (getRoom(room.token) !== room) {
      channel.close();
      return;
    }

    client = {
      socket,
      channel,
      room,
      memberId: randomId(),
      name,
      clientSeq: 0,
      hostSeq: 0,
      images:
        isObject(join.capabilities) &&
        join.capabilities[IMAGE_CAPABILITY] === true,
      readWindow: Date.now(),
      readBytes: 0,
      ready: false,
      closed: false,
      output: Promise.resolve(),
      outputCount: 0,
      outputBytes: 0,
      initializing: [],
      initializingBytes: 0,
      close() {
        this.closed = true;
        channel.close(1000, "closed");
      },
    };
    let initialized!: () => void;
    const barrier = new Promise<void>((resolve) => {
      initialized = resolve;
    });
    settleAdmission = initialized;
    const activeClient = client;
    let input = barrier;
    let queued = 0;
    let queuedBytes = 0;
    onPlaintext = (next) => {
      const bytes = recordByteLength(next);
      if (
        queued >= 4 ||
        queuedBytes + bytes > 128 * 1024 ||
        totalQueuedInputs >= 128 ||
        totalQueuedBytes + bytes > 4 * 1024 * 1024
      ) {
        client?.close();
        return;
      }
      const record = parseClientRecord(next);
      if (!record || !client) {
        client?.close();
        return;
      }
      queued++;
      queuedBytes += bytes;
      totalQueuedInputs++;
      totalQueuedBytes += bytes;
      input = input
        .then(() =>
          handleClientRecord(
            live,
            activeClient,
            record,
            checkRateLimit,
            deps,
            answerQuestion,
          ),
        )
        .catch(() => client?.close())
        .finally(() => {
          queued--;
          queuedBytes -= bytes;
          totalQueuedInputs--;
          totalQueuedBytes -= bytes;
        });
    };
    live.clients.add(client);
    live.presence.join(client, name);
    if (!live.unsubscribe && !live.subscribing) {
      live.subscribing = deps
        .subscribeAgent(room.agentId, ({ event, timestamp }) => {
          if (event.type === "replacement") {
            // Secure clients reconnect and receive a fresh encrypted welcome.
            for (const member of live.clients) member.close();
            return;
          }
          const publicEvent = publicStreamEvent(event);
          const projected =
            isObject(publicEvent) && publicEvent.type === "timeline"
              ? {
                  ...publicEvent,
                  item: decorateRoomItem(room, publicEvent.item),
                }
              : publicEvent;
          broadcastSecure(live, "event", {
            type: "stream",
            event: projected,
            timestamp,
          });
        })
        .then((unsubscribe) => {
          if (
            liveSecureRooms.get(room.token) !== live ||
            !live.clients.size ||
            getRoom(room.token) !== room
          ) {
            unsubscribe();
            return;
          }
          live.unsubscribe = unsubscribe;
        })
        .finally(() => {
          live.subscribing = null;
        });
    }
    if (live.subscribing) await live.subscribing;
    if (client.closed || getRoom(room.token) !== room) return;

    const welcomePayload = boundedWelcomePayload(live, client, {
      memberId: client.memberId,
      resumeSecret: null,
      nextClientSeq: 1,
      capabilities: client.images ? { [IMAGE_CAPABILITY]: true } : {},
      ...(await roomSnapshot(room, live.presence.list(), deps)),
    });
    await sendSecure(live, client, "welcome", welcomePayload);
    if (getRoom(room.token) !== room || client.closed) {
      client.close();
      return;
    }
    const flushing = client.initializing
      .splice(0)
      .map((update) => sendSecure(live, client!, update.kind, update.payload));
    client.ready = true;
    await Promise.all(flushing);
    releasePending();
    initialized();
    client.initializingBytes = 0;
    broadcastSecure(live, "presence", {
      type: "presence",
      participants: live.presence.list(),
    });
  };

  onPlaintext = (data) => {
    if (admissionStarted) {
      socket.close(1008, "duplicate join");
      return;
    }
    admissionStarted = true;
    void admit(data).catch(() => channel.close(1011, "join failed"));
  };
  for (const data of pending.splice(0)) onPlaintext(data);
  return true;
}

export function closeSecureRoom(token: string): void {
  for (const socket of pendingSockets.get(token) ?? [])
    socket.close(1000, "room closed");
  const live = liveSecureRooms.get(token);
  if (!live) return;
  for (const client of live.clients) client.close();
  live.unsubscribe?.();
  liveSecureRooms.delete(token);
}

function getSecureRoomFromPath(token: string): SecureRoom | undefined {
  const room = getRoomForSecurePath(token);
  return room && isSecureRoom(room) ? room : undefined;
}

function getRoomForSecurePath(token: string): AnyRoom | undefined {
  return getRoom(token);
}
