import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeParticipantName } from "../src/presence.js";
import { sanitizeDisplayName } from "../web/src/name.js";

test("browser and server agree on public display-name rules", () => {
  for (const value of [" Thomas ", "[Thomas]", "[]", "one\ntwo", ""]) {
    assert.equal(sanitizeDisplayName(value), sanitizeParticipantName(value));
  }
});
