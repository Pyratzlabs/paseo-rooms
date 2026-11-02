import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_ORIGIN_PRESETS,
  DEFAULT_CLIENT_ORIGIN,
  DEFAULT_RELAY_ORIGIN,
  normalizeClientUrl,
  parseClientOriginPreference,
  normalizeRelayOrigin,
  rebaseRoomUrl,
} from "../client-origin.js";

const roomUrl =
  "https://paseo-rooms.pyratzlabs.fr/r/route-id#v=2&i=invite&hp=public-key";

test("rebasing changes only the client origin and keeps the room capability", () => {
  assert.equal(
    rebaseRoomUrl(roomUrl, DEFAULT_CLIENT_ORIGIN),
    "https://pyratzlabs.github.io/paseo-rooms/r/route-id#v=2&i=invite&hp=public-key",
  );
  assert.equal(
    rebaseRoomUrl(roomUrl, "https://client.example/ignored-path"),
    "https://client.example/ignored-path/r/route-id#v=2&i=invite&hp=public-key",
  );
});

test("custom client origins are normalized and unsafe schemes are rejected", () => {
  assert.equal(
    normalizeClientUrl(" https://client.example/path "),
    "https://client.example/path",
  );
  assert.equal(
    normalizeClientUrl("http://127.0.0.1:4173"),
    "http://127.0.0.1:4173",
  );
  assert.equal(
    normalizeClientUrl("http://localhost:4173"),
    "http://localhost:4173",
  );
  assert.equal(normalizeClientUrl("http://[::1]:4173"), "http://[::1]:4173");
  assert.equal(normalizeClientUrl("http://client.example"), null);
  assert.equal(normalizeClientUrl("javascript:alert(1)"), null);
  assert.equal(normalizeClientUrl("not a url"), null);
});

test("rebasing rejects public plaintext client origins", () => {
  assert.equal(rebaseRoomUrl(roomUrl, "http://client.example"), null);
});

test("relay origins use WSS publicly and keep WS for loopback testing", () => {
  assert.equal(
    normalizeRelayOrigin("https://relay.example"),
    "wss://relay.example",
  );
  assert.equal(
    normalizeRelayOrigin(DEFAULT_RELAY_ORIGIN),
    DEFAULT_RELAY_ORIGIN,
  );
  assert.equal(
    normalizeRelayOrigin("ws://127.0.0.1:8787"),
    "ws://127.0.0.1:8787",
  );
  assert.equal(normalizeRelayOrigin("ws://relay.example"), null);
});

// Existing invites preserve their embedded relay; only newly selected defaults move.
test("the new hosted default preserves legacy invite capabilities on rebase", () => {
  assert.equal(DEFAULT_RELAY_ORIGIN, "wss://paseo-rooms.pyratz.com");
  const preset = CLIENT_ORIGIN_PRESETS.find((entry) => entry.id === "pyratz");
  assert.ok(preset);
  const origin = preset.origin;
  assert.equal(origin, "https://paseo-rooms.pyratz.com");
  const legacy = `${roomUrl}&relay=wss%3A%2F%2Fpaseo-rooms.pyratzlabs.fr`;
  const rebasedUrl = rebaseRoomUrl(legacy, origin);
  assert.ok(rebasedUrl);
  const rebased = new URL(rebasedUrl);
  assert.equal(rebased.origin, origin);
  assert.equal(rebased.pathname, new URL(legacy).pathname);
  assert.equal(rebased.hash, new URL(legacy).hash);
});

test("Pages rebasing does not duplicate base paths and keeps invite fragments", () => {
  const invite = `${DEFAULT_CLIENT_ORIGIN}/r/room-id?view=full#v=2&i=secret&hp=key&relay=wss%3A%2F%2Frelay.example`;
  assert.equal(rebaseRoomUrl(invite, DEFAULT_CLIENT_ORIGIN), invite);
  assert.equal(
    rebaseRoomUrl(invite, "https://other.example/team/"),
    invite.replace(DEFAULT_CLIENT_ORIGIN, "https://other.example/team"),
  );
  assert.equal(
    rebaseRoomUrl("https://example.com/not-a-room", DEFAULT_CLIENT_ORIGIN),
    null,
  );
  assert.equal(
    normalizeClientUrl("https://client.example/path/?query=value"),
    null,
  );
  assert.equal(
    normalizeClientUrl("https://user:password@client.example"),
    null,
  );
});

test("the saved Pages preference migrates while custom endpoints remain explicit", () => {
  for (const raw of [
    null,
    "bad json",
    "null",
    '{"choice":"gitlab"}',
    '{"choice":"github"}',
  ]) {
    assert.equal(parseClientOriginPreference(raw).choice, "github");
  }
  assert.deepEqual(
    parseClientOriginPreference(
      '{"choice":"custom","customOrigin":"https://client.example/team"}',
    ),
    { choice: "custom", customOrigin: "https://client.example/team" },
  );
  assert.equal(
    parseClientOriginPreference('{"choice":"pyratz"}').choice,
    "pyratz",
  );
});
