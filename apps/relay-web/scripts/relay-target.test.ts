import assert from "node:assert/strict";
import test from "node:test";
import {
  legacyRoomUsesConfiguredRelay,
  normalizeRelayOrigin,
  relayHostUrl,
  relayKeyCompatibilityError,
} from "../src/relay-target.js";

test("relay targets require TLS except on loopback", () => {
  assert.equal(
    normalizeRelayOrigin("https://relay.example.com"),
    "wss://relay.example.com",
  );
  assert.equal(
    normalizeRelayOrigin("wss://relay.example.com/"),
    "wss://relay.example.com",
  );
  assert.equal(
    normalizeRelayOrigin("ws://127.0.0.1:8787"),
    "ws://127.0.0.1:8787",
  );
  assert.equal(normalizeRelayOrigin("ws://relay.example.com"), null);
  assert.equal(normalizeRelayOrigin("wss://user@relay.example.com"), null);
  assert.equal(normalizeRelayOrigin("wss://relay.example.com/custom"), null);
  assert.equal(
    relayHostUrl("wss://relay.example.com"),
    "wss://relay.example.com/host",
  );
});

test("legacy rooms remain on the configured relay", () => {
  assert.equal(
    legacyRoomUsesConfiguredRelay(
      "wss://relay.example.test",
      "wss://relay.example.test",
    ),
    true,
  );
  assert.equal(
    legacyRoomUsesConfiguredRelay(
      "wss://private-relay.example.test",
      "wss://relay.example.test",
    ),
    false,
  );
});

test("a changed relay key is rejected before allocating another active route", () => {
  assert.match(
    relayKeyCompatibilityError("old-key", "new-key", 1) ?? "",
    /key changed while rooms are active/,
  );
  assert.equal(relayKeyCompatibilityError("old-key", "new-key", 0), null);
  assert.equal(relayKeyCompatibilityError("same-key", "same-key", 1), null);
});
