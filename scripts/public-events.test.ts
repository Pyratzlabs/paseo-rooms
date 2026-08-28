import assert from "node:assert/strict";
import test from "node:test";
import { publicStreamEvent } from "../src/public-events.js";

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
