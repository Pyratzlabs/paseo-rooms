import assert from "node:assert/strict";
import test from "node:test";
import {
  providerQuestions,
  optionalCommentQuestion,
  codexPlan,
} from "./fixtures/provider-questions.js";
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

for (const request of providerQuestions) {
  test(`projects and answers ${request.provider} ${request.name}`, () => {
    const prompt = projectRoomQuestion(request)?.prompts[0];
    assert.ok(prompt, "the question must be visible");
    assert.equal(prompt.question, request.input.questions[0].question);
    const options = request.input.questions[0].options;
    assert.deepEqual(
      prompt.options.map((option) => option.label),
      options.map((option) => option.label),
    );
    const labels = options
      .slice(0, request.input.questions[0].multiSelect ? 2 : 1)
      .map((option) => option.label);
    const answer = labels.length
      ? labels.join(", ")
      : "Some text\nAnother line";
    assert.deepEqual(
      buildRoomQuestionUpdatedInput(request, {
        answers: [
          {
            questionIndex: 0,
            optionLabels: labels,
            ...(labels.length ? {} : { other: answer }),
          },
        ],
      }),
      { ...request.input, answers: { Response: answer } },
    );
  });
}

test("supports combined Pi/OMP questions with empty optional comments", () => {
  const prompts = projectRoomQuestion(optionalCommentQuestion)?.prompts;
  assert.equal(prompts?.length, 2);
  assert.equal((prompts?.[1] as { allowEmpty?: boolean })?.allowEmpty, true);
  assert.equal(
    (prompts?.[1] as { placeholder?: string })?.placeholder,
    "Optional comment (press Enter to skip)...",
  );
  assert.deepEqual(
    buildRoomQuestionUpdatedInput(optionalCommentQuestion, {
      answers: [
        { questionIndex: 0, optionLabels: ["Alpha"] },
        { questionIndex: 1, optionLabels: [] },
      ],
    }),
    {
      ...optionalCommentQuestion.input,
      answers: { Response: "Alpha", Comment: "" },
    },
  );
});

test("honors allowOther rather than enabling free text for every provider", () => {
  const request = providerQuestions.find(
    (request) => request.name === "Pi select",
  )!;
  assert.equal(projectRoomQuestion(request)?.prompts[0].allowOther, false);
  assert.equal(
    buildRoomQuestionUpdatedInput(request, {
      answers: [{ questionIndex: 0, optionLabels: [], other: "Unlisted" }],
    }),
    null,
  );
});

test("supports Codex plan approval with its actual dismiss action", () => {
  const projected = projectRoomQuestion(codexPlan);
  assert.equal(projected?.plan, codexPlan.input.plan);
  assert.deepEqual(
    projected?.actions,
    codexPlan.actions.map(({ id, label }) => ({ id, label })),
  );
  assert.equal(roomQuestionActionBehavior(codexPlan, "dismiss"), "deny");
  assert.equal(roomQuestionActionBehavior(codexPlan, "implement"), "allow");
  assert.equal(
    projectRoomQuestion({
      ...codexPlan,
      actions: [
        { id: "dismiss", label: "Dismiss", behavior: "allow" },
        codexPlan.actions[1],
      ],
    }),
    null,
  );
});

test("does not silently submit a partial malformed question set", () => {
  const request = {
    ...optionalCommentQuestion,
    input: {
      questions: [
        optionalCommentQuestion.input.questions[0],
        { question: "Missing header" },
      ],
    },
  };
  assert.equal(
    buildRoomQuestionUpdatedInput(request, {
      answers: [{ questionIndex: 0, optionLabels: ["Alpha"] }],
    }),
    null,
  );
});

test("rejects duplicate answer keys and prototype-shaped answer keys", () => {
  for (const header of ["Response", "__proto__"]) {
    const request = {
      ...optionalCommentQuestion,
      input: {
        questions: optionalCommentQuestion.input.questions.map((prompt) => ({
          ...prompt,
          header,
        })),
      },
    };
    assert.equal(
      buildRoomQuestionUpdatedInput(request, {
        answers: [
          { questionIndex: 0, optionLabels: ["Alpha"] },
          { questionIndex: 1, optionLabels: [], other: "Comment" },
        ],
      }),
      null,
    );
  }
});

test("unsupported questions get an explicit host fallback instead of a blank card", () => {
  assert.match(
    projectRoomQuestion({ id: "unknown", kind: "question", name: "new-format" })
      ?.description ?? "",
    /answer.*Paseo/i,
  );
});
