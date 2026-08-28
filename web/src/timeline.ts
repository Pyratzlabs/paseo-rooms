import type { StreamEvent, TimelineItem } from "./api";

export type DisplayItem =
  | { id: string; kind: "user" | "assistant"; text: string; author?: string }
  | {
      id: string;
      kind: "reasoning" | "activity" | "todo" | "error";
      label: string;
      detail?: string;
      todos?: Array<{ text: string; done: boolean }>;
    };

const collaborator = /^\[([^\]\n]{1,40})\]\n([\s\S]*)$/;

function id(index: number, item: TimelineItem): string {
  return `${index}:${item.type}:${item.text ?? item.message ?? item.name ?? ""}`;
}

export function projectTimeline(
  items: Array<{ item: TimelineItem }>,
): DisplayItem[] {
  const output: DisplayItem[] = [];
  let index = 0;
  for (const entry of items) {
    const item = entry.item;
    if (!item || typeof item !== "object") continue;
    const key = id(index++, item);
    switch (item.type) {
      case "user_message": {
        const text = item.text ?? "";
        const match = text.match(collaborator);
        output.push({
          id: key,
          kind: "user",
          text: match?.[2] ?? text,
          author: match?.[1] ?? "Host",
        });
        break;
      }
      case "assistant_message":
        output.push({ id: key, kind: "assistant", text: item.text ?? "" });
        break;
      case "reasoning":
        output.push({
          id: key,
          kind: "reasoning",
          label: "Thinking",
          detail: item.text ?? "",
        });
        break;
      case "tool_call":
        output.push({
          id: key,
          kind: "activity",
          label: `${item.name ?? "Tool"} · ${item.status ?? "working"}`,
        });
        break;
      case "todo":
        output.push({
          id: key,
          kind: "todo",
          label: "Plan",
          todos: (item.items ?? []).map((todo) => ({
            text: todo.text ?? "Untitled task",
            done: todo.completed === true || todo.status === "completed",
          })),
        });
        break;
      case "error":
        output.push({
          id: key,
          kind: "error",
          label: item.message ?? "Agent error",
        });
        break;
      default:
        output.push({ id: key, kind: "activity", label: "Agent activity" });
    }
  }
  return output;
}

/** Returns a small append-only projection suitable for a live socket frame. */
export function projectStream(
  event: StreamEvent,
  position: number,
): DisplayItem | null {
  if (event.type === "timeline")
    return projectTimeline([{ item: event.item }])[0] ?? null;
  if (event.type === "turn_canceled")
    return {
      id: `stream:${position}`,
      kind: "activity",
      label: "Turn canceled",
    };
  if (event.type === "turn_failed")
    return {
      id: `stream:${position}`,
      kind: "error",
      label: event.error ?? "Turn failed",
    };
  if (event.type === "permission_requested" && !event.request) {
    return {
      id: `stream:${position}`,
      kind: "activity",
      label: "The agent needs the host to respond in Paseo",
    };
  }
  return null;
}
