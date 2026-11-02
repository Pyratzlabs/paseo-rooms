import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = path.join(root, ".pages-site");

test("Pages deep-link fallback loads the same app with project-relative assets", () => {
  const html = readFileSync(path.join(output, "index.html"), "utf8");
  assert.equal(readFileSync(path.join(output, "404.html"), "utf8"), html);
  const assets = [
    ...html.matchAll(/(?:src|href)="([^"]+\/assets\/[^"]+)"/g),
  ].map((match) => match[1]);
  assert.ok(
    assets.some((asset) => asset.endsWith(".js")),
    "the fallback must load an executable app",
  );
  for (const asset of assets) {
    assert.ok(asset.startsWith("/paseo-rooms/assets/"), asset);
    assert.ok(
      existsSync(path.join(output, asset.slice("/paseo-rooms/".length))),
      asset,
    );
  }
  assert.doesNotMatch(html, /(?:src|href)="\/assets\//);
});

test("the Pages artifact publishes only browser files", () => {
  assert.deepEqual(readdirSync(output).sort(), [
    ".nojekyll",
    "404.html",
    "assets",
    "index.html",
  ]);
});
