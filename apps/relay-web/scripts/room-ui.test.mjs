import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = await readFile(
  new URL("../public/room.html", import.meta.url),
  "utf8",
);
const app = await readFile(
  new URL("../web/src/App.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(
  new URL("../web/src/styles.css", import.meta.url),
  "utf8",
);
const timeline = await readFile(
  new URL("../web/src/timeline.ts", import.meta.url),
  "utf8",
);
const nameGate = await readFile(
  new URL("../web/src/components/NameGate.tsx", import.meta.url),
  "utf8",
);
const participants = await readFile(
  new URL("../web/src/components/Participants.tsx", import.meta.url),
  "utf8",
);
const timelineComponent = await readFile(
  new URL("../web/src/components/Timeline.tsx", import.meta.url),
  "utf8",
);
const markdown = await readFile(
  new URL("../web/src/components/Markdown.tsx", import.meta.url),
  "utf8",
);
const landing = await readFile(
  new URL("../public/index.html", import.meta.url),
  "utf8",
);
const server = await readFile(
  new URL("../src/server.ts", import.meta.url),
  "utf8",
);
const relay = await readFile(
  new URL("../src/relay/relay.ts", import.meta.url),
  "utf8",
);

test("the public root is a responsive, accessible Paseo Rooms landing page", () => {
  assert.match(
    landing,
    /<meta name="viewport" content="width=device-width, initial-scale=1"/,
  );
  assert.match(
    landing,
    /<h1>Bring a second engineer into the conversation\.<\/h1>/,
  );
  assert.match(landing, /Collaborative agent work/);
  assert.match(landing, /room-plan-approval\.png/);
  assert.match(landing, /room-question\.png/);
  assert.match(landing, /made-tommy-medium\.woff2/);
  assert.match(landing, /@media \(max-width:\s*720px\)/);
  assert.match(server, /landingAssetResponse/);
  assert.match(server, /parts\[0\] === "landing"/);
  assert.match(relay, /staticDocument\(res, "index\.html"\)/);
  assert.match(relay, /safeAsset\(\s*res,\s*"landing"/);
});

test("the public room is a Vite entry with relay-owned immutable assets", () => {
  assert.match(page, /<div id="root"><\/div>/);
  assert.doesNotMatch(page, /__ROOM_BASE__/);
  assert.match(page, /src="\/assets\/room-/);
  assert.match(page, /href="\/assets\/room-/);
  assert.match(server, /function publicAssetResponse/);
  assert.match(relay, /staticDocument\(res, "room\.html"\)/);
  assert.match(relay, /parts\[0\] === "assets"/);
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

test("secure rooms submit only through their encrypted session", () => {
  assert.doesNotMatch(
    app,
    /try \{\s*await api\.(message|answer|answerPrompts)/,
  );
  assert.match(app, /if \(secureInvite\.current\) \{/);
  assert.match(app, /await session\.sendMessage\(message\)/);
  assert.match(app, /await session\.answer\(question\.id, actionId\)/);
  assert.match(app, /await session\.answerPrompts\(question\.id, answers\)/);
});

test("the React room gates live participation on a name and renders presence", () => {
  assert.match(
    app,
    /socket\?\.send\(JSON\.stringify\(\{ type: "hello", name \}\)\)/,
  );
  assert.match(app, /frame\.type === "presence"/);
  assert.match(app, /<NameGate/);
  assert.match(app, /<Participants/);
  assert.match(nameGate, /What should we call you\?/);
  assert.match(participants, /People/);
  assert.match(styles, /\.room-body/);
  assert.match(styles, /\.participants/);
});

test("the React room follows new activity without stealing an older reader's scroll", () => {
  assert.match(app, /useLayoutEffect/);
  assert.match(app, /scrollToLatest/);
  assert.match(app, /onScroll=/);
  assert.match(app, /scrollToLatest\(true\)/);
});

test("the React room renders and submits structured plan-mode questions", () => {
  assert.match(app, /api\.answerPrompts/);
  assert.match(timelineComponent, /PromptQuestions/);
  assert.match(timelineComponent, /Submit answers/);
  assert.match(timelineComponent, /prompt-tabs/);
  assert.match(timelineComponent, />\s*Next\s*</);
  assert.match(timelineComponent, /Other\.\.\./);
  assert.match(timelineComponent, /checkbox/);
});

test("the React room renders scoped plan acceptance separately from questions", () => {
  assert.match(timelineComponent, /PlanApproval/);
  assert.match(timelineComponent, /How would you like to proceed/);
  assert.match(timelineComponent, /plan-implement/);
  assert.match(timelineComponent, /plan-reject/);
  assert.match(styles, /\.plan-approval/);
});

test("Markdown preserves fenced code and ordered-list numbering for plans", () => {
  assert.match(markdown, /const fence = lines\[line\]\.match/);
  assert.match(markdown, /<pre key=/);
  assert.match(markdown, /start: Number\.parseInt/);
});

test("the React room uses Paseo-aligned semantic tokens and responsive layout", () => {
  for (const token of [
    "--surface-0",
    "--surface-2",
    "--text-muted",
    "--accent",
    "--border",
  ]) {
    assert.match(styles, new RegExp(token));
  }
  assert.match(styles, /@media \(max-width: 700px\)/);
  assert.match(styles, /grid-template-columns: minmax\(0, 1fr\) auto/);
  assert.match(styles, /prefers-color-scheme: dark/);
});
