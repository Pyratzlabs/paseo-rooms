/* End-to-end test against a real Paseo daemon and a running paseo-rooms server.

   Creates a throwaway agent, shares it, then simulates two browsers (A and B)
   over the public room API + WebSocket and asserts the whole PoC contract.

   Usage: npm run e2e            (server must be running on $PORT, daemon on 6767)
   Env:   E2E_PROVIDER=claude|codex (default claude), E2E_CWD (default: a temp dir) */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { getClient } from "../src/paseo.js";

const PORT = Number(process.env.PORT ?? 3000);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const PROVIDER = process.env.E2E_PROVIDER ?? "claude";

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
}

function openBrowser(name: string, token: string): Promise<Browser> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE_URL.replace("http", "ws")}/api/rooms/${token}/ws`);
    const browser: Browser = { name, ws, events: [] };
    ws.on("message", (data) => {
      const frame = JSON.parse(String(data));
      if (frame.type === "stream") browser.events.push(frame);
    });
    ws.on("open", () => resolve(browser));
    ws.on("error", reject);
  });
}

async function waitFor(pred: () => boolean, ms: number, label: string): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return true;
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
  const all = b.events
    .filter((f) => f.event.type === "timeline" && f.event.item.type === "assistant_message")
    .map((f) => f.event.item.text)
    .join("");
  return all.includes(text);
}

async function main(): Promise<void> {
  console.log(`e2e against ${BASE_URL} (provider: ${PROVIDER})`);
  const client = await getClient();

  // -- setup: a throwaway agent with existing history ------------------------
  const cwd = process.env.E2E_CWD ?? fs.mkdtempSync(path.join(os.tmpdir(), "paseo-rooms-e2e-"));
  // Prefer a small fast model for the test agent; fall back to the default.
  const { models } = await client.providers.listModels(PROVIDER as never);
  const model =
    models.find((m: { id: string }) => m.id.includes("haiku")) ??
    models.find((m: { isDefault?: boolean }) => m.isDefault) ??
    models[0];
  console.log(`\ncreating throwaway agent (${PROVIDER}/${model.id})…`);
  const agent = await client.agents.create({
    config: { provider: `${PROVIDER}/${model.id}` } as never,
    cwd,
    prompt:
      "Hi! We are demoing a shared chat room where several people talk to you; each message " +
      "starts with the sender's name in [brackets]. Please reply with a one-line hello that " +
      "includes the token HISTORY-MARKER-1, and from now on always greet each sender by name.",
  } as never);
  const first = await agent.waitForFinish(180_000);
  check("throwaway agent produced initial history", (first.lastMessage ?? "").includes("HISTORY-MARKER-1"));

  // -- room creation (admin) -------------------------------------------------
  const adminToken = fs.readFileSync(path.join(DATA_DIR, "admin-token"), "utf8").trim();
  const createRes = await fetch(`${BASE_URL}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ agentId: agent.id }),
  });
  check("room created via admin API", createRes.status === 201);
  const { token, url } = (await createRes.json()) as { token: string; url: string };
  console.log(`  room url: ${url}`);

  const noAuth = await fetch(`${BASE_URL}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentId: agent.id }),
  });
  check("room creation without admin token is rejected", noAuth.status === 401);

  // -- history on join -------------------------------------------------------
  const histRes = await fetch(`${BASE_URL}/api/rooms/${token}/history`);
  const hist = (await histRes.json()) as { entries: Array<{ item: any }> };
  check(
    "existing history is served to a fresh join",
    histRes.status === 200 &&
      hist.entries.some((e) => e.item.type === "assistant_message" && e.item.text.includes("HISTORY-MARKER-1")),
  );

  // -- two "browsers" --------------------------------------------------------
  const a = await openBrowser("A", token);
  const b = await openBrowser("B", token);
  console.log("\ntwo browsers connected; Alice (A) sends a message…");

  const sendA = await fetch(`${BASE_URL}/api/rooms/${token}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Hello! Please greet me by my name.", name: "Alice" }),
  });
  check("Alice's send accepted", sendA.status === 202);

  await waitFor(() => sawUserMessage(a, "[Alice]") && sawUserMessage(b, "[Alice]"), 15_000, "Alice's message on both sockets");
  check("browser A sees Alice's message live", sawUserMessage(a, "[Alice]"));
  check("browser B sees Alice's message live", sawUserMessage(b, "[Alice]"));

  await waitFor(() => sawAssistantText(a, "Alice") && sawAssistantText(b, "Alice"), 120_000, "agent reply to Alice on both sockets");
  check("agent reply streams to browser A", sawAssistantText(a, "Alice"));
  check("agent reply streams to browser B", sawAssistantText(b, "Alice"));

  console.log("\nBob (B) sends a message…");
  const sendB = await fetch(`${BASE_URL}/api/rooms/${token}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Hi, I just joined — please greet me by my name too.", name: "Bob", agent_id: "some-other-agent" }),
  });
  check("Bob's send accepted (extra agent_id field ignored)", sendB.status === 202);

  await waitFor(() => sawAssistantText(a, "Bob") && sawAssistantText(b, "Bob"), 120_000, "agent reply to Bob on both sockets");
  check("browser A sees Bob's message live", sawUserMessage(a, "[Bob]"));
  check("agent reply to Bob streams to both browsers", sawAssistantText(a, "Bob") && sawAssistantText(b, "Bob"));

  // -- both messages landed on the same underlying Paseo agent ---------------
  const page = await agent.timeline.refetch({ direction: "tail", limit: 200, projection: "projected" });
  const texts = page.entries.filter((e) => e.item.type === "user_message").map((e) => (e.item as any).text as string);
  check(
    "both humans' messages are on the same Paseo agent timeline",
    texts.some((t) => t.startsWith("[Alice]")) && texts.some((t) => t.startsWith("[Bob]")),
  );

  // -- reload restores history ----------------------------------------------
  const reload = (await (await fetch(`${BASE_URL}/api/rooms/${token}/history`)).json()) as { entries: Array<{ item: any }> };
  const reloadUsers = reload.entries.filter((e) => e.item.type === "user_message").map((e) => e.item.text as string);
  check(
    "reload restores full history from Paseo",
    reloadUsers.some((t) => t.startsWith("[Alice]")) &&
      reloadUsers.some((t) => t.startsWith("[Bob]")) &&
      reload.entries.some((e) => e.item.type === "assistant_message" && e.item.text.includes("HISTORY-MARKER-1")),
  );

  // -- security --------------------------------------------------------------
  const bad = await fetch(`${BASE_URL}/api/rooms/definitely-not-a-token/history`);
  check("invalid share token is rejected", bad.status === 404);
  const badSend = await fetch(`${BASE_URL}/api/rooms/nope/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "hi", name: "Eve" }),
  });
  check("invalid token cannot send messages", badSend.status === 404);
  const badWs = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`${BASE_URL.replace("http", "ws")}/api/rooms/nope/ws`);
    ws.on("open", () => resolve(false));
    ws.on("error", () => resolve(true));
  });
  check("invalid token cannot open the live socket", badWs);
  check(
    "room API never exposes the agent id",
    !JSON.stringify(await (await fetch(`${BASE_URL}/api/rooms/${token}`)).json()).includes(agent.id),
  );

  // -- cleanup ---------------------------------------------------------------
  a.ws.close();
  b.ws.close();
  await agent.archive();
  console.log("\nthrowaway agent archived.");
  await client.close();
  console.log(`\n${process.exitCode ? "FAILED" : "PASSED"} (${passed} checks ok)`);
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
