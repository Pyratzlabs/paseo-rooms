import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("package-lock.json supports a clean npm install", () => {
  const result = spawnSync("npm", ["ci", "--dry-run", "--ignore-scripts"], {
    cwd: new URL("../../..", import.meta.url),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
