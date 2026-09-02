import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const output = new URL("../.e2ee-smoke/assets/", import.meta.url);

test("Vite bundles Paseo E2EE's published browser artifact", async () => {
  const files = await readdir(output);
  const scripts = files.filter((file) => file.endsWith(".js"));
  assert.ok(scripts.length > 0, "the E2EE smoke build must emit JavaScript");

  const bundles = await Promise.all(
    scripts.map((file) => readFile(join(output.pathname, file), "utf8")),
  );
  assert.ok(
    bundles.some((bundle) => bundle.includes("e2ee_hello")),
    "the bundled graph must contain Paseo's encrypted-channel handshake",
  );
});
