/**
 * paseo-rooms relay — a dumb pipe from public browser traffic to whichever
 * laptop room server claimed the room token. Implements "Relay protocol v1"
 * (docs/plan.md). Routing is in-memory only: on restart, laptops re-register.
 *
 * The relay never sees daemon credentials, agent ids, or conversation content
 * it can interpret — it moves opaque bytes between a token and a connection.
 */

import http from "node:http";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import {
  MAX_BODY_BYTES,
  FORWARDED_REQUEST_HEADERS,
  matchPublicRoute,
  parseLaptopFrame,
  type HttpResponseFrame,
  type RelayFrame,
} from "./protocol.js";

export interface RelayOptions {
  /** TCP port; 0 picks a free one (used by the protocol test). */
  port?: number;
  /** Shared secret expected in the `x-relay-key` header on /host. */
  relayKey: string;
  /** Ping cadence; connections die after 2 missed pongs. */
  pingIntervalMs?: number;
  /** How long a forwarded HTTP request may take before the browser gets 504. */
  httpTimeoutMs?: number;
  log?: (line: string) => void;
}

export interface Relay {
  /** Actual bound port (resolved even when `port: 0` was requested). */
  port: number;
  server: http.Server;
  close(): Promise<void>;
}

const MISSED_PONG_LIMIT = 2;

interface PendingRequest {
  settle(frame: HttpResponseFrame): void;
  fail(status: number, message: string): void;
  timer: NodeJS.Timeout;
}

/** One laptop room server's outbound connection, plus everything it owns. */
class HostConnection {
  readonly tokens = new Set<string>();
  readonly pending = new Map<string, PendingRequest>();
  readonly browsers = new Map<string, WebSocket>();
  missedPongs = 0;

  constructor(
    readonly id: number,
    readonly ws: WebSocket,
  ) {}

  get alive(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  send(frame: RelayFrame): void {
    if (this.alive) this.ws.send(JSON.stringify(frame));
  }
}

export function createRelay(options: RelayOptions): Promise<Relay> {
  const { relayKey } = options;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const httpTimeoutMs = options.httpTimeoutMs ?? 30_000;
  const log = options.log ?? ((line: string) => console.log(line));

  /** token -> owning laptop connection. The relay's entire routing table. */
  const routes = new Map<string, HostConnection>();
  const hosts = new Set<HostConnection>();
  let hostSeq = 0;
  let idSeq = 0;
  const nextId = (): string => `${++idSeq}`;

  function routeFor(token: string): HostConnection | undefined {
    const host = routes.get(token);
    if (host && !host.alive) {
      routes.delete(token);
      return undefined;
    }
    return host;
  }

  // ---- host (laptop) side --------------------------------------------------

  const hostWss = new WebSocketServer({ noServer: true });

  function onHostConnection(ws: WebSocket): void {
    const host = new HostConnection(++hostSeq, ws);
    hosts.add(host);
    log(`[relay] host #${host.id} connected`);

    ws.on("message", (data) => {
      const frame = parseLaptopFrame(typeof data === "string" ? data : data.toString());
      if (!frame) return;

      switch (frame.type) {
        case "register":
          for (const token of frame.tokens) {
            const owner = routes.get(token);
            if (owner && owner !== host && owner.alive) {
              log(`[relay] host #${host.id} register rejected for token ${token} (claimed by #${owner.id})`);
              host.send({ v: 1, type: "register_rejected", token });
              continue;
            }
            routes.set(token, host);
            host.tokens.add(token);
          }
          break;

        case "unregister":
          for (const token of frame.tokens) {
            if (routes.get(token) === host) routes.delete(token);
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
            if (browser.readyState === WebSocket.OPEN && frame.dataB64 !== undefined) {
              browser.send(Buffer.from(frame.dataB64, "base64"));
            }
          } else if (frame.event === "close") {
            host.browsers.delete(frame.id);
            browser.close(1000, "room closed");
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
      for (const token of host.tokens) {
        if (routes.get(token) === host) routes.delete(token);
      }
      host.tokens.clear();
      for (const pending of host.pending.values()) {
        clearTimeout(pending.timer);
        pending.fail(502, "laptop disconnected");
      }
      host.pending.clear();
      for (const browser of host.browsers.values()) {
        browser.close(1001, "laptop disconnected");
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

  function plain(res: http.ServerResponse, status: number, message: string): void {
    if (res.headersSent) return;
    res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
    res.end(message);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://relay.invalid");
      const route = matchPublicRoute(url.pathname, false);
      if (!route) return plain(res, 404, "not found");

      const host = routeFor(route.token);
      if (!host) return plain(res, 404, "not found");

      const body = await readBody(req);
      if (body === null) return plain(res, 413, "payload too large");

      const headers: Record<string, string> = {};
      for (const name of FORWARDED_REQUEST_HEADERS) {
        const value = req.headers[name];
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

  const browserWss = new WebSocketServer({ noServer: true });

  function refuse(socket: Duplex, status: number, reason: string): void {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay.invalid");

    if (url.pathname === "/host") {
      const key = req.headers["x-relay-key"];
      if (typeof key !== "string" || key !== relayKey) {
        log(`[relay] host connection rejected: bad relay key`);
        return refuse(socket, 401, "Unauthorized");
      }
      hostWss.handleUpgrade(req, socket, head, (ws) => onHostConnection(ws));
      return;
    }

    const route = matchPublicRoute(url.pathname, true);
    if (!route) return refuse(socket, 404, "Not Found");
    const host = routeFor(route.token);
    if (!host) return refuse(socket, 404, "Not Found");

    browserWss.handleUpgrade(req, socket, head, (ws) => {
      const id = nextId();
      host.browsers.set(id, ws);
      host.send({ v: 1, type: "ws_event", id, event: "open", path: req.url ?? url.pathname });

      ws.on("message", (data, isBinary) => {
        const buf = Buffer.isBuffer(data)
          ? data
          : Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.from(data as ArrayBuffer);
        void isBinary;
        host.send({ v: 1, type: "ws_event", id, event: "message", dataB64: buf.toString("base64") });
      });

      const closeUp = (): void => {
        if (!host.browsers.delete(id)) return;
        host.send({ v: 1, type: "ws_event", id, event: "close" });
      };
      ws.on("close", closeUp);
      ws.on("error", closeUp);
    });
  });

  // ---- liveness ------------------------------------------------------------

  const heartbeat = setInterval(() => {
    for (const host of hosts) {
      if (host.missedPongs >= MISSED_PONG_LIMIT) {
        log(`[relay] host #${host.id} missed ${host.missedPongs} pongs, dropping`);
        host.ws.terminate();
        continue;
      }
      host.missedPongs += 1;
      host.send({ v: 1, type: "ping", t: Date.now() });
    }
  }, pingIntervalMs);
  heartbeat.unref?.();

  return new Promise<Relay>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8080, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        server,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const host of hosts) host.ws.terminate();
            hosts.clear();
            routes.clear();
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
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntry) {
  const relayKey = process.env.RELAY_KEY;
  if (!relayKey) {
    console.error("RELAY_KEY is required (shared secret between relay and laptop room servers)");
    process.exit(1);
  }
  const port = Number(process.env.RELAY_PORT ?? 8080);
  createRelay({ port, relayKey })
    .then((relay) => {
      console.log(`[relay] listening on :${relay.port} (host endpoint /host)`);
    })
    .catch((err: unknown) => {
      console.error("[relay] failed to start:", err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
