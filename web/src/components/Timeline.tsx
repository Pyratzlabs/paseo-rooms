import { Markdown } from "./Markdown";
import type { RoomQuestion } from "../api";
import type { DisplayItem } from "../timeline";

export function Timeline({
  items,
  questions,
  onAnswer,
  answering,
}: {
  items: DisplayItem[];
  questions: RoomQuestion[];
  onAnswer: (question: RoomQuestion, actionId: string) => void;
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
        </section>
      ))}
    </>
  );
}
