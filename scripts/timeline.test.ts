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

  const streamed = appendLiveItem(appendLiveItem([], greeting), update);
  assert.deepEqual(streamed, [
    {
      id: "stream:0",
      kind: "assistant",
      text: "The relay now sends text frames. The browser can parse live updates.",
    },
  ]);

  assert.deepEqual(appendLiveItem(streamed, collaborator), [
    ...streamed,
    collaborator,
  ]);
});
