import assert from "node:assert/strict";
import { test } from "node:test";
import { createClientChannel, type Transport } from "../src/paseo-e2ee.js";
import { createRoom, deleteRoom, publicRoomUrl } from "../src/rooms.js";
import { closeSecureRoom, openSecureRoomSocket } from "../src/secure-room.js";
import type { RoomSocket } from "../src/relay-client.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
type SecureRoomDeps = NonNullable<Parameters<typeof openSecureRoomSocket>[4]>;
type AnswerQuestion = Parameters<typeof openSecureRoomSocket>[3];

class MemorySocket implements RoomSocket {
  peer: MemorySocket | null = null;
  private readonly messageHandlers: Array<(data: string) => void> = [];
  private readonly closeHandlers: Array<() => void> = [];
  closed = false;
  closeCode: number | undefined;

  send(data: string): void {
    if (!this.closed) this.peer?.receive(data);
  }

  close(code?: number): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    for (const handler of this.closeHandlers) handler();
    if (this.peer && !this.peer.closed) this.peer.close(code);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  onMessage(handler: (data: string) => void): void {
    this.messageHandlers.push(handler);
  }

  private receive(data: string): void {
    for (const handler of this.messageHandlers) handler(data);
  }
}

function socketPair(): [MemorySocket, MemorySocket] {
  const left = new MemorySocket();
  const right = new MemorySocket();
  left.peer = right;
  right.peer = left;
  return [left, right];
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function browserTransport(socket: MemorySocket): Transport {
  const transport: Transport = {
    onmessage: null,
    onclose: null,
    onerror: null,
    send(data) {
      const bytes =
        typeof data === "string" ? encoder.encode(data) : new Uint8Array(data);
      socket.send(
        JSON.stringify({
          v: 2,
          type: typeof data === "string" ? "handshake" : "secure",
          data: base64url(bytes),
        }),
      );
    },
    close(code, reason) {
      void reason;
      socket.close(code);
    },
  };
  socket.onMessage((raw) => {
    const value = JSON.parse(raw) as {
      type: "handshake" | "secure";
      data: string;
    };
    const bytes = Buffer.from(value.data, "base64url");
    transport.onmessage?.({
      data:
        value.type === "handshake"
          ? decoder.decode(bytes)
          : bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
      isBinary: value.type === "secure",
    });
  });
  socket.onClose(() => transport.onclose?.(1000, "closed"));
  return transport;
}

function decodeAppRecord(data: string | ArrayBuffer): {
  sessionId: string;
  kind: string;
  payload: Record<string, unknown>;
} {
  const raw = typeof data === "string" ? data : decoder.decode(data);
  return JSON.parse(raw) as {
    sessionId: string;
    kind: string;
    payload: Record<string, unknown>;
  };
}

function receivedRecords(): {
  onmessage(data: string | ArrayBuffer): void;
  next(): Promise<ReturnType<typeof decodeAppRecord>>;
} {
  const records: ReturnType<typeof decodeAppRecord>[] = [];
  const waiters: Array<(record: ReturnType<typeof decodeAppRecord>) => void> =
    [];
  return {
    onmessage(data) {
      const record = decodeAppRecord(data);
      const waiter = waiters.shift();
      if (waiter) waiter(record);
      else records.push(record);
    },
    next() {
      const record = records.shift();
      if (record) return Promise.resolve(record);
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("timed out"));
      }
    }, 10);
  });
}

test("a local-only v2 room does not put a relay target in its invite", () => {
  const room = createRoom("agent", "Local-only room");
  try {
    const invite = publicRoomUrl(room, "http://127.0.0.1:3000");
    assert.match(invite, /#v=2&i=/);
    assert.doesNotMatch(invite, /[?&]relay=/);
  } finally {
    deleteRoom(room.token);
  }
});

function fakeDependencies(): {
  deps: SecureRoomDeps;
  sentMessages: string[];
  publish(event: { type: "turn_started"; provider: string }): void;
} {
  let subscriber: Parameters<SecureRoomDeps["subscribeAgent"]>[1] | null = null;
  const sentMessages: string[] = [];
  return {
    sentMessages,
    publish(event) {
      subscriber?.({
        agentId: "agent",
        event,
        timestamp: "2026-08-31T00:00:01.000Z",
      });
    },
    deps: {
      agentInfo: async () => ({
        title: "Encrypted room",
        status: "running",
        provider: "paseo",
      }),
      fetchFullHistory: async () => [
        {
          item: { type: "message", text: "previous" },
          timestamp: "2026-08-31T00:00:00.000Z",
        },
      ],
      listRoomQuestions: async () => [],
      sendToAgent: async (_agentId, text) => {
        sentMessages.push(text);
      },
      subscribeAgent: async (_agentId, handler) => {
        subscriber = handler;
        return () => {
          subscriber = null;
        };
      },
    },
  };
}

test("secure room admits a valid invite and applies encrypted room actions", async () => {
  const room = createRoom("agent", "Test room");
  const [serverSocket, browserSocket] = socketPair();
  const received = receivedRecords();
  const fake = fakeDependencies();
  const answers: Array<{ questionId: string; payload: unknown }> = [];
  const answerQuestion: AnswerQuestion = async (_room, questionId, payload) => {
    answers.push({ questionId, payload });
    return true;
  };

  try {
    const opened = openSecureRoomSocket(
      `/v2/rooms/${room.token}/ws`,
      serverSocket,
      () => true,
      answerQuestion,
      fake.deps,
    );
    const channel = await createClientChannel(
      browserTransport(browserSocket),
      room.hostPublicKey,
      { onmessage: received.onmessage, onerror() {} },
    );
    assert.equal(await opened, true);

    await channel.send(
      encoder.encode(
        JSON.stringify({
          v: 2,
          kind: "join",
          joinAttemptId: "attempt-1",
          inviteSecret: room.inviteSecret,
          displayName: "Alice",
        }),
      ).buffer,
    );

    const welcome = await received.next();
    assert.equal(welcome.kind, "welcome");
    assert.equal(
      (welcome.payload.room as { label?: string }).label,
      "Test room",
    );

    const presence = await received.next();
    assert.equal(presence.kind, "presence");
    assert.equal(presence.payload.type, "presence");
    assert.deepEqual(
      (presence.payload.participants as Array<{ name: string }>).map(
        (participant) => participant.name,
      ),
      ["Host", "Alice"],
    );

    await channel.send(
      encoder.encode(
        JSON.stringify({
          v: 2,
          sessionId: welcome.sessionId,
          seq: 1,
          id: "message-1",
          kind: "message",
          payload: { message: "hello" },
        }),
      ).buffer,
    );
    await waitFor(() => fake.sentMessages.length === 1);
    assert.deepEqual(fake.sentMessages, ["[Alice]\nhello"]);

    await channel.send(
      encoder.encode(
        JSON.stringify({
          v: 2,
          sessionId: welcome.sessionId,
          seq: 2,
          id: "answer-1",
          kind: "answer",
          payload: { questionId: "plan-question", actionId: "implement" },
        }),
      ).buffer,
    );
    await waitFor(() => answers.length === 1);
    assert.deepEqual(answers[0], {
      questionId: "plan-question",
      payload: { actionId: "implement" },
    });

    await channel.send(
      encoder.encode(
        JSON.stringify({
          v: 2,
          sessionId: welcome.sessionId,
          seq: 3,
          id: "prompt-answer-1",
          kind: "answer_prompts",
          payload: {
            questionId: "prompt-question",
            answers: [
              {
                questionIndex: 0,
                optionLabels: ["Shared room sync"],
                other: "presence",
              },
            ],
          },
        }),
      ).buffer,
    );
    await waitFor(() => answers.length === 2);
    assert.deepEqual(answers[1], {
      questionId: "prompt-question",
      payload: {
        answers: [
          {
            questionIndex: 0,
            optionLabels: ["Shared room sync"],
            other: "presence",
          },
        ],
      },
    });

    fake.publish({ type: "turn_started", provider: "paseo" });
    const event = await received.next();
    assert.equal(event.kind, "event");
    assert.deepEqual(event.payload, {
      type: "stream",
      event: { type: "turn_started", provider: "paseo" },
      timestamp: "2026-08-31T00:00:01.000Z",
    });
  } finally {
    closeSecureRoom(room.token);
    deleteRoom(room.token);
  }
});

test("secure room bounds an oversized welcome history without dropping the client", async () => {
  const room = createRoom("agent", "Long history room");
  const [serverSocket, browserSocket] = socketPair();
  const received = receivedRecords();
  const fake = fakeDependencies();
  const originalHistory = Array.from({ length: 8 }, (_, index) => ({
    item: { type: "message", text: `${index}:${"x".repeat(16_000)}` },
    timestamp: "2026-08-31T00:00:00.000Z",
  }));
  fake.deps.fetchFullHistory = async () => originalHistory;

  try {
    const opened = openSecureRoomSocket(
      `/v2/rooms/${room.token}/ws`,
      serverSocket,
      () => true,
      async () => true,
      fake.deps,
    );
    const channel = await createClientChannel(
      browserTransport(browserSocket),
      room.hostPublicKey,
      { onmessage: received.onmessage, onerror() {} },
    );
    assert.equal(await opened, true);
    await channel.send(
      encoder.encode(
        JSON.stringify({
          v: 2,
          kind: "join",
          joinAttemptId: "long-history-attempt",
          inviteSecret: room.inviteSecret,
          displayName: "Alice",
        }),
      ).buffer,
    );

    const welcome = await received.next();
    assert.equal(welcome.kind, "welcome");
    assert.equal(welcome.payload.historyTruncated, true);
    const history = welcome.payload.history as Array<unknown>;
    assert.ok(history.length > 0);
    assert.ok(history.length < originalHistory.length);
    assert.equal(serverSocket.closed, false);
  } finally {
    closeSecureRoom(room.token);
    deleteRoom(room.token);
  }
});

test("secure room rejects an encrypted join with the wrong invite", async () => {
  const room = createRoom("agent", "Test room");
  const [serverSocket, browserSocket] = socketPair();
  try {
    const opened = openSecureRoomSocket(
      `/v2/rooms/${room.token}/ws`,
      serverSocket,
      () => true,
      async () => true,
    );
    const channel = await createClientChannel(
      browserTransport(browserSocket),
      room.hostPublicKey,
      { onmessage() {}, onerror() {} },
    );
    assert.equal(await opened, true);
    await channel.send(
      encoder.encode(
        JSON.stringify({
          v: 2,
          kind: "join",
          joinAttemptId: "attempt-1",
          inviteSecret: "wrong-secret",
          displayName: "Mallory",
        }),
      ).buffer,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(serverSocket.closed, true);
    assert.equal(browserSocket.closed, true);
  } finally {
    deleteRoom(room.token);
  }
});

test("secure room cleans up a failed subscription before a later join", async () => {
  const room = createRoom("agent", "Test room");
  const [failedServer, failedBrowser] = socketPair();
  const failing = fakeDependencies();
  failing.deps.subscribeAgent = async () => {
    throw new Error("subscription unavailable");
  };
  try {
    const failedOpen = openSecureRoomSocket(
      `/v2/rooms/${room.token}/ws`,
      failedServer,
      () => true,
      async () => true,
      failing.deps,
    );
    const failedClient = await createClientChannel(
      browserTransport(failedBrowser),
      room.hostPublicKey,
      { onmessage() {}, onerror() {} },
    );
    assert.equal(await failedOpen, true);
    await failedClient.send(
      encoder.encode(
        JSON.stringify({
          v: 2,
          kind: "join",
          joinAttemptId: "failing-subscription",
          inviteSecret: room.inviteSecret,
          displayName: "Alice",
        }),
      ).buffer,
    );
    await waitFor(() => failedServer.closed);

    const [serverSocket, browserSocket] = socketPair();
    const received = receivedRecords();
    const succeeding = fakeDependencies();
    const opened = openSecureRoomSocket(
      `/v2/rooms/${room.token}/ws`,
      serverSocket,
      () => true,
      async () => true,
      succeeding.deps,
    );
    const channel = await createClientChannel(
      browserTransport(browserSocket),
      room.hostPublicKey,
      { onmessage: received.onmessage, onerror() {} },
    );
    assert.equal(await opened, true);
    await channel.send(
      encoder.encode(
        JSON.stringify({
          v: 2,
          kind: "join",
          joinAttemptId: "successful-subscription",
          inviteSecret: room.inviteSecret,
          displayName: "Bob",
        }),
      ).buffer,
    );
    assert.equal((await received.next()).kind, "welcome");
  } finally {
    closeSecureRoom(room.token);
    deleteRoom(room.token);
  }
});

test("secure room retains join replay protection after the last client leaves", async () => {
  const room = createRoom("agent", "Test room");
  const fake = fakeDependencies();
  const join = {
    v: 2,
    kind: "join",
    joinAttemptId: "reused-attempt",
    inviteSecret: room.inviteSecret,
    displayName: "Alice",
  };
  try {
    const [firstServer, firstBrowser] = socketPair();
    const firstOpen = openSecureRoomSocket(
      `/v2/rooms/${room.token}/ws`,
      firstServer,
      () => true,
      async () => true,
      fake.deps,
    );
    const first = await createClientChannel(
      browserTransport(firstBrowser),
      room.hostPublicKey,
      { onmessage() {}, onerror() {} },
    );
    assert.equal(await firstOpen, true);
    await first.send(encoder.encode(JSON.stringify(join)).buffer);
    await new Promise((resolve) => setTimeout(resolve, 0));
    first.close();
    await waitFor(() => firstServer.closed);

    const [secondServer, secondBrowser] = socketPair();
    const secondOpen = openSecureRoomSocket(
      `/v2/rooms/${room.token}/ws`,
      secondServer,
      () => true,
      async () => true,
      fake.deps,
    );
    const second = await createClientChannel(
      browserTransport(secondBrowser),
      room.hostPublicKey,
      { onmessage() {}, onerror() {} },
    );
    assert.equal(await secondOpen, true);
    await second.send(encoder.encode(JSON.stringify(join)).buffer);
    await waitFor(() => secondServer.closed);
  } finally {
    closeSecureRoom(room.token);
    deleteRoom(room.token);
  }
});

test("secure room bounds unauthenticated handshakes per route", async () => {
  const room = createRoom("agent", "Test room");
  const sockets: MemorySocket[] = [];
  const openings: Array<Promise<boolean>> = [];
  try {
    for (let index = 0; index < 8; index++) {
      const [serverSocket] = socketPair();
      sockets.push(serverSocket);
      openings.push(
        openSecureRoomSocket(
          `/v2/rooms/${room.token}/ws`,
          serverSocket,
          () => true,
          async () => true,
        ),
      );
    }
    const [overflow] = socketPair();
    const overflowOpen = openSecureRoomSocket(
      `/v2/rooms/${room.token}/ws`,
      overflow,
      () => true,
      async () => true,
    );
    assert.equal(await overflowOpen, true);
    assert.equal(overflow.closed, true);
    assert.equal(overflow.closeCode, 1013);
  } finally {
    for (const socket of sockets) socket.close();
    await Promise.allSettled(openings);
    deleteRoom(room.token);
  }
});
