import assert from "node:assert/strict";
import test from "node:test";
import { shouldFollowTimeline } from "../web/src/scroll.js";

test("the room follows only when the reader is close to the latest content", () => {
  assert.equal(
    shouldFollowTimeline({ scrollTop: 820, scrollHeight: 1_000, clientHeight: 100 }),
    true,
  );
  assert.equal(
    shouldFollowTimeline({ scrollTop: 819, scrollHeight: 1_000, clientHeight: 100 }),
    false,
  );
  assert.equal(
    shouldFollowTimeline({ scrollTop: 100, scrollHeight: 1_000, clientHeight: 100 }),
    false,
  );
});
