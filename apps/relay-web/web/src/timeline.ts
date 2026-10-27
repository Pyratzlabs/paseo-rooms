import type { StreamEvent, TimelineItem } from "./api.js";
import { isRoomImage, type RoomImage } from "../../shared/room-attachments.js";

export type DisplayItem =
  | {
      id: string;
      kind: "user" | "assistant";
      text: string;
      author?: string;
      images?: RoomImage[];
    }
  | {
      id: string;
      kind: "reasoning" | "activity" | "todo" | "error";
      label: string;
      detail?: string;
      todos?: Array<{ text: string; done: boolean }>;
    };

/**
 * Appends a live projection, extending the current assistant bubble only when
 * it is another fragment of that same in-progress response.
 */
export function appendLiveItem(
  items: DisplayItem[],
  item: DisplayItem,
  continueAssistant: boolean,
): DisplayItem[] {
  if (item.kind === "user" && item.id.startsWith("user:")) {
    const index = items.findIndex(
      (value) => value.kind === "user" && value.id === item.id,
    );
    if (index >= 0)
      return items.map((value, at) =>
        at === index ? { ...value, ...item } : value,
      );
  }
  const previous = items.at(-1);
  if (
    continueAssistant &&
    item.kind === "assistant" &&
    previous?.kind === "assistant"
  ) {
    return [
      ...items.slice(0, -1),
      { ...previous, text: previous.text + item.text },
    ];
  }
  return [...items, item];
}

const collaborator = /^\[([^\]\n]{1,40})\]\n([\s\S]*)$/;

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function id(index: number, item: TimelineItem): string {
  return `${index}:${item.type}:${text(item.text) || text(item.message) || text(item.name)}`;
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
        const value = text(item.text);
        const match = value.match(collaborator);
        output.push({
          id:
            typeof item.clientMessageId === "string"
              ? `user:${item.clientMessageId}`
              : typeof item.messageId === "string"
                ? `user:${item.messageId}`
                : key,
          kind: "user",
          text: match?.[2] ?? value,
          author: match?.[1] ?? "Host",
          ...(Array.isArray(item.roomImages) &&
          item.roomImages.length === 1 &&
          item.roomImages.every(isRoomImage)
            ? { images: item.roomImages }
            : {}),
        });
        break;
      }
      case "assistant_message":
        output.push({ id: key, kind: "assistant", text: text(item.text) });
        break;
      case "reasoning":
        output.push({
          id: key,
          kind: "reasoning",
          label: "Thinking",
          detail: text(item.text),
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
          todos: (Array.isArray(item.items) ? item.items : []).map(
            (todo: {
              text?: string;
              completed?: boolean;
              status?: string;
            }) => ({
              text: todo.text ?? "Untitled task",
              done: todo.completed === true || todo.status === "completed",
            }),
          ),
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
  return output.reduce<DisplayItem[]>(
    (all, item) => appendLiveItem(all, item, false),
    [],
  );
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
