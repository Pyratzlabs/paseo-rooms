import assert from "node:assert/strict";
import test from "node:test";
import { publicStreamEvent } from "../src/public-events.js";

test("redacts host-only daemon permission fields from shared stream events", () => {
  const event = publicStreamEvent({ type: "permission_requested", request: {
    id: "q1", kind: "question", title: "Choose", description: "Pick one", input: { command: "rm -rf" },
    detail: { cwd: "/private" }, metadata: { token: "secret" }, actions: [{ id: "yes", label: "Yes", behavior: "allow" }],
  } });
  assert.deepEqual(event, { type: "permission_requested", kind: "question", request: { id: "q1", kind: "question", title: "Choose", description: "Pick one", actions: [{ id: "yes", label: "Yes" }] } });
});

test("turns every host-only permission kind into a non-actionable redacted notice", () => {
  for (const kind of ["tool", "plan", "mode", "other"]) {
    assert.deepEqual(publicStreamEvent({ type: "permission_requested", request: { id: "x", kind, input: { secret: true } } }), { type: "permission_requested", kind, request: null });
  }
});

test("redacts permission resolutions too", () => {
  assert.deepEqual(publicStreamEvent({ type: "permission_resolved", requestId: "q1", resolution: { updatedInput: { secret: true } } }), { type: "permission_resolved", requestId: "q1" });
});
