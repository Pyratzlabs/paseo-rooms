import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../public/room.html", import.meta.url), "utf8");
const app = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const timeline = await readFile(new URL("../web/src/timeline.ts", import.meta.url), "utf8");

test("the public room is a Vite entry with token-scoped relative assets", () => {
  assert.match(page, /<div id="root"><\/div>/);
  assert.match(page, /<base href="__ROOM_BASE__"/);
  assert.match(page, /src="\.\/assets\/room-/);
  assert.match(page, /href="\.\/assets\/room-/);
});

test("the React room keeps live, error, question, and composer behavior", () => {
  assert.match(app, /aria-live="polite"/);
  assert.match(app, /aria-busy=\{!room\}/);
  assert.match(app, /api\.answer\(token, question\.id, actionId\)/);
  assert.match(app, /api\.message\(token, message, name\)/);
  assert.match(app, /roomSocket\(token\)/);
  assert.match(timeline, /permission_requested/);
  assert.match(timeline, /The agent needs the host to respond in Paseo/);
});

test("the React room uses Paseo-aligned semantic tokens and responsive layout", () => {
  for (const token of ["--surface-0", "--surface-2", "--text-muted", "--accent", "--border"]) {
    assert.match(styles, new RegExp(token));
  }
  assert.match(styles, /@media \(max-width: 700px\)/);
  assert.match(styles, /prefers-color-scheme: dark/);
});
