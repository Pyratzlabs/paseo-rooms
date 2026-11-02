# Shared-room question support audit

Audited on 2026-11-02 against the locally installed `@getpaseo/server` 0.7.2 and the Rooms client/protocol dependency 0.7.2. This is an audit of that installed API, not a claim that every newer Paseo release or third-party plugin has the same payloads. Paseo distinguishes native adapters and ACP adapters ([provider overview](https://paseo.sh/docs/providers)).

## Support matrix

“Before” means before this investigation. “After” includes the initial Codex fix and this follow-up. All supported rows cover both room snapshots and live events, and both plaintext and encrypted transports.

| Provider / request                                           | Paseo shape                                                                | Before                            | After                                                  |
| ------------------------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------ |
| Claude `AskUserQuestion`                                     | `kind: question`, `input.questions`; single/multiple choice and Other      | Supported                         | Supported; strict validation retained                  |
| Codex `request_user_input`                                   | Same structured prompts; `isOther`, optional `isSecret`, text-only prompts | Blank question card               | Supported by the initial fix; secret inputs now masked |
| OpenCode `question`                                          | Same prompts; `multiple` normalized to `multiSelect`, `allowOther: true`   | Blank question card               | Supported                                              |
| Pi / OMP `select`                                            | Structured choice under a provider-specific request name                   | Blank question card               | Supported                                              |
| Pi / OMP `confirm`                                           | Yes/No choice under a provider-specific request name                       | Blank question card               | Supported                                              |
| Pi / OMP `input`                                             | Text-only prompt, sometimes `allowEmpty`, `placeholder`, `dismissLabel`    | Blank question card               | Supported, including empty optional submissions / Skip |
| Pi / OMP `editor`                                            | Text-only prompt; `metadata.extensionUiMethod: editor`                     | Blank question card               | Supported with a multiline control                     |
| Pi / OMP combined `ask_user`                                 | Choice/Other followed by an optional comment                               | Blank question card               | Supported; the optional comment can remain empty       |
| Custom / plugin providers using the shared question contract | `kind: question`, `input.questions`                                        | Only recognized tool names worked | Supported independently of provider ID or tool name    |
| Explicit question actions                                    | `kind: question`, labeled `actions`                                        | Supported                         | Supported                                              |
| Claude `ExitPlanMode`                                        | `kind: plan`, plan text; `reject` and `implement`                          | Supported                         | Supported                                              |
| Codex `CodexPlanApproval`                                    | `kind: plan`, plan text; `dismiss` and `implement`                         | Hidden                            | Supported                                              |
| Questions asked in ordinary assistant prose                  | Timeline text, answered through the message composer                       | Supported                         | Supported                                              |

## Response contracts

Rooms re-reads the pending daemon request before accepting an answer. It sends only validated selections and text, preserving the original input exclusively on the host.

- Claude receives answers keyed by full question text. Its installed normalizer also accepts headers, but Rooms preserves the existing full-text behavior.
- Codex, OpenCode, Pi, OMP and the shared question form contract receive answers keyed by header. Codex maps those headers to its internal question IDs.
- Multi-select answers use comma-separated labels, matching Paseo's own shared form. Codex and OpenCode split these strings downstream; labels or free text containing commas therefore retain the upstream format's ambiguity.
- Empty answers are accepted only for prompts marked `allowEmpty`. Free text is available for text-only prompts or an explicit Other path; Claude supplies Other implicitly.
- Pi/OMP editor input retains internal newlines. Text is trimmed at submission, matching the existing shared form behavior.
- Invalid prompts/options reject the entire structured form rather than silently dropping a question. Duplicate or unsafe answer keys and invalid selections are rejected. Unrecognized question formats show an explicit instruction to answer in Paseo instead of a blank card.

## Host-only cases and upstream limits

The installed ACP adapter is shared by Cursor, Copilot, Kimi, Kiro, Trae and generic/custom ACP agents. It maps `session/request_permission` to `kind: tool` (or `mode`), even when repeated allow-option kinds identify a chooser in the native UI. It forwards an exact selected option ID. It does not expose a normalized `kind: question` payload. These dialogs remain host-only because Rooms cannot distinguish a user question from an ordinary tool approval through the permission kind. A provider that emits normalized questions is supported by the generic path above.

Codex MCP elicitation is also an upstream tool approval (`CodexMcpElicitation`), not a question form. The installed adapter automatically declines URL elicitation and schemas with required fields; optional-schema approvals remain host-only. Rooms cannot add schema-form support without a corresponding upstream adapter capability.

Other tool, mode, and unknown permission kinds stay host-only. Plan actions that restore bypass-permissions mode (`implement_resume`) are not exposed; ordinary Implement remains available. Arbitrary plugin-specific forms, OAuth dialogs, and interactive terminal prompts have no general normalized form contract in this audit.

## Evidence and validation

Inspected installed `@getpaseo/server` implementations under `dist/server/server/agent/`:

- `providers/claude/agent.js`: request normalization and full-text answer normalization.
- `providers/codex-app-server-agent.js`: question normalization, header-to-ID responses, plan actions and MCP elicitation handling.
- `providers/opencode-agent.js`: question event projection and header-based replies.
- `providers/pi/agent.js` and `providers/omp/agent.js`: select/input/editor/confirm mapping, combined ask-user flow, optional comment handling and responses.
- `providers/acp-agent.js`: permission-kind classification, chooser detection and exact option-ID responses; specialized ACP adapters inherit this path.
- `provider-registry.js`: native and ACP adapter factories, including derived providers.
- Installed web UI's shared question parser and form serializer: `allowOther` / `isOther`, `allowEmpty`, placeholders, dismiss labels and header-keyed answers.

Synthetic provider fixtures are in `apps/relay-web/scripts/fixtures/provider-questions.ts`. Regression tests cover projection, answer construction, UI rendering, live-event redaction and encrypted snapshot/submission handling. Run `npm run test:questions`, `npm run test:public-events`, and `npm run test:e2ee`.

Browser QA uses synthetic API/WebSocket fixtures, not paid live agents. At 1440×1000 and 390×844, selection, multi-select, free text, multiline editors, empty optional comments, Skip, masked input, and plan approval were exercised. Screenshots were inspected for layout issues. Live-provider end-to-end calls were not performed.

The initial Codex gap is confirmed by source and a failing reproducer. This audit does not establish when it was introduced or explain why a prior Codex session appeared to work.
