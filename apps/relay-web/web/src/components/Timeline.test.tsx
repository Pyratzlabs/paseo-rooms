import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Timeline } from "./Timeline";
import { projectRoomQuestion } from "../../../src/questions";
import {
  providerQuestions,
  optionalCommentQuestion,
} from "../../../scripts/fixtures/provider-questions";

function renderQuestion(request: Parameters<typeof projectRoomQuestion>[0]) {
  const question = projectRoomQuestion(request);
  assert.ok(question);
  return renderToStaticMarkup(
    <Timeline
      items={[]}
      questions={[question]}
      answering={null}
      onAnswer={() => {}}
      onAnswerPrompts={() => {}}
    />,
  );
}

test("optional text questions can be submitted empty", () => {
  const html = renderQuestion({
    ...optionalCommentQuestion,
    input: { questions: [optionalCommentQuestion.input.questions[1]] },
  });
  assert.match(html, /Optional comment \(press Enter to skip\)/);
  assert.doesNotMatch(html, /class="prompt-submit" disabled/);
});

test("Pi and OMP editors render multiline controls", () => {
  for (const request of providerQuestions.filter((request) =>
    request.name.endsWith("editor"),
  )) {
    assert.match(renderQuestion(request), /<textarea/);
  }
});

test("secret Codex text input is masked", () => {
  const html = renderQuestion({
    id: "secret",
    kind: "question",
    name: "request_user_input",
    input: {
      questions: [
        {
          header: "Secret",
          question: "Enter the value",
          options: [],
          isSecret: true,
        },
      ],
    },
  });
  assert.match(html, /type="password"/);
});
