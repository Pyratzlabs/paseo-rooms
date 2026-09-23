import assert from "node:assert/strict";
import { test } from "node:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { RelayCredentialStore } from "../relay-credentials.server";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "rooms-credentials-"));
  const store = new RelayCredentialStore({ configHome: root, env: {} });
  return {
    root,
    store,
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("credentials persist scoped by canonical origin; forget suppresses legacy fallback", () => {
  const f = fixture();
  try {
    writeFileSync(
      path.join(f.root, "paseo-rooms.env"),
      "RELAY_URL=wss://private.example/host\nRELAY_KEY=old-key\n",
    );
    assert.deepEqual(f.store.resolve("https://private.example"), {
      key: "old-key",
      source: "legacy",
    });
    f.store.save("https://private.example", "new-key");
    assert.deepEqual(
      new RelayCredentialStore({ configHome: f.root, env: {} }).resolve(
        "wss://private.example",
      ),
      { key: "new-key", source: "saved" },
    );
    assert.deepEqual(f.store.resolve("wss://other.example"), {
      source: "none",
    });
    f.store.forget("https://private.example");
    assert.deepEqual(f.store.resolve("wss://private.example"), {
      source: "none",
    });
    const directory = path.join(f.root, "paseo-rooms");
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    assert.equal(
      lstatSync(path.join(directory, "relay-credentials.json")).mode & 0o777,
      0o600,
    );
  } finally {
    f.close();
  }
});

test("environment credentials retain precedence and exact endpoint scope after forget", () => {
  const f = fixture();
  try {
    const store = new RelayCredentialStore({
      configHome: f.root,
      env: {
        RELAY_URL: "wss://private.example/host",
        RELAY_KEY: "environment-key",
      },
    });
    store.save("wss://private.example", "saved-key");
    store.forget("wss://private.example");
    assert.deepEqual(store.resolve("wss://private.example"), {
      key: "environment-key",
      source: "environment",
    });
    assert.deepEqual(store.resolve("wss://other.example"), { source: "none" });
  } finally {
    f.close();
  }
});

test("store tightens permissions and refuses file or directory symlinks", () => {
  const f = fixture();
  try {
    f.store.save("wss://private.example", "key");
    const directory = path.join(f.root, "paseo-rooms");
    const filename = path.join(directory, "relay-credentials.json");
    chmodSync(directory, 0o755);
    chmodSync(filename, 0o644);
    f.store.resolve("wss://private.example");
    assert.equal(lstatSync(filename).mode & 0o777, 0o600);
    rmSync(filename);
    const target = path.join(f.root, "target");
    writeFileSync(target, "{}");
    symlinkSync(target, filename);
    assert.throws(
      () => f.store.save("wss://private.example", "secret-should-not-leak"),
      /could not safely read/,
    );
    assert.equal(readFileSync(target, "utf8"), "{}");
    rmSync(directory, { recursive: true });
    const alternate = path.join(f.root, "alternate");
    mkdirSync(alternate);
    symlinkSync(alternate, directory);
    assert.throws(
      () => f.store.resolve("wss://private.example"),
      /could not safely read/,
    );
  } finally {
    f.close();
  }
});

test("malformed stores and excessive credentials fail closed without exposing contents", () => {
  const f = fixture();
  try {
    f.store.save("wss://private.example", "key");
    const filename = path.join(f.root, "paseo-rooms", "relay-credentials.json");
    writeFileSync(filename, '{"bad":"sensitive-value"}');
    assert.throws(
      () => f.store.resolve("wss://private.example"),
      /^Error: paseo-rooms: could not safely read relay credentials$/,
    );
    assert.throws(
      () => f.store.save("wss://private.example", "x".repeat(4097)),
      /invalid relay key/,
    );
    assert.throws(
      () => f.store.resolve("https://private.example/path"),
      /invalid relay origin/,
    );
  } finally {
    f.close();
  }
});

test("unsupported platform permits scoped environment credentials but disables persistence", () => {
  const f = fixture();
  try {
    const store = new RelayCredentialStore({
      configHome: f.root,
      platform: "win32",
      env: { RELAY_URL: "wss://private.example/host", RELAY_KEY: "key" },
    });
    assert.equal(store.rememberSupported, false);
    assert.equal(store.resolve("wss://private.example").source, "environment");
    assert.throws(
      () => store.save("wss://private.example", "key"),
      /unavailable/,
    );
  } finally {
    f.close();
  }
});

test("oversized serialized credentials cannot corrupt an existing store", () => {
  const f = fixture();
  try {
    const largeKey = "界".repeat(4096);
    for (let i = 0; i < 48; i++)
      f.store.save(`wss://relay-${i}.example`, largeKey);
    const filename = path.join(f.root, "paseo-rooms", "relay-credentials.json");
    const before = readFileSync(filename, "utf8");
    assert.ok(Buffer.byteLength(before) < 600_000);
    assert.throws(
      () => f.store.save("wss://overflow.example", largeKey),
      /storage limit reached/,
    );
    assert.equal(readFileSync(filename, "utf8"), before);
    assert.deepEqual(f.store.resolve("wss://relay-0.example"), {
      key: largeKey,
      source: "saved",
    });
  } finally {
    f.close();
  }
});
