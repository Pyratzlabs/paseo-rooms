import assert from "node:assert/strict";
import test from "node:test";
import { savedRelayKey } from "../relay-credentials.server";

test("reuses a saved key only for its configured relay endpoint", () => {
  const saved =
    'RELAY_URL=wss://relay.example.com/host\nRELAY_KEY="saved-key"\nBASE_URL=http://localhost:9999\n';
  assert.equal(
    savedRelayKey(saved, "wss://relay.example.com/host"),
    "saved-key",
  );
  assert.equal(savedRelayKey(saved, "wss://other.example.com/host"), undefined);
  assert.equal(savedRelayKey(saved, "ws://relay.example.com/host"), undefined);
  assert.equal(
    savedRelayKey(saved, "wss://relay.example.com/other"),
    undefined,
  );
});

test("does not use an unpaired or empty saved credential", () => {
  assert.equal(
    savedRelayKey("RELAY_KEY=orphan", "wss://relay.example.com/host"),
    undefined,
  );
  assert.equal(
    savedRelayKey(
      "RELAY_URL=not-a-url\nRELAY_KEY=key",
      "wss://relay.example.com/host",
    ),
    undefined,
  );
  assert.equal(
    savedRelayKey(
      "RELAY_URL=wss://relay.example.com/host\nRELAY_KEY=",
      "wss://relay.example.com/host",
    ),
    undefined,
  );
});
