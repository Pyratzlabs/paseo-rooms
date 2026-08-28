import assert from "node:assert/strict";
import test from "node:test";
import { projectTimeline } from "../web/src/timeline.js";

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
