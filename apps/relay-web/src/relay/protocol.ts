/**
 * Relay protocol v1 — wire types shared by the relay (this dir) and, later, the
 * laptop-side dial-out client. JSON text frames; binary payloads are base64.
 * See docs/plan.md "Relay protocol v1" — that section is normative.
 */

export const PROTOCOL_VERSION = 1;
export type RoomProtocolVersion = 1 | 2;

/** Only these request headers cross the relay. */
export const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "x-forwarded-for",
] as const;

/** Same cap as the room server's own body limit. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Maximum decoded opaque v2 record. */
export const MAX_V2_PAYLOAD_BYTES = 64 * 1024;
/** Maximum UTF-8 JSON wrapper carrying a v2 record. */
export const MAX_V2_RECORD_BYTES = 90 * 1024;
/** Base64 length when a maximal v2 wrapper crosses the host control channel. */
export const MAX_V2_RELAY_EVENT_B64_CHARS = Math.ceil(
  (MAX_V2_RECORD_BYTES * 4) / 3,
);
/** Bound the authenticated laptop control channel independently from room data. */
export const MAX_HOST_CONTROL_BYTES = 512 * 1024;
export const MAX_REGISTERED_ROUTES = 256;

export interface RegisteredRoute {
  token: string;
  protocol: RoomProtocolVersion;
}

// ---- laptop -> relay -------------------------------------------------------

export interface RegisterFrame {
  v: 1;
  type: "register";
  tokens: string[];
  routes?: RegisteredRoute[];
}

export interface UnregisterFrame {
  v: 1;
  type: "unregister";
  tokens: string[];
  routes?: RegisteredRoute[];
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

export type RelayFrame =
  HttpRequestFrame | WsEventFrame | PingFrame | RegisterRejectedFrame;

// ---- parsing ---------------------------------------------------------------

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

const ROUTE_TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;
const V2_ROUTE_ID_RE = /^[A-Za-z0-9_-]{43}$/;

export function isRouteToken(value: unknown): value is string {
  return typeof value === "string" && ROUTE_TOKEN_RE.test(value);
}

function isRoomProtocolVersion(value: unknown): value is RoomProtocolVersion {
  return value === 1 || value === 2;
}

function parseRegisteredRoutes(value: unknown): RegisteredRoute[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length > MAX_REGISTERED_ROUTES) return null;
  const routes: RegisteredRoute[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null) return null;
    const route = item as Record<string, unknown>;
    if (!isRouteToken(route.token) || !isRoomProtocolVersion(route.protocol))
      return null;
    if (route.protocol === 2 && !V2_ROUTE_ID_RE.test(route.token)) return null;
    if (seen.has(route.token)) return null;
    seen.add(route.token);
    routes.push({ token: route.token, protocol: route.protocol });
  }
  return routes;
}

function hasRouteConflicts(routes: RegisteredRoute[]): boolean {
  const seen = new Map<string, RoomProtocolVersion>();
  for (const route of routes) {
    const existing = seen.get(route.token);
    if (existing !== undefined) return true;
    seen.set(route.token, route.protocol);
  }
  return false;
}

export function frameRoutes(
  frame: RegisterFrame | UnregisterFrame,
): RegisteredRoute[] {
  return [
    ...frame.tokens.map((token) => ({ token, protocol: 1 as const })),
    ...(frame.routes ?? []),
  ];
}

/**
 * Parse a frame received from a laptop. Returns null for anything malformed —
 * the relay ignores junk rather than trusting shapes it did not verify.
 */
export function parseLaptopFrame(raw: string): LaptopFrame | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_HOST_CONTROL_BYTES) return null;
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
    case "unregister": {
      if (f.tokens !== undefined && !isStringArray(f.tokens)) return null;
      if (f.tokens !== undefined && !f.tokens.every(isRouteToken)) return null;
      const tokens = isStringArray(f.tokens) ? f.tokens : [];
      const routes =
        f.routes === undefined ? undefined : parseRegisteredRoutes(f.routes);
      if (f.tokens === undefined && routes === undefined) return null;
      if (routes === null) return null;
      if (tokens.length + (routes?.length ?? 0) > MAX_REGISTERED_ROUTES)
        return null;
      if (
        routes &&
        hasRouteConflicts([
          ...tokens.map((token) => ({ token, protocol: 1 as const })),
          ...routes,
        ])
      )
        return null;
      return {
        v: 1,
        type: f.type,
        tokens,
        ...(routes ? { routes } : {}),
      } as LaptopFrame;
    }
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
      if (f.event !== "open" && f.event !== "message" && f.event !== "close")
        return null;
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
    Object.values(value as Record<string, unknown>).every(
      (v) => typeof v === "string",
    )
  );
}

// ---- public route parsing --------------------------------------------------

export type PublicRoute =
  | { kind: "api"; token: string; protocol: 1 }
  | { kind: "ws"; token: string; protocol: RoomProtocolVersion }
  | null;

export type V2OuterRecordType = "handshake" | "secure";

export interface V2OuterRecord {
  v: 2;
  type: V2OuterRecordType;
  data: string;
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export function parseV2OuterRecord(raw: string): V2OuterRecord | null {
  if (Buffer.byteLength(raw, "utf8") > MAX_V2_RECORD_BYTES) return null;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const frame = msg as Record<string, unknown>;
  if (frame.v !== 2) return null;
  if (frame.type !== "handshake" && frame.type !== "secure")
    return null;
  if (typeof frame.data !== "string" || !BASE64URL_RE.test(frame.data))
    return null;
  const data = Buffer.from(frame.data, "base64url");
  if (data.byteLength === 0 || data.byteLength > MAX_V2_PAYLOAD_BYTES)
    return null;
  // The v2 wrapper is deliberately canonical. Besides making relaying
  // byte-for-byte predictable, this rejects duplicate/unknown JSON members:
  // JSON.parse would otherwise silently overwrite duplicate keys.
  const canonical = JSON.stringify({
    v: 2,
    type: frame.type,
    data: frame.data,
  });
  if (raw !== canonical || data.toString("base64url") !== frame.data)
    return null;
  return { v: 2, type: frame.type, data: frame.data };
}

/**
 * Dynamic browser-side paths which need a laptop hop. The public relay serves
 * the room shell and Vite assets itself; only capability-scoped APIs and the
 * room WebSocket are forwarded to a laptop. `POST /api/rooms` without a token
 * is deliberately never routable.
 */
export function matchPublicRoute(
  pathname: string,
  isUpgrade: boolean,
): PublicRoute {
  const parts = pathname.split("/").filter(Boolean);
  if (
    isUpgrade &&
    parts.length === 4 &&
    parts[0] === "v2" &&
    parts[1] === "rooms" &&
    parts[3] === "ws"
  ) {
    if (!V2_ROUTE_ID_RE.test(parts[2])) return null;
    return { kind: "ws", token: parts[2], protocol: 2 };
  }
  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "rooms") {
    const token = parts[2];
    if (!isRouteToken(token)) return null;
    if (isUpgrade) {
      return parts.length === 4 && parts[3] === "ws"
        ? { kind: "ws", token, protocol: 1 }
        : null;
    }
    return { kind: "api", token, protocol: 1 };
  }
  return null;
}
