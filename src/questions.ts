export interface RoomQuestion {
  id: string;
  title: string | null;
  description: string | null;
  actions: Array<{ id: string; label: string }>;
}

interface PermissionAction { id?: unknown; label?: unknown; behavior?: unknown }
interface PermissionRequest {
  id?: unknown;
  kind?: unknown;
  title?: unknown;
  description?: unknown;
  actions?: unknown;
}

/** Project exactly the safe, collaborator-answerable part of a Paseo request. */
export function projectRoomQuestion(request: PermissionRequest): RoomQuestion | null {
  if (request.kind !== "question" || typeof request.id !== "string" || !request.id) return null;
  const actions = Array.isArray(request.actions)
    ? request.actions.flatMap((action: PermissionAction) =>
        typeof action.id === "string" && action.id && typeof action.label === "string" && action.label
          ? [{ id: action.id, label: action.label }]
          : [],
      )
    : [];
  return {
    id: request.id,
    title: typeof request.title === "string" ? request.title : null,
    description: typeof request.description === "string" ? request.description : null,
    actions,
  };
}

export function canAnswerRoomQuestion(request: PermissionRequest, actionId: unknown): boolean {
  return Boolean(projectRoomQuestion(request)?.actions.some((action) => action.id === actionId));
}

export function roomQuestionActionBehavior(request: PermissionRequest, actionId: unknown): "allow" | "deny" | null {
  if (!canAnswerRoomQuestion(request, actionId) || !Array.isArray(request.actions)) return null;
  const action = request.actions.find((candidate: PermissionAction) => candidate.id === actionId);
  return action?.behavior === "deny" ? "deny" : action?.behavior === "allow" ? "allow" : null;
}
