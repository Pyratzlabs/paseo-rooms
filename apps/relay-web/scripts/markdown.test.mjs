import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const result = await build({
  entryPoints: [
    new URL("../web/src/components/Markdown.tsx", import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "cjs",
  external: ["react", "react/*", "react-dom/*", "mermaid", "dompurify"],
});
const module = { exports: {} };
new Function("require", "module", "exports", result.outputFiles[0].text)(
  createRequire(import.meta.url),
  module,
  module.exports,
);
const render = (text) =>
  renderToStaticMarkup(React.createElement(module.exports.Markdown, { text }));

test("closed Mermaid fences become diagram regions", () => {
  const html = render(
    "Before\n\n```mermaid\nflowchart TD\nA[User] --> B[Backend]\n```\n\nAfter",
  );
  assert.match(html, /aria-label="Mermaid diagram"/);
  assert.match(html, /Before/);
  assert.match(html, /After/);
});

test("streaming Mermaid fences remain readable code until closed", () => {
  const html = render("```mermaid\nflowchart TD\nA -->");
  assert.doesNotMatch(html, /aria-label="Mermaid diagram"/);
  assert.match(html, /language-mermaid/);
  assert.match(html, /A --&gt;/);
});

test("ordinary fenced code keeps its language, lines and escaped HTML", () => {
  const html = render("```html\n<script>alert(1)</script>\n  second line\n```");
  assert.match(html, /language-html/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /second line/);
});

test("multiple Mermaid blocks render independently", () => {
  const html = render(
    "```mermaid\ngraph TD\nA --> B\n```\n\n```mermaid\nsequenceDiagram\nA->>B: Hello\n```",
  );
  assert.equal((html.match(/aria-label="Mermaid diagram"/g) ?? []).length, 2);
});

test("GFM tables render headers, alignment, inline formatting and escaped pipes", () => {
  const html = render(
    "Before\n\n| Billing method | Cost |\n| :--- | ---: |\n| **Fixed** price | `a\\|b` |\n\nAfter",
  );
  assert.match(html, /<table>/);
  assert.match(html, /<th[^>]*>Billing method<\/th>/);
  assert.match(html, /text-align:right/);
  assert.match(html, /<strong>Fixed<\/strong>/);
  assert.match(html, /<code>a\|b<\/code>/);
  assert.match(html, /After/);
});

test("HTML and executable Markdown URLs never become active content", () => {
  const html = render(
    "<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)",
  );
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /href="javascript:/);
});

test("alternate Mermaid fences and numbered lists follow CommonMark", () => {
  const html = render(
    "3. Third\n4. Fourth\n\n~~~~mermaid\ngraph TD\nA --> B\n~~~~",
  );
  assert.match(html, /<ol start="3">/);
  assert.match(html, /aria-label="Mermaid diagram"/);
});
