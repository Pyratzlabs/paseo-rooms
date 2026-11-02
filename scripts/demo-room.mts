/**
 * Local-only editorial fixture: the real encrypted Rooms UI, fictional data,
 * and no Paseo daemon or model calls. Run with: node --import tsx scripts/demo-room.mts
 */
import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const scratch = mkdtempSync(path.join(tmpdir(), "rooms-editorial-"));
// Set before dynamically importing room storage; never read a user's room data.
process.env.DATA_DIR = scratch;
const { createRoom, publicRoomUrl, deleteRoom } =
  await import("../apps/relay-web/src/rooms.js");
const { openSecureRoomSocket, closeSecureRoom } =
  await import("../apps/relay-web/src/secure-room.js");
const assets = fileURLToPath(new URL("../.pages-site/", import.meta.url));
const base = "/paseo-rooms/";
const history = [
  {
    item: {
      type: "user_message",
      text: "[Lina]\nLet’s plan Gather, an app for booking community workshops. The first release needs schedules and reservations.",
    },
  },
  {
    item: {
      type: "user_message",
      text: "[Noah]\nLet’s keep v1 small: one organiser per workshop, no payments, and no recurring events.",
    },
  },
  {
    item: {
      type: "user_message",
      text: "[Maya]\nPeople cancel late. We need to fill empty places without managing a spreadsheet. A waitlist would help.",
    },
  },
  {
    item: {
      type: "assistant_message",
      text: "Here’s the first-release plan:\n\n1. **Browse workshops** with dates and available places.\n2. **Reserve or cancel** a place, with email confirmation.\n3. **Join a waitlist** when a workshop is full.\n\nBefore I turn this into implementation tasks, let’s settle the cancellation flow.",
    },
  },
];
const question = {
  id: "demo-waitlist-question",
  kind: "question" as const,
  title: "The agent has a question",
  description: "This decision changes the booking model and notification flow.",
  actions: [],
  plan: null,
  prompts: [
    {
      header: "Waitlist",
      question: "Who gets a place when someone cancels?",
      multiSelect: false,
      allowOther: true,
      options: [
        {
          label: "Offer it to the next person",
          description: "Notify them and reserve the place for two hours.",
        },
        {
          label: "Let the organiser choose",
          description:
            "Show the waitlist and let the organiser send invitations.",
        },
      ],
    },
  ],
};
let pending = true;
let subscription: ((update: unknown) => void) | undefined;
const room = createRoom(
  "editorial-demo-agent",
  "Gather · workshop booking plan",
);
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith(base)) {
    res.writeHead(404).end();
    return;
  }
  const relative = url.pathname.slice(base.length);
  const isRoom = relative.startsWith("r/");
  const filename = path.resolve(
    assets,
    isRoom || !relative ? "index.html" : relative,
  );
  if (!filename.startsWith(assets)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const type = filename.endsWith(".js")
      ? "text/javascript"
      : filename.endsWith(".css")
        ? "text/css"
        : "text/html";
    // Match GitHub Pages: unknown deep routes receive the app via a 404 response.
    res.writeHead(isRoom ? 404 : 200, { "content-type": type });
    res.end(readFileSync(filename));
  } catch {
    res.writeHead(404).end();
  }
});
const sockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  sockets.handleUpgrade(req, socket, head, (ws) => {
    void openSecureRoomSocket(
      req.url ?? "",
      {
        send: (data) => {
          ws.send(data);
        },
        close: (code, reason) => {
          ws.close(code, reason);
        },
        onMessage: (handler) => {
          ws.on("message", (data) => handler(data.toString()));
        },
        onClose: (handler) => {
          ws.on("close", handler);
        },
      },
      () => true,
      async () => {
        pending = false;
        subscription?.({
          agentId: "editorial-demo-agent",
          event: { type: "permission_resolved", requestId: question.id },
        });
        return true;
      },
      {
        agentInfo: async () => ({
          title: "Gather · workshop booking plan",
          status: "idle",
          provider: "demo",
        }),
        fetchFullHistory: async () => history,
        listRoomQuestions: async () => (pending ? [question] : []),
        sendToAgent: async (_id, text) => {
          const item = { type: "user_message", text };
          history.push({ item });
          subscription?.({
            agentId: "editorial-demo-agent",
            event: { type: "timeline", item },
          });
        },
        subscribeAgent: async (_id, handler) => {
          subscription = handler as typeof subscription;
          return () => {
            subscription = undefined;
          };
        },
      },
    )
      .then((opened) => {
        if (!opened) ws.close(1008);
      })
      .catch(() => ws.close(1011));
  });
});
server.listen(0, "127.0.0.1", () => {
  const port = (server.address() as { port: number }).port;
  room.relayOrigin = `ws://127.0.0.1:${port}`;
  // Only the local test fixture receives this ephemeral invite. Never publish it.
  console.log(
    JSON.stringify({
      port,
      url: publicRoomUrl(room, `http://127.0.0.1:${port}${base.slice(0, -1)}`),
    }),
  );
});
function shutdown() {
  closeSecureRoom(room.token);
  deleteRoom(room.token);
  for (const socket of sockets.clients) socket.terminate();
  sockets.close();
  server.close();
  rmSync(scratch, { recursive: true, force: true });
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
