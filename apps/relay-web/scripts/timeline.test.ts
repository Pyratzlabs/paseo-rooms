import assert from "node:assert/strict";
import test from "node:test";
import { appendLiveItem, projectTimeline } from "../web/src/timeline.js";

test("live timeline projection ignores malformed optional daemon fields", () => {
  const items = projectTimeline([
    { item: { type: "user_message", text: { unexpected: true } } as never },
    { item: { type: "assistant_message", text: ["unexpected"] } as never },
    { item: { type: "todo", items: { unexpected: true } } as never },
  ]);

  assert.deepEqual(items, [
    { id: "0:user_message:", kind: "user", text: "", author: "Host" },
    { id: "1:assistant_message:", kind: "assistant", text: "" },
    { id: "2:todo:", kind: "todo", label: "Plan", todos: [] },
  ]);
});

test("unprefixed timeline messages are attributed to the host", () => {
  assert.deepEqual(
    projectTimeline([
      { item: { type: "user_message", text: "A host note" } as never },
      { item: { type: "user_message", text: "[Alice]\nHello" } as never },
    ]),
    [
      {
        id: "0:user_message:A host note",
        kind: "user",
        text: "A host note",
        author: "Host",
      },
      {
        id: "1:user_message:[Alice]\nHello",
        kind: "user",
        text: "Hello",
        author: "Alice",
      },
    ],
  );
});

test("live assistant chunks are coalesced until a timeline boundary", () => {
  const greeting = {
    id: "stream:0",
    kind: "assistant" as const,
    text: "The relay now sends text frames. ",
  };
  const update = {
    id: "stream:1",
    kind: "assistant" as const,
    text: "The browser can parse live updates.",
  };
  const collaborator = {
    id: "stream:2",
    kind: "user" as const,
    text: "Thanks!",
    author: "Thomas",
  };

  const streamed = appendLiveItem(
    appendLiveItem([], greeting, false),
    update,
    true,
  );
  assert.deepEqual(streamed, [
    {
      id: "stream:0",
      kind: "assistant",
      text: "The relay now sends text frames. The browser can parse live updates.",
    },
  ]);

  assert.deepEqual(appendLiveItem(streamed, collaborator, true), [
    ...streamed,
    collaborator,
  ]);

  assert.deepEqual(
    appendLiveItem(
      streamed,
      { id: "stream:3", kind: "assistant", text: "A new turn." },
      false,
    ),
    [...streamed, { id: "stream:3", kind: "assistant", text: "A new turn." }],
  );
});

test("user image metadata upserts exact message IDs without merging identical text or losing assistant fragments", () => {
  const image = {
    id: "x".repeat(24),
    mimeType: "image/png" as const,
    byteLength: 100,
    width: 10,
    height: 10,
  };
  const first = projectTimeline([
    {
      item: {
        type: "user_message",
        text: "[Alice]\nsame",
        messageId: "first",
        clientMessageId: "first",
        roomImages: [image],
      },
    },
    {
      item: {
        type: "user_message",
        text: "[Alice]\nsame",
        messageId: "second",
        clientMessageId: "second",
      },
    },
  ]);
  assert.equal(first.length, 2);
  assert.equal(first[0].id, "user:first");
  const partial = {
    id: "assistant",
    kind: "assistant" as const,
    text: "Hello ",
  };
  let items = appendLiveItem(first, partial, false);
  assert.ok(first[0].kind === "user");
  items = appendLiveItem(items, { ...first[0], images: [image] }, true);
  assert.equal(items.length, 3);
  items = appendLiveItem(items, { ...partial, text: "world" }, true);
  assert.equal(items.length, 3);
  assert.equal((items[2] as { text: string }).text, "Hello world");
  assert.deepEqual((items[0] as { images: unknown[] }).images, [image]);
});
