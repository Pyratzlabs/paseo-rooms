import {
  discoverRelayPolicy,
  type RelayMode,
  type RelayPolicy,
} from "./relay-policy.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
  createRoom,
  createLegacyRoom,
  deleteRoom,
  getAdminToken,
  getRoom,
  isSecureRoom,
  listRooms,
  publicRoomUrl,
  relayRoutes,
  relayTokens,
  timingSafeEqual,
  toPublicRoom,
  type AnyRoom,
  type Room,
  type SecureRoom,
} from "./rooms.js";
import { closeSecureRoom, openSecureRoomSocket } from "./secure-room.js";
import {
  startRelayClient,
  type ApiRequest,
  type ApiResponse,
  type RelayClient,
  type RoomSocket,
} from "./relay-client.js";
import {
  agentInfo,
  ensureConnected,
  fetchFullHistory,
  listRoomQuestions,
  answerRoomQuestion,
  closePaseoConnections,
  isConnected,
  sendToAgent,
  subscribeAgent,
} from "./paseo.js";
import { publicStreamEvent } from "./public-events.js";
import type { RoomQuestionResponse } from "./questions.js";
import { MAX_V2_RECORD_BYTES } from "./relay/protocol.js";
import {
  legacyRoomUsesConfiguredRelay,
  relayHasActiveRooms,
  normalizeRelayOrigin,
  relayHostUrl,
  relayKeyCompatibilityError,
} from "./relay-target.js";
import {
  parsePresenceHello,
  RoomPresence,
  sanitizeParticipantName,
} from "./presence.js";

const PORT = Number(process.env.PORT ?? 3000);
const LOCAL_BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL ?? LOCAL_BASE_URL;
const BASE_HOST = new URL(LOCAL_BASE_URL).host;
// Paseo evaluates plugin server code in a function bundle, where module
// metadata cannot be parsed. The plugin supplies an explicit directory before
// importing this module. Standalone commands run either from this package or
// the repository root, so retain both working-directory layouts as fallbacks.
function resolvePublicDirectory(): string {
  const configured = process.env.PASEO_ROOMS_PUBLIC_DIR;
  if (configured) return configured;

  const candidates = [
    path.join(process.cwd(), "public"),
    path.join(process.cwd(), "apps", "relay-web", "public"),
  ];
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
  );
}

const PUBLIC_DIR = resolvePublicDirectory();

const ADMIN_TOKEN = getAdminToken();

// ---- rate limiting ----------------------------------------------------------

const RATE_LIMIT = 10; // max messages per token per window
const RATE_WINDOW_MS = 60_000;
const messageTimestamps = new Map<string, number[]>();
const answeringQuestions = new Set<string>();
const questionTimestamps = new Map<string, number[]>();

function checkRateLimit(token: string): boolean {
  const now = Date.now();
  const timestamps = (messageTimestamps.get(token) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (timestamps.length >= RATE_LIMIT) {
    messageTimestamps.set(token, timestamps);
    return false;
  }
  timestamps.push(now);
  messageTimestamps.set(token, timestamps);
  return true;
}

function checkQuestionRateLimit(token: string): boolean {
  const now = Date.now();
  const timestamps = (questionTimestamps.get(token) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (timestamps.length >= RATE_LIMIT) return false;
  timestamps.push(now);
  questionTimestamps.set(token, timestamps);
  return true;
}

// ---- live fan-out ----------------------------------------------------------

interface LiveRoom {
  sockets: Set<RoomSocket>;
  presence: RoomPresence<RoomSocket>;
  unsubscribe: (() => void) | null;
}

const liveRooms = new Map<string, LiveRoom>();

/** Close all live sockets for a room (used on revocation). */
function closeLiveRoom(token: string): void {
  const live = liveRooms.get(token);
  if (!live) return;
  for (const ws of live.sockets) {
    ws.close(4004, "room revoked");
  }
  live.unsubscribe?.();
  liveRooms.delete(token);
}

async function answerQuestionOnce(
  room: Pick<Room, "agentId" | "token">,
  requestId: string,
  payload: { actionId?: string; answers?: RoomQuestionResponse["answers"] },
): Promise<boolean> {
  const key = `${room.token}:${requestId}`;
  if (!checkQuestionRateLimit(room.token)) return false;
  if (answeringQuestions.has(key)) return false;
  answeringQuestions.add(key);
  try {
    return await answerRoomQuestion(room.agentId, requestId, payload);
  } finally {
    answeringQuestions.delete(key);
  }
}

/**
 * Attach a browser socket to a room's timeline fan-out. The socket may be a
 * local `ws` connection or a relay-forwarded virtual one — see `RoomSocket`.
 */
async function joinRoom(room: Room, socket: RoomSocket): Promise<void> {
  let live = liveRooms.get(room.token);
  if (!live) {
    live = {
      sockets: new Set(),
      presence: new RoomPresence(),
      unsubscribe: null,
    };
    liveRooms.set(room.token, live);
    live.unsubscribe = await subscribeAgent(
      room.agentId,
      ({ event, timestamp }) => {
        if (event.type === "replacement") {
          // Rejoining fetches a fresh snapshot after Paseo invalidates history.
          for (const ws of live!.sockets) ws.close(1012, "timeline replaced");
          return;
        }
        const frame = JSON.stringify({
          type: "stream",
          event: publicStreamEvent(event),
          timestamp,
        });
        for (const ws of live!.sockets) {
          ws.send(frame);
        }
      },
    );
  }
  live.sockets.add(socket);
  const broadcastPresence = () => {
    const frame = JSON.stringify({
      type: "presence",
      participants: live!.presence.list(),
    });
    for (const ws of live!.sockets) ws.send(frame);
  };
  socket.onMessage((data) => {
    const name = parsePresenceHello(data);
    if (name && live!.presence.join(socket, name)) broadcastPresence();
  });
  socket.send(
    JSON.stringify({ type: "presence", participants: live.presence.list() }),
  );
  socket.onClose(() => {
    live!.sockets.delete(socket);
    if (live!.presence.leave(socket)) broadcastPresence();
    if (live!.sockets.size === 0) {
      live!.unsubscribe?.();
      liveRooms.delete(room.token);
    }
  });
}

/** Adapt a real `ws` socket to the transport-agnostic `RoomSocket` shape. */
function wrapWebSocket(ws: WebSocket): RoomSocket {
  return {
    get bufferedAmount() {
      return ws.bufferedAmount;
    },
    send: (data) => {
      if (ws.bufferedAmount > 256 * 1024) {
        ws.close(1013, "slow room connection");
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: (code, reason) => ws.close(code, reason),
    onClose: (handler) => ws.on("close", handler),
    onMessage: (handler) =>
      ws.on("message", (data) => handler(data.toString())),
  };
}

// ---- helpers ---------------------------------------------------------------

function json(status: number, body: unknown): ApiResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify(body)),
  };
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024) reject(new Error("body too large"));
      else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function fileResponse(file: string, type: string): ApiResponse {
  try {
    const content = fs.readFileSync(path.join(PUBLIC_DIR, file));
    return { status: 200, headers: { "content-type": type }, body: content };
  } catch {
    return notFound();
  }
}

function landingAssetResponse(pieces: string[]): ApiResponse {
  if (
    pieces.length === 0 ||
    pieces.some((piece) => !/^[A-Za-z0-9._-]+$/.test(piece))
  )
    return notFound();
  const root = path.join(PUBLIC_DIR, "landing");
  const target = path.resolve(root, ...pieces);
  if (!target.startsWith(`${root}${path.sep}`)) return notFound();
  try {
    const type =
      ASSET_TYPES[path.extname(target).toLowerCase()] ??
      "application/octet-stream";
    return {
      status: 200,
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=31536000, immutable",
      },
      body: fs.readFileSync(target),
    };
  } catch {
    return notFound();
  }
}

/** Public, immutable Vite assets. They contain UI code only; room data remains token-gated. */
function publicAssetResponse(pieces: string[]): ApiResponse {
  if (
    pieces.length === 0 ||
    pieces.some((piece) => !/^[A-Za-z0-9._-]+$/.test(piece))
  )
    return notFound();
  const root = path.join(PUBLIC_DIR, "assets");
  const target = path.resolve(root, ...pieces);
  if (!target.startsWith(`${root}${path.sep}`)) return notFound();
  try {
    const type =
      ASSET_TYPES[path.extname(target).toLowerCase()] ??
      "application/octet-stream";
    return {
      status: 200,
      headers: {
        "content-type": type,
        "cache-control": "public, max-age=31536000, immutable",
      },
      body: fs.readFileSync(target),
    };
  } catch {
    return notFound();
  }
}

/** Static documentation built by Docusaurus into the public relay bundle. */
function docsResponse(pieces: string[]): ApiResponse {
  if (pieces.some((piece) => !/^[A-Za-z0-9._-]+$/.test(piece)))
    return notFound();
  const root = path.join(PUBLIC_DIR, "docs");
  const target = path.resolve(root, ...pieces);
  if (target !== root && !target.startsWith(`${root}${path.sep}`))
    return notFound();
  const candidates = [target, path.join(target, "index.html")];
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) continue;
      const type =
        ASSET_TYPES[path.extname(candidate).toLowerCase()] ??
        "application/octet-stream";
      return {
        status: 200,
        headers: {
          "content-type": type,
          "cache-control": type.startsWith("text/html")
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        },
        body: fs.readFileSync(candidate),
      };
    } catch {
      // Try the directory index next.
    }
  }
  return notFound();
}

function roomPageResponse(token: string): ApiResponse {
  if (!getRoom(token)) return notFound();
  try {
    return {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: fs.readFileSync(path.join(PUBLIC_DIR, "room.html")),
    };
  } catch {
    return notFound();
  }
}

const ASSET_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function notFound(): ApiResponse {
  return {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: Buffer.from("not found"),
  };
}

// ---- routes ----------------------------------------------------------------

/**
 * The single request handler, shared by the local HTTP listener and by
 * relay-forwarded `http_request` frames. It takes a plain request shape and
 * returns a plain response — no `http.IncomingMessage` anywhere.
 *
 * Relay-forwarded requests carry only content-type/x-forwarded-for, so the
 * admin routes below are unreachable through the relay by construction (and
 * the relay refuses to route `POST /api/rooms` at all).
 */
export async function handleApiRequest(req: ApiRequest): Promise<ApiResponse> {
  try {
    const url = new URL(req.path, LOCAL_BASE_URL);
    const parts = url.pathname.split("/").filter(Boolean);

    // Local development keeps the same shell as the public relay. The shell is
    // token-gated; its hashed UI assets are public and contain no room data.
    if (req.method === "GET" && parts[0] === "r" && parts.length === 2) {
      return roomPageResponse(parts[1]);
    }
    if (req.method === "GET" && parts[0] === "landing" && parts.length >= 2) {
      return landingAssetResponse(parts.slice(1));
    }
    if (req.method === "GET" && parts[0] === "assets" && parts.length >= 2) {
      return publicAssetResponse(parts.slice(1));
    }
    if (req.method === "GET" && parts[0] === "docs") {
      return docsResponse(parts.slice(1));
    }
    if (req.method === "GET" && url.pathname === "/") {
      return fileResponse("index.html", "text/html; charset=utf-8");
    }

    // GET /healthz — liveness + daemon connectivity, unauthenticated
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(200, { ok: true, daemonConnected: isConnected() });
    }

    // Everything below talks to the daemon: fail fast while it's unreachable.
    if (url.pathname.startsWith("/api/") && !isConnected()) {
      return json(503, { error: "daemon unavailable" });
    }

    const checkAdmin = (): boolean => {
      const auth = req.headers.authorization ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      return timingSafeEqual(bearer, ADMIN_TOKEN);
    };

    // POST /api/rooms — admin only: create a share room for an agent
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      if (!checkAdmin()) return json(401, { error: "unauthorized" });
      const body = JSON.parse(req.body.toString() || "{}");
      const agentId = typeof body.agentId === "string" ? body.agentId : null;
      if (!agentId) return json(400, { error: "agentId required" });
      const info = await agentInfo(agentId);
      if (!info) return json(404, { error: "no such agent" });
      const label =
        typeof body.label === "string"
          ? body.label
          : (info.title ?? "Shared session");
      const requestedRelay =
        typeof body.relayOrigin === "string" ? body.relayOrigin : undefined;
      const relayOrigin = requestedRelay
        ? normalizeRelayOrigin(requestedRelay)
        : defaultRelayOrigin();
      if (requestedRelay && !relayOrigin)
        return json(400, { error: "a valid relay origin is required" });
      const configuredRelayOrigin = defaultRelayOrigin();
      const relayMode = body.relayMode ?? process.env.RELAY_MODE ?? "auto";
      if (relayMode !== "auto" && relayMode !== "legacy-key")
        return json(400, { error: "invalid relay mode" });
      const policy = relayOrigin
        ? await discoverRelayPolicy(relayOrigin, relayMode)
        : null;
      const candidateKey =
        relayOrigin &&
        typeof body.relayKey === "string" &&
        body.relayKey.length > 0
          ? body.relayKey
          : relayOrigin === configuredRelayOrigin
            ? process.env.RELAY_KEY
            : undefined;
      const relayKey =
        policy?.registration === "key" ? candidateKey : undefined;
      if (policy?.registration === "key" && !relayKey)
        return json(400, { error: "a host registration key is required" });
      const isLegacyRequest = body.protocol === 1;
      if (isLegacyRequest && policy && !policy.roomProtocols.includes(1))
        return json(400, { error: "this relay does not support legacy rooms" });
      if (
        isLegacyRequest &&
        relayOrigin &&
        !legacyRoomUsesConfiguredRelay(relayOrigin, configuredRelayOrigin)
      ) {
        return json(400, {
          error: "legacy rooms only support the configured relay",
        });
      }
      // This is deliberately before createRoom(): a rejected credential
      // change must not leave an unregistered room in the local registry.
      if (relayOrigin) assertRelayKeyCompatible(relayOrigin, relayKey ?? "");
      const relayClient =
        relayOrigin && policy
          ? relayClientFor(relayOrigin, relayKey ?? "", policy)
          : null;
      // Wait until the relay has accepted the host control connection before
      // allocating an invite. In particular, an invalid custom relay key must
      // fail this request rather than mint a route the relay will never serve.
      try {
        await relayClient?.waitUntilConnected();
      } catch (error) {
        if (relayOrigin && activeRelayRegistrationCount(relayOrigin) === 0) {
          relayClient?.close();
          relayClients.delete(relayOrigin);
        }
        throw error;
      }
      const room = isLegacyRequest
        ? createLegacyRoom(agentId, label)
        : createRoom(
            agentId,
            label,
            relayOrigin ?? undefined,
            !!policy?.routeOwnership,
          );
      if (relayClient) {
        try {
          if (isSecureRoom(room)) {
            const routes = [
              {
                token: room.token,
                protocol: 2 as const,
                ...(room.ownershipSecret
                  ? { ownershipSecret: room.ownershipSecret }
                  : {}),
              },
            ];
            if (policy?.registrationAck)
              await relayClient.registerRoutesConfirmed(routes);
            else relayClient.registerRoutes(routes);
          } else {
            relayClient!.register([room.token]);
          }
        } catch (error) {
          // A client setup failure (including a changed registration key) must
          // not leave a local link whose relay route was never registered.
          deleteRoom(room.token);
          relayClient.unregisterRoutes([
            { token: room.token, protocol: room.protocol },
          ]);
          if (relayOrigin && activeRelayRegistrationCount(relayOrigin) === 0) {
            relayClient.close();
            relayClients.delete(relayOrigin);
          }
          throw error;
        }
      }
      return json(201, {
        token: room.token,
        url: publicRoomUrl(room, PUBLIC_BASE_URL),
      });
    }

    // GET /api/rooms — admin only: list rooms
    if (req.method === "GET" && url.pathname === "/api/rooms") {
      if (!checkAdmin()) return json(401, { error: "unauthorized" });
      return json(200, {
        rooms: listRooms().map((room) => ({
          ...toPublicRoom(room),
          url: publicRoomUrl(room, PUBLIC_BASE_URL),
        })),
      });
    }

    // DELETE /api/rooms/<token> — admin only: revoke a room
    if (
      req.method === "DELETE" &&
      parts[0] === "api" &&
      parts[1] === "rooms" &&
      parts.length === 3
    ) {
      if (!checkAdmin()) return json(401, { error: "unauthorized" });
      const room = getRoom(parts[2]);
      if (!room) return json(404, { error: "unknown room" });
      deleteRoom(parts[2]);
      closeLiveRoom(parts[2]);
      closeSecureRoom(parts[2]);
      const relayOrigin = isSecureRoom(room)
        ? room.relayOrigin
        : defaultRelayOrigin();
      const client = relayOrigin ? relayClients.get(relayOrigin) : undefined;
      client?.client.unregister([parts[2]]);
      client?.client.unregisterRoutes([{ token: parts[2], protocol: 2 }]);
      if (
        relayOrigin &&
        !relayHasActiveRooms(
          relayOrigin,
          defaultRelayOrigin(),
          relayRoutes(relayOrigin).length,
          relayTokens().length,
        )
      ) {
        client?.client.close();
        relayClients.delete(relayOrigin);
      }
      return json(200, { ok: true });
    }

    // /api/rooms/<token>[/...] — collaborator endpoints, gated on the room token
    if (parts[0] === "api" && parts[1] === "rooms" && parts.length >= 3) {
      const room = getRoom(parts[2]);
      if (!room) return json(404, { error: "unknown room" });
      if (isSecureRoom(room)) return notFound();
      const rest = parts.slice(3).join("/");

      if (req.method === "GET" && rest === "") {
        const info = await agentInfo(room.agentId);
        return json(200, {
          label: room.label,
          createdAt: room.createdAt,
          agent: info
            ? {
                title: info.title,
                status: info.status,
                provider: info.provider,
              }
            : null,
          questions: await listRoomQuestions(room.agentId),
        });
      }

      if (req.method === "GET" && rest === "history") {
        const entries = await fetchFullHistory(room.agentId);
        return json(200, { entries });
      }

      if (req.method === "POST" && /^questions\/[^/]+\/respond$/.test(rest)) {
        const requestId = rest.split("/")[1];
        const body = JSON.parse(req.body.toString() || "{}");
        const hasAction = typeof body.actionId === "string";
        const hasAnswers = Array.isArray(body.answers);
        if (!hasAction && !hasAnswers)
          return json(400, { error: "answer required" });
        const answered = await answerQuestionOnce(room, requestId, {
          actionId: body.actionId,
          answers: hasAnswers ? body.answers : undefined,
        });
        if (!answered) return json(409, { error: "question unavailable" });
        return json(202, { ok: true });
      }

      if (req.method === "POST" && rest === "messages") {
        if (!checkRateLimit(room.token))
          return json(429, { error: "rate limit exceeded" });
        const body = JSON.parse(req.body.toString() || "{}");
        const message =
          typeof body.message === "string" ? body.message.trim() : "";
        if (!message) return json(400, { error: "message required" });
        const name = sanitizeParticipantName(body.name);
        // The room's mapping is the only routing authority: any agent_id in the
        // body is ignored.
        if (!name) return json(400, { error: "name required" });
        const text = `[${name}]\n${message}`;
        await sendToAgent(room.agentId, text);
        return json(202, { ok: true });
      }
    }

    return notFound();
  } catch (err) {
    return json(500, {
      error: err instanceof Error ? err.message : "internal error",
    });
  }
}

/**
 * Attach a browser socket for `/api/rooms/<token>/ws`. Returns false when the
 * token is unknown or the daemon is down (caller answers 404). Used by the
 * local upgrade path and by relay-forwarded `ws_event: open` frames alike.
 */
export async function openRoomSocket(
  requestPath: string,
  socket: RoomSocket,
): Promise<boolean> {
  if (!isConnected()) return false;
  const url = new URL(requestPath, LOCAL_BASE_URL);
  const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
  const room = match ? getRoom(match[1]) : undefined;
  if (!room || isSecureRoom(room)) return false;
  await joinRoom(room, socket);
  return true;
}

export async function openAnyRoomSocket(
  requestPath: string,
  socket: RoomSocket,
): Promise<boolean> {
  if (!isConnected()) return false;
  if (requestPath.startsWith("/v2/rooms/")) {
    return openSecureRoomSocket(
      requestPath,
      socket,
      checkRateLimit,
      (room: SecureRoom, questionId, payload) =>
        answerQuestionOnce(room, questionId, payload),
    );
  }
  return openRoomSocket(requestPath, socket);
}

// ---- local HTTP listener ---------------------------------------------------

const server = http.createServer(async (req, res) => {
  let response: ApiResponse;
  try {
    response = await handleApiRequest({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: Object.fromEntries(
        Object.entries(req.headers).flatMap(([k, v]) =>
          typeof v === "string" ? [[k, v] as [string, string]] : [],
        ),
      ),
      body: await readBody(req),
    });
  } catch (err) {
    response = json(500, {
      error: err instanceof Error ? err.message : "internal error",
    });
  }
  res.writeHead(response.status, response.headers);
  res.end(response.body);
});

// WS /api/rooms/<token>/ws — live timeline fan-out
const wss = new WebSocketServer({ noServer: true });
const v2Wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_V2_RECORD_BYTES,
  perMessageDeflate: false,
});
server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== BASE_HOST) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    } catch {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
  }
  if (!isConnected()) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? "/", LOCAL_BASE_URL);
  if (url.pathname.startsWith("/v2/rooms/")) {
    v2Wss.handleUpgrade(req, socket, head, (ws) => {
      openAnyRoomSocket(req.url ?? url.pathname, wrapWebSocket(ws)).then(
        (accepted) => {
          if (!accepted) ws.close(1008, "room unavailable");
        },
        () => ws.close(1011, "subscription failed"),
      );
    });
    return;
  }
  const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
  const room = match ? getRoom(match[1]) : undefined;
  if (!room || isSecureRoom(room)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    joinRoom(room, wrapWebSocket(ws)).catch(() =>
      ws.close(1011, "subscription failed"),
    );
  });
});

// ---- relay dial-out (opt-in) -----------------------------------------------

interface ManagedRelayClient {
  client: RelayClient;
  key: string;
  policy: RelayPolicy;
}

const relayClients = new Map<string, ManagedRelayClient>();

function defaultRelayOrigin(): string | null {
  const configured = process.env.RELAY_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return normalizeRelayOrigin(url.origin);
  } catch {
    return null;
  }
}

function relayClientFor(
  relayOrigin: string,
  key: string,
  policy: RelayPolicy,
): RelayClient {
  const existing = relayClients.get(relayOrigin);
  if (existing) {
    if (
      existing.key !== key ||
      existing.policy.registration !== policy.registration ||
      existing.policy.registrationAck !== policy.registrationAck
    ) {
      if (activeRelayRegistrationCount(relayOrigin) > 0)
        throw new Error(
          "Relay access mode or key changed while rooms are active",
        );
      assertRelayKeyCompatible(relayOrigin, key);
      existing.client.close();
      relayClients.delete(relayOrigin);
    } else {
      return existing.client;
    }
  }
  const client = startRelayClient({
    url: relayHostUrl(relayOrigin),
    key,
    minBackoffMs: Number(process.env.RELAY_MIN_BACKOFF_MS ?? 1_000),
    maxBackoffMs: Number(process.env.RELAY_MAX_BACKOFF_MS ?? 30_000),
    // Product room creation is v2. Never leak global legacy route tokens to
    // a separately selected relay; legacy compatibility stays on the default.
    currentTokens: () =>
      policy.roomProtocols.includes(1) && relayOrigin === defaultRelayOrigin()
        ? relayTokens()
        : [],
    currentRoutes: () => relayRoutes(relayOrigin),
    handleRequest: handleApiRequest,
    openSocket: openAnyRoomSocket,
  });
  relayClients.set(relayOrigin, { client, key, policy });
  return client;
}

function assertRelayKeyCompatible(relayOrigin: string, key: string): void {
  const existing = relayClients.get(relayOrigin);
  const error = relayKeyCompatibilityError(
    existing?.key,
    key,
    activeRelayRegistrationCount(relayOrigin),
  );
  if (error) throw new Error(error);
}

function activeRelayRegistrationCount(relayOrigin: string): number {
  return (
    relayRoutes(relayOrigin).length +
    (relayOrigin === defaultRelayOrigin() ? relayTokens().length : 0)
  );
}

export interface LocalRoomServer {
  baseUrl: string;
  adminToken: string;
  close(): Promise<void>;
}

export interface StartLocalRoomServerOptions {
  /** Tests can avoid opening a long-lived connection to a real Paseo daemon. */
  connectDaemon?: boolean;
  /** Resolve a private startup credential without copying it into process.env. */
  resolveRelayKey?: (origin: string) => string | undefined;
}

let localServer: Promise<LocalRoomServer> | null = null;

function startRelayDialOut(options: StartLocalRoomServerOptions): void {
  // Room creation performs discovery and admission on demand. Only persisted
  // legacy rooms need an eager connection; v2 rooms are intentionally ephemeral.
  const relayOrigin = defaultRelayOrigin();
  if (!relayOrigin || relayTokens().length === 0) return;
  const mode = process.env.RELAY_MODE ?? "auto";
  if (mode !== "auto" && mode !== "legacy-key") return;
  const generation = relayLifecycleGeneration;
  void discoverRelayPolicy(relayOrigin, mode as RelayMode)
    .then((policy) => {
      if (
        generation !== relayLifecycleGeneration ||
        !policy.roomProtocols.includes(1)
      )
        return;
      const key =
        policy.registration === "key"
          ? options.resolveRelayKey
            ? options.resolveRelayKey(relayOrigin)
            : process.env.RELAY_KEY
          : undefined;
      if (policy.registration === "key" && !key)
        throw new Error("A host registration key is required");
      relayClientFor(relayOrigin, key ?? "", policy);
    })
    .catch(() =>
      console.error(
        "Unable to restore legacy relay registration; check relay access configuration",
      ),
    );
}
let relayLifecycleGeneration = 0;

async function closeLocalRoomServer(): Promise<void> {
  if (!localServer) return;
  localServer = null;
  relayLifecycleGeneration++;
  for (const { client } of relayClients.values()) client.close();
  relayClients.clear();
  await closePaseoConnections();
  for (const socket of wss.clients) socket.close(1001, "room server stopped");
  for (const socket of v2Wss.clients) socket.close(1001, "room server stopped");
  if (!server.listening) {
    localServer = null;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

/**
 * Start the laptop-side room server as a lifecycle-managed service.
 *
 * The standalone CLI and the Paseo plugin both use this function. Keeping the
 * listener in-process lets plugin reload, update, disable, and daemon shutdown
 * close the matching room runtime instead of leaving a detached child behind.
 */
export async function startLocalRoomServer(
  options: StartLocalRoomServerOptions = {},
): Promise<LocalRoomServer> {
  if (localServer) return localServer;
  const pending = new Promise<LocalRoomServer>((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    server.once("error", onError);
    server.listen(PORT, "127.0.0.1", () => {
      server.off("error", onError);
      if (options.connectDaemon !== false) startRelayDialOut(options);
      console.log(`paseo-rooms listening on ${LOCAL_BASE_URL}`);
      if (options.connectDaemon !== false) {
        void ensureConnected()
          .then(() => console.log("connected to Paseo daemon"))
          .catch((error) => {
            // Shutdown deliberately invalidates a pending retry. The plugin
            // lifecycle already owns that transition, so do not turn it into
            // an unhandled rejection.
            if (localServer)
              console.error("Paseo daemon connection stopped:", error);
          });
      }
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : PORT;
      const baseUrl = new URL(LOCAL_BASE_URL);
      baseUrl.port = String(port);
      resolve({
        baseUrl: baseUrl.toString().replace(/\/$/, ""),
        adminToken: ADMIN_TOKEN,
        close: closeLocalRoomServer,
      });
    });
  });
  localServer = pending;
  try {
    return await pending;
  } catch (error) {
    // A synchronous startup failure must not poison later attempts from the
    // plugin panel.
    if (localServer === pending) localServer = null;
    throw error;
  }
}
