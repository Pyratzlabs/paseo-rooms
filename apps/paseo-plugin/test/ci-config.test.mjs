import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const ci = fs.readFileSync(path.join(root, ".gitlab-ci.yml"), "utf8");

test("plugin CI uses the dedicated paseo-rooms runner and runs verification", () => {
  assert.match(ci, /^plugin-verify:[\s\S]*?tags:\s*\n\s*- paseo-rooms/m);
  assert.match(ci, /npm ci --no-audit --no-fund/);
  assert.match(ci, /npm run verify:plugin-distribution/);
});
