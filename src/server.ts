import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { createRoom, deleteRoom, getAdminToken, getRoom, listRooms, timingSafeEqual, type Room } from "./rooms.js";
import {
  agentInfo,
  ensureConnected,
  fetchFullHistory,
  isConnected,
  sendToAgent,
  subscribeAgent,
} from "./paseo.js";

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const BASE_HOST = new URL(BASE_URL).host;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

const ADMIN_TOKEN = getAdminToken();

// ---- rate limiting ----------------------------------------------------------

const RATE_LIMIT = 10; // max messages per token per window
const RATE_WINDOW_MS = 60_000;
const messageTimestamps = new Map<string, number[]>();

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

// ---- live fan-out ----------------------------------------------------------

interface LiveRoom {
  sockets: Set<WebSocket>;
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

async function joinRoom(room: Room, socket: WebSocket): Promise<void> {
  let live = liveRooms.get(room.token);
  if (!live) {
    live = { sockets: new Set(), unsubscribe: null };
    liveRooms.set(room.token, live);
    live.unsubscribe = await subscribeAgent(room.agentId, ({ event, timestamp }) => {
      const frame = JSON.stringify({ type: "stream", event, timestamp });
      for (const ws of live!.sockets) {
        if (ws.readyState === WebSocket.OPEN) ws.send(frame);
      }
    });
  }
  live.sockets.add(socket);
  socket.on("close", () => {
    live!.sockets.delete(socket);
    if (live!.sockets.size === 0) {
      live!.unsubscribe?.();
      liveRooms.delete(room.token);
    }
  });
}

// ---- helpers ---------------------------------------------------------------

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 256 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function serveFile(res: http.ServerResponse, file: string, type: string): void {
  try {
    const content = fs.readFileSync(path.join(PUBLIC_DIR, file));
    res.writeHead(200, { "content-type": type });
    res.end(content);
  } catch {
    res.writeHead(404).end("not found");
  }
}

/** Collaborator display name: keep it short and unable to fake timeline markup. */
function sanitizeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\[\]\n\r]/g, "").trim().slice(0, 40);
  return name.length > 0 ? name : null;
}

// ---- routes ----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", BASE_URL);
    const parts = url.pathname.split("/").filter(Boolean);

    // GET /r/<token> — the shared chat page (token validated client-side via API)
    if (req.method === "GET" && parts[0] === "r" && parts.length === 2) {
      return serveFile(res, "room.html", "text/html; charset=utf-8");
    }
    if (req.method === "GET" && url.pathname === "/") {
      return serveFile(res, "index.html", "text/html; charset=utf-8");
    }

    // GET /healthz — liveness + daemon connectivity, unauthenticated
    if (req.method === "GET" && url.pathname === "/healthz") {
      return sendJson(res, 200, { ok: true, daemonConnected: isConnected() });
    }

    // Everything below talks to the daemon: fail fast while it's unreachable.
    if (url.pathname.startsWith("/api/") && !isConnected()) {
      return sendJson(res, 503, { error: "daemon unavailable" });
    }

    function checkAdmin(): boolean {
      const auth = req.headers.authorization ?? "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      return timingSafeEqual(bearer, ADMIN_TOKEN);
    }

    // POST /api/rooms — admin only: create a share room for an agent
    if (req.method === "POST" && url.pathname === "/api/rooms") {
      if (!checkAdmin()) return sendJson(res, 401, { error: "unauthorized" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const agentId = typeof body.agentId === "string" ? body.agentId : null;
      if (!agentId) return sendJson(res, 400, { error: "agentId required" });
      const info = await agentInfo(agentId);
      if (!info) return sendJson(res, 404, { error: "no such agent" });
      const room = createRoom(agentId, typeof body.label === "string" ? body.label : info.title ?? "Shared session");
      return sendJson(res, 201, { token: room.token, url: `${BASE_URL}/r/${room.token}` });
    }

    // GET /api/rooms — admin only: list rooms
    if (req.method === "GET" && url.pathname === "/api/rooms") {
      if (!checkAdmin()) return sendJson(res, 401, { error: "unauthorized" });
      return sendJson(res, 200, { rooms: listRooms() });
    }

    // DELETE /api/rooms/<token> — admin only: revoke a room
    if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "rooms" && parts.length === 3) {
      if (!checkAdmin()) return sendJson(res, 401, { error: "unauthorized" });
      const existed = deleteRoom(parts[2]);
      if (!existed) return sendJson(res, 404, { error: "unknown room" });
      closeLiveRoom(parts[2]);
      return sendJson(res, 200, { ok: true });
    }

    // /api/rooms/<token>[/...] — collaborator endpoints, gated on the room token
    if (parts[0] === "api" && parts[1] === "rooms" && parts.length >= 3) {
      const room = getRoom(parts[2]);
      if (!room) return sendJson(res, 404, { error: "unknown room" });
      const rest = parts.slice(3).join("/");

      if (req.method === "GET" && rest === "") {
        const info = await agentInfo(room.agentId);
        return sendJson(res, 200, {
          label: room.label,
          createdAt: room.createdAt,
          agent: info ? { title: info.title, status: info.status, provider: info.provider } : null,
        });
      }

      if (req.method === "GET" && rest === "history") {
        const entries = await fetchFullHistory(room.agentId);
        return sendJson(res, 200, { entries });
      }

      if (req.method === "POST" && rest === "messages") {
        if (!checkRateLimit(room.token)) return sendJson(res, 429, { error: "rate limit exceeded" });
        const body = JSON.parse((await readBody(req)) || "{}");
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) return sendJson(res, 400, { error: "message required" });
        const name = sanitizeName(body.name);
        // The room's mapping is the only routing authority: any agent_id in the
        // body is ignored.
        const text = name ? `[${name}]\n${message}` : message;
        await sendToAgent(room.agentId, text);
        return sendJson(res, 202, { ok: true });
      }
    }

    res.writeHead(404).end("not found");
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
  }
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
    joinRoom(room, ws).catch(() => ws.close(1011, "subscription failed"));
  });
});

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
