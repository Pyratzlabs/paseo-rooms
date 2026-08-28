import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(new URL("../public/room.html", import.meta.url), "utf8");

test("the public room exposes the focused conversation and work-detail regions", () => {
  for (const id of ["room-header", "timeline", "working", "composer", "room-error"]) {
    assert.match(page, new RegExp(`id=["']${id}["']`), `missing #${id}`);
  }
  assert.match(page, /assistant-message/);
  assert.match(page, /user-message/);
  assert.match(page, /work-detail/);
  assert.match(page, /function question\(value\)/);
  assert.match(page, /questions\/"\+encodeURIComponent\(value\.id\)\+"\/respond/);
});

test("the public room has accessible live, error, and busy feedback", () => {
  assert.match(page, /id=["']live["'][^>]*aria-live=["']polite["']/);
  assert.match(page, /id=["']send-error["'][^>]*role=["']alert["']/);
  assert.match(page, /aria-busy/);
});

test("the room uses Paseo-aligned semantic tokens and responsive layout", () => {
  for (const token of ["--surface-0", "--surface-2", "--text-muted", "--accent", "--border"]) {
    assert.match(page, new RegExp(token));
  }
  assert.match(page, /@media\s*\(max-width:\s*700px\)/);
  assert.match(page, /prefers-color-scheme\s*:\s*dark/);
});
