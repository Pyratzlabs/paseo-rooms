import { useState } from "react";
import { Markdown } from "./Markdown";
import type { RoomQuestion, RoomQuestionAnswer } from "../api";
import type { DisplayItem } from "../timeline";

export function Timeline({
  items,
  questions,
  onAnswer,
  onAnswerPrompts,
  answering,
}: {
  items: DisplayItem[];
  questions: RoomQuestion[];
  onAnswer: (question: RoomQuestion, actionId: string) => void;
  onAnswerPrompts: (
    question: RoomQuestion,
    answers: RoomQuestionAnswer[],
  ) => void;
  answering: string | null;
}) {
  return (
    <>
      {items.map((item) => {
        if (item.kind === "user")
          return (
            <article className="message user-message" key={item.id}>
              <span className="author">{item.author}</span>
              <Markdown text={item.text} />
            </article>
          );
        if (item.kind === "assistant")
          return (
            <article className="message assistant-message" key={item.id}>
              <Markdown text={item.text} />
            </article>
          );
        if (item.kind === "reasoning")
          return (
            <details className="activity work-detail" key={item.id}>
              <summary>Thinking</summary>
              <div className="detail">{item.detail}</div>
            </details>
          );
        if (item.kind === "todo")
          return (
            <section className="activity" key={item.id}>
              <div className="activity-label">
                ◌ <span>{item.label}</span>
              </div>
              <div className="todo">
                {item.todos?.map((todo, index) => (
                  <div className={todo.done ? "done" : ""} key={index}>
                    {todo.done ? "✓" : "○"} {todo.text}
                  </div>
                ))}
              </div>
            </section>
          );
        return (
          <section
            className={`activity ${item.kind === "error" ? "error" : ""}`}
            key={item.id}
          >
            <div className="activity-label">
              ◌ <span>{"label" in item ? item.label : "Agent activity"}</span>
            </div>
          </section>
        );
      })}
      {questions.map((question) => (
        <section
          className="question"
          key={question.id}
          data-question-id={question.id}
        >
          <h2>{question.title || "The agent has a question"}</h2>
          {question.description && <p>{question.description}</p>}
          {question.kind === "plan" && question.plan ? (
            <PlanApproval
              actions={question.actions}
              disabled={answering === question.id}
              onAnswer={(actionId) => onAnswer(question, actionId)}
              plan={question.plan}
            />
          ) : question.prompts.length ? (
            <PromptQuestions
              question={question}
              disabled={answering === question.id}
              onSubmit={(answers) => onAnswerPrompts(question, answers)}
            />
          ) : (
            <div className="question-actions">
              {question.actions.map((action) => (
                <button
                  type="button"
                  disabled={answering === question.id}
                  onClick={() => onAnswer(question, action.id)}
                  key={action.id}
                >
                  {answering === question.id
                    ? "Sending…"
                    : action.label || "Choose"}
                </button>
              ))}
            </div>
          )}
        </section>
      ))}
    </>
  );
}

function PlanApproval({
  actions,
  disabled,
  onAnswer,
  plan,
}: {
  actions: RoomQuestion["actions"];
  disabled: boolean;
  onAnswer: (actionId: string) => void;
  plan: string;
}) {
  return (
    <div className="plan-approval">
      <div className="plan-markdown">
        <Markdown text={plan} />
      </div>
      <p className="plan-prompt">How would you like to proceed?</p>
      <div className="plan-actions">
        {actions.map((action) => (
          <button
            className={
              action.id === "implement" ? "plan-implement" : "plan-reject"
            }
            disabled={disabled}
            key={action.id}
            onClick={() => onAnswer(action.id)}
            type="button"
          >
            {disabled ? "Sending…" : action.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function PromptQuestions({
  question,
  disabled,
  onSubmit,
}: {
  question: RoomQuestion;
  disabled: boolean;
  onSubmit: (answers: RoomQuestionAnswer[]) => void;
}) {
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});
  const [activePrompt, setActivePrompt] = useState(0);
  const prompt = question.prompts[activePrompt];
  const answered = question.prompts.map(
    (_, index) =>
      (selected[index]?.length ?? 0) > 0 || Boolean(other[index]?.trim()),
  );
  const complete = answered.every(Boolean);

  function choose(index: number, label: string, multiSelect: boolean) {
    setSelected((current) => {
      const currentLabels = current[index] ?? [];
      const next = multiSelect
        ? currentLabels.includes(label)
          ? currentLabels.filter((value) => value !== label)
          : [...currentLabels, label]
        : [label];
      return { ...current, [index]: next };
    });
    if (!multiSelect) setOther((current) => ({ ...current, [index]: "" }));
  }

  function writeOther(index: number, value: string, multiSelect: boolean) {
    setOther((current) => ({ ...current, [index]: value }));
    if (!multiSelect) setSelected((current) => ({ ...current, [index]: [] }));
  }

  const activeComplete = answered[activePrompt] ?? false;

  return (
    <div className="prompt-questions">
      {question.prompts.length > 1 && (
        <div aria-label="Questions" className="prompt-tabs" role="tablist">
          {question.prompts.map((item, index) => (
            <button
              aria-selected={activePrompt === index}
              className={activePrompt === index ? "active" : undefined}
              key={item.question}
              onClick={() => setActivePrompt(index)}
              role="tab"
              type="button"
            >
              {item.header}
            </button>
          ))}
        </div>
      )}
      <fieldset className="prompt-question" disabled={disabled}>
        <legend>{prompt.question}</legend>
        {prompt.options.map((option) => {
          const checked = (selected[activePrompt] ?? []).includes(option.label);
          return (
            <label className="prompt-option" key={option.label}>
              <input
                checked={checked}
                name={`${question.id}:${activePrompt}`}
                onChange={() =>
                  choose(activePrompt, option.label, prompt.multiSelect)
                }
                type={prompt.multiSelect ? "checkbox" : "radio"}
              />
              <span>
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          );
        })}
        {prompt.allowOther && (
          <input
            aria-label={`${prompt.header} other answer`}
            className="other-answer"
            onChange={(event) =>
              writeOther(activePrompt, event.target.value, prompt.multiSelect)
            }
            placeholder="Other..."
            value={other[activePrompt] ?? ""}
          />
        )}
      </fieldset>
      {activePrompt < question.prompts.length - 1 ? (
        <button
          className="prompt-submit"
          disabled={disabled || !activeComplete}
          onClick={() => setActivePrompt((index) => index + 1)}
          type="button"
        >
          Next
        </button>
      ) : (
        <button
          className="prompt-submit"
          disabled={disabled || !complete}
          onClick={() =>
            onSubmit(
              question.prompts.map((_, questionIndex) => ({
                questionIndex,
                optionLabels: selected[questionIndex] ?? [],
                ...(other[questionIndex]?.trim()
                  ? { other: other[questionIndex].trim() }
                  : {}),
              })),
            )
          }
          type="button"
        >
          {disabled ? "Sending..." : "Submit answers"}
        </button>
      )}
    </div>
  );
}
