import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { createRoom, deleteRoom, getAdminToken, getRoom, listRooms, timingSafeEqual, type Room } from "./rooms.js";
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
  isConnected,
  sendToAgent,
  subscribeAgent,
} from "./paseo.js";
import { publicStreamEvent } from "./public-events.js";
import { parsePresenceHello, RoomPresence, sanitizeParticipantName } from "./presence.js";

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const BASE_HOST = new URL(BASE_URL).host;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const ADMIN_TOKEN = getAdminToken();

// ---- rate limiting ----------------------------------------------------------

const RATE_LIMIT = 10; // max messages per token per window
const RATE_WINDOW_MS = 60_000;
const messageTimestamps = new Map<string, number[]>();
const answeringQuestions = new Set<string>();
const questionTimestamps = new Map<string, number[]>();

function checkRateLimit(token: string): boolean {
  const now = Date.now();
  const timestamps = (messageTimestamps.get(token) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
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
  const timestamps = (questionTimestamps.get(token) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
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

/**
 * Attach a browser socket to a room's timeline fan-out. The socket may be a
 * local `ws` connection or a relay-forwarded virtual one — see `RoomSocket`.
 */
async function joinRoom(room: Room, socket: RoomSocket): Promise<void> {
  let live = liveRooms.get(room.token);
  if (!live) {
    live = { sockets: new Set(), presence: new RoomPresence(), unsubscribe: null };
    liveRooms.set(room.token, live);
    live.unsubscribe = await subscribeAgent(room.agentId, ({ event, timestamp }) => {
      const frame = JSON.stringify({ type: "stream", event: publicStreamEvent(event), timestamp });
      for (const ws of live!.sockets) {
        ws.send(frame);
      }
    });
  }
  live.sockets.add(socket);
  const broadcastPresence = () => {
    const frame = JSON.stringify({ type: "presence", participants: live!.presence.list() });
    for (const ws of live!.sockets) ws.send(frame);
  };
  socket.onMessage((data) => {
    const name = parsePresenceHello(data);
    if (name && live!.presence.join(socket, name)) broadcastPresence();
  });
  socket.send(JSON.stringify({ type: "presence", participants: live.presence.list() }));
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
    send: (data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    },
    close: (code, reason) => ws.close(code, reason),
    onClose: (handler) => ws.on("close", handler),
    onMessage: (handler) => ws.on("message", (data) => handler(data.toString())),
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
  if (pieces.length === 0 || pieces.some((piece) => !/^[A-Za-z0-9._-]+$/.test(piece))) return notFound();
  const root = path.join(PUBLIC_DIR, "landing");
  const target = path.resolve(root, ...pieces);
  if (!target.startsWith(`${root}${path.sep}`)) return notFound();
  try {
    const type = ASSET_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream";
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
  if (pieces.length === 0 || pieces.some((piece) => !/^[A-Za-z0-9._-]+$/.test(piece))) return notFound();
  const root = path.join(PUBLIC_DIR, "assets");
  const target = path.resolve(root, ...pieces);
  if (!target.startsWith(`${root}${path.sep}`)) return notFound();
  try {
    const type = ASSET_TYPES[path.extname(target).toLowerCase()] ?? "application/octet-stream";
    return { status: 200, headers: { "content-type": type, "cache-control": "public, max-age=31536000, immutable" }, body: fs.readFileSync(target) };
  } catch {
    return notFound();
  }
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
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function notFound(): ApiResponse {
  return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: Buffer.from("not found") };
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
    const url = new URL(req.path, BASE_URL);
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
      const room = createRoom(agentId, typeof body.label === "string" ? body.label : info.title ?? "Shared session");
      relayClient?.register([room.token]);
      return json(201, { token: room.token, url: `${BASE_URL}/r/${room.token}` });
    }

    // GET /api/rooms — admin only: list rooms
    if (req.method === "GET" && url.pathname === "/api/rooms") {
      if (!checkAdmin()) return json(401, { error: "unauthorized" });
      return json(200, {
        rooms: listRooms().map((room) => ({
          ...room,
          url: `${BASE_URL}/r/${room.token}`,
        })),
      });
    }

    // DELETE /api/rooms/<token> — admin only: revoke a room
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "rooms" && parts.length === 3) {
      if (!checkAdmin()) return json(401, { error: "unauthorized" });
      const existed = deleteRoom(parts[2]);
      if (!existed) return json(404, { error: "unknown room" });
      closeLiveRoom(parts[2]);
      relayClient?.unregister([parts[2]]);
      return json(200, { ok: true });
    }

    // /api/rooms/<token>[/...] — collaborator endpoints, gated on the room token
    if (parts[0] === "api" && parts[1] === "rooms" && parts.length >= 3) {
      const room = getRoom(parts[2]);
      if (!room) return json(404, { error: "unknown room" });
      const rest = parts.slice(3).join("/");

      if (req.method === "GET" && rest === "") {
        const info = await agentInfo(room.agentId);
        return json(200, {
          label: room.label,
          createdAt: room.createdAt,
          agent: info ? { title: info.title, status: info.status, provider: info.provider } : null,
          questions: await listRoomQuestions(room.agentId),
        });
      }

      if (req.method === "GET" && rest === "history") {
        const entries = await fetchFullHistory(room.agentId);
        return json(200, { entries });
      }

      if (req.method === "POST" && /^questions\/[^/]+\/respond$/.test(rest)) {
        const requestId = rest.split("/")[1];
        const key = `${room.token}:${requestId}`;
        if (!checkQuestionRateLimit(room.token)) return json(429, { error: "rate limit exceeded" });
        if (answeringQuestions.has(key)) return json(409, { error: "question already resolved" });
        const body = JSON.parse(req.body.toString() || "{}");
        const hasAction = typeof body.actionId === "string";
        const hasAnswers = Array.isArray(body.answers);
        if (!hasAction && !hasAnswers) return json(400, { error: "answer required" });
        answeringQuestions.add(key);
        try {
          const answered = await answerRoomQuestion(room.agentId, requestId, {
            actionId: body.actionId,
            answers: hasAnswers ? body.answers : undefined,
          });
          if (!answered) return json(409, { error: "question unavailable" });
          return json(202, { ok: true });
        } finally {
          answeringQuestions.delete(key);
        }
      }

      if (req.method === "POST" && rest === "messages") {
        if (!checkRateLimit(room.token)) return json(429, { error: "rate limit exceeded" });
        const body = JSON.parse(req.body.toString() || "{}");
        const message = typeof body.message === "string" ? body.message.trim() : "";
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
    return json(500, { error: err instanceof Error ? err.message : "internal error" });
  }
}

/**
 * Attach a browser socket for `/api/rooms/<token>/ws`. Returns false when the
 * token is unknown or the daemon is down (caller answers 404). Used by the
 * local upgrade path and by relay-forwarded `ws_event: open` frames alike.
 */
export async function openRoomSocket(requestPath: string, socket: RoomSocket): Promise<boolean> {
  if (!isConnected()) return false;
  const url = new URL(requestPath, BASE_URL);
  const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
  const room = match ? getRoom(match[1]) : undefined;
  if (!room) return false;
  await joinRoom(room, socket);
  return true;
}

// ---- local HTTP listener ---------------------------------------------------

const server = http.createServer(async (req, res) => {
  let response: ApiResponse;
  try {
    response = await handleApiRequest({
      method: req.method ?? "GET",
      path: req.url ?? "/",
      headers: Object.fromEntries(
        Object.entries(req.headers).flatMap(([k, v]) => (typeof v === "string" ? [[k, v] as [string, string]] : [])),
      ),
      body: await readBody(req),
    });
  } catch (err) {
    response = json(500, { error: err instanceof Error ? err.message : "internal error" });
  }
  res.writeHead(response.status, response.headers);
  res.end(response.body);
});

// WS /api/rooms/<token>/ws — live timeline fan-out
const wss = new WebSocketServer({ noServer: true });
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
  const url = new URL(req.url ?? "/", BASE_URL);
  const match = url.pathname.match(/^\/api\/rooms\/([^/]+)\/ws$/);
  const room = match ? getRoom(match[1]) : undefined;
  if (!room) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    joinRoom(room, wrapWebSocket(ws)).catch(() => ws.close(1011, "subscription failed"));
  });
});

// ---- relay dial-out (opt-in) -----------------------------------------------

let relayClient: RelayClient | null = null;

const RELAY_URL = process.env.RELAY_URL;
const RELAY_KEY = process.env.RELAY_KEY;
if (RELAY_URL) {
  if (!RELAY_KEY) {
    console.error("RELAY_URL is set but RELAY_KEY is missing — not dialling out to the relay");
  } else {
    relayClient = startRelayClient({
      url: RELAY_URL,
      key: RELAY_KEY,
      minBackoffMs: Number(process.env.RELAY_MIN_BACKOFF_MS ?? 1_000),
      maxBackoffMs: Number(process.env.RELAY_MAX_BACKOFF_MS ?? 30_000),
      currentTokens: () => listRooms().map((r) => r.token),
      handleRequest: handleApiRequest,
      openSocket: openRoomSocket,
    });
  }
}

// Boot resilience: start the HTTP listener immediately so /healthz and
// static routes work even if the daemon is down; connect (with retry) in the
// background. API routes respond 503 until connected.
server.listen(PORT, () => {
  console.log(`paseo-rooms listening on ${BASE_URL}`);
  console.log(`admin token: data/admin-token (create rooms with "npm run share -- <agent-id>")`);
});
ensureConnected().then(() => {
  console.log("connected to Paseo daemon");
});
