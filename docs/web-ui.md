# Shared room web UI — draft

## Purpose

Give a collaborator a calm, capable way to follow and contribute to one Paseo
agent session from any modern browser, especially a phone. The room is a
capability-scoped view of an agent: it is not a replacement Paseo client and
must never reveal daemon credentials, agent IDs, workspace paths, or unrelated
Paseo state.

## First-release outcome

A person opening a valid room link can understand what the agent is doing,
read the relevant conversation comfortably, answer an agent's scoped question,
send an attributed message, and trust the connection state. The experience
should feel like a focused shared conversation rather than a debug event feed.

## Users and permissions

| Person | Can do | Cannot do |
| --- | --- | --- |
| Host | Creates/revokes a room locally; approves Paseo permissions in Paseo | Delegate daemon access through the room |
| Collaborator | Read the room timeline; send attributed messages | Choose an agent, approve permissions, browse the daemon, create/revoke rooms |
| Agent | Receives messages on its canonical Paseo timeline | Learn a browser's identity beyond the supplied display name |

The URL is a bearer capability. The UI should say this plainly in a compact
room-information affordance, without making the page feel alarming.

## Information hierarchy

1. **Conversation** — human messages and assistant output are primary.
2. **Work in progress** — a small persistent indicator when the agent is
   running; streaming text remains in the conversation.
3. **Work detail** — tool calls, todo updates, reasoning, and failures are
   available inline but visually quieter and collapsible when long.
4. **Room status** — connection/reconnection, send errors, rate limiting, and
   host-only permission notices are clear but do not displace the conversation.

## Timeline presentation

| Paseo item/event | First-release presentation |
| --- | --- |
| `user_message` | Right-aligned message card with a participant name. Preserve the existing `[Name]` convention, but never show the prefix as message body. |
| `assistant_message` | Left-aligned Markdown message card. Consecutive live pieces append to one open card. |
| `reasoning` | Collapsed "Thinking" disclosure by default; show plain text when expanded. |
| `tool_call` | Compact, collapsible activity row: tool name, outcome/status, and elapsed/updated state where available. Do not dump raw tool input/output by default. |
| `todo` | Compact checklist card, replacing the previous checklist state rather than creating visual noise. |
| `turn_started` / terminal turn events | One working indicator; failure/cancellation adds a concise timeline notice. |
| `permission_requested`, `kind: "question"` | First-class decision card with the safe action labels supplied by Paseo. A collaborator can select exactly one. |
| other `permission_requested` kinds | Prominent non-actionable notice: "The host must respond in Paseo." |
| unknown future item | Safe, quiet generic activity row; never fail the whole renderer. |

Markdown must be rendered from a safe, allowlisted subset. Raw HTML, script
URLs, and untrusted link schemes are never rendered. External links open in a
new tab with `noopener noreferrer`.

## Agent questions and plan-mode decisions

Paseo models an interactive question as a structured pending permission request
with `kind: "question"`, a request ID, optional title/description, and a
whitelisted set of actions. It is not reliable to infer choices from Markdown
bullets. A room must therefore render this protocol data as a **decision card**
rather than attempting to parse assistant prose.

- Show the agent's title/description and the supplied action labels; do not
  expose arbitrary `input`, `detail`, or metadata fields.
- A decision is disabled after one submission and resolves in the timeline as
  answered, superseded, or unavailable.
- On reconnect or page load, show still-pending questions from the
  authoritative agent snapshot, not just socket events seen by this browser.
- If another client answers first, reconcile to the resolved state without
  treating it as an error.
- Preserve a conventional free-text composer as the fallback for ordinary
  textual questions.

### Authority boundary

Only `kind: "question"` is eligible for a collaborator answer in the first
release. `tool`, `plan`, `mode`, and `other` requests remain host-only in
Paseo. In particular, a plan-execution approval can imply permission to make
changes on the host machine; a room capability must not silently become a
machine-control capability.

The server must resolve a question only after all of these checks:

1. The room token maps to the agent that owns the pending request.
2. The request is still pending and its kind is exactly `question`.
3. The submitted action ID occurs in that request's current action set.
4. The response is an allow response with that selected action ID; the browser
   cannot supply arbitrary permissions, metadata, or a different agent ID.

The browser receives a small question DTO, not raw Paseo permission objects.
The endpoint needs an idempotency/concurrency policy: the first successful
resolution wins; a stale second answer returns a harmless conflict/resolved
state and the UI re-syncs.

## Composer

- Sticky at the bottom of the viewport, including on mobile keyboards.
- Display name is stored locally in the browser and editable from the composer.
- A message is sent only once; the UI waits for the authoritative timeline
  event rather than creating a local duplicate.
- Disable while a request is in flight, then restore focus on failure.
- Show specific, recoverable errors for offline/reconnecting, rate limit,
  invalid room, and server failure.
- `Enter` sends on desktop; `Shift+Enter` inserts a newline. Mobile uses the
  native multiline keyboard affordance.

## Connection and synchronization contract

The timeline fetch is authoritative; the socket makes it immediate.

1. Load room metadata and history.
2. Open the room WebSocket.
3. Re-fetch history after the socket opens to cover the join race.
4. Append live events, coalescing assistant stream pieces.
5. On disconnect, preserve rendered history, show reconnecting state, and
   retry with bounded backoff.
6. After reconnect, re-fetch history and reconcile rather than assuming every
   event arrived.

The UI model must give every fetched or streamed item a stable semantic key
when the protocol supplies one. Until then, reconciliation may replace the
visible history with the authoritative projection, while retaining scroll
position whenever the reader is not at the bottom.

## Responsive layout

- **Mobile (< 700px):** one-column conversation; header is one compact row;
  composer controls remain finger-sized; tool/reasoning cards use full width.
- **Desktop:** centered readable conversation column (about 720px), with a
  small optional room-details area rather than a permanent sidebar.
- Respect light/dark system preference and retain a high-contrast readable
  default. Avoid a theme switcher in the first release.
- Auto-scroll only when the reader was already close to the bottom. Provide a
  "new messages" affordance otherwise.

## Visual language — Paseo-aligned

The room should feel recognizably at home beside Paseo without impersonating
the full desktop application. Adopt its quiet, information-dense visual grammar:
neutral surfaces, one restrained green accent, fine dividers, compact utility
text, and visual emphasis earned by content rather than decoration.

### Tokens

Use this as the initial CSS token set, derived from Paseo's default themes.
It is deliberately semantic so future tuning does not require repainting every
component.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--surface-0` | `#ffffff` | `#181B1A` | page and primary conversation canvas |
| `--surface-1` | `#fafafa` | `#1E2120` | subtle raised/hover surface |
| `--surface-2` | `#f4f4f5` | `#272A29` | input and quiet cards |
| `--surface-sidebar` | `#f4f4f5` | `#141716` | optional room-details rail only |
| `--text` | `#1a1a1e` | `#fafafa` | primary prose |
| `--text-muted` | `#71717a` | `#A1A5A4` | metadata and inactive utility text |
| `--text-extra-muted` | `#a1a1aa` | `#717574` | timestamps and de-emphasized detail |
| `--border` | `#e4e4e7` | `#252B2A` | dividers and input edges |
| `--accent` | `#20744A` | `#20744A` | selected/affirmative interaction |
| `--accent-bright` | `#239956` | `#7ccba0` | hover/focus and live emphasis |
| `--danger` | `#b04138` | `#c64f43` | destructive/failure state only |

Use the system UI stack (`system-ui, -apple-system, BlinkMacSystemFont,
"Segoe UI", Roboto, Helvetica, Arial, sans-serif`) and a conventional
monospace stack for code. The base reading size is 15px; compact metadata is
12px; standard UI labels are 14px. The rhythm is a 4px grid: 4, 8, 12, 16, 24,
32. Border radii remain small: 4px controls, 6–8px cards, 12px only for large
grouped surfaces. Shadows are exceptional—use borders and surface steps first.

### Composition

- Keep the conversation on an uncluttered `surface-0` canvas with a readable
  max width. The screenshot's broad whitespace is intentional: it supports
  long-form agent output better than a chat-app bubble wall.
- Human messages can use a quiet `surface-2` rounded block; assistant content
  should normally sit directly on the canvas, with a card only where grouping
  or an interaction requires it.
- Tool activity, reasoning, and todos use a 1px left rule or a low-contrast
  `surface-1` row—not bright cards competing with conversation.
- Decision cards use the accent only for the selected/primary action. Their
  other actions are bordered neutral controls, matching Paseo's restrained
  control hierarchy.
- A tiny status dot and muted label communicate live/reconnecting state; avoid
  a large colored banner except for an actionable failure.
- Motion is short and functional: gentle disclosure expansion and a restrained
  live cursor/working indicator. No animated gradients, glass effects, or
  decorative chat bubbles.

The public room should default to the system light/dark preference. A later
preference may expose Paseo-compatible tint choices, but the first release
ships only the default Paseo green-tinted dark and neutral light themes.

## Implementation direction

Keep the public relay contract unchanged: collaborator traffic can only reach
`/r/<token>` and `/api/rooms/<token>/...`. The room must therefore remain
self-contained or ship an explicitly relay-routable static asset path; the
first implementation should preserve the current self-contained room document
to avoid widening the public surface while the UI is being stabilized.

Separate the frontend into testable layers even if it is bundled into one HTML
file:

1. API/socket transport and reconnect state.
2. Timeline normalization and reconciliation.
3. Rendering primitives (message, Markdown, activity, todo, status).
4. Page layout and composer interaction.

Adopt a component framework only if it materially improves this separation;
the framework must not force the relay to expose unrestricted asset routes.

## Explicit non-goals for the first release

- Participant authentication, profiles, presence, or typing indicators.
- Permission approval from the room.
- File browsing, terminal access, or workspace metadata.
- Full fidelity rendering of every provider-specific tool payload.
- Editing/deleting messages or room administration from the share URL.
- A complete copy of the Paseo desktop interface.

## Delivery slices and acceptance criteria

### Slice A — interaction foundation

- Introduce the normalized timeline model and reconnect/reconciliation logic.
- Preserve all current room behavior and security invariants.
- Add automated coverage for history + live ordering, streaming coalescence,
  reconnect re-sync, and error states.
- Add the server-side pending-question projection and scoped question-response
  endpoint, with tests proving that tool/plan/mode requests cannot be resolved
  from a room URL.

### Slice B — readable conversation

- Deliver polished responsive message cards, safe Markdown, working state,
  unread affordance, question decision cards, and the improved composer.
- Verify real room behavior at narrow phone and desktop viewports.

### Slice C — agent-work details

- Add collapsible reasoning, tool, todo, permission, and terminal-turn cards.
- Ensure a noisy tool-heavy session remains easy to scan.

### Slice D — refinement

- Empty/loading/invalid/revoked states, accessibility pass, motion restraint,
  and visual regression coverage.

## Decisions to make before Slice B

1. Visual character: **Paseo-aligned calm utilitarian** (recommended and
   specified above), or a distinct "shared room" identity?
2. Reasoning visibility: collapsed by default (recommended) or always visible?
3. Tool activity: names/status only (recommended) or selected details exposed
   to collaborators?
4. Should the host have a visibly distinct author treatment from collaborators?
