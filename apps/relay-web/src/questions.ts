export interface RoomQuestion {
  id: string;
  kind: "question" | "plan";
  title: string | null;
  description: string | null;
  actions: Array<{ id: string; label: string }>;
  prompts: RoomQuestionPrompt[];
  plan: string | null;
}

export interface RoomQuestionPrompt {
  question: string;
  header: string;
  options: Array<{ label: string; description: string | null }>;
  multiSelect: boolean;
  allowOther: boolean;
}

export interface RoomQuestionResponse {
  answers: Array<{
    questionIndex: number;
    optionLabels: string[];
    other?: string;
  }>;
}

interface PermissionAction {
  id?: unknown;
  label?: unknown;
  behavior?: unknown;
}
interface QuestionOption {
  label?: unknown;
  description?: unknown;
}
interface QuestionPrompt {
  question?: unknown;
  header?: unknown;
  options?: unknown;
  multiSelect?: unknown;
  isOther?: unknown;
}
interface PermissionRequest {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  input?: unknown;
  actions?: unknown;
}

function projectActions(
  actions: unknown,
): Array<{ id: string; label: string }> {
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((action: PermissionAction) =>
    typeof action.id === "string" &&
    action.id &&
    typeof action.label === "string" &&
    action.label
      ? [{ id: action.id, label: action.label }]
      : [],
  );
}

function projectExitPlanActions(
  actions: unknown,
): Array<{ id: string; label: string }> {
  if (!Array.isArray(actions)) return [];
  const required = [
    { id: "reject", behavior: "deny" },
    { id: "implement", behavior: "allow" },
  ];
  return required.flatMap((expected) => {
    const matches = actions.filter(
      (candidate: PermissionAction) => candidate?.id === expected.id,
    );
    if (matches.length !== 1) return [];
    const action = matches[0];
    if (action.behavior !== expected.behavior) return [];
    return typeof action?.label === "string" && action.label
      ? [{ id: expected.id, label: action.label }]
      : [];
  });
}

function projectPrompts(input: unknown, codex = false): RoomQuestionPrompt[] {
  if (
    !input ||
    typeof input !== "object" ||
    !Array.isArray((input as { questions?: unknown }).questions)
  )
    return [];
  return (input as { questions: unknown[] }).questions.flatMap(
    (value): RoomQuestionPrompt[] => {
      const prompt = value as QuestionPrompt;
      if (
        !prompt ||
        typeof prompt.question !== "string" ||
        !prompt.question ||
        typeof prompt.header !== "string" ||
        !prompt.header ||
        !Array.isArray(prompt.options)
      )
        return [];
      const options = prompt.options.flatMap((option: QuestionOption) =>
        typeof option?.label === "string" && option.label
          ? [
              {
                label: option.label,
                description:
                  typeof option.description === "string"
                    ? option.description
                    : null,
              },
            ]
          : [],
      );
      if (!options.length && !codex) return [];
      return [
        {
          question: prompt.question,
          header: prompt.header,
          options,
          multiSelect: prompt.multiSelect === true,
          // Claude always supplies Other; Codex marks it with isOther and
          // also supports text-only prompts with no options.
          allowOther: !codex || prompt.isOther === true || !options.length,
        },
      ];
    },
  );
}

/** Project exactly the safe, collaborator-answerable part of a Paseo request. */
export function projectRoomQuestion(
  request: PermissionRequest,
): RoomQuestion | null {
  if (typeof request.id !== "string" || !request.id) return null;
  if (request.kind === "plan" && request.name === "ExitPlanMode") {
    const plan =
      request.input && typeof request.input === "object"
        ? (request.input as { plan?: unknown }).plan
        : null;
    const actions = projectExitPlanActions(request.actions);
    if (typeof plan !== "string" || !plan.trim() || actions.length !== 2)
      return null;
    return {
      id: request.id,
      kind: "plan",
      title: "Plan",
      description: null,
      actions,
      prompts: [],
      plan,
    };
  }
  if (request.kind !== "question") return null;
  const actions = projectActions(request.actions);
  const prompts =
    request.name === "AskUserQuestion" || request.name === "request_user_input"
      ? projectPrompts(request.input, request.name === "request_user_input")
      : [];
  return {
    id: request.id,
    kind: "question",
    title: typeof request.title === "string" ? request.title : null,
    description:
      typeof request.description === "string" ? request.description : null,
    actions,
    prompts,
    plan: null,
  };
}

export function canAnswerRoomQuestion(
  request: PermissionRequest,
  actionId: unknown,
): boolean {
  return Boolean(
    projectRoomQuestion(request)?.actions.some(
      (action) => action.id === actionId,
    ),
  );
}

export function roomQuestionActionBehavior(
  request: PermissionRequest,
  actionId: unknown,
): "allow" | "deny" | null {
  if (
    !canAnswerRoomQuestion(request, actionId) ||
    !Array.isArray(request.actions)
  )
    return null;
  const action = request.actions.find(
    (candidate: PermissionAction) => candidate.id === actionId,
  );
  return action?.behavior === "deny"
    ? "deny"
    : action?.behavior === "allow"
      ? "allow"
      : null;
}

/**
 * Rebuild the provider's question answer shape from a compact
 * collaborator submission. The original tool input stays server-side.
 */
export function buildRoomQuestionUpdatedInput(
  request: PermissionRequest,
  response: unknown,
): Record<string, unknown> | null {
  if (
    request.kind !== "question" ||
    (request.name !== "AskUserQuestion" &&
      request.name !== "request_user_input")
  )
    return null;
  const codex = request.name === "request_user_input";
  const prompts = projectPrompts(request.input, codex);
  if (!prompts.length || !response || typeof response !== "object") return null;
  const answers = (response as Partial<RoomQuestionResponse>).answers;
  if (!Array.isArray(answers) || answers.length !== prompts.length) return null;

  const answerMap: Record<string, string> = {};
  for (let index = 0; index < prompts.length; index++) {
    const prompt = prompts[index];
    const answer = answers.find(
      (candidate) => candidate?.questionIndex === index,
    );
    if (
      !answer ||
      !Array.isArray(answer.optionLabels) ||
      !answer.optionLabels.every((label) => typeof label === "string")
    )
      return null;
    const optionLabels = [...new Set(answer.optionLabels)];
    const known = new Set(prompt.options.map((option) => option.label));
    if (!optionLabels.every((label) => known.has(label))) return null;
    const other = typeof answer.other === "string" ? answer.other.trim() : "";
    if (
      (!prompt.multiSelect && optionLabels.length > 1) ||
      (other && !prompt.allowOther) ||
      (!optionLabels.length && !other)
    )
      return null;
    // Paseo's Codex adapter looks up answers by header, Claude by full text.
    answerMap[codex ? prompt.header : prompt.question] = [
      ...optionLabels,
      ...(other ? [other] : []),
    ].join(", ");
  }

  if (
    !request.input ||
    typeof request.input !== "object" ||
    Array.isArray(request.input)
  )
    return null;
  return { ...(request.input as Record<string, unknown>), answers: answerMap };
}
