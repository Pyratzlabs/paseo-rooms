/**
 * Laptop-side dial-out client for "Relay protocol v1" (docs/plan.md).
 *
 * When `RELAY_URL` (+ `RELAY_KEY`) is set, the room server keeps ONE outbound
 * WebSocket to the relay open forever: it registers the room tokens it owns,
 * answers forwarded HTTP requests and WebSocket events by dispatching into the
 * exact same handlers that serve local traffic, and reconnects with backoff.
 *
 * Nothing about the daemon (credentials, agent ids) crosses this connection —
 * the relay only ever sees room tokens and opaque response bytes.
 */

import { WebSocket } from "ws";
import {
  matchPublicRoute,
  MAX_HOST_CONTROL_BYTES,
  MAX_V2_RELAY_EVENT_B64_CHARS,
  parseV2OuterRecord,
  PROTOCOL_VERSION,
  type LaptopFrame,
  type RegisteredRoute,
  type RelayFrame,
  type RoomProtocolVersion,
} from "./relay/protocol.js";

/**
 * Parse a frame received from the relay. Mirror image of the relay's
 * `parseLaptopFrame`: anything malformed is dropped rather than trusted.
 */
function parseRelayFrame(raw: string): RelayFrame | null {
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
    case "http_request":
      if (
        typeof f.id !== "string" ||
        typeof f.method !== "string" ||
        typeof f.path !== "string"
      )
        return null;
      return {
        v: 1,
        type: "http_request",
        id: f.id,
        method: f.method,
        path: f.path,
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
        ...(typeof f.path === "string" ? { path: f.path } : {}),
        ...(typeof f.dataB64 === "string" ? { dataB64: f.dataB64 } : {}),
      };
    case "ping":
      return { v: 1, type: "ping", t: typeof f.t === "number" ? f.t : 0 };
    case "register_rejected":
      return typeof f.token === "string"
        ? { v: 1, type: "register_rejected", token: f.token }
        : null;
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

// ---- the contract this client needs from the room server -------------------

/** A protocol-agnostic view of an inbound request. */
export interface ApiRequest {
  method: string;
  /** Request target, may include a query string. */
  path: string;
  headers: Record<string, string>;
  body: Buffer;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

/**
 * The subset of a browser WebSocket the room fan-out actually uses. Local
 * `ws` sockets and relay-forwarded virtual sockets both implement it, so
 * `joinRoom` cannot tell them apart.
 */
export interface RoomSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  /** Register a close callback (fires once, whoever closed first). */
  onClose(handler: () => void): void;
  /** Register an inbound browser-frame callback. */
  onMessage(handler: (data: string) => void): void;
}

export interface RelayClientHooks {
  handleRequest(req: ApiRequest): Promise<ApiResponse>;
  /** Attach a virtual browser socket to a room; false = reject (404). */
  openSocket(path: string, socket: RoomSocket): Promise<boolean>;
  /** All room tokens that currently exist, re-sent on every (re)connect. */
  currentTokens(): string[];
  /** Explicit protocol-aware routes, registered alongside legacy v1 tokens. */
  currentRoutes?(): RegisteredRoute[];
}

export interface RelayClientOptions extends RelayClientHooks {
  url: string;
  key: string;
  /** Backoff bounds; overridable so tests do not wait seconds. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  log?: (line: string) => void;
}

export interface RelayClient {
  /** Claim tokens (call on room creation). No-op while disconnected — the
   *  full set is re-registered on the next connect anyway. */
  register(tokens: string[]): void;
  /** Release tokens (call on revocation). */
  unregister(tokens: string[]): void;
  /** Claim protocol-aware routes (used by v2 once secure rooms exist). */
  registerRoutes(routes: RegisteredRoute[]): void;
  unregisterRoutes(routes: RegisteredRoute[]): void;
  connected(): boolean;
  close(): void;
}

export function startRelayClient(options: RelayClientOptions): RelayClient {
  const minBackoff = options.minBackoffMs ?? 1_000;
  const maxBackoff = options.maxBackoffMs ?? 30_000;
  const log = options.log ?? ((line: string) => console.log(line));

  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = minBackoff;
  let retryTimer: NodeJS.Timeout | null = null;
  /** Virtual browser sockets, keyed by the relay's per-socket id. */
  const sockets = new Map<string, VirtualSocket>();

  function send(frame: LaptopFrame): void {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  }

  /** A relay-forwarded browser socket, dressed up as a local room socket. */
  class VirtualSocket implements RoomSocket {
    private closed = false;
    private handlers: Array<() => void> = [];
    private messageHandlers: Array<(data: string) => void> = [];

    constructor(
      readonly id: string,
      readonly protocol: RoomProtocolVersion,
    ) {}

    send(data: string): void {
      if (this.closed) return;
      send({
        v: 1,
        type: "ws_event",
        id: this.id,
        event: "message",
        dataB64: Buffer.from(data).toString("base64"),
      });
    }

    /** Close initiated by us (revocation, subscription failure): tell the relay. */
    close(): void {
      if (this.closed) return;
      send({ v: 1, type: "ws_event", id: this.id, event: "close" });
      this.remoteClosed();
    }

    /** Close initiated by the browser or by losing the relay: local teardown. */
    remoteClosed(): void {
      if (this.closed) return;
      this.closed = true;
      sockets.delete(this.id);
      for (const handler of this.handlers) handler();
      this.handlers = [];
      this.messageHandlers = [];
    }

    onClose(handler: () => void): void {
      if (this.closed) handler();
      else this.handlers.push(handler);
    }

    onMessage(handler: (data: string) => void): void {
      if (!this.closed) this.messageHandlers.push(handler);
    }

    receive(data: string): void {
      if (!this.closed)
        for (const handler of this.messageHandlers) handler(data);
    }
  }

  function dropAllSockets(): void {
    for (const socket of [...sockets.values()]) socket.remoteClosed();
    sockets.clear();
  }

  function connect(): void {
    if (stopped) return;
    const socket = new WebSocket(options.url, {
      headers: { "x-relay-key": options.key },
    });
    ws = socket;

    socket.on("open", () => {
      backoff = minBackoff;
      const routes = options.currentRoutes?.() ?? [];
      const routedTokens = new Set(routes.map((route) => route.token));
      const tokens = options
        .currentTokens()
        .filter((token) => !routedTokens.has(token));
      const count = tokens.length + routes.length;
      log(
        `[relay-client] connected to ${options.url} (registering ${count} route(s))`,
      );
      if (routes && routes.length > 0)
        send({ v: 1, type: "register", tokens, routes });
      else if (tokens.length > 0) send({ v: 1, type: "register", tokens });
    });

    socket.on("message", (data) => {
      const frame = parseRelayFrame(
        typeof data === "string" ? data : data.toString(),
      );
      if (!frame) return;

      switch (frame.type) {
        case "ping":
          send({ v: 1, type: "pong", t: frame.t });
          break;

        case "register_rejected":
          log(
            `[relay-client] token ${frame.token} is claimed by another room server`,
          );
          break;

        case "http_request":
          void (async () => {
            let response: ApiResponse;
            try {
              response = await options.handleRequest({
                method: frame.method,
                path: frame.path,
                headers: frame.headers,
                body: Buffer.from(frame.bodyB64, "base64"),
              });
            } catch (err) {
              response = {
                status: 500,
                headers: { "content-type": "application/json" },
                body: Buffer.from(
                  JSON.stringify({
                    error:
                      err instanceof Error ? err.message : "internal error",
                  }),
                ),
              };
            }
            send({
              v: 1,
              type: "http_response",
              id: frame.id,
              status: response.status,
              headers: response.headers,
              bodyB64: response.body.toString("base64"),
            });
          })();
          break;

        case "ws_event":
          if (frame.event === "open") {
            const route = matchPublicRoute(
              new URL(frame.path ?? "/", "http://relay.invalid").pathname,
              true,
            );
            if (!route) return;
            const virtual = new VirtualSocket(frame.id, route.protocol);
            sockets.set(frame.id, virtual);
            void options
              .openSocket(frame.path ?? "/", virtual)
              .then((accepted) => {
                if (!accepted) virtual.close();
              })
              .catch(() => virtual.close());
          } else if (frame.event === "message") {
            const socket = sockets.get(frame.id);
            const maximum =
              socket?.protocol === 2 ? MAX_V2_RELAY_EVENT_B64_CHARS : 4096;
            if (frame.dataB64 && frame.dataB64.length <= maximum) {
              const data = Buffer.from(frame.dataB64, "base64").toString(
                "utf8",
              );
              if (socket?.protocol === 2 && !parseV2OuterRecord(data)) {
                socket.close();
                return;
              }
              socket?.receive(data);
            }
          } else {
            sockets.get(frame.id)?.remoteClosed();
          }
          break;
      }
    });

    const reconnect = (): void => {
      if (socket !== ws) return; // superseded
      ws = null;
      dropAllSockets();
      if (stopped) return;
      const jitter = Math.random() * backoff * 0.5;
      const delay = Math.round(backoff + jitter);
      log(`[relay-client] disconnected; reconnecting in ${delay}ms`);
      retryTimer = setTimeout(connect, delay);
      retryTimer.unref?.();
      backoff = Math.min(backoff * 2, maxBackoff);
    };

    socket.on("close", (code, reason) => {
      const detail = reason.toString("utf8");
      log(
        `[relay-client] control socket closed (code ${code}${detail ? `, ${detail}` : ""})`,
      );
      reconnect();
    });
    socket.on("error", (error) => {
      // 'close' always follows; keep the reconnect path single, but retain the
      // cause: without it, an upstream or TLS failure is indistinguishable
      // from an intentional relay restart.
      log(`[relay-client] control socket error: ${error.message}`);
    });
  }

  connect();

  return {
    register: (tokens) => {
      if (tokens.length > 0) send({ v: 1, type: "register", tokens });
    },
    unregister: (tokens) => {
      if (tokens.length > 0) send({ v: 1, type: "unregister", tokens });
    },
    registerRoutes: (routes) => {
      if (routes.length > 0)
        send({ v: 1, type: "register", tokens: [], routes });
    },
    unregisterRoutes: (routes) => {
      if (routes.length > 0)
        send({ v: 1, type: "unregister", tokens: [], routes });
    },
    connected: () => ws !== null && ws.readyState === WebSocket.OPEN,
    close: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      dropAllSockets();
      ws?.close();
      ws = null;
    },
  };
}
