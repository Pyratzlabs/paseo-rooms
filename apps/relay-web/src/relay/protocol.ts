/**
 * Relay protocol v1 — wire types shared by the relay (this dir) and, later, the
 * laptop-side dial-out client. JSON text frames; binary payloads are base64.
 * See docs/plan.md "Relay protocol v1" — that section is normative.
 */

export const PROTOCOL_VERSION = 1;

/** Only these request headers cross the relay. */
export const FORWARDED_REQUEST_HEADERS = ["content-type", "x-forwarded-for"] as const;

/** Same cap as the room server's own body limit. */
export const MAX_BODY_BYTES = 256 * 1024;

// ---- laptop -> relay -------------------------------------------------------

export interface RegisterFrame {
  v: 1;
  type: "register";
  tokens: string[];
}

export interface UnregisterFrame {
  v: 1;
  type: "unregister";
  tokens: string[];
}

export interface HttpResponseFrame {
  v: 1;
  type: "http_response";
  id: string;
  status: number;
  headers: Record<string, string>;
  bodyB64: string;
}

export interface PongFrame {
  v: 1;
  type: "pong";
  t: number;
}

/** `ws_event` travels both ways; `open`/`path` are relay -> laptop only. */
export interface WsEventFrame {
  v: 1;
  type: "ws_event";
  id: string;
  event: "open" | "message" | "close";
  path?: string;
  dataB64?: string;
}

export type LaptopFrame =
  | RegisterFrame
  | UnregisterFrame
  | HttpResponseFrame
  | WsEventFrame
  | PongFrame;

// ---- relay -> laptop -------------------------------------------------------

export interface HttpRequestFrame {
  v: 1;
  type: "http_request";
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  bodyB64: string;
}

export interface PingFrame {
  v: 1;
  type: "ping";
  t: number;
}

export interface RegisterRejectedFrame {
  v: 1;
  type: "register_rejected";
  token: string;
}

export type RelayFrame = HttpRequestFrame | WsEventFrame | PingFrame | RegisterRejectedFrame;

// ---- parsing ---------------------------------------------------------------

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Parse a frame received from a laptop. Returns null for anything malformed —
 * the relay ignores junk rather than trusting shapes it did not verify.
 */
export function parseLaptopFrame(raw: string): LaptopFrame | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const f = msg as Record<string, unknown>;
  if (f.v !== PROTOCOL_VERSION) return null;

  switch (f.type) {
    case "register":
    case "unregister":
      return isStringArray(f.tokens) ? ({ v: 1, type: f.type, tokens: f.tokens } as LaptopFrame) : null;
    case "http_response":
      if (typeof f.id !== "string" || typeof f.status !== "number") return null;
      return {
        v: 1,
        type: "http_response",
        id: f.id,
        status: f.status,
        headers: isHeaders(f.headers) ? f.headers : {},
        bodyB64: typeof f.bodyB64 === "string" ? f.bodyB64 : "",
      };
    case "ws_event":
      if (typeof f.id !== "string") return null;
      if (f.event !== "open" && f.event !== "message" && f.event !== "close") return null;
      return {
        v: 1,
        type: "ws_event",
        id: f.id,
        event: f.event,
        ...(typeof f.dataB64 === "string" ? { dataB64: f.dataB64 } : {}),
      };
    case "pong":
      return { v: 1, type: "pong", t: typeof f.t === "number" ? f.t : 0 };
    default:
      return null;
  }
}

function isHeaders(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value as Record<string, unknown>).every((v) => typeof v === "string")
  );
}

// ---- public route parsing --------------------------------------------------

export type PublicRoute =
  | { kind: "page"; token: string }
  | { kind: "api"; token: string }
  | { kind: "ws"; token: string }
  | null;

/**
 * Routable browser-side paths, per protocol v1: `GET /r/:token`, its
 * capability-scoped Vite assets (`/r/:token/assets/...`),
 * `ANY /api/rooms/:token(/...)`, and the WS upgrade `/api/rooms/:token/ws`.
 * Everything else — notably `POST /api/rooms` with no token — is not routable.
 */
export function matchPublicRoute(pathname: string, isUpgrade: boolean): PublicRoute {
  const parts = pathname.split("/").filter(Boolean);
  if (!isUpgrade && parts.length === 2 && parts[0] === "r") {
    return { kind: "page", token: parts[1] };
  }
  if (!isUpgrade && parts.length >= 4 && parts[0] === "r" && parts[2] === "assets") {
    return { kind: "page", token: parts[1] };
  }
  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "rooms") {
    const token = parts[2];
    if (isUpgrade) {
      return parts.length === 4 && parts[3] === "ws" ? { kind: "ws", token } : null;
    }
    return { kind: "api", token };
  }
  return null;
}
