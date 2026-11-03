# Shared-room question support audit

Re-audited on 2026-11-02 against the published `@getpaseo/server` **0.14.0** package and Rooms' upgraded client/protocol/plugin/relay dependencies **0.14.0**. The initial pass mistakenly used the old global CLI's 0.7.2 source; the desktop-managed daemon was actually 0.12.0. This report reflects the corrected 0.14.0 audit, with older compatibility forms marked separately. Paseo distinguishes native adapters and ACP adapters ([provider overview](https://paseo.sh/docs/providers)).

## Support matrix

“Before” means before this investigation. “After” includes the initial Codex fix and this follow-up. All supported rows cover both room snapshots and live events, and both plaintext and encrypted transports.

| Provider / request                                           | Paseo shape                                                                  | Before                            | After                                                   |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| Claude `AskUserQuestion`                                     | `kind: question`, `input.questions`; single/multiple choice and Other        | Supported                         | Supported; strict validation retained                   |
| Codex `request_user_input`                                   | Same structured prompts; `isOther`, optional `isSecret`, text-only prompts   | Blank question card               | Supported by the initial fix; secret inputs now masked  |
| Codex `request_user_input_async`                             | Async agent messages become pending prompts with generated headers and Other | Blank card                        | Supported; answers checked with the actual 0.14 adapter |
| OpenCode `question`                                          | Same prompts; `multiple` normalized to `multiSelect`, `allowOther: true`     | Blank question card               | Supported                                               |
| Pi / OMP `select`                                            | Structured choice under a provider-specific request name                     | Blank question card               | Supported                                               |
| Pi / OMP `confirm`                                           | Yes/No choice under a provider-specific request name                         | Blank question card               | Supported                                               |
| Pi / OMP `input`                                             | Text-only prompt, sometimes `allowEmpty`, `placeholder`, `dismissLabel`      | Blank question card               | Supported, including empty optional submissions / Skip  |
| Pi / OMP `editor`                                            | Text-only prompt; `metadata.extensionUiMethod: editor`                       | Blank question card               | Supported with a multiline control                      |
| Pi `ask_user_question`                                       | Extension maps tool questions to normalized prompts with Other               | Blank card                        | Supported                                               |
| OMP `ask`                                                    | Choice, multi-select and Other with adapter-managed callbacks                | Blank card                        | Supported; multi-step response sequence checked         |
| Muse user input                                              | Tool name varies; normalized selection mode and optional allowEmpty          | Blank card                        | Supported                                               |
| Older Pi / OMP combined `ask_user` compatibility form        | Choice/Other followed by an optional comment                                 | Blank question card               | Supported; the optional comment can remain empty        |
| Custom / plugin providers using the shared question contract | `kind: question`, `input.questions`                                          | Only recognized tool names worked | Supported independently of provider ID or tool name     |
| Explicit question actions                                    | `kind: question`, labeled `actions`                                          | Supported                         | Supported                                               |
| Claude `ExitPlanMode`                                        | `kind: plan`, plan text; `reject` and `implement`                            | Supported                         | Supported                                               |
| Codex `CodexPlanApproval`                                    | `kind: plan`, plan text; `dismiss` and `implement`                           | Hidden                            | Supported                                               |
| Questions asked in ordinary assistant prose                  | Timeline text, answered through the message composer                         | Supported                         | Supported                                               |

## Response contracts

Rooms re-reads the pending daemon request before accepting an answer. It sends only validated selections and text, preserving the original input exclusively on the host.

- Claude receives answers keyed by full question text. Its installed normalizer also accepts headers, but Rooms preserves the existing full-text behavior.
- Codex, OpenCode, Pi, OMP and the shared question form contract receive answers keyed by header. Codex maps those headers to its internal question IDs.
- Multi-select answers use comma-separated labels, matching Paseo's own shared form. Codex, OpenCode and Muse split these strings downstream; labels or free text containing commas therefore retain the upstream format's ambiguity. OMP 0.14 uses its `splitMultiSelectAnswer` helper to preserve exact known labels.
- Empty answers are accepted only for prompts marked `allowEmpty`. Free text is available for text-only prompts or an explicit Other path; Claude supplies Other implicitly.
- Pi/OMP editor input retains internal newlines. Text is trimmed at submission, matching the existing shared form behavior.
- Invalid prompts/options reject the entire structured form rather than silently dropping a question. Duplicate or unsafe answer keys and invalid selections are rejected. Unrecognized question formats show an explicit instruction to answer in Paseo instead of a blank card.

## Host-only cases and upstream limits

The installed ACP adapter is shared by Cursor, Copilot, Kimi, Kiro, Trae and generic/custom ACP agents. It maps `session/request_permission` to `kind: tool` (or `mode`), even when repeated allow-option kinds identify a chooser in the native UI. It forwards an exact selected option ID. It does not expose a normalized `kind: question` payload. These dialogs remain host-only because Rooms cannot distinguish a user question from an ordinary tool approval through the permission kind. A provider that emits normalized questions is supported by the generic path above.

Codex MCP elicitation is also an upstream tool approval (`CodexMcpElicitation`), not a question form. The installed adapter automatically declines URL elicitation and schemas with required fields; optional-schema approvals remain host-only. Rooms cannot add schema-form support without a corresponding upstream adapter capability.

Other tool, mode, and unknown permission kinds stay host-only. Plan actions that restore bypass-permissions mode (`implement_resume`) are not exposed; ordinary Implement remains available. Arbitrary plugin-specific forms, OAuth dialogs, and interactive terminal prompts have no general normalized form contract in this audit.

The bundled Antigravity provider in this published package does not emit normalized question permission events. Rooms renders its ordinary timeline output; it cannot create a structured answer capability that the adapter does not expose. OMP's own multi-question/multi-select RPC flow also documents a limit: when OMP omits its Done option, the right-arrow navigation callback cannot be expressed by the RPC response, so the adapter cancels that sequence. These are upstream limits.

## Evidence and validation

Inspected published `@getpaseo/server` 0.14.0 implementations under `dist/server/server/agent/`:

- `providers/claude/agent.js`: request normalization and full-text answer normalization.
- `providers/codex-app-server-agent.js` and `providers/codex/async-questions.js`: synchronous/asynchronous questions, header-to-ID responses, plan actions and MCP elicitation handling.
- `providers/opencode-agent.js`: question event projection and header-based replies.
- `providers/pi/agent.js`, `providers/pi/extensions/rpiv-ask-user-question/index.js`, and `providers/omp/question-ui.js`: select/input/editor/confirm mapping, structured ask tools and multi-step responses.
- `providers/acp-agent.js`: permission-kind classification, chooser detection and exact option-ID responses; specialized ACP adapters inherit this path.
- `provider-registry.js`: native and ACP adapter factories, including derived providers.
- Bundled `muse-provider/server/questions.ts` and `wire.ts`: normalized user-input requests and header-keyed answer delivery.
- Bundled `antigravity-provider/server/`: streaming provider surface without normalized question requests.
- The original 0.7.2 web UI's shared form parser established the common `allowOther` / `isOther`, `allowEmpty`, placeholder, dismiss-label and header-keyed answer contract; the 0.14 adapters above confirm continued use of these fields.

Synthetic provider fixtures are in `apps/relay-web/scripts/fixtures/provider-questions.ts`. Regression tests cover projection, answer construction, UI rendering, live-event redaction and encrypted snapshot/submission handling. Run `npm run test:questions`, `npm run test:public-events`, and `npm run test:e2ee`.

Browser QA uses synthetic API/WebSocket fixtures, not paid live agents. At 1440×1000 and 390×844, selection, multi-select, free text, multiline editors, empty optional comments, Skip, masked input, and plan approval were exercised. Screenshots were inspected for layout issues. Live-provider end-to-end calls were not performed.

The initial Codex gap is confirmed by source and a failing reproducer. This audit does not establish when it was introduced or explain why a prior Codex session appeared to work.

## Upgrade verification

The repository pins Paseo SDK/plugin/relay packages to 0.14.0. The plugin uses separate client/server entries and declares `requirements.paseo: >=0.14.0 <0.15.0`; the native 0.14 compiler and evaluator accepted the generated modules and registered all server RPC handlers. Timeline replacement, subscription-restored and error controls trigger room reconnection so guests reload a fresh snapshot after history gaps.

The official 0.14 `CodexAsyncQuestions` and `OmpQuestionUi` classes were exercised with Rooms-produced answers; async responses and the multi-step OMP selection sequence completed correctly. This verification did not invoke paid live agents.
