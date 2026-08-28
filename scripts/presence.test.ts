import assert from "node:assert/strict";
import test from "node:test";
import {
  RoomPresence,
  parsePresenceHello,
} from "../src/presence.js";

test("presence includes the host and tracks each connected browser", () => {
  const presence = new RoomPresence<object>();
  const alice = {};
  const secondAlice = {};

  assert.equal(presence.join(alice, " Alice "), true);
  assert.deepEqual(presence.list(), [
    { id: "host", name: "Host", role: "host" },
    { id: "participant-1", name: "Alice", role: "collaborator" },
  ]);

  assert.equal(presence.join(alice, "Alice renamed"), false);
  assert.deepEqual(presence.list(), [
    { id: "host", name: "Host", role: "host" },
    { id: "participant-1", name: "Alice", role: "collaborator" },
  ]);

  assert.equal(presence.join(secondAlice, "Alice"), true);
  assert.deepEqual(presence.list(), [
    { id: "host", name: "Host", role: "host" },
    { id: "participant-1", name: "Alice", role: "collaborator" },
    { id: "participant-2", name: "Alice", role: "collaborator" },
  ]);

  presence.leave(alice);
  assert.deepEqual(presence.list(), [
    { id: "host", name: "Host", role: "host" },
    { id: "participant-2", name: "Alice", role: "collaborator" },
  ]);
});

test("only a bounded, display-safe hello frame creates presence", () => {
  assert.equal(parsePresenceHello('{"type":"hello","name":"  Thomas  "}'), "Thomas");
  assert.equal(parsePresenceHello('{"type":"hello","name":"[Thomas]"}'), "Thomas");
  assert.equal(parsePresenceHello('{"type":"hello","name":""}'), null);
  assert.equal(parsePresenceHello('{"type":"hello","name":"one\\ntwo"}'), null);
  assert.equal(parsePresenceHello('{"type":"message","name":"Thomas"}'), null);
  assert.equal(parsePresenceHello("not json"), null);
});
