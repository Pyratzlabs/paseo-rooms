import assert from "node:assert/strict";
import test from "node:test";
import { parseSecureStreamEvent } from "../web/src/secure-room-client.js";

test("secure stream parser distinguishes supported, unsupported, and malformed events", () => {
  assert.deepEqual(
    parseSecureStreamEvent({
      type: "stream",
      event: { type: "attention_required", reason: "finished" },
    }),
    {
      type: "stream",
      event: { type: "attention_required", reason: "finished" },
    },
  );
  assert.equal(
    parseSecureStreamEvent({
      type: "stream",
      event: { type: "future_paseo_event" },
    }),
    "unsupported",
  );
  assert.equal(
    parseSecureStreamEvent({ type: "stream", event: { type: 42 } }),
    null,
  );
  assert.equal(
    parseSecureStreamEvent({ type: "stream", event: { type: "timeline" } }),
    null,
  );
  assert.equal(
    parseSecureStreamEvent({ type: "presence", participants: "not-an-array" }),
    null,
  );
});

test(
  "browser secure client uses ACK chunks, lazy reads and stable SDK receipts over a real encrypted socket",
  { timeout: 8000 },
  async () => {
    const { WebSocketServer } = await import("ws");
    const { readFileSync } = await import("node:fs");
    const { createRoom, deleteRoom } = await import("../src/rooms.js");
    const { openSecureRoomSocket, closeSecureRoom } =
      await import("../src/secure-room.js");
    const { connectSecureRoom } =
      await import("../web/src/secure-room-client.js");
    const room = createRoom("agent", "browser protocol");
    const wss = new WebSocketServer({ port: 0 });
    await new Promise<void>((resolve) => wss.once("listening", resolve));
    const address = wss.address();
    assert.ok(typeof address === "object" && address);
    let sent = 0;
    let allowed = false;
    let metadata: import("../shared/room-attachments.js").RoomImage | undefined;
    wss.on("connection", (ws, req) => {
      void openSecureRoomSocket(
        req.url!,
        {
          get bufferedAmount() {
            return ws.bufferedAmount;
          },
          send: (data) => ws.send(data),
          close: (code, reason) => ws.close(code, reason),
          onMessage: (handler) =>
            ws.on("message", (data) => handler(data.toString())),
          onClose: (handler) => ws.on("close", handler),
        },
        () => allowed,
        async () => true,
        {
          agentInfo: async () => null,
          fetchFullHistory: async () => [],
          listRoomQuestions: async () => [],
          subscribeAgent: async () => () => {},
          sendToAgent: async (_id, text, options) => {
            sent++;
            const { decorateRoomItem } =
              await import("../src/room-attachments.js");
            metadata = (
              decorateRoomItem(room, {
                type: "user_message",
                text,
                messageId: options!.messageId,
              }) as {
                roomImages: import("../shared/room-attachments.js").RoomImage[];
              }
            ).roomImages[0];
            assert.equal(text, "[Alice]\ncaption");
            assert.ok(options?.messageId);
            assert.deepEqual(
              Buffer.from(options!.images![0].data, "base64"),
              bytes,
            );
          },
        },
      );
    });
    const original = readFileSync(
      new URL("./fixtures/room-images/fixture.jpeg", import.meta.url),
    );
    // A legal opaque APP15 segment makes this fixture cross multiple 24KiB chunks.
    const app = Buffer.alloc(60004);
    app[0] = 255;
    app[1] = 239;
    app.writeUInt16BE(60002, 2);
    const bytes = Buffer.concat([
      original.subarray(0, 2),
      app,
      original.subarray(2),
    ]);
    let ready!: () => void;
    const welcomed = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let errored: Error | undefined;
    const session = await connectSecureRoom(
      {
        routeId: room.token,
        inviteSecret: room.inviteSecret,
        hostPublicKey: room.hostPublicKey,
        relayOrigin: `ws://127.0.0.1:${address.port}`,
      },
      "Alice",
      {
        onWelcome(value) {
          assert.equal(value.images, true);
          ready();
        },
        onEvent() {},
        onClose() {},
        onError(error) {
          errored = error;
        },
      },
    );
    try {
      await welcomed;
      await assert.rejects(
        session.sendMessage("x".repeat(70 * 1024)),
        /message_too_large/,
      );
      const key = crypto.randomUUID().replaceAll("-", "");
      const progress: number[] = [];
      await assert.rejects(
        session.sendImageMessage(
          "caption",
          new File([bytes], "photo.jpeg", { type: "image/jpeg" }),
          key,
          () => {},
        ),
        /rate_limited/,
      );
      allowed = true;
      const receipt = await session.sendImageMessage(
        "caption",
        new File([bytes], "photo.jpeg", { type: "image/jpeg" }),
        key,
        (value) => progress.push(value),
      );
      assert.equal(receipt.status, "accepted");
      assert.ok(progress.length >= 3);
      assert.equal(progress.at(-1), 100);
      assert.equal(sent, 1);
      const again = await session.sendImageMessage(
        "caption",
        new File([bytes], "photo.jpeg", { type: "image/jpeg" }),
        key,
        () => {},
      );
      assert.equal(again.messageId, receipt.messageId);
      assert.equal(sent, 1);
      assert.equal(errored, undefined);
      assert.ok(metadata);
      const downloaded = await session.readImage(metadata);
      assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
      await assert.rejects(
        session.readImage(metadata, AbortSignal.abort()),
        /cancelled/,
      );
    } finally {
      session.close();
      closeSecureRoom(room.token);
      deleteRoom(room.token);
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  },
);

test("session image cache bounds lazy download concurrency, bytes and URL lifetime", async () => {
  const { RoomImageCache } = await import("../web/src/image-cache.js");
  const create = URL.createObjectURL,
    revoke = URL.revokeObjectURL;
  let next = 0;
  const revoked: string[] = [];
  URL.createObjectURL = () => `blob:test-${++next}`;
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  let active = 0,
    maxActive = 0;
  const cache = new RoomImageCache({
    readImage: async () => {
      active++;
      maxActive = Math.max(active, maxActive);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return new Blob([new Uint8Array(2 * 1024 * 1024)]);
    },
  });
  try {
    const images = Array.from({ length: 5 }, (_, i) => ({
      id: String(i).repeat(24),
      mimeType: "image/png" as const,
      byteLength: 2 * 1024 * 1024,
      width: 1,
      height: 1,
    }));
    const urls = await Promise.all(images.map((image) => cache.load(image)));
    assert.equal(maxActive, 2);
    assert.equal(new Set(urls).size, 5);
    assert.equal(revoked.length, 1);
    assert.equal(await cache.load(images[4]), urls[4]);
    assert.equal(next, 5);
    cache.close();
    assert.equal(revoked.length, 5);
    await assert.rejects(cache.load(images[0]), /image_unavailable/);
  } finally {
    cache.close();
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
});
