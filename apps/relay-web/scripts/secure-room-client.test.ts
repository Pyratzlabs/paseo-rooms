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
