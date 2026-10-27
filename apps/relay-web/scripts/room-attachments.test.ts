import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import test from "node:test";
import { createRoom, deleteRoom } from "../src/rooms.js";
import { validateImage } from "../src/image-validation.js";
import {
  beginImage,
  appendImage,
  finishImage,
  cancelImage,
  readImage,
  disconnectAttachments,
  expireAttachments,
  submitRoomMessage,
  submissionStatus,
  decorateRoomItem,
  ATTACHMENT_LIMITS,
} from "../src/room-attachments.js";
import { IMAGE_CHUNK_BYTES } from "../shared/room-attachments.js";
const id = () => crypto.randomBytes(16).toString("base64url");
const fixture = (type: string) =>
  readFileSync(
    new URL(`./fixtures/room-images/fixture.${type}`, import.meta.url),
  );
function upload(
  room: ReturnType<typeof createRoom>,
  owner: string,
  type = "png",
) {
  const bytes = fixture(type),
    auth = beginImage(room, owner, {
      mimeType: `image/${type}`,
      byteLength: bytes.length,
    });
  for (let offset = 0; offset < bytes.length; offset += IMAGE_CHUNK_BYTES)
    appendImage(room, owner, {
      ...auth,
      offset,
      data: bytes
        .subarray(offset, offset + IMAGE_CHUNK_BYTES)
        .toString("base64"),
    });
  const value = finishImage(room, owner, auth);
  return { ...auth, ...value, bytes };
}
test("real PNG/JPEG/WebP fixtures validate; malformed containers, MIME, dimensions and animation are rejected", () => {
  for (const type of ["png", "jpeg", "webp"]) {
    const bytes = fixture(type);
    assert.deepEqual(validateImage(bytes, `image/${type}` as never), {
      width: 480,
      height: 280,
    });
    assert.throws(() =>
      validateImage(
        bytes.subarray(0, bytes.length - 1),
        `image/${type}` as never,
      ),
    );
  }
  assert.throws(() => validateImage(fixture("png"), "image/jpeg"));
  const corrupt = Buffer.from(fixture("png"));
  corrupt[30] ^= 1;
  assert.throws(() => validateImage(corrupt, "image/png"));
  const huge = Buffer.from(fixture("png"));
  huge.writeUInt32BE(100_000, 16);
  assert.throws(() => validateImage(huge, "image/png"));
  const animated = Buffer.from(fixture("webp"));
  animated.write("ANIM", 12);
  assert.throws(() => validateImage(animated, "image/webp"));
  assert.throws(() =>
    validateImage(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      "image/png",
    ),
  );
});
test("uploads enforce private capabilities, exact canonical chunks, reservation and inactivity cleanup", () => {
  const room = createRoom("agent", "staging");
  const saved = { ...ATTACHMENT_LIMITS };
  try {
    const bytes = fixture("png"),
      auth = beginImage(room, "alice", {
        mimeType: "image/png",
        byteLength: bytes.length,
      });
    assert.throws(
      () =>
        appendImage(room, "bob", {
          ...auth,
          offset: 0,
          data: bytes.toString("base64"),
        }),
      /image_unavailable/,
    );
    assert.throws(
      () =>
        appendImage(room, "alice", {
          ...auth,
          offset: 1,
          data: bytes.toString("base64"),
        }),
      /invalid_chunk/,
    );
    assert.throws(() => finishImage(room, "alice", auth), /image_unavailable/);
    const next = beginImage(room, "alice", {
      mimeType: "image/png",
      byteLength: bytes.length,
    });
    assert.throws(
      () => appendImage(room, "alice", { ...next, offset: 0, data: "YQ==\n" }),
      /invalid_chunk/,
    );
    const third = beginImage(room, "alice", {
      mimeType: "image/png",
      byteLength: bytes.length,
    });
    disconnectAttachments(room, "alice");
    assert.throws(() => finishImage(room, "alice", third), /image_unavailable/);
    beginImage(room, "alice", {
      mimeType: "image/png",
      byteLength: bytes.length,
    });
    expireAttachments(Date.now() + ATTACHMENT_LIMITS.idleMs + 1);
    const finished = upload(room, "alice");
    assert.throws(
      () => readImage(room, { imageId: finished.image.id, offset: 0 }),
      /image_unavailable/,
    );
    cancelImage(room, "alice", finished);
    ATTACHMENT_LIMITS.roomBytes = bytes.length;
    const full = upload(room, "alice");
    assert.throws(
      () => beginImage(room, "bob", { mimeType: "image/png", byteLength: 1 }),
      /room_full/,
    );
    cancelImage(room, "alice", full);
  } finally {
    Object.assign(ATTACHMENT_LIMITS, saved);
    deleteRoom(room.token);
  }
});
test("SDK gets original bytes and exact ID; associations survive zero viewers, stay room-scoped, and retries never duplicate", async () => {
  const room = createRoom("same-agent", "A"),
    other = createRoom("same-agent", "B");
  let calls = 0;
  try {
    const image = upload(room, "alice");
    const submissionKey = id();
    const payload = {
      message: "same text",
      submissionKey,
      imageId: image.image.id,
      capability: image.capability,
    };
    let sdkId = "";
    const send = async (
      text: string,
      options: {
        messageId: string;
        images?: Array<{ data: string; mimeType: string }>;
      },
    ) => {
      calls++;
      sdkId = options.messageId;
      assert.equal(text, "[Alice]\nsame text");
      assert.deepEqual(
        Buffer.from(options.images![0].data, "base64"),
        image.bytes,
      );
      assert.equal(
        (
          decorateRoomItem(room, {
            type: "user_message",
            text,
            messageId: sdkId,
            clientMessageId: sdkId,
          }) as { roomImages: unknown[] }
        ).roomImages.length,
        1,
      );
    };
    const receipt = await submitRoomMessage(
      room,
      "alice",
      "Alice",
      payload,
      () => true,
      send,
    );
    assert.equal(receipt.status, "accepted");
    disconnectAttachments(room, "alice");
    assert.equal(submissionStatus(room, submissionKey).status, "accepted");
    assert.equal(
      (
        await submitRoomMessage(
          room,
          "new-connection",
          "Alice",
          payload,
          () => true,
          send,
        )
      ).messageId,
      sdkId,
    );
    assert.equal(calls, 1);
    await assert.rejects(
      submitRoomMessage(
        room,
        "alice",
        "Alice",
        { ...payload, message: "changed" },
        () => true,
        send,
      ),
      /submission_changed/,
    );
    assert.deepEqual(
      Buffer.from(
        readImage(room, { imageId: image.image.id, offset: 0 }).data,
        "base64",
      ),
      image.bytes,
    );
    assert.throws(
      () => readImage(other, { imageId: image.image.id, offset: 0 }),
      /image_unavailable/,
    );
    assert.deepEqual(
      decorateRoomItem(other, {
        type: "user_message",
        text: "same text",
        messageId: sdkId,
        images: ["upstream secret"],
        roomImages: [image.image],
      }),
      { type: "user_message", text: "same text", messageId: sdkId },
    );
    deleteRoom(room.token);
    assert.throws(() => submissionStatus(room, submissionKey), /room_closed/);
  } finally {
    deleteRoom(room.token);
    deleteRoom(other.token);
  }
});
test("exact echo remains accepted after lost SDK response; definite rejection releases image; unknown does not resend", async () => {
  const room = createRoom("agent", "outcomes");
  try {
    const a = upload(room, "alice");
    const key = id();
    let count = 0;
    const payload = {
      message: "",
      submissionKey: key,
      imageId: a.image.id,
      capability: a.capability,
    };
    const accepted = await submitRoomMessage(
      room,
      "alice",
      "Alice",
      payload,
      () => true,
      async (text, options) => {
        count++;
        decorateRoomItem(room, {
          type: "user_message",
          text,
          clientMessageId: options.messageId,
        });
        throw new Error("connection closed");
      },
    );
    assert.equal(accepted.status, "accepted");
    const b = upload(room, "alice");
    const rejected = await submitRoomMessage(
      room,
      "alice",
      "Alice",
      {
        message: "",
        submissionKey: id(),
        imageId: b.image.id,
        capability: b.capability,
      },
      () => true,
      async () => {
        throw new Error("sendAgentMessage rejected");
      },
    );
    assert.equal(rejected.status, "rejected");
    assert.throws(
      () => readImage(room, { imageId: b.image.id, offset: 0 }),
      /image_unavailable/,
    );
    const c = upload(room, "alice");
    const uncertainPayload = {
      message: "",
      submissionKey: id(),
      imageId: c.image.id,
      capability: c.capability,
    };
    const uncertain = await submitRoomMessage(
      room,
      "alice",
      "Alice",
      uncertainPayload,
      () => true,
      async () => {
        count++;
        throw new Error("transport timeout");
      },
    );
    assert.equal(uncertain.status, "unknown");
    await submitRoomMessage(
      room,
      "new",
      "Alice",
      uncertainPayload,
      () => true,
      async () => {
        count++;
      },
    );
    assert.equal(count, 2);
  } finally {
    deleteRoom(room.token);
  }
});
test("revocation during SDK dispatch prevents late store resurrection", async () => {
  const room = createRoom("agent", "revoke");
  const a = upload(room, "alice");
  let finish!: () => void;
  const pending = submitRoomMessage(
    room,
    "alice",
    "Alice",
    {
      message: "",
      submissionKey: id(),
      imageId: a.image.id,
      capability: a.capability,
    },
    () => true,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  deleteRoom(room.token);
  finish();
  await assert.rejects(pending, /room_closed/);
});

function submission(room: ReturnType<typeof createRoom>) {
  const image = upload(room, "alice");
  return {
    message: "image",
    submissionKey: id(),
    imageId: image.image.id,
    capability: image.capability,
  };
}
const flushDispatch = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

test("timeouts abort never-settling SDK sends and restore both room and global capacity without retrying unknown submissions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rooms = Array.from({ length: 3 }, (_, index) =>
    createRoom("agent", `timeout ${index}`),
  );
  const payloads = rooms.map(submission);
  const signals: AbortSignal[] = [];
  let calls = 0;
  try {
    const stuck = rooms.slice(0, 2).map((room, index) =>
      submitRoomMessage(
        room,
        "alice",
        "Alice",
        payloads[index],
        () => true,
        (_text, _options, signal: AbortSignal) => {
          calls++;
          signals.push(signal);
          return new Promise<void>(() => {});
        },
      ),
    );
    await flushDispatch();
    t.mock.timers.tick(ATTACHMENT_LIMITS.sendMs);
    assert.deepEqual(
      (await Promise.all(stuck)).map((value) => value.status),
      ["unknown", "unknown"],
    );
    const healthy = await submitRoomMessage(
      rooms[2],
      "alice",
      "Alice",
      payloads[2],
      () => true,
      async () => {},
    );
    assert.equal(healthy.status, "accepted");
    assert.ok(signals.every((signal) => signal.aborted));
    const repeat = await submitRoomMessage(
      rooms[0],
      "new-connection",
      "Alice",
      payloads[0],
      () => true,
      async () => {
        calls++;
      },
    );
    assert.equal(repeat.status, "unknown");
    assert.equal(calls, 2);
    assert.equal(
      (
        await submitRoomMessage(
          rooms[0],
          "alice",
          "Alice",
          submission(rooms[0]),
          () => true,
          async () => {},
        )
      ).status,
      "accepted",
    );
  } finally {
    for (const room of rooms) deleteRoom(room.token);
  }
});

test("revoking never-settling dispatches aborts them immediately and restores global capacity", async () => {
  const rooms = Array.from({ length: 3 }, (_, index) =>
    createRoom("agent", `revoke ${index}`),
  );
  const signals: AbortSignal[] = [];
  try {
    const stuck = rooms.slice(0, 2).map((room) =>
      submitRoomMessage(
        room,
        "alice",
        "Alice",
        submission(room),
        () => true,
        (_text, _options, signal: AbortSignal) => {
          signals.push(signal);
          return new Promise<void>(() => {});
        },
      ),
    );
    const rejected = stuck.map((value) => assert.rejects(value, /room_closed/));
    await flushDispatch();
    deleteRoom(rooms[0].token);
    deleteRoom(rooms[1].token);
    assert.equal(
      (
        await submitRoomMessage(
          rooms[2],
          "alice",
          "Alice",
          submission(rooms[2]),
          () => true,
          async () => {},
        )
      ).status,
      "accepted",
    );
    await Promise.all(rejected);
    assert.ok(signals.every((signal) => signal.aborted));
  } finally {
    for (const room of rooms) deleteRoom(room.token);
  }
});

test("late SDK settlement cannot double-release a replacement dispatch or downgrade exact echo acceptance", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rooms = Array.from({ length: 5 }, (_, index) =>
    createRoom("agent", `late ${index}`),
  );
  let acceptOld!: () => void,
    rejectOld!: (cause: Error) => void,
    acceptNewA!: () => void,
    acceptNewB!: () => void;
  try {
    const payloadA = submission(rooms[0]),
      payloadB = submission(rooms[1]);
    const oldA = submitRoomMessage(
      rooms[0],
      "alice",
      "Alice",
      payloadA,
      () => true,
      () =>
        new Promise<void>((resolve) => {
          acceptOld = resolve;
        }),
    );
    const oldB = submitRoomMessage(
      rooms[1],
      "alice",
      "Alice",
      payloadB,
      () => true,
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    await flushDispatch();
    t.mock.timers.tick(ATTACHMENT_LIMITS.sendMs);
    await Promise.all([oldA, oldB]);
    decorateRoomItem(rooms[1], {
      type: "user_message",
      text: "image",
      clientMessageId: submissionStatus(rooms[1], payloadB.submissionKey)
        .messageId,
    });
    const newA = submitRoomMessage(
      rooms[0],
      "alice",
      "Alice",
      submission(rooms[0]),
      () => true,
      () =>
        new Promise<void>((resolve) => {
          acceptNewA = resolve;
        }),
    );
    const newB = submitRoomMessage(
      rooms[2],
      "alice",
      "Alice",
      submission(rooms[2]),
      () => true,
      () =>
        new Promise<void>((resolve) => {
          acceptNewB = resolve;
        }),
    );
    const newRejected = assert.rejects(newA, /room_closed/);
    await flushDispatch();
    acceptOld();
    rejectOld(new Error("sendAgentMessage rejected"));
    await flushDispatch();
    assert.equal(
      submissionStatus(rooms[0], payloadA.submissionKey).status,
      "accepted",
    );
    assert.equal(
      submissionStatus(rooms[1], payloadB.submissionKey).status,
      "accepted",
    );
    const waitingPayload = submission(rooms[3]);
    await assert.rejects(
      submitRoomMessage(
        rooms[3],
        "alice",
        "Alice",
        waitingPayload,
        () => true,
        async () => {},
      ),
      /send_busy/,
    );
    deleteRoom(rooms[0].token);
    await newRejected;
    assert.equal(
      (
        await submitRoomMessage(
          rooms[3],
          "alice",
          "Alice",
          waitingPayload,
          () => true,
          async () => {},
        )
      ).status,
      "accepted",
    );
    acceptNewA();
    acceptNewB();
    await newB;
    assert.equal(
      (
        await submitRoomMessage(
          rooms[4],
          "alice",
          "Alice",
          submission(rooms[4]),
          () => true,
          async () => {},
        )
      ).status,
      "accepted",
    );
  } finally {
    acceptOld?.();
    rejectOld?.(new Error("closed"));
    acceptNewA?.();
    acceptNewB?.();
    for (const room of rooms) deleteRoom(room.token);
  }
});
