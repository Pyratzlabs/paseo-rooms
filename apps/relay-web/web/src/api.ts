export interface RoomQuestion {
  id: string;
  kind: "question" | "plan";
  title?: string | null;
  description?: string | null;
  actions: Array<{ id: string; label?: string }>;
  prompts: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description?: string | null }>;
    multiSelect: boolean;
    allowOther: boolean;
    allowEmpty?: boolean;
    placeholder?: string;
    dismissLabel?: string;
    isSecret?: boolean;
    multiline?: boolean;
  }>;
  plan?: string | null;
}

export interface RoomQuestionAnswer {
  questionIndex: number;
  optionLabels: string[];
  other?: string;
}

export interface RoomInfo {
  label?: string;
  createdAt?: string;
  agent?: { title?: string; status?: string; provider?: string } | null;
  questions?: RoomQuestion[];
}

export interface RoomParticipant {
  id: string;
  name: string;
  role: "host" | "collaborator";
}

export interface TimelineItem {
  type: string;
  text?: string;
  name?: string;
  status?: string;
  message?: string;
  items?: Array<{ text?: string; completed?: boolean; status?: string }>;
  messageId?: string;
  clientMessageId?: string;
  roomImages?: import("../../shared/room-attachments.js").RoomImage[];
}

export type StreamEvent =
  | { type: "thread_started" }
  | { type: "timeline"; item: TimelineItem }
  | { type: "turn_started" | "turn_completed" | "turn_canceled" }
  | { type: "turn_failed"; error?: string }
  | {
      type: "permission_requested";
      request?: RoomQuestion | null;
      kind?: string;
    }
  | { type: "permission_resolved"; requestId?: string }
  | { type: "attention_required" };

function roomPath(token: string, suffix = ""): string {
  return `/api/rooms/${encodeURIComponent(token)}${suffix}`;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  if (!response.ok) throw new Error(String(response.status));
  return response.json() as Promise<T>;
}

export const api = {
  room: (token: string) => request<RoomInfo>(roomPath(token)),
  history: async (token: string) =>
    (
      await request<{ entries?: Array<{ item: TimelineItem }> }>(
        roomPath(token, "/history"),
      )
    ).entries ?? [],
  message: (token: string, message: string, name: string) =>
    request(roomPath(token, "/messages"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, name }),
    }),
  answer: (token: string, requestId: string, actionId: string) =>
    request(
      roomPath(token, `/questions/${encodeURIComponent(requestId)}/respond`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ actionId }),
      },
    ),
  answerPrompts: (
    token: string,
    requestId: string,
    answers: RoomQuestionAnswer[],
  ) =>
    request(
      roomPath(token, `/questions/${encodeURIComponent(requestId)}/respond`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers }),
      },
    ),
};

export function roomSocket(token: string): WebSocket {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(
    `${protocol}//${location.host}${roomPath(token, "/ws")}`,
  );
}
