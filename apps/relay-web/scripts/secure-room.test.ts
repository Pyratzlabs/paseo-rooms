import assert from "node:assert/strict";
import crypto from "node:crypto";
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

test("a static client base path is retained without a duplicate slash", () => {
  const room = createRoom("agent", "Pages room", "wss://relay.example");
  try {
    const url = new URL(
      publicRoomUrl(room, "https://pyratzlabs.github.io/paseo-rooms/"),
    );
    assert.equal(url.pathname, `/paseo-rooms/r/${room.token}`);
    assert.equal(
      new URLSearchParams(url.hash.slice(1)).get("relay"),
      "wss://relay.example",
    );
  } finally {
    deleteRoom(room.token);
  }
});

function fakeDependencies(): {
  deps: SecureRoomDeps;
  sentMessages: string[];
  publish(
    event:
      | { type: "turn_started"; provider: string }
      | { type: "replacement"; epoch: string },
  ): void;
} {
  let subscriber: Parameters<SecureRoomDeps["subscribeAgent"]>[1] | null = null;
  const sentMessages: string[] = [];
  return {
    sentMessages,
    publish(event) {
      if (event.type === "replacement") {
        subscriber?.({ agentId: "agent", event });
        return;
      }
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

test("Paseo timeline replacement disconnects guests so rejoining fetches fresh history", async () => {
  const room = createRoom("agent", "Replacement room");
  const fake = fakeDependencies();
  try {
    for (const text of ["previous", "replacement history"]) {
      const [serverSocket, browserSocket] = socketPair();
      const received = receivedRecords();
      fake.deps.fetchFullHistory = async () => [
        {
          item: { type: "message", text },
          timestamp: "2026-09-22T00:00:00.000Z",
        },
      ];
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
            joinAttemptId: text,
            inviteSecret: room.inviteSecret,
            displayName: "Alice",
          }),
        ).buffer,
      );
      const welcome = await received.next();
      assert.equal(welcome.kind, "welcome");
      assert.deepEqual(
        welcome.payload.history,
        await fake.deps.fetchFullHistory("agent"),
      );
      fake.publish({ type: "replacement", epoch: "new-epoch" });
      await waitFor(() => browserSocket.closed);
    }
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

// Real encrypted-channel integration: the wire, not only store helpers.
async function imageTestGuest(
  room: ReturnType<typeof createRoom>,
  deps: SecureRoomDeps,
  name = "Alice",
  answerQuestion: AnswerQuestion = async () => true,
) {
  const [server, browser] = socketPair(),
    received = receivedRecords();
  const opened = openSecureRoomSocket(
    `/v2/rooms/${room.token}/ws`,
    server,
    () => true,
    answerQuestion,
    deps,
  );
  const channel = await createClientChannel(
    browserTransport(browser),
    room.hostPublicKey,
    {
      onmessage(data) {
        assert.ok(
          (typeof data === "string"
            ? Buffer.byteLength(data)
            : data.byteLength) <=
            64 * 1024,
        );
        received.onmessage(data);
      },
      onerror() {},
    },
  );
  await opened;
  const random = () => crypto.randomUUID().replaceAll("-", "");
  let seq = 0;
  await channel.send(
    encoder.encode(
      JSON.stringify({
        v: 2,
        kind: "join",
        joinAttemptId: random(),
        inviteSecret: room.inviteSecret,
        displayName: name,
        capabilities: { "room-images-v1": true },
      }),
    ).buffer,
  );
  const welcome = await received.next();
  assert.equal(welcome.kind, "welcome");
  async function request(kind: string, payload: Record<string, unknown>) {
    const requestId = random();
    await channel.send(
      encoder.encode(
        JSON.stringify({
          v: 2,
          sessionId: welcome.sessionId,
          seq: ++seq,
          id: random(),
          kind,
          payload: { ...payload, requestId },
        }),
      ).buffer,
    );
    while (true) {
      const record = await received.next();
      if (record.kind === "response" && record.payload.requestId === requestId)
        return record.payload;
    }
  }
  return { server, browser, channel, received, welcome, request };
}

test(
  "two encrypted guests share byte-exact image-only SDK messages, lazy reads and zero-viewer reconnect",
  { timeout: 5000 },
  async () => {
    const room = createRoom("agent", "images"),
      fake = fakeDependencies();
    const fs = await import("node:fs");
    const bytes = fs.readFileSync(
      new URL("./fixtures/room-images/fixture.png", import.meta.url),
    );
    let subscriber: Parameters<SecureRoomDeps["subscribeAgent"]>[1] | null =
      null;
    const history: Awaited<ReturnType<SecureRoomDeps["fetchFullHistory"]>> = [];
    let sends = 0;
    fake.deps.fetchFullHistory = async () => history;
    fake.deps.subscribeAgent = async (_id, handler) => {
      subscriber = handler;
      return () => {
        subscriber = null;
      };
    };
    fake.deps.sendToAgent = async (_id, text, options, signal) => {
      assert.ok(signal instanceof AbortSignal);
      sends++;
      assert.equal(text, "[Alice]\n");
      assert.deepEqual(Buffer.from(options!.images![0].data, "base64"), bytes);
      const item = {
        type: "user_message" as const,
        text,
        messageId: options!.messageId,
        clientMessageId: options!.messageId,
      };
      history.push({ item, timestamp: "2026-10-26T00:00:00Z" });
      subscriber?.({
        agentId: "agent",
        timestamp: "2026-10-26T00:00:00Z",
        event: { type: "timeline", provider: "mock", item },
      });
    };
    try {
      const alice = await imageTestGuest(room, fake.deps),
        bob = await imageTestGuest(room, fake.deps, "Bob");
      const start = await alice.request("image_begin", {
        mimeType: "image/png",
        byteLength: bytes.length,
      });
      assert.equal(start.ok, true);
      const auth = start.value as Record<string, unknown>;
      assert.equal((await bob.request("image_finish", auth)).ok, false);
      assert.equal(
        (
          await alice.request("image_chunk", {
            ...auth,
            offset: 0,
            data: bytes.toString("base64"),
          })
        ).ok,
        true,
      );
      const finish = await alice.request("image_finish", auth);
      assert.equal(finish.ok, true);
      const metadata = (finish.value as { image: { id: string } }).image;
      const key = crypto.randomUUID().replaceAll("-", "");
      const payload = { ...auth, message: "", submissionKey: key };
      const sent = await alice.request("message", payload);
      assert.equal((sent.value as { status: string }).status, "accepted");
      assert.equal(sends, 1);
      assert.equal((await alice.request("message", payload)).ok, true);
      assert.equal(sends, 1);
      const downloaded = await bob.request("image_read", {
        imageId: metadata.id,
        offset: 0,
      });
      assert.deepEqual(
        Buffer.from((downloaded.value as { data: string }).data, "base64"),
        bytes,
      );
      alice.channel.close();
      bob.channel.close();
      const rejoined = await imageTestGuest(room, fake.deps, "Again");
      const snapshot = rejoined.welcome.payload.history as Array<{
        item: { roomImages?: Array<{ id: string }> };
      }>;
      assert.equal(snapshot[0].item.roomImages?.[0].id, metadata.id);
      assert.equal(
        (await rejoined.request("submission_status", { submissionKey: key }))
          .ok,
        true,
      );
      assert.deepEqual(
        Buffer.from(
          (
            (
              await rejoined.request("image_read", {
                imageId: metadata.id,
                offset: 0,
              })
            ).value as { data: string }
          ).data,
          "base64",
        ),
        bytes,
      );
      // Host output respects real transport pressure even when the application
      // channel send itself resolves immediately.
      Object.defineProperty(rejoined.server, "bufferedAmount", {
        value: 300 * 1024,
      });
      void rejoined.request("image_read", { imageId: metadata.id, offset: 0 });
      await waitFor(() => rejoined.server.closed);
    } finally {
      closeSecureRoom(room.token);
      deleteRoom(room.token);
    }
  },
);

test(
  "joining clients share a subscription and unsubscribe after disconnect during a delayed subscription",
  { timeout: 5000 },
  async () => {
    const room = createRoom("agent", "slow join"),
      fake = fakeDependencies();
    let subscribed = 0,
      unsubscribed = 0,
      finish!: () => void;
    fake.deps.subscribeAgent = async () => {
      subscribed++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return () => {
        unsubscribed++;
      };
    };
    const channels: Awaited<ReturnType<typeof createClientChannel>>[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const [server, browser] = socketPair();
        const opened = openSecureRoomSocket(
          `/v2/rooms/${room.token}/ws`,
          server,
          () => true,
          async () => true,
          fake.deps,
        );
        const channel = await createClientChannel(
          browserTransport(browser),
          room.hostPublicKey,
          { onerror() {} },
        );
        await opened;
        channels.push(channel);
        await channel.send(
          encoder.encode(
            JSON.stringify({
              v: 2,
              kind: "join",
              joinAttemptId: crypto.randomUUID(),
              inviteSecret: room.inviteSecret,
              displayName: "Guest",
            }),
          ).buffer,
        );
      }
      await waitFor(() => subscribed === 1);
      for (const channel of channels) channel.close();
      finish();
      await waitFor(() => unsubscribed === 1);
      assert.equal(subscribed, 1);
      fake.deps.subscribeAgent = async () => () => {};
      const next = await imageTestGuest(room, fake.deps);
      assert.equal(next.welcome.kind, "welcome");
      next.channel.close();
    } finally {
      for (const channel of channels) channel.close();
      closeSecureRoom(room.token);
      deleteRoom(room.token);
    }
  },
);

test(
  "failed admission settles queued work and never exhausts the global input budget",
  { timeout: 8000 },
  async () => {
    const room = createRoom("agent", "cancel joins"),
      fake = fakeDependencies();
    let snapshotStarted = 0;
    const pending: Array<() => void> = [];
    fake.deps.agentInfo = async () => {
      snapshotStarted++;
      await new Promise<void>((resolve) => pending.push(resolve));
      return null;
    };
    try {
      for (let i = 0; i < 40; i++) {
        const [server, browser] = socketPair();
        const opened = openSecureRoomSocket(
          `/v2/rooms/${room.token}/ws`,
          server,
          () => true,
          async () => true,
          fake.deps,
        );
        const channel = await createClientChannel(
          browserTransport(browser),
          room.hostPublicKey,
          { onerror() {} },
        );
        await opened;
        await channel.send(
          encoder.encode(
            JSON.stringify({
              v: 2,
              kind: "join",
              joinAttemptId: crypto.randomUUID(),
              inviteSecret: room.inviteSecret,
              displayName: "Guest",
            }),
          ).buffer,
        );
        await waitFor(() => snapshotStarted === i + 1);
        for (let seq = 1; seq <= 4; seq++)
          await channel.send(
            encoder.encode(
              JSON.stringify({
                v: 2,
                sessionId: "not-yet-known",
                seq,
                id: crypto.randomUUID(),
                kind: "message",
                payload: { message: "never sent" },
              }),
            ).buffer,
          );
        channel.close();
        pending.shift()?.();
      }
      fake.deps.agentInfo = async () => null;
      const next = await imageTestGuest(room, fake.deps);
      const reply = await next.request("submission_status", {
        submissionKey: crypto.randomUUID().replaceAll("-", ""),
      });
      assert.equal(reply.code, "submission_missing");
      assert.equal(next.server.closed, false);
      next.channel.close();
      assert.equal(fake.sentMessages.length, 0);
    } finally {
      for (const finish of pending) finish();
      closeSecureRoom(room.token);
      deleteRoom(room.token);
    }
  },
);

test(
  "host rejects pipelined work beyond the bound while another encrypted room remains usable",
  { timeout: 8000 },
  async () => {
    const room = createRoom("agent", "flood"),
      other = createRoom("other", "healthy"),
      fake = fakeDependencies();
    let release!: () => void;
    let started = false;
    const [server, browser] = socketPair(),
      received = receivedRecords();
    try {
      const opened = openSecureRoomSocket(
        `/v2/rooms/${room.token}/ws`,
        server,
        () => true,
        async () => {
          started = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return true;
        },
        fake.deps,
      );
      const channel = await createClientChannel(
        browserTransport(browser),
        room.hostPublicKey,
        { onmessage: received.onmessage, onerror() {} },
      );
      await opened;
      await channel.send(
        encoder.encode(
          JSON.stringify({
            v: 2,
            kind: "join",
            joinAttemptId: crypto.randomUUID(),
            inviteSecret: room.inviteSecret,
            displayName: "Flood",
          }),
        ).buffer,
      );
      const welcome = await received.next();
      const record = (seq: number) =>
        encoder.encode(
          JSON.stringify({
            v: 2,
            sessionId: welcome.sessionId,
            seq,
            id: crypto.randomUUID(),
            kind: "answer",
            payload: { questionId: "q", actionId: "a" },
          }),
        ).buffer;
      await channel.send(record(1));
      await waitFor(() => started);
      await Promise.allSettled(
        Array.from({ length: 1001 }, (_, i) => channel.send(record(i + 2))),
      );
      await waitFor(() => server.closed);
      release();
      const healthy = await imageTestGuest(other, fakeDependencies().deps);
      assert.equal(healthy.server.closed, false);
      healthy.channel.close();
    } finally {
      release?.();
      closeSecureRoom(room.token);
      closeSecureRoom(other.token);
      deleteRoom(room.token);
      deleteRoom(other.token);
    }
  },
);

test(
  "welcome precedes buffered live events and post-welcome requests while snapshot overlap deduplicates exact IDs",
  { timeout: 5000 },
  async () => {
    const room = createRoom("agent", "snapshot overlap"),
      fake = fakeDependencies(),
      received = receivedRecords();
    let subscriber: Parameters<SecureRoomDeps["subscribeAgent"]>[1] | undefined;
    let release!: () => void;
    let snapshot = false;
    const item = (messageId: string) => ({
      type: "user_message" as const,
      text: `[Alice]\n${messageId}`,
      messageId,
      clientMessageId: messageId,
    });
    const publish = (messageId: string) =>
      subscriber?.({
        agentId: "agent",
        timestamp: "2026-10-26T00:00:00Z",
        event: { type: "timeline", provider: "mock", item: item(messageId) },
      });
    fake.deps.subscribeAgent = async (_id, handler) => {
      subscriber = handler;
      return () => {};
    };
    fake.deps.fetchFullHistory = async () => {
      snapshot = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [{ item: item("first"), timestamp: "2026-10-26T00:00:00Z" }];
    };
    const [server, browser] = socketPair();
    let channel: Awaited<ReturnType<typeof createClientChannel>>;
    try {
      const opened = openSecureRoomSocket(
        `/v2/rooms/${room.token}/ws`,
        server,
        () => true,
        async () => true,
        fake.deps,
      );
      channel = await createClientChannel(
        browserTransport(browser),
        room.hostPublicKey,
        {
          onmessage(data) {
            const record = decodeAppRecord(data);
            received.onmessage(data);
            if (record.kind === "welcome") {
              // A normal client can issue its first request directly from onWelcome.
              void channel.send(
                encoder.encode(
                  JSON.stringify({
                    v: 2,
                    sessionId: record.sessionId,
                    seq: 1,
                    id: crypto.randomUUID(),
                    kind: "submission_status",
                    payload: {
                      requestId: "q".repeat(24),
                      submissionKey: "s".repeat(24),
                    },
                  }),
                ).buffer,
              );
              publish("third");
            }
          },
          onerror() {},
        },
      );
      await opened;
      await channel.send(
        encoder.encode(
          JSON.stringify({
            v: 2,
            kind: "join",
            joinAttemptId: crypto.randomUUID(),
            inviteSecret: room.inviteSecret,
            displayName: "Alice",
            capabilities: { "room-images-v1": true },
          }),
        ).buffer,
      );
      await waitFor(() => snapshot);
      publish("first");
      publish("second");
      release();
      const welcome = await received.next();
      assert.equal(welcome.kind, "welcome");
      const { projectTimeline, projectStream, appendLiveItem } =
        await import("../web/src/timeline.js");
      let projected = projectTimeline(welcome.payload.history as never);
      const ids: string[] = [];
      let response = false;
      while (ids.length < 3 || !response) {
        const record = await received.next();
        if (record.kind === "response") {
          response = true;
          assert.equal(record.payload.code, "submission_missing");
        }
        if (record.kind === "event") {
          const event = record.payload
            .event as import("../web/src/api.js").StreamEvent;
          if (event.type === "timeline") {
            ids.push(event.item.messageId!);
            const value = projectStream(event, ids.length);
            if (value) projected = appendLiveItem(projected, value, false);
          }
        }
      }
      assert.deepEqual(ids, ["first", "second", "third"]);
      assert.equal(projected.length, 3);
      assert.equal(server.closed, false);
    } finally {
      release?.();
      closeSecureRoom(room.token);
      deleteRoom(room.token);
    }
  },
);

test(
  "disconnecting hung text and question operations releases queued input capacity for healthy rooms",
  { timeout: 8000 },
  async () => {
    const room = createRoom("agent", "hung records"),
      healthyRoom = createRoom("healthy", "healthy records");
    try {
      for (const kind of ["message", "answer"] as const) {
        const fake = fakeDependencies();
        let calls = 0;
        const signals: Array<AbortSignal | undefined> = [];
        fake.deps.sendToAgent = async (_id, _text, _options, signal) => {
          calls++;
          signals.push(signal);
          await new Promise<void>(() => {});
        };
        const answer: AnswerQuestion = async (_room, _id, _payload, signal) => {
          calls++;
          signals.push(signal);
          return new Promise<boolean>(() => {});
        };
        for (let index = 0; index < 40; index++) {
          const guest = await imageTestGuest(room, fake.deps, "Guest", answer);
          for (let seq = 1; seq <= 4; seq++)
            await guest.channel.send(
              encoder.encode(
                JSON.stringify({
                  v: 2,
                  sessionId: guest.welcome.sessionId,
                  seq,
                  id: crypto.randomUUID(),
                  kind,
                  payload:
                    kind === "message"
                      ? { message: `record ${seq}` }
                      : { questionId: "question", actionId: "yes" },
                }),
              ).buffer,
            );
          await waitFor(() => calls === index + 1);
          await new Promise((resolve) => setImmediate(resolve));
          guest.channel.close();
        }
        assert.equal(
          calls,
          40,
          "queued records behind a disconnected operation must never reach SDK",
        );
        assert.ok(
          signals.every((signal) => signal?.aborted),
          "executing SDK operations must be canceled",
        );
        const healthy = await imageTestGuest(
          healthyRoom,
          fakeDependencies().deps,
        );
        const response = await healthy.request("submission_status", {
          submissionKey: "s".repeat(24),
        });
        assert.equal(response.code, "submission_missing");
        healthy.channel.close();
      }
    } finally {
      closeSecureRoom(room.token);
      closeSecureRoom(healthyRoom.token);
      deleteRoom(room.token);
      deleteRoom(healthyRoom.token);
    }
  },
);

async function queueClientRecords(
  guest: Awaited<ReturnType<typeof imageTestGuest>>,
  kind: "message" | "answer",
  count = 4,
) {
  for (let seq = 1; seq <= count; seq++)
    await guest.channel.send(
      encoder.encode(
        JSON.stringify({
          v: 2,
          sessionId: guest.welcome.sessionId,
          seq,
          id: crypto.randomUUID(),
          kind,
          payload:
            kind === "message"
              ? { message: `record ${seq}` }
              : { questionId: "question", actionId: "yes" },
        }),
      ).buffer,
    );
}

test(
  "text and question operation deadlines cancel execution, close queued work and restore healthy input",
  { timeout: 5000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { SECURE_ROOM_OPERATION_TIMEOUT_MS } =
      await import("../src/secure-room.js");
    const room = createRoom("agent", "deadlines"),
      other = createRoom("other", "after deadlines");
    try {
      for (const kind of ["message", "answer"] as const) {
        const fake = fakeDependencies();
        let calls = 0;
        let operationSignal: AbortSignal | undefined;
        fake.deps.sendToAgent = async (_id, _text, _options, signal) => {
          calls++;
          operationSignal = signal;
          await new Promise<void>(() => {});
        };
        const answer: AnswerQuestion = async (_room, _id, _payload, signal) => {
          calls++;
          operationSignal = signal;
          return new Promise<boolean>(() => {});
        };
        const guest = await imageTestGuest(room, fake.deps, "Guest", answer);
        await queueClientRecords(guest, kind);
        await waitFor(() => calls === 1);
        await new Promise((resolve) => setImmediate(resolve));
        t.mock.timers.tick(SECURE_ROOM_OPERATION_TIMEOUT_MS);
        assert.equal(guest.server.closed, true);
        assert.equal(operationSignal?.aborted, true);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(calls, 1);
        const healthy = await imageTestGuest(other, fakeDependencies().deps);
        assert.equal(
          (
            await healthy.request("submission_status", {
              submissionKey: "s".repeat(24),
            })
          ).code,
          "submission_missing",
        );
        healthy.channel.close();
      }
    } finally {
      closeSecureRoom(room.token);
      closeSecureRoom(other.token);
      deleteRoom(room.token);
      deleteRoom(other.token);
    }
  },
);

test(
  "late canceled SDK completion cannot release another connection's full input reservation",
  { timeout: 8000 },
  async () => {
    const oldRoom = createRoom("old", "old input"),
      rooms = Array.from({ length: 33 }, (_, index) =>
        createRoom(`new-${index}`, `new ${index}`),
      );
    const guests: Array<Awaited<ReturnType<typeof imageTestGuest>>> = [];
    let resolveOld!: () => void;
    try {
      const oldFake = fakeDependencies();
      oldFake.deps.sendToAgent = () =>
        new Promise<void>((resolve) => {
          resolveOld = resolve;
        });
      const old = await imageTestGuest(oldRoom, oldFake.deps);
      await queueClientRecords(old, "message");
      await waitFor(() => Boolean(resolveOld));
      old.channel.close();
      deleteRoom(oldRoom.token);
      const busy = fakeDependencies();
      let calls = 0;
      busy.deps.sendToAgent = async () => {
        calls++;
        await new Promise<void>(() => {});
      };
      for (let index = 0; index < 32; index++) {
        const guest = await imageTestGuest(rooms[index], busy.deps);
        guests.push(guest);
        await queueClientRecords(guest, "message");
        await waitFor(() => calls === index + 1);
      }
      resolveOld();
      await new Promise((resolve) => setImmediate(resolve));
      const blocked = await imageTestGuest(rooms[32], busy.deps);
      guests.push(blocked);
      await queueClientRecords(blocked, "message", 1).catch(() => {});
      await waitFor(() => blocked.server.closed);
      assert.equal(
        calls,
        32,
        "late release must not undercount 128 live reservations",
      );
    } finally {
      resolveOld?.();
      for (const guest of guests) guest.channel.close();
      closeSecureRoom(oldRoom.token);
      deleteRoom(oldRoom.token);
      for (const room of rooms) {
        closeSecureRoom(room.token);
        deleteRoom(room.token);
      }
    }
  },
);

test(
  "disconnect releases the byte budget before the record-count budget is reached",
  { timeout: 8000 },
  async () => {
    const room = createRoom("agent", "byte leases"),
      other = createRoom("other", "healthy byte leases");
    const fake = fakeDependencies();
    let calls = 0;
    fake.deps.sendToAgent = async () => {
      calls++;
      await new Promise<void>(() => {});
    };
    try {
      for (let index = 0; index < 40; index++) {
        const guest = await imageTestGuest(room, fake.deps);
        for (let seq = 1; seq <= 2; seq++)
          await guest.channel.send(
            encoder.encode(
              JSON.stringify({
                v: 2,
                sessionId: guest.welcome.sessionId,
                seq,
                id: crypto.randomUUID(),
                kind: "message",
                payload: { message: "x".repeat(60 * 1024) },
              }),
            ).buffer,
          );
        await waitFor(() => calls === index + 1);
        await new Promise((resolve) => setImmediate(resolve));
        guest.channel.close();
      }
      assert.equal(
        calls,
        40,
        "only the first large record from each disconnected client executes",
      );
      // Eighty records remain below the 128-record cap, while their cumulative
      // serialized payload exceeds 4 MiB. This independently exercises byte leases.
      const healthy = await imageTestGuest(other, fakeDependencies().deps);
      assert.equal(
        (
          await healthy.request("submission_status", {
            submissionKey: "s".repeat(24),
          })
        ).code,
        "submission_missing",
      );
      healthy.channel.close();
    } finally {
      closeSecureRoom(room.token);
      closeSecureRoom(other.token);
      deleteRoom(room.token);
      deleteRoom(other.token);
    }
  },
);

test(
  "disconnecting the uploader keeps a committed image dispatch room-owned until late SDK acceptance",
  { timeout: 5000 },
  async () => {
    const room = createRoom("agent", "room-owned dispatch"),
      fake = fakeDependencies();
    const { readFileSync } = await import("node:fs");
    const bytes = readFileSync(
      new URL("./fixtures/room-images/fixture.png", import.meta.url),
    );
    let complete!: () => void;
    let operationSignal: AbortSignal | undefined;
    let calls = 0;
    let subscriber: Parameters<SecureRoomDeps["subscribeAgent"]>[1] | null =
      null;
    const history: Awaited<ReturnType<SecureRoomDeps["fetchFullHistory"]>> = [];
    fake.deps.fetchFullHistory = async () => history;
    fake.deps.subscribeAgent = async (_id, handler) => {
      subscriber = handler;
      return () => {
        subscriber = null;
      };
    };
    fake.deps.sendToAgent = async (_id, text, options, signal) => {
      calls++;
      operationSignal = signal;
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
      const item = {
        type: "user_message" as const,
        text,
        messageId: options!.messageId,
        clientMessageId: options!.messageId,
      };
      history.push({ item, timestamp: "2026-10-27T00:00:00Z" });
      subscriber?.({
        agentId: "agent",
        timestamp: "2026-10-27T00:00:00Z",
        event: { type: "timeline", provider: "mock", item },
      });
    };
    try {
      const uploader = await imageTestGuest(room, fake.deps);
      const begin = await uploader.request("image_begin", {
        mimeType: "image/png",
        byteLength: bytes.length,
      });
      assert.equal(begin.ok, true);
      const auth = begin.value as { imageId: string; capability: string };
      await uploader.request("image_chunk", {
        ...auth,
        offset: 0,
        data: bytes.toString("base64"),
      });
      await uploader.request("image_finish", auth);
      const submissionKey = crypto.randomUUID().replaceAll("-", "");
      const payload = { ...auth, message: "pending image", submissionKey };
      void uploader.request("message", payload);
      await waitFor(() => Boolean(complete));
      assert.ok(operationSignal);
      uploader.channel.close();
      assert.equal(
        operationSignal.aborted,
        false,
        "client cancellation must not abort committed room dispatch",
      );
      const observer = await imageTestGuest(room, fake.deps, "Observer");
      assert.equal(
        (
          (await observer.request("submission_status", { submissionKey }))
            .value as { status: string }
        ).status,
        "pending",
      );
      complete();
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(
        (
          (await observer.request("submission_status", { submissionKey }))
            .value as { status: string }
        ).status,
        "accepted",
      );
      assert.equal(operationSignal.aborted, false);
      assert.equal((await observer.request("message", payload)).ok, true);
      assert.equal(calls, 1);
      observer.channel.close();
      const rejoined = await imageTestGuest(room, fake.deps, "Rejoined");
      const entries = rejoined.welcome.payload.history as Array<{
        item: { roomImages: Array<{ id: string }> };
      }>;
      assert.equal(entries[0].item.roomImages[0].id, auth.imageId);
      const downloaded = await rejoined.request("image_read", {
        imageId: auth.imageId,
        offset: 0,
      });
      assert.deepEqual(
        Buffer.from((downloaded.value as { data: string }).data, "base64"),
        bytes,
      );
      rejoined.channel.close();
    } finally {
      complete?.();
      closeSecureRoom(room.token);
      deleteRoom(room.token);
    }
  },
);
