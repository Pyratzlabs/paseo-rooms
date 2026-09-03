import assert from "node:assert/strict";
import test from "node:test";
import {
  inviteRelayOrigin,
  relayOriginFor,
  relayWebSocketUrlFor,
} from "../web/src/relay-origin.js";

test("the static client uses its configured relay instead of its page origin", () => {
  assert.equal(
    relayOriginFor(
      "https://paseo-rooms.pyratzlabs.fr/",
      "https://pyratzlabs.gitlab.io",
    ),
    "https://paseo-rooms.pyratzlabs.fr",
  );
  assert.equal(
    relayWebSocketUrlFor(
      "https://paseo-rooms.pyratzlabs.fr",
      "/v2/rooms/route-id/ws",
    ),
    "wss://paseo-rooms.pyratzlabs.fr/v2/rooms/route-id/ws",
  );
});

test("the relay-hosted client keeps using its own origin", () => {
  assert.equal(
    relayOriginFor(undefined, "http://127.0.0.1:3000"),
    "http://127.0.0.1:3000",
  );
  assert.equal(
    relayWebSocketUrlFor("http://127.0.0.1:3000", "/v2/rooms/a/ws"),
    "ws://127.0.0.1:3000/v2/rooms/a/ws",
  );
});

test("the relay origin rejects non-HTTP configuration", () => {
  assert.throws(
    () => relayOriginFor("wss://relay.example", "https://client.example"),
    /must use http or https/,
  );
});

test("an invite relay overrides the build-time relay only when safe", () => {
  assert.equal(
    inviteRelayOrigin("wss://private-relay.example"),
    "wss://private-relay.example",
  );
  assert.equal(inviteRelayOrigin("ws://127.0.0.1:8787"), "ws://127.0.0.1:8787");
  assert.equal(inviteRelayOrigin("ws://private-relay.example"), null);
});
