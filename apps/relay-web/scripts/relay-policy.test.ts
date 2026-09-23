import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { discoverRelayPolicy } from "../src/relay-policy.js";

const valid = {
  version: 1,
  registration: "open",
  roomProtocols: [2],
  routeOwnership: "sha256-secret-v1",
  registrationAck: true,
};
test("discovery validates capabilities without sending credentials or following redirects", async () => {
  let response = JSON.stringify(valid);
  let redirect = false;
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    assert.equal(req.url, "/.well-known/paseo-rooms");
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers["x-relay-key"], undefined);
    if (redirect) {
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
      return;
    }
    res.end(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const origin = `ws://127.0.0.1:${address.port}`;
  try {
    assert.deepEqual(await discoverRelayPolicy(origin), valid);
    const count = requests;
    assert.equal(
      (await discoverRelayPolicy(origin, "legacy-key")).registrationAck,
      false,
    );
    assert.equal(requests, count);
    response = "x".repeat(4097);
    await assert.rejects(discoverRelayPolicy(origin), /too large/);
    response = JSON.stringify({ ...valid, version: 2 });
    await assert.rejects(discoverRelayPolicy(origin), /Unsupported/);
    response = "not-json";
    await assert.rejects(discoverRelayPolicy(origin), /Invalid/);
    redirect = true;
    const before = requests;
    await assert.rejects(discoverRelayPolicy(origin));
    assert.equal(requests, before + 1);
    await assert.rejects(
      discoverRelayPolicy("https://example.org/host"),
      /valid relay/,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
