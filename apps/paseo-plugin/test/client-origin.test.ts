import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CLIENT_ORIGIN,
  DEFAULT_RELAY_ORIGIN,
  normalizeClientOrigin,
  normalizeRelayOrigin,
  rebaseRoomUrl,
} from "../client-origin.js";

const roomUrl =
  "https://paseo-rooms.pyratzlabs.fr/r/route-id#v=2&i=invite&hp=public-key";

test("rebasing changes only the client origin and keeps the room capability", () => {
  assert.equal(
    rebaseRoomUrl(roomUrl, DEFAULT_CLIENT_ORIGIN),
    "https://paseo-rooms-9eb268.gitlab.io/r/route-id#v=2&i=invite&hp=public-key",
  );
  assert.equal(
    rebaseRoomUrl(roomUrl, "https://client.example/ignored-path"),
    "https://client.example/r/route-id#v=2&i=invite&hp=public-key",
  );
});

test("custom client origins are normalized and unsafe schemes are rejected", () => {
  assert.equal(
    normalizeClientOrigin(" https://client.example/path "),
    "https://client.example",
  );
  assert.equal(
    normalizeClientOrigin("http://127.0.0.1:4173"),
    "http://127.0.0.1:4173",
  );
  assert.equal(
    normalizeClientOrigin("http://localhost:4173"),
    "http://localhost:4173",
  );
  assert.equal(normalizeClientOrigin("http://[::1]:4173"), "http://[::1]:4173");
  assert.equal(normalizeClientOrigin("http://client.example"), null);
  assert.equal(normalizeClientOrigin("javascript:alert(1)"), null);
  assert.equal(normalizeClientOrigin("not a url"), null);
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
