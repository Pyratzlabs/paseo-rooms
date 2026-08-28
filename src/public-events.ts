import { projectRoomQuestion } from "./questions.js";

/** Redact daemon permission internals before WebSocket fan-out to a room URL. */
export function publicStreamEvent(event: unknown): unknown {
  if (!event || typeof event !== "object") return event;
  if ((event as { type?: unknown }).type === "permission_resolved") {
    const requestId = (event as { requestId?: unknown }).requestId;
    return {
      type: "permission_resolved",
      requestId: typeof requestId === "string" ? requestId : null,
    };
  }
  if ((event as { type?: unknown }).type !== "permission_requested")
    return event;
  const request = (event as { request?: unknown }).request;
  const kind =
    request && typeof request === "object"
      ? (request as { kind?: unknown }).kind
      : null;
  const question =
    request && typeof request === "object"
      ? projectRoomQuestion(request)
      : null;
  return question
    ? { type: "permission_requested", kind: question.kind, request: question }
    : {
        type: "permission_requested",
        kind: typeof kind === "string" ? kind : "other",
        request: null,
      };
}
