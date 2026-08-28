/* End-to-end test of the FULL path: browser -> relay -> laptop room server ->
   Paseo daemon, and back. Everything runs in this one process:

     - a relay on a random port (short ping/timeouts so the test is quick)
     - the room server, imported with RELAY_URL/RELAY_KEY set so it dials out
     - two fake browsers that speak ONLY to the relay's public port

   Admin traffic (create/revoke) deliberately stays on the laptop's local
   listener — the relay must not route it.

   Usage: npm run e2e:relay      (a real Paseo daemon must be on ws://…:6767/ws)
   Env:   E2E_PROVIDER=claude|codex (default claude), E2E_CWD (default: temp dir) */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { createRelay, type Relay } from "../src/relay/relay.js";

const PROVIDER = process.env.E2E_PROVIDER ?? "claude";
const LOCAL_PORT = Number(process.env.E2E_ROOM_PORT ?? 3179);
const LOCAL_BASE = `http://127.0.0.1:${LOCAL_PORT}`;
const RELAY_KEY = crypto.randomBytes(16).toString("hex");
const PING_INTERVAL_MS = 400;

let passed = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    console.error(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`);
    process.exitCode = 1;
  }
}

interface Browser {
  name: string;
  ws: WebSocket;
  events: Array<{ event: any; timestamp: string }>;
  closed: boolean;
}

function openBrowser(name: string, base: string, token: string): Promise<Browser> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace("http", "ws")}/api/rooms/${token}/ws`);
    const browser: Browser = { name, ws, events: [], closed: false };
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "stream") browser.events.push(frame);
    });
    ws.on("close", () => {
      browser.closed = true;
    });
    ws.on("open", () => resolve(browser));
    ws.on("error", reject);
  });
}

async function waitFor(pred: () => boolean | Promise<boolean>, ms: number, label: string): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await pred()) return true;
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  console.error(`  (timeout waiting for: ${label})`);
  return false;
}

function sawUserMessage(b: Browser, text: string): boolean {
  return b.events.some(
    (f) => f.event.type === "timeline" && f.event.item.type === "user_message" && f.event.item.text.includes(text),
  );
}
function sawAssistantText(b: Browser, text: string): boolean {
  return b.events
    .filter((f) => f.event.type === "timeline" && f.event.item.type === "assistant_message")
    .map((f) => f.event.item.text)
    .join("")
    .includes(text);
}

async function main(): Promise<void> {
  // -- 1. relay ---------------------------------------------------------------
  let relay: Relay = await createRelay({
    port: 0,
    relayKey: RELAY_KEY,
    pingIntervalMs: PING_INTERVAL_MS,
    httpTimeoutMs: 15_000,
    log: (line) => console.log(`    ${line}`),
  });
  const relayPort = relay.port;
  const RELAY_BASE = `http://127.0.0.1:${relayPort}`;
  console.log(`relay listening on :${relayPort}`);

  // -- 2. room server, in dial-out mode, on its own data dir ------------------
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-rooms-relay-e2e-"));
  process.env.DATA_DIR = dataDir;
  process.env.PORT = String(LOCAL_PORT);
  process.env.BASE_URL = LOCAL_BASE;
  process.env.RELAY_URL = `ws://127.0.0.1:${relayPort}/host`;
  process.env.RELAY_KEY = RELAY_KEY;
  process.env.RELAY_MIN_BACKOFF_MS = "200";
  process.env.RELAY_MAX_BACKOFF_MS = "1000";
  await import("../src/server.js");
  const { getClient } = await import("../src/paseo.js");

  const healthy = await waitFor(
    async () => {
      try {
        const h = (await (await fetch(`${LOCAL_BASE}/healthz`)).json()) as { daemonConnected: boolean };
        return h.daemonConnected === true;
      } catch {
        return false;
      }
    },
    30_000,
    "room server up and connected to the daemon",
  );
  check("room server boots and reaches the daemon", healthy);

  // -- 3. throwaway agent -----------------------------------------------------
  const client = await getClient();
  const cwd = process.env.E2E_CWD ?? fs.mkdtempSync(path.join(os.tmpdir(), "paseo-rooms-relay-cwd-"));
  const { models } = await client.providers.listModels(PROVIDER as never);
  const model =
    models!.find((m: { id: string }) => m.id.includes("haiku")) ??
    models!.find((m: { isDefault?: boolean }) => m.isDefault) ??
    models![0];
  console.log(`\ncreating throwaway agent (${PROVIDER}/${model.id})…`);
  const agent = await client.agents.create({
    config: { provider: `${PROVIDER}/${model.id}` } as never,
    cwd,
    prompt:
      "Hi! We are demoing a shared chat room where several people talk to you; each message " +
      "starts with the sender's name in [brackets]. Please reply with a one-line hello that " +
      "includes the token RELAY-MARKER-1, and from now on always greet each sender by name.",
  } as never);
  const first = await agent.waitForFinish(180_000);
  check("throwaway agent produced initial history", (first.lastMessage ?? "").includes("RELAY-MARKER-1"));

  // -- 4. room creation stays local (admin never crosses the relay) -----------
  const adminToken = fs.readFileSync(path.join(dataDir, "admin-token"), "utf8").trim();
  const createRes = await fetch(`${LOCAL_BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ agentId: agent.id }),
  });
  check("room created via the LOCAL admin API", createRes.status === 201);
  const { token } = (await createRes.json()) as { token: string };

  const relayAdmin = await fetch(`${RELAY_BASE}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ agentId: agent.id }),
  });
  check("POST /api/rooms is NOT routable through the relay (404)", relayAdmin.status === 404);

  // -- 5. collaborator traffic, entirely through the relay --------------------
  const routed = await waitFor(
    async () => (await fetch(`${RELAY_BASE}/api/rooms/${token}`)).status === 200,
    10_000,
    "token registered with the relay",
  );
  check("room token is registered with the relay on creation", routed);

  const pageRes = await fetch(`${RELAY_BASE}/r/${token}`);
  const pageHtml = await pageRes.text();
  const assetPath = pageHtml.match(/src="(\/assets\/room-[^"]+)"/)?.[1];
  const assetRes = assetPath ? await fetch(`${RELAY_BASE}${assetPath}`) : null;
  check(
    "room shell and React bundle are served by the public relay",
    pageRes.status === 200 &&
      pageHtml.includes("<script") &&
      pageHtml.includes('src="/assets/') &&
      assetRes?.status === 200,
  );

  const infoBody = await (await fetch(`${RELAY_BASE}/api/rooms/${token}`)).text();
  check("relay-served room info never exposes the agent id", !infoBody.includes(agent.id));

  const histRes = await fetch(`${RELAY_BASE}/api/rooms/${token}/history`);
  const hist = (await histRes.json()) as { entries: Array<{ item: any }> };
  check(
    "history on join is served through the relay",
    histRes.status === 200 &&
      hist.entries.some((e) => e.item.type === "assistant_message" && e.item.text.includes("RELAY-MARKER-1")),
  );

  const a = await openBrowser("A", RELAY_BASE, token);
  const b = await openBrowser("B", RELAY_BASE, token);
  console.log("\ntwo browsers connected THROUGH THE RELAY; Alice (A) sends a message…");

  const sendA = await fetch(`${RELAY_BASE}/api/rooms/${token}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Hello! Please greet me by my name.", name: "Alice" }),
  });
  check("Alice's send accepted through the relay", sendA.status === 202);

  await waitFor(() => sawUserMessage(a, "[Alice]") && sawUserMessage(b, "[Alice]"), 20_000, "Alice's message on both relay sockets");
  check("browser A sees Alice's message over the relay", sawUserMessage(a, "[Alice]"));
  check("browser B sees Alice's message over the relay", sawUserMessage(b, "[Alice]"));

  await waitFor(() => sawAssistantText(a, "Alice") && sawAssistantText(b, "Alice"), 120_000, "agent reply to Alice");
  check("agent reply streams over the relay to browser A", sawAssistantText(a, "Alice"));
  check("agent reply streams over the relay to browser B", sawAssistantText(b, "Alice"));

  console.log("\nBob (B) sends a message…");
  const sendB = await fetch(`${RELAY_BASE}/api/rooms/${token}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Hi, I just joined — please greet me by my name too.", name: "Bob" }),
  });
  check("Bob's send accepted through the relay", sendB.status === 202);
  await waitFor(() => sawAssistantText(a, "Bob") && sawAssistantText(b, "Bob"), 120_000, "agent reply to Bob");
  check("browser A sees Bob's message over the relay", sawUserMessage(a, "[Bob]"));
  check("agent reply to Bob reaches both relay browsers", sawAssistantText(a, "Bob") && sawAssistantText(b, "Bob"));

  // -- 6. bad tokens at the relay --------------------------------------------
  const bad = await fetch(`${RELAY_BASE}/api/rooms/definitely-not-a-token/history`);
  check("unknown token 404s at the relay", bad.status === 404);
  const badWs = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`${RELAY_BASE.replace("http", "ws")}/api/rooms/nope/ws`);
    ws.on("open", () => resolve(false));
    ws.on("error", () => resolve(true));
  });
  check("unknown token cannot open a live socket through the relay", badWs);

  // -- 7. heartbeat survival --------------------------------------------------
  console.log(`\nidling ~${PING_INTERVAL_MS * 8}ms across heartbeats…`);
  await new Promise((r) => setTimeout(r, PING_INTERVAL_MS * 8));
  const afterPings = await fetch(`${RELAY_BASE}/api/rooms/${token}`);
  check("host connection survives several ping/pong intervals", afterPings.status === 200 && !a.closed && !b.closed);

  // -- 8. relay restart: the laptop must dial back in and re-register ---------
  console.log("\nkilling the relay and starting a fresh one on the same port…");
  await relay.close();
  check("browsers are disconnected when the relay dies", await waitFor(() => a.closed && b.closed, 5_000, "browser sockets closed"));

  relay = await createRelay({
    port: relayPort,
    relayKey: RELAY_KEY,
    pingIntervalMs: PING_INTERVAL_MS,
    httpTimeoutMs: 15_000,
    log: (line) => console.log(`    ${line}`),
  });
  const recovered = await waitFor(
    async () => {
      try {
        return (await fetch(`${RELAY_BASE}/api/rooms/${token}`)).status === 200;
      } catch {
        return false;
      }
    },
    20_000,
    "room server reconnects and re-registers",
  );
  check("room server reconnects to the new relay and re-registers its tokens", recovered);

  const c = await openBrowser("C", RELAY_BASE, token);
  const sendC = await fetch(`${RELAY_BASE}/api/rooms/${token}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Hello again after the reconnect — greet me by name please.", name: "Carol" }),
  });
  check("send accepted after the relay restart", sendC.status === 202);
  await waitFor(() => sawUserMessage(c, "[Carol]"), 20_000, "Carol's message on the recovered socket");
  check("live streaming works again after the relay restart", sawUserMessage(c, "[Carol]"));

  // -- 9. revocation unregisters at the relay ---------------------------------
  const revoked = new Promise<boolean>((resolve) => {
    c.ws.on("close", () => resolve(true));
    setTimeout(() => resolve(false), 10_000);
  });
  const revokeRes = await fetch(`${LOCAL_BASE}/api/rooms/${token}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${adminToken}` },
  });
  check("revoke via the local admin API succeeds", revokeRes.status === 200);
  check("revoked room's relay socket is closed", await revoked);
  const afterRevoke = await fetch(`${RELAY_BASE}/api/rooms/${token}/history`);
  check("revoked room is no longer routable at the relay (404)", afterRevoke.status === 404);

  // -- cleanup ----------------------------------------------------------------
  await agent.archive();
  // Also archive the workspace the throwaway cwd created, so test runs don't
  // pile up junk entries in the user's Paseo sidebar.
  const workspaces = await client.workspaces.list({});
  for (const w of workspaces.entries) {
    if (w.projectRootPath === cwd) await client.workspaces.archive(w.id).catch(() => {});
  }
  console.log("\nthrowaway agent + workspace archived.");
  await client.close();
  await relay.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(`\n${process.exitCode ? "FAILED" : "PASSED"} (${passed} checks ok)`);
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
