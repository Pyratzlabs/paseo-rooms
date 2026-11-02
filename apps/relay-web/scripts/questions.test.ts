import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRoomQuestionUpdatedInput,
  canAnswerRoomQuestion,
  projectRoomQuestion,
  roomQuestionActionBehavior,
} from "../src/questions.js";

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
    kind: "question",
    title: "Which visual direction should we take?",
    description: "This changes the room renderer only.",
    actions: [
      { id: "paseo", label: "Paseo-aligned" },
      { id: "distinct", label: "Distinct identity" },
    ],
    prompts: [],
    plan: null,
  });
});

const askUserQuestion = {
  id: "ask-plan-scope",
  kind: "question",
  name: "AskUserQuestion",
  title: "Choose planning scope",
  input: {
    questions: [
      {
        question: "What should we improve?",
        header: "Focus",
        options: [
          { label: "Mobile", description: "Small screen layout" },
          { label: "Sync", description: "Live room behavior" },
        ],
        multiSelect: false,
      },
      {
        question: "Which checks?",
        header: "Checks",
        options: [{ label: "Visual", description: "Browser QA" }],
        multiSelect: true,
      },
    ],
    metadata: { private: true },
  },
};

test("projects AskUserQuestion prompts without exposing raw tool input", () => {
  assert.deepEqual(projectRoomQuestion(askUserQuestion), {
    id: "ask-plan-scope",
    kind: "question",
    title: "Choose planning scope",
    description: null,
    actions: [],
    prompts: [
      {
        question: "What should we improve?",
        header: "Focus",
        options: [
          { label: "Mobile", description: "Small screen layout" },
          { label: "Sync", description: "Live room behavior" },
        ],
        multiSelect: false,
        allowOther: true,
      },
      {
        question: "Which checks?",
        header: "Checks",
        options: [{ label: "Visual", description: "Browser QA" }],
        multiSelect: true,
        allowOther: true,
      },
    ],
    plan: null,
  });
});

// Shape emitted by Paseo 0.7.2's Codex provider. Responses use headers,
// unlike Claude's AskUserQuestion, which uses the full question text.
const codexQuestion = {
  id: "permission-codex-question",
  kind: "question",
  name: "request_user_input",
  title: "Question",
  input: {
    questions: [
      {
        id: "scope",
        header: "Scope",
        question: "Which scope should we use?",
        options: [{ label: "Small", description: "Minimal change" }],
        isOther: true,
      },
      {
        id: "notes",
        header: "Notes",
        question: "What else should we know?",
        options: [],
      },
    ],
    private: "server-only",
  },
};

test("projects Codex request_user_input choices and text-only questions", () => {
  assert.deepEqual(projectRoomQuestion(codexQuestion)?.prompts, [
    {
      question: "Which scope should we use?",
      header: "Scope",
      options: [{ label: "Small", description: "Minimal change" }],
      multiSelect: false,
      allowOther: true,
    },
    {
      question: "What else should we know?",
      header: "Notes",
      options: [],
      multiSelect: false,
      allowOther: true,
    },
  ]);
});

test("rebuilds Codex answers keyed by header while preserving original input", () => {
  assert.deepEqual(
    buildRoomQuestionUpdatedInput(codexQuestion, {
      answers: [
        { questionIndex: 0, optionLabels: ["Small"] },
        { questionIndex: 1, optionLabels: [], other: "Check billing" },
      ],
    }),
    {
      ...codexQuestion.input,
      answers: { Scope: "Small", Notes: "Check billing" },
    },
  );
});

test("rejects free text for Codex choices without an Other path", () => {
  const request = {
    ...codexQuestion,
    input: {
      questions: [{ ...codexQuestion.input.questions[0], isOther: false }],
    },
  };
  assert.equal(projectRoomQuestion(request)?.prompts[0]?.allowOther, false);
  assert.equal(
    buildRoomQuestionUpdatedInput(request, {
      answers: [{ questionIndex: 0, optionLabels: [], other: "Unlisted" }],
    }),
    null,
  );
  assert.equal(
    buildRoomQuestionUpdatedInput(request, {
      answers: [{ questionIndex: 0, optionLabels: ["Unlisted"] }],
    }),
    null,
  );
});

test("projects only the explicit ExitPlanMode approval capability", () => {
  const request = {
    id: "plan-1",
    kind: "plan",
    name: "ExitPlanMode",
    input: { plan: "# Ship it", planFilePath: "/private/plan.md" },
    metadata: { secret: true },
    actions: [
      { id: "reject", label: "Reject", behavior: "deny" },
      { id: "implement", label: "Implement", behavior: "allow" },
      { id: "other", label: "Do something else", behavior: "allow" },
    ],
  };
  assert.deepEqual(projectRoomQuestion(request), {
    id: "plan-1",
    kind: "plan",
    title: "Plan",
    description: null,
    actions: [
      { id: "reject", label: "Reject" },
      { id: "implement", label: "Implement" },
    ],
    prompts: [],
    plan: "# Ship it",
  });
  assert.equal(
    projectRoomQuestion({
      ...request,
      actions: [{ id: "implement", label: "Implement", behavior: "allow" }],
    }),
    null,
  );
  assert.equal(
    projectRoomQuestion({
      ...request,
      actions: [
        { id: "reject", label: "Reject", behavior: "deny" },
        { id: "implement", label: "Fake reject", behavior: "deny" },
        { id: "implement", label: "Implement", behavior: "allow" },
      ],
    }),
    null,
  );
  assert.equal(roomQuestionActionBehavior(request, "implement"), "allow");
  assert.equal(roomQuestionActionBehavior(request, "reject"), "deny");
  assert.equal(roomQuestionActionBehavior(request, "other"), null);
});

test("rebuilds AskUserQuestion updated input from only valid selections", () => {
  const updated = buildRoomQuestionUpdatedInput(askUserQuestion, {
    answers: [
      { questionIndex: 0, optionLabels: ["Mobile"] },
      {
        questionIndex: 1,
        optionLabels: ["Visual"],
        other: "Include a real phone",
      },
    ],
  });
  assert.deepEqual(updated, {
    ...askUserQuestion.input,
    answers: {
      "What should we improve?": "Mobile",
      "Which checks?": "Visual, Include a real phone",
    },
  });
  assert.equal(
    buildRoomQuestionUpdatedInput(askUserQuestion, {
      answers: [
        { questionIndex: 0, optionLabels: ["Unknown"] },
        { questionIndex: 1, optionLabels: ["Visual"] },
      ],
    }),
    null,
  );
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
