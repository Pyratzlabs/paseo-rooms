// Normalized permission shapes audited against @getpaseo/server 0.7.2.
// Keep these synthetic: daemon metadata and original inputs never go to clients.
export const providerQuestions = [
  {
    provider: "opencode",
    name: "question",
    multiSelect: true,
    allowOther: true,
  },
  { provider: "pi", name: "Pi select" },
  { provider: "pi", name: "Pi confirm", options: ["Yes", "No"] },
  { provider: "pi", name: "Pi input", options: [] },
  { provider: "pi", name: "Pi editor", options: [], multiline: true },
  { provider: "omp", name: "OMP select" },
  { provider: "omp", name: "OMP confirm", options: ["Yes", "No"] },
  { provider: "omp", name: "OMP input", options: [] },
  { provider: "omp", name: "OMP editor", options: [], multiline: true },
  { provider: "custom-provider", name: "ask_question", allowOther: true },
].map(
  ({ provider, name, options = ["Alpha", "Beta"], multiline, ...flags }) => ({
    id: `${provider}-${name}`,
    provider,
    name,
    kind: "question",
    title: "Question",
    input: {
      questions: [
        {
          question: "What should we do next?",
          header: "Response",
          options: options.map((label) => ({ label })),
          ...flags,
        },
      ],
      private: "must stay server-side",
    },
    metadata: {
      ...(multiline ? { extensionUiMethod: "editor" } : {}),
      private: "must stay server-side",
    },
  }),
);

export const optionalCommentQuestion = {
  id: "pi-ask-user",
  provider: "pi",
  kind: "question",
  name: "Pi ask_user",
  input: {
    questions: [
      {
        question: "Pick a direction",
        header: "Response",
        options: [{ label: "Alpha" }, { label: "Beta" }],
        allowOther: true,
      },
      {
        question: "Optional comment",
        header: "Comment",
        options: [],
        allowEmpty: true,
        placeholder: "Optional comment (press Enter to skip)...",
      },
    ],
  },
};

export const codexPlan = {
  id: "codex-plan",
  provider: "codex",
  kind: "plan",
  name: "CodexPlanApproval",
  input: { plan: "# Proposed plan\n\nImplement the selected direction." },
  actions: [
    { id: "dismiss", label: "Dismiss", behavior: "deny" },
    { id: "implement", label: "Implement", behavior: "allow" },
  ],
};
