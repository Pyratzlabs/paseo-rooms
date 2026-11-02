import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const ci = fs.readFileSync(
  path.join(root, ".github", "workflows", "ci.yml"),
  "utf8",
);

test("the official GitHub CI runs plugin distribution verification", () => {
  assert.match(ci, /^  plugin-verify:[\s\S]*?runs-on: ubuntu-24.04/m);
  assert.match(ci, /npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(ci, /npm run verify:plugin-distribution/);
});
