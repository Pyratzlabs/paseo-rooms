import assert from "node:assert/strict";
import test from "node:test";
import { canAnswerRoomQuestion, projectRoomQuestion } from "../src/questions.js";

const question = {
  id: "ask-visual-direction",
  kind: "question",
  title: "Which visual direction should we take?",
  description: "This changes the room renderer only.",
  input: { secret: "must not leave the daemon" },
  actions: [
    { id: "paseo", label: "Paseo-aligned", behavior: "allow" },
    { id: "distinct", label: "Distinct identity", behavior: "allow" },
  ],
  metadata: { workspacePath: "/private" },
};

test("projects only safe structured question fields", () => {
  assert.deepEqual(projectRoomQuestion(question), {
    id: "ask-visual-direction",
    title: "Which visual direction should we take?",
    description: "This changes the room renderer only.",
    actions: [
      { id: "paseo", label: "Paseo-aligned" },
      { id: "distinct", label: "Distinct identity" },
    ],
  });
});

test("never projects or answers non-question permission kinds", () => {
  for (const kind of ["tool", "plan", "mode", "other"]) {
    const request = { ...question, kind };
    assert.equal(projectRoomQuestion(request), null);
    assert.equal(canAnswerRoomQuestion(request, "paseo"), false);
  }
});

test("only accepts an action advertised by the live question", () => {
  assert.equal(canAnswerRoomQuestion(question, "paseo"), true);
  assert.equal(canAnswerRoomQuestion(question, "made-up-action"), false);
  assert.equal(canAnswerRoomQuestion(question, { id: "paseo" }), false);
});
