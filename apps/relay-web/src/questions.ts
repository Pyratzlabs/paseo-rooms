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
  allowEmpty?: boolean;
  placeholder?: string;
  dismissLabel?: string;
  isSecret?: boolean;
  multiline?: boolean;
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
interface QuestionPrompt {
  question?: unknown;
  header?: unknown;
  options?: unknown;
  multiSelect?: unknown;
  isOther?: unknown;
  allowOther?: unknown;
  allowEmpty?: unknown;
  placeholder?: unknown;
  dismissLabel?: unknown;
  isSecret?: unknown;
}
interface PermissionRequest {
  id?: unknown;
  kind?: unknown;
  name?: unknown;
  title?: unknown;
  description?: unknown;
  input?: unknown;
  actions?: unknown;
  metadata?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function projectActions(
  actions: unknown,
): Array<{ id: string; label: string }> {
  if (!Array.isArray(actions)) return [];
  return actions.flatMap((action: PermissionAction) =>
    isRecord(action) &&
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
  dismissId: "reject" | "dismiss",
): Array<{ id: string; label: string }> {
  if (!Array.isArray(actions)) return [];
  const required = [
    { id: dismissId, behavior: "deny" },
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

function projectPrompts(request: PermissionRequest): RoomQuestionPrompt[] {
  const input = request.input;
  if (!isRecord(input) || !Array.isArray(input.questions)) return [];
  const prompts: RoomQuestionPrompt[] = [];
  for (const value of input.questions) {
    const prompt = value as QuestionPrompt;
    if (
      !isRecord(prompt) ||
      typeof prompt.question !== "string" ||
      !prompt.question ||
      typeof prompt.header !== "string" ||
      !prompt.header ||
      (prompt.options !== undefined && !Array.isArray(prompt.options))
    )
      return [];
    const rawOptions = (prompt.options ?? []) as unknown[];
    const options = rawOptions.flatMap((option) =>
      isRecord(option) && typeof option.label === "string" && option.label
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
    // Never drop a broken prompt/option and then answer the remaining subset.
    if (options.length !== rawOptions.length) return [];
    prompts.push({
      question: prompt.question,
      header: prompt.header,
      options,
      multiSelect: prompt.multiSelect === true,
      allowOther:
        request.name === "AskUserQuestion" ||
        prompt.allowOther === true ||
        prompt.isOther === true ||
        !options.length,
      ...(prompt.allowEmpty === true ? { allowEmpty: true } : {}),
      ...(typeof prompt.placeholder === "string"
        ? { placeholder: prompt.placeholder }
        : {}),
      ...(typeof prompt.dismissLabel === "string"
        ? { dismissLabel: prompt.dismissLabel }
        : {}),
      ...(prompt.isSecret === true ? { isSecret: true } : {}),
      ...(isRecord(request.metadata) &&
      request.metadata.extensionUiMethod === "editor"
        ? { multiline: true }
        : {}),
    });
  }
  return prompts;
}

/** Project exactly the safe, collaborator-answerable part of a Paseo request. */
export function projectRoomQuestion(
  request: PermissionRequest,
): RoomQuestion | null {
  if (typeof request.id !== "string" || !request.id) return null;
  if (
    request.kind === "plan" &&
    (request.name === "ExitPlanMode" || request.name === "CodexPlanApproval")
  ) {
    const plan =
      request.input && typeof request.input === "object"
        ? (request.input as { plan?: unknown }).plan
        : null;
    const actions = projectExitPlanActions(
      request.actions,
      request.name === "CodexPlanApproval" ? "dismiss" : "reject",
    );
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
  const prompts = projectPrompts(request);
  const description =
    typeof request.description === "string" ? request.description : null;
  return {
    id: request.id,
    kind: "question",
    title: typeof request.title === "string" ? request.title : null,
    description:
      !prompts.length && !actions.length
        ? [
            description,
            "Please answer this question in Paseo; this format is not supported in shared rooms yet.",
          ]
            .filter(Boolean)
            .join("\n\n")
        : description,
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
    (candidate: PermissionAction) => candidate?.id === actionId,
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
  if (request.kind !== "question") return null;
  const prompts = projectPrompts(request);
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
      !Number.isSafeInteger(answer.questionIndex) ||
      !Array.isArray(answer.optionLabels) ||
      !answer.optionLabels.every((label) => typeof label === "string") ||
      (answer.other !== undefined && typeof answer.other !== "string")
    )
      return null;
    const optionLabels = [...new Set(answer.optionLabels)];
    const known = new Set(prompt.options.map((option) => option.label));
    if (!optionLabels.every((label) => known.has(label))) return null;
    const other = typeof answer.other === "string" ? answer.other.trim() : "";
    if (
      (!prompt.multiSelect && optionLabels.length > 1) ||
      (!prompt.multiSelect && optionLabels.length > 0 && other) ||
      (other && !prompt.allowOther) ||
      (!optionLabels.length && !other && !prompt.allowEmpty)
    )
      return null;
    // Shared provider contract uses headers. Claude's tool also accepts full text.
    const key =
      request.name === "AskUserQuestion" ? prompt.question : prompt.header;
    if (
      ["__proto__", "constructor", "prototype"].includes(key) ||
      Object.hasOwn(answerMap, key)
    )
      return null;
    answerMap[key] = [...optionLabels, ...(other ? [other] : [])].join(", ");
  }

  if (
    !request.input ||
    typeof request.input !== "object" ||
    Array.isArray(request.input)
  )
    return null;
  return { ...(request.input as Record<string, unknown>), answers: answerMap };
}
