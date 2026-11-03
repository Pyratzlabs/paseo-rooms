import assert from "node:assert/strict";
import test from "node:test";
import { publicStreamEvent } from "../src/public-events.js";
import { projectRoomQuestion } from "../src/questions.js";
import {
  providerQuestions,
  optionalCommentQuestion,
  codexPlan,
} from "./fixtures/provider-questions.js";

test("live events share every normalized provider question and redact raw metadata", () => {
  for (const request of [
    ...providerQuestions,
    optionalCommentQuestion,
    codexPlan,
  ]) {
    const event = publicStreamEvent({ type: "permission_requested", request });
    assert.deepEqual(event, {
      type: "permission_requested",
      kind: request.kind,
      request: projectRoomQuestion(request),
    });
    assert.doesNotMatch(
      JSON.stringify(event),
      /must stay server-side|extensionUiMethod|"input"|"metadata"/,
    );
  }
});

test("redacts host-only daemon permission fields from shared stream events", () => {
  const event = publicStreamEvent({
    type: "permission_requested",
    request: {
      id: "q1",
      kind: "question",
      title: "Choose",
      description: "Pick one",
      input: { command: "rm -rf" },
      detail: { cwd: "/private" },
      metadata: { token: "secret" },
      actions: [{ id: "yes", label: "Yes", behavior: "allow" }],
    },
  });
  assert.deepEqual(event, {
    type: "permission_requested",
    kind: "question",
    request: {
      id: "q1",
      kind: "question",
      title: "Choose",
      description: "Pick one",
      actions: [{ id: "yes", label: "Yes" }],
      prompts: [],
      plan: null,
    },
  });
});

test("projects structured AskUserQuestion choices without its private metadata", () => {
  const event = publicStreamEvent({
    type: "permission_requested",
    request: {
      id: "q2",
      kind: "question",
      name: "AskUserQuestion",
      input: {
        questions: [
          {
            question: "Pick",
            header: "Choice",
            options: [{ label: "One", description: "First" }],
            multiSelect: false,
          },
        ],
        metadata: { secret: true },
      },
    },
  });
  assert.deepEqual(event, {
    type: "permission_requested",
    kind: "question",
    request: {
      id: "q2",
      kind: "question",
      title: null,
      description: null,
      actions: [],
      prompts: [
        {
          question: "Pick",
          header: "Choice",
          options: [{ label: "One", description: "First" }],
          multiSelect: false,
          allowOther: true,
        },
      ],
      plan: null,
    },
  });
});

test("projects the plan text and only ExitPlanMode's accept/reject actions", () => {
  assert.deepEqual(
    publicStreamEvent({
      type: "permission_requested",
      request: {
        id: "p1",
        kind: "plan",
        name: "ExitPlanMode",
        input: { plan: "# A safe plan", planFilePath: "/private/plan.md" },
        actions: [
          { id: "reject", label: "Reject", behavior: "deny" },
          { id: "implement", label: "Implement", behavior: "allow" },
        ],
      },
    }),
    {
      type: "permission_requested",
      kind: "plan",
      request: {
        id: "p1",
        kind: "plan",
        title: "Plan",
        description: null,
        actions: [
          { id: "reject", label: "Reject" },
          { id: "implement", label: "Implement" },
        ],
        prompts: [],
        plan: "# A safe plan",
      },
    },
  );
});

test("shares Codex question prompts through live events without private input", () => {
  const event = publicStreamEvent({
    type: "permission_requested",
    request: {
      id: "codex-question",
      kind: "question",
      name: "request_user_input",
      title: "Question",
      input: {
        questions: [
          {
            id: "scope",
            header: "Scope",
            question: "Which scope?",
            options: [{ label: "Small" }],
          },
        ],
        private: "must stay local",
      },
      metadata: { threadId: "private-thread" },
    },
  });
  assert.deepEqual(event, {
    type: "permission_requested",
    kind: "question",
    request: {
      id: "codex-question",
      kind: "question",
      title: "Question",
      description: null,
      actions: [],
      prompts: [
        {
          question: "Which scope?",
          header: "Scope",
          options: [{ label: "Small", description: null }],
          multiSelect: false,
          allowOther: false,
        },
      ],
      plan: null,
    },
  });
});

test("turns every host-only permission kind into a non-actionable redacted notice", () => {
  for (const kind of ["tool", "plan", "mode", "other"]) {
    assert.deepEqual(
      publicStreamEvent({
        type: "permission_requested",
        request: { id: "x", kind, input: { secret: true } },
      }),
      { type: "permission_requested", kind, request: null },
    );
  }
});

test("redacts permission resolutions too", () => {
  assert.deepEqual(
    publicStreamEvent({
      type: "permission_resolved",
      requestId: "q1",
      resolution: { updatedInput: { secret: true } },
    }),
    { type: "permission_resolved", requestId: "q1" },
  );
});
