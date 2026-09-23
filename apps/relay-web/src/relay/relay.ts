/**
 * paseo-rooms relay — a dumb pipe from public browser traffic to whichever
 * laptop room server claimed the room token. Implements "Relay protocol v1"
 * (docs/plan.md). Routing is in-memory only: on restart, laptops re-register.
 *
 * The relay never sees daemon credentials or agent IDs. v1 room payloads remain
 * plaintext to the relay; v2 route work below only establishes the opaque
 * transport boundary that later encrypted room records will use.
 */

import http from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { verifyRouteOwnership } from "./route-ownership.js";
import fs from "node:fs";
import path from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  MAX_BODY_BYTES,
  MAX_HOST_CONTROL_BYTES,
  MAX_V2_RECORD_BYTES,
  FORWARDED_REQUEST_HEADERS,
  frameRoutes,
  matchPublicRoute,
  parseLaptopFrame,
  parseV2OuterRecord,
  type HttpResponseFrame,
  type RelayFrame,
  type RoomProtocolVersion,
} from "./protocol.js";

export interface RelayOptions {
  /** TCP port; 0 picks a free one (used by the protocol test). */
  port?: number;
  /** Shared secret expected in the `x-relay-key` header on /host. */
  relayKey?: string;
  authMode?: "open" | "key";
  limits?: Partial<RelayLimits>;
  /** Exact immediate proxy IPs; these peers must overwrite X-Forwarded-For. */
  trustedProxyAddresses?: string[];
  admissionEnabled?: boolean;
  /** Ping cadence; connections die after 2 missed pongs. */
  pingIntervalMs?: number;
  /** How long a forwarded HTTP request may take before the browser gets 504. */
  httpTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface RelayLimits {
  maxConnections: number;
  maxHosts: number;
  maxHostsPerSource: number;
  maxBrowsers: number;
  maxBrowsersPerSource: number;
  maxBrowsersPerRoute: number;
  maxRoutes: number;
  maxRoutesPerHost: number;
  maxPendingRequests: number;
  maxPendingRequestsPerHost: number;
  maxBufferedBytes: number;
  attemptsPerMinute: number;
  messagesPerMinute: number;
  bytesPerMinute: number;
  totalBytesPerMinute: number;
  emptyHostIdleMs: number;
  maxSources: number;
  browserIdleMs: number;
}
const DEFAULT_LIMITS: RelayLimits = {
  maxConnections: 2048,
  maxHosts: 256,
  maxHostsPerSource: 32,
  maxBrowsers: 1024,
  maxBrowsersPerSource: 128,
  maxBrowsersPerRoute: 64,
  maxRoutes: 4096,
  maxRoutesPerHost: 256,
  maxPendingRequests: 512,
  maxPendingRequestsPerHost: 64,
  maxBufferedBytes: 2 * 1024 * 1024,
  attemptsPerMinute: 240,
  messagesPerMinute: 6000,
  bytesPerMinute: 32 * 1024 * 1024,
  totalBytesPerMinute: 256 * 1024 * 1024,
  emptyHostIdleMs: 60_000,
  maxSources: 4096,
  browserIdleMs: 5 * 60_000,
};

export interface Relay {
  /** Actual bound port (resolved even when `port: 0` was requested). */
  port: number;
  server: http.Server;
  close(): Promise<void>;
}

const MISSED_PONG_LIMIT = 2;
const PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "public",
);

const ASSET_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function safeAsset(
  res: http.ServerResponse,
  directory: string,
  pieces: string[],
  cacheControl: string,
): boolean {
  if (
    pieces.length === 0 ||
    pieces.some((piece) => !/^[A-Za-z0-9._-]+$/.test(piece))
  )
    return false;
  const root = path.join(PUBLIC_DIR, directory);
  const target = path.resolve(root, ...pieces);
  if (!target.startsWith(`${root}${path.sep}`)) return false;
  try {
    const type =
      ASSET_TYPES[path.extname(target).toLowerCase()] ??
      "application/octet-stream";
    const data = fs.readFileSync(target);
    res.writeHead(200, { "content-type": type, "cache-control": cacheControl });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function staticDocument(res: http.ServerResponse, file: string): boolean {
  try {
    const data = fs.readFileSync(path.join(PUBLIC_DIR, file));
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-cache",
    });
    res.end(data);
    return true;
  } catch {
    return false;
  }
}

function docsDocument(res: http.ServerResponse, pieces: string[]): boolean {
  if (pieces.some((piece) => !/^[A-Za-z0-9._-]+$/.test(piece))) return false;
  const root = path.join(PUBLIC_DIR, "docs");
  const target = path.resolve(root, ...pieces);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return false;
  for (const candidate of [target, path.join(target, "index.html")]) {
    try {
      if (fs.statSync(candidate).isDirectory()) continue;
      const type =
        ASSET_TYPES[path.extname(candidate).toLowerCase()] ??
        "application/octet-stream";
      const data = fs.readFileSync(candidate);
      res.writeHead(200, {
        "content-type": type,
        "cache-control": type.startsWith("text/html")
          ? "no-cache"
          : "public, max-age=31536000, immutable",
      });
      res.end(data);
      return true;
    } catch {
      // Try the directory index next.
    }
  }
  return false;
}

interface PendingRequest {
  settle(frame: HttpResponseFrame): void;
  fail(status: number, message: string): void;
  timer: NodeJS.Timeout;
}

interface BrowserConnection {
  ws: WebSocket;
  protocol: RoomProtocolVersion;
  token: string;
  lastActivity: number;
}

/** One laptop room server's outbound connection, plus everything it owns. */
class HostConnection {
  readonly tokens = new Map<string, RoomProtocolVersion>();
  readonly pending = new Map<string, PendingRequest>();
  readonly browsers = new Map<string, BrowserConnection>();
  missedPongs = 0;
  lastActivity = Date.now();

  constructor(
    readonly id: number,
    readonly ws: WebSocket,
    readonly source: string,
    readonly maxBufferedBytes: number,
  ) {}

  get alive(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(frame: RelayFrame, origin?: WebSocket): void {
    if (!this.alive) return;
    const data = JSON.stringify(frame);
    if (
      this.ws.bufferedAmount + Buffer.byteLength(data) >
      this.maxBufferedBytes
    ) {
      (origin ?? this.ws).terminate();
      return;
    }
    this.ws.send(data);
  }
}

export function createRelay(options: RelayOptions): Promise<Relay> {
  const { relayKey } = options;
  const authMode = options.authMode ?? "key";
  if (authMode !== "open" && authMode !== "key")
    throw new Error("invalid RELAY_AUTH_MODE");
  if (authMode === "key" && !relayKey?.trim())
    throw new Error("RELAY_KEY is required in key mode");
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`invalid relay limit: ${name}`);
  }
  const trustedProxies = new Set(options.trustedProxyAddresses ?? []);
  if ([...trustedProxies].some((address) => !isIP(address)))
    throw new Error("invalid trusted proxy address");
  interface Source {
    since: number;
    attempts: number;
    hosts: number;
    browsers: number;
  }
  const sources = new Map<string, Source>();
  const traffic = new WeakMap<
    WebSocket,
    { since: number; messages: number; bytes: number }
  >();
  const forwardedTraffic = new WeakMap<
    WebSocket,
    { since: number; messages: number; bytes: number }
  >();
  let browserCount = 0;
  let globalTraffic = { since: Date.now(), bytes: 0 };
  function sourceFor(req: http.IncomingMessage): string {
    const peer = req.socket.remoteAddress ?? "unknown";
    const forwarded = req.headers["x-forwarded-for"];
    return trustedProxies.has(peer) &&
      typeof forwarded === "string" &&
      isIP(forwarded.trim())
      ? forwarded.trim()
      : peer;
  }
  function admitAttempt(req: http.IncomingMessage): Source | undefined {
    if (options.admissionEnabled === false) return undefined;
    const now = Date.now();
    const key = sourceFor(req);
    let state = sources.get(key);
    if (!state) {
      if (sources.size >= limits.maxSources) return undefined;
      state = { since: now, attempts: 0, hosts: 0, browsers: 0 };
      sources.set(key, state);
    }
    if (now - state.since >= 60_000) {
      state.since = now;
      state.attempts = 0;
    }
    return ++state.attempts <= limits.attemptsPerMinute ? state : undefined;
  }
  function acceptTraffic(
    ws: WebSocket,
    bytes: number,
    origin = ws,
    forwarded = false,
  ): boolean {
    const now = Date.now();
    const budgets = forwarded ? forwardedTraffic : traffic;
    let state = budgets.get(ws);
    if (!state || now - state.since >= 60_000) {
      state = { since: now, messages: 0, bytes: 0 };
      budgets.set(ws, state);
    }
    state.messages++;
    state.bytes += bytes;
    if (
      state.messages > limits.messagesPerMinute ||
      state.bytes > limits.bytesPerMinute
    ) {
      origin.terminate();
      return false;
    }
    return true;
  }
  // Global saturation sheds data without terminating another tenant's control
  // connection. Host liveness and registration frames still get processed.
  function acceptGlobalTraffic(bytes: number): boolean {
    const now = Date.now();
    if (now - globalTraffic.since >= 60_000)
      globalTraffic = { since: now, bytes: 0 };
    globalTraffic.bytes += bytes;
    return globalTraffic.bytes <= limits.totalBytesPerMinute;
  }
  function pendingCount(): number {
    let count = 0;
    for (const host of hosts) count += host.pending.size;
    return count;
  }
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const httpTimeoutMs = options.httpTimeoutMs ?? 30_000;
  const log = options.log ?? ((line: string) => console.log(line));

  /** token -> owning laptop connection. The relay's entire routing table. */
  const routes = new Map<string, HostConnection>();
  const routeProtocols = new Map<string, RoomProtocolVersion>();
  const hosts = new Set<HostConnection>();
  let hostSeq = 0;
  let idSeq = 0;
  const nextId = (): string => `${++idSeq}`;

  function routeFor(
    token: string,
  ): { host: HostConnection; protocol: RoomProtocolVersion } | undefined {
    const host = routes.get(token);
    if (host && !host.alive) {
      routes.delete(token);
      routeProtocols.delete(token);
      return undefined;
    }
    const protocol = routeProtocols.get(token);
    return host && protocol ? { host, protocol } : undefined;
  }

  // ---- host (laptop) side --------------------------------------------------

  const hostWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_HOST_CONTROL_BYTES,
  });

  function onHostConnection(
    ws: WebSocket,
    source: string,
    state: Source,
  ): void {
    const host = new HostConnection(
      ++hostSeq,
      ws,
      source,
      limits.maxBufferedBytes,
    );
    state.hosts++;
    hosts.add(host);
    log(`[relay] host #${host.id} connected`);

    ws.on("message", (data) => {
      if (!acceptTraffic(ws, Buffer.byteLength(data.toString()))) return;
      const frame = parseLaptopFrame(
        typeof data === "string" ? data : data.toString(),
      );
      if (!frame) return;
      if (
        (frame.type === "http_response" ||
          (frame.type === "ws_event" && frame.event === "message")) &&
        !acceptGlobalTraffic(Buffer.byteLength(data.toString()))
      )
        return;
      if (frame.type !== "pong") host.lastActivity = Date.now();

      switch (frame.type) {
        case "register":
          for (const route of frameRoutes(frame)) {
            if (
              (route.token.startsWith("o_") &&
                (route.protocol !== 2 ||
                  !verifyRouteOwnership(route.token, route.ownershipSecret))) ||
              (authMode === "open" &&
                (!route.token.startsWith("o_") || route.protocol !== 2))
            ) {
              host.send({
                v: 1,
                type: "register_rejected",
                token: route.token,
                reason: "ownership",
              });
              continue;
            }
            if (
              !host.tokens.has(route.token) &&
              (host.tokens.size >= limits.maxRoutesPerHost ||
                routes.size >= limits.maxRoutes)
            ) {
              host.send({
                v: 1,
                type: "register_rejected",
                token: route.token,
                reason: "capacity",
              });
              continue;
            }
            const owner = routes.get(route.token);
            const protocol = routeProtocols.get(route.token);
            if (owner && owner !== host && owner.alive) {
              log(
                `[relay] host #${host.id} register rejected for token ${route.token} (claimed by #${owner.id})`,
              );
              host.send({
                v: 1,
                type: "register_rejected",
                token: route.token,
              });
              continue;
            }
            if (owner === host && protocol && protocol !== route.protocol) {
              log(
                `[relay] host #${host.id} register rejected for token ${route.token} (protocol changed)`,
              );
              host.send({
                v: 1,
                type: "register_rejected",
                token: route.token,
              });
              continue;
            }
            routes.set(route.token, host);
            routeProtocols.set(route.token, route.protocol);
            host.tokens.set(route.token, route.protocol);
            host.send({ v: 1, type: "registered", token: route.token });
          }
          break;

        case "unregister":
          for (const { token } of frameRoutes(frame)) {
            if (routes.get(token) === host) {
              routes.delete(token);
              routeProtocols.delete(token);
            }
            host.tokens.delete(token);
          }
          break;

        case "http_response": {
          const pending = host.pending.get(frame.id);
          if (!pending) return;
          host.pending.delete(frame.id);
          clearTimeout(pending.timer);
          pending.settle(frame);
          break;
        }

        case "ws_event": {
          const browser = host.browsers.get(frame.id);
          if (!browser) return;
          if (frame.event === "message") {
            if (
              browser.ws.readyState === WebSocket.OPEN &&
              frame.dataB64 !== undefined
            ) {
              // RoomSocket.send accepts JSON text. Passing a Buffer here turns
              // it into a binary WebSocket frame, which browsers expose as a
              // Blob rather than the string expected by the room renderer.
              const data = Buffer.from(frame.dataB64, "base64").toString(
                "utf8",
              );
              if (browser.protocol === 2 && !parseV2OuterRecord(data)) {
                browser.ws.close(1003, "invalid v2 record");
                return;
              }
              if (
                browser.ws.bufferedAmount + Buffer.byteLength(data) >
                limits.maxBufferedBytes
              ) {
                browser.ws.terminate();
                return;
              }
              browser.lastActivity = Date.now();
              browser.ws.send(data);
            }
          } else if (frame.event === "close") {
            host.browsers.delete(frame.id);
            browser.ws.close(1000, "room closed");
          }
          break;
        }

        case "pong":
          host.missedPongs = 0;
          break;
      }
    });

    const teardown = (): void => {
      if (!hosts.delete(host)) return;
      state.hosts--;
      for (const token of host.tokens.keys()) {
        if (routes.get(token) === host) {
          routes.delete(token);
          routeProtocols.delete(token);
        }
      }
      host.tokens.clear();
      for (const pending of host.pending.values()) {
        clearTimeout(pending.timer);
        pending.fail(502, "laptop disconnected");
      }
      host.pending.clear();
      for (const browser of host.browsers.values()) {
        browser.ws.close(1001, "laptop disconnected");
      }
      host.browsers.clear();
      log(`[relay] host #${host.id} disconnected`);
    };

    ws.on("close", teardown);
    ws.on("error", teardown);
  }

  // ---- browser side: HTTP --------------------------------------------------

  function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let size = 0;
      let done = false;
      req.on("data", (chunk: Buffer) => {
        if (done) return;
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
          done = true;
          resolve(null); // caller answers 413
          return;
        }
        chunks.push(chunk);
      });
      req.on("end", () => {
        if (!done) {
          done = true;
          resolve(Buffer.concat(chunks));
        }
      });
      req.on("error", () => {
        if (!done) {
          done = true;
          resolve(Buffer.concat(chunks));
        }
      });
    });
  }

  function plain(
    res: http.ServerResponse,
    status: number,
    message: string,
  ): void {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(message);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://relay.invalid");
      const parts = url.pathname.split("/").filter(Boolean);
      if (!admitAttempt(req))
        return plain(
          res,
          options.admissionEnabled === false ? 503 : 429,
          "relay admission limited",
        );
      if (req.method === "GET" && url.pathname === "/.well-known/paseo-rooms") {
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(
          JSON.stringify({
            version: 1,
            registration: authMode,
            roomProtocols: authMode === "open" ? [2] : [1, 2],
            routeOwnership: "sha256-secret-v1",
            registrationAck: true,
          }),
        );
        return;
      }

      // Presentation belongs to the public relay. Dynamic room calls below
      // remain routed to the laptop that owns the capability token.
      if (req.method === "GET" && url.pathname === "/") {
        return void (
          staticDocument(res, "index.html") || plain(res, 404, "not found")
        );
      }
      if (req.method === "GET" && parts[0] === "landing") {
        return void (
          safeAsset(
            res,
            "landing",
            parts.slice(1),
            "public, max-age=31536000, immutable",
          ) || plain(res, 404, "not found")
        );
      }
      if (req.method === "GET" && parts[0] === "assets") {
        return void (
          safeAsset(
            res,
            "assets",
            parts.slice(1),
            "public, max-age=31536000, immutable",
          ) || plain(res, 404, "not found")
        );
      }
      if (req.method === "GET" && parts[0] === "docs") {
        return void (
          docsDocument(res, parts.slice(1)) || plain(res, 404, "not found")
        );
      }
      if (req.method === "GET" && parts[0] === "r" && parts.length === 2) {
        if (!routeFor(parts[1])) return plain(res, 404, "not found");
        return void (
          staticDocument(res, "room.html") || plain(res, 404, "not found")
        );
      }

      const route = matchPublicRoute(url.pathname, false);
      if (!route) return plain(res, 404, "not found");

      const claim = routeFor(route.token);
      if (!claim || claim.protocol !== route.protocol)
        return plain(res, 404, "not found");
      const { host } = claim;

      if (
        host.pending.size >= limits.maxPendingRequestsPerHost ||
        pendingCount() >= limits.maxPendingRequests
      )
        return plain(res, 503, "relay capacity reached");
      const body = await readBody(req);
      if (
        host.pending.size >= limits.maxPendingRequestsPerHost ||
        pendingCount() >= limits.maxPendingRequests
      )
        return plain(res, 503, "relay capacity reached");
      if (body === null) return plain(res, 413, "payload too large");

      const headers: Record<string, string> = {};
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value =
          name === "x-forwarded-for" ? sourceFor(req) : req.headers[name];
        if (typeof value === "string") headers[name] = value;
      }

      const id = nextId();
      const settled = { done: false };
      const finish = (fn: () => void): void => {
        if (settled.done) return;
        settled.done = true;
        host.pending.delete(id);
        fn();
      };

      const timer = setTimeout(() => {
        finish(() => plain(res, 504, "room server did not respond"));
      }, httpTimeoutMs);

      host.pending.set(id, {
        timer,
        settle: (frame) =>
          finish(() => {
            clearTimeout(timer);
            if (res.headersSent) return;
            res.writeHead(frame.status, frame.headers);
            res.end(Buffer.from(frame.bodyB64, "base64"));
          }),
        fail: (status, message) =>
          finish(() => {
            clearTimeout(timer);
            plain(res, status, message);
          }),
      });

      res.on("close", () => {
        if (!settled.done) {
          settled.done = true;
          clearTimeout(timer);
          host.pending.delete(id);
        }
      });

      host.send({
        v: 1,
        type: "http_request",
        id,
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers,
        bodyB64: body.toString("base64"),
      });
    } catch (err) {
      plain(res, 500, err instanceof Error ? err.message : "internal error");
    }
  });

  // ---- browser side: WebSocket + host upgrade ------------------------------

  const browserWss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: MAX_V2_RECORD_BYTES,
  });

  function refuse(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://relay.invalid");
    } catch {
      return refuse(socket, 400, "Bad Request");
    }
    const state = admitAttempt(req);
    if (!state)
      return refuse(
        socket,
        options.admissionEnabled === false ? 503 : 429,
        "Admission Limited",
      );

    if (url.pathname === "/host") {
      const key = req.headers["x-relay-key"];
      if (
        authMode === "key" &&
        (typeof key !== "string" ||
          !timingSafeEqual(
            createHash("sha256").update(key).digest(),
            createHash("sha256").update(relayKey!).digest(),
          ))
      ) {
        log(`[relay] host connection rejected: bad relay key`);
        return refuse(socket, 401, "Unauthorized");
      }
      if (
        hosts.size >= limits.maxHosts ||
        state.hosts >= limits.maxHostsPerSource
      )
        return refuse(socket, 503, "Capacity Reached");
      hostWss.handleUpgrade(req, socket, head, (ws) =>
        onHostConnection(ws, sourceFor(req), state),
      );
      return;
    }

    const route = matchPublicRoute(url.pathname, true);
    if (!route) return refuse(socket, 404, "Not Found");
    const claim = routeFor(route.token);
    if (!claim || claim.protocol !== route.protocol)
      return refuse(socket, 404, "Not Found");
    const { host } = claim;

    const routeBrowserCount = [...host.browsers.values()].filter(
      (browser) => browser.token === route.token,
    ).length;
    if (
      browserCount >= limits.maxBrowsers ||
      state.browsers >= limits.maxBrowsersPerSource ||
      routeBrowserCount >= limits.maxBrowsersPerRoute
    )
      return refuse(socket, 503, "Capacity Reached");
    browserWss.handleUpgrade(req, socket, head, (ws) => {
      browserCount++;
      state.browsers++;
      let counted = true;
      const release = (): void => {
        if (counted) {
          counted = false;
          browserCount--;
          state.browsers--;
        }
      };
      ws.on("close", release);
      ws.on("error", release);
      const id = nextId();
      const browser = {
        ws,
        protocol: route.protocol,
        token: route.token,
        lastActivity: Date.now(),
      };
      host.browsers.set(id, browser);
      host.send(
        {
          v: 1,
          type: "ws_event",
          id,
          event: "open",
          path: req.url ?? url.pathname,
        },
        ws,
      );

      ws.on("message", (data, isBinary) => {
        const buf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
        if (
          !acceptTraffic(ws, buf.byteLength) ||
          !acceptTraffic(host.ws, buf.byteLength, ws, true)
        )
          return;
        if (!acceptGlobalTraffic(buf.byteLength)) {
          ws.terminate();
          return;
        }
        browser.lastActivity = Date.now();
        if (route.protocol === 2) {
          if (
            isBinary ||
            buf.byteLength > MAX_V2_RECORD_BYTES ||
            !parseV2OuterRecord(buf.toString("utf8"))
          ) {
            ws.close(1003, "invalid v2 record");
            return;
          }
        }
        host.send(
          {
            v: 1,
            type: "ws_event",
            id,
            event: "message",
            dataB64: buf.toString("base64"),
          },
          ws,
        );
      });

      const closeUp = (): void => {
        if (!host.browsers.delete(id)) return;
        host.send({ v: 1, type: "ws_event", id, event: "close" }, ws);
      };
      ws.on("close", closeUp);
      ws.on("error", closeUp);
    });
  });

  server.maxConnections = limits.maxConnections;
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const maintenance = setInterval(
    () => {
      const now = Date.now();
      for (const [source, state] of sources) {
        if (!state.hosts && !state.browsers && now - state.since >= 60_000)
          sources.delete(source);
      }
      for (const host of hosts) {
        if (
          !host.tokens.size &&
          now - host.lastActivity >= limits.emptyHostIdleMs
        )
          host.ws.terminate();
        for (const browser of host.browsers.values()) {
          if (now - browser.lastActivity >= limits.browserIdleMs)
            browser.ws.terminate();
        }
      }
    },
    Math.min(1000, limits.browserIdleMs, limits.emptyHostIdleMs),
  );
  maintenance.unref();

  // ---- liveness ------------------------------------------------------------

  const heartbeat = setInterval(() => {
    for (const host of hosts) {
      if (host.missedPongs >= MISSED_PONG_LIMIT) {
        log(
          `[relay] host #${host.id} missed ${host.missedPongs} pongs, dropping`,
        );
        host.ws.terminate();
        continue;
      }
      host.missedPongs += 1;
      host.send({ v: 1, type: "ping", t: Date.now() });
    }
  }, pingIntervalMs);
  heartbeat.unref?.();

  return new Promise<Relay>((resolve, reject) => {
    server.once("error", (error) => {
      clearInterval(heartbeat);
      clearInterval(maintenance);
      reject(error);
    });
    server.listen(options.port ?? 8080, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        server,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            clearInterval(maintenance);
            for (const host of hosts) {
              // Browser sockets are upgraded connections: `server.close()` will
              // not complete while they are open, so drop them explicitly.
              for (const browser of host.browsers.values())
                browser.ws.terminate();
              host.browsers.clear();
              host.ws.terminate();
            }
            for (const browser of browserWss.clients) browser.terminate();
            hosts.clear();
            routes.clear();
            routeProtocols.clear();
            hostWss.close();
            browserWss.close();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

// ---- entry point -----------------------------------------------------------

const isEntry =
  process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntry) {
  const relayKey = process.env.RELAY_KEY;
  const authMode = process.env.RELAY_AUTH_MODE ?? "key";
  if (
    (authMode !== "key" && authMode !== "open") ||
    (authMode === "key" && !relayKey)
  ) {
    console.error(
      "RELAY_AUTH_MODE must be open or key; key mode requires RELAY_KEY",
    );
    process.exit(1);
  }
  const port = Number(process.env.RELAY_PORT ?? 8080);
  createRelay({
    port,
    relayKey,
    authMode: authMode as "open" | "key",
    admissionEnabled: process.env.RELAY_ADMISSION_ENABLED !== "false",
    trustedProxyAddresses: process.env.RELAY_TRUSTED_PROXY_ADDRESSES?.split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  })
    .then((relay) => {
      console.log(`[relay] listening on :${relay.port} (host endpoint /host)`);
    })
    .catch((err: unknown) => {
      console.error(
        "[relay] failed to start:",
        err instanceof Error ? err.message : err,
      );
      process.exit(1);
    });
}
