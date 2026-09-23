# Relay access implementation plan

Status: implemented locally, with verification evidence recorded below. Review verdicts and CI status are tracked in the merge request; hosted rollout is separate.

## Smallest complete slice

Implement one local vertical slice: explicit relay policy and capability endpoint; protected automatic v2 ownership; bounded admission/traffic; server-side discovery and remembered private credentials; default/advanced plugin workflow; tests and operator documentation. Keep production deployment keyed and untouched. Release publication, accounts, team membership, and persistent v2 room recovery are outside this slice. Existing secure rooms intentionally disappear when the local room server restarts (`rooms.ts`); do not accidentally promise persistent links while implementing persistent relay keys.

## Existing code and reuse

- `relay-target.ts` already validates/canonicalizes secure origins and loopback development origins. Reuse for credential scope and discovery; derive HTTPS from WSS without paths/query/userinfo.
- `relay/protocol.ts` already bounds single control frames (512 KiB), records (90 KiB wrapper, 64 KiB payload), registration batch (256); these are not cumulative route/socket limits.
- `rooms.ts` owns invitation secrets and ephemeral E2EE keypairs; add independent ownership material here and never expose it through `toPublicRoom`, URLs, RPCs, logs, or guest frames.
- `relay-client.ts` already reconnects with `currentRoutes`; extend rather than introducing a parallel client. It currently resolves connection readiness before registrations and only logs registration rejection: positive acknowledgement is necessary for reliable creation under new capacity/ownership checks.
- `relay-credentials.server.ts` already reads endpoint-matched dotenv credentials. Retain this migration fallback, normalizing `/host` legacy endpoints narrowly to an origin, without accepting arbitrary paths.
- `share.shared.ts` defines typed local RPCs; `share.server.ts` is trusted local server execution, and `server.ts` retains authenticated local admin endpoints. Keep this boundary.

## Wire contract and route ownership

Prefer independent per-route random 32-byte ownership secrets and self-authenticating route identifiers over a relay database or new signing-key challenge protocol. Compute SHA-256 of a fixed UTF-8 domain prefix plus the raw secret; never derive ownership from invitation or endpoint keys. Send the secret only over host TLS inside register frames. Relay validates the hash on each registration and does not persist the secret. Relay restart therefore cannot free a protected name for arbitrary claims. This is a bearer proof: a compromised relay can impersonate its routes; E2EE already treats relays as untrusted for plaintext, but the routing availability boundary is not protected against its own operator.

Compatibility decision: to enforce protection on new relays even in key mode, use a distinct protected route namespace, e.g. `o_` + 43-character canonical base64url digest. New relays accept old 43-character IDs only in key mode and never treat `o_...` as a legacy token, including under protocol 1. Open mode accepts only protected protocol 2 routes. Capability reports ownership support. Old relays enforce a 43-character v2 regex, so legacy key fallback must generate old-format routes when talking to those relays. Route generation needs an explicit protection option selected by discovered capability, not inference from whether a key exists. New relay key mode can support both old clients and protected new clients. If implementation instead keeps all route IDs at 43 characters, document that key mode must trust every key holder and cannot universally prevent proofless downgrade after restart; do not claim cross-host ownership guarantees in that mode.

Register extension: `{v:1,type:"register",tokens:[],routes:[{token,protocol:2,ownershipSecret}]}`. Secret must decode canonically to exactly 32 bytes. Positive response `{v:1,type:"registered",token}` and existing `{v:1,type:"register_rejected",token,reason?}`; bound reason to known enums. Capability declares registration ACK support. New protected creation waits for ACK with timeout, revokes locally and releases route on failure; legacy clients retain old readiness behavior only for explicit old-relay compatibility. ACK/reject waiters must reject on disconnect/close and reconnect must not revive pending creation after timeout. Repeated claim by same connection is idempotent; different live owner rejects even with valid secret; after disconnect/relay restart correct owner may claim again. Unregister still requires the owning connection. No reconnect takeover or indefinite leases are needed.

## Explicit policy and discovery

`RELAY_AUTH_MODE` defaults to `key`; only `open` and `key` accepted. Key mode requires nonempty `RELAY_KEY` before listening; open mode ignores global key requirement. Timing-safe key check. Keep policy validation inside `createRelay` too so tests/embedding cannot bypass fail-closed startup.

Unauthenticated `GET /.well-known/paseo-rooms` returns a small versioned shape such as `{version:1,registration:"open"|"key",roomProtocols:[2],routeOwnership:"sha256-secret-v1",registrationAck:true}`. Include legacy protocol only where supported. Discovery sends no key/cookie/authorization, refuses redirects, uses timeout and capped body size, checks status/JSON/schema/version. Failed auto discovery stays an error. Explicit `legacy-key` mode bypasses missing capability only through deliberate user selection. A custom open origin receives no key field and no saved key on host connect. Browser website selection has no authority over relay policy.

Avoid eager managed-server dialout as the sole policy mechanism. Room creation must resolve policy and selected credentials consistently, including configured default and custom origins; standalone server auto mode must also work. Keep mode/key compatibility checks for active relay clients and do not silently swap credentials underneath rooms.

## Credential storage and UI

Implement server-only adapter with read/save/forget keyed by canonical origin. For this slice a protected Unix file is pragmatic: dedicated directory mode 0700, JSON file mode 0600, current UID/regular-file validation, symlink refusal, exclusive temporary creation and atomic rename, serialized mutations, validate bounds/schema, errors that never include secret values. Tighten/check pre-existing parent/file permissions; do not claim `mode:0600` protects an existing permissive file. Cap stored origin count. Never use plugin settings/browser localStorage for keys. Test directory/file attacks and failed writes. Preserve existing environment/dotenv fallback and explicit precedence.

OS keychain integration is not available in this repository. Do not claim it is tested. On Windows, Unix modes do not enforce ACLs: either implement a platform credential/ACL adapter and verify it on Windows, or explicitly disable remember and show session-only input on unsupported platforms. This is an honest platform limitation, not secure cross-platform persistence. A forget operation should suppress old dotenv fallback for that origin (tombstone or equivalent), otherwise the forgotten key immediately reappears. Environment-managed keys may be non-removable; expose that fact without revealing them.

Add local RPCs to inspect relay policy/status (`hasSavedKey`, source, rememberSupported; never the key), replace/save, and forget. Validate a submitted private key by successful host admission before remembering it, or clearly mark an unverified credential; preferably persist only after successful share creation. Respect active-client credentials when replacing/forgetting, retaining live rooms rather than breaking them implicitly. Key field is password input, transient state cleared after success/origin changes; guard stale async discovery responses from updating another selected origin.

Normal panel shows Create share link, active links, and actionable default policy/loading/error. Advanced contains independent client and relay origins plus Auto / Legacy private compatibility. Auto asks for key only when policy is key and no server credential is available. Existing localStorage origin preferences remain nonsecret and blank values still choose hosted defaults. Never store a key through React preference persistence.

## Abuse controls

Add a cohesive limits object with validated conservative defaults and lower injectable values in tests. Bound global/per-source host and browser sockets, total/per-host routes across batches, browser sockets per route, pending HTTP requests global/per-host, upgrades/control message attempts, aggregate bytes/messages per host/socket, outgoing buffered bytes, browser idle lifespan and existing host heartbeat. Reject before allocating maps or expensive work. Apply admission controls to unsuccessful attempts too. Sweep/cap source limiter maps so spoofed/source churn cannot grow memory without bound. Bound accepted TCP/HTTP connections/request timeouts as well as WebSockets where practical. Socket closure releases every counter exactly once. On send overflow terminate slow consumers; `maxPayload` does not bound queued outgoing data. Return 429 for rate and 503 for capacity. Add admission kill switch.

Use socket remote address by default. Trust forwarded source only from explicitly configured exact proxy peer addresses, with an unambiguous single-hop header contract; ignore forged forwarding on direct connections. Document Caddy deployment source handling. Prefer coarse structured rejection counts without tokens/keys. Defaults are local safety bounds, not evidence of hosted capacity or DDoS protection.

## Ownership for implementation

1. Relay/protocol: `apps/relay-web/src/relay/{relay,protocol}.ts`, focused relay tests; policy endpoint, route proof, ACK, all relay admission limits/proxy behavior.
2. Host: `rooms.ts`, `relay-client.ts`, `server.ts`, shared `relay-target.ts` plus small server-only policy/ownership helpers; discovery-aware generation, reconnect registration, ACK and rollback, open keyless transport; focused room/client tests.
3. Plugin: `relay-credentials.server.ts`, `runtime.server.ts`, `share.server.ts`, `share.shared.ts`, `index.server.ts`, `main.client.tsx`; credentials/status RPCs, server discovery integration, advanced UI and tests.
4. Documentation/deploy examples: clarify explicit default key policy and explicit local open setup, compatibility, storage support and no production switch.

Coordinate shared protocol types and exact capability JSON before workers edit. `server.ts` and plugin runtime must use the same policy interpretation.

## Validation and lifecycle gates

Focused tests first: bad/missing/unknown configuration; open no key versus private wrong key; malformed/unreachable/redirect discovery; custom open never forwards saved credential; legacy explicit compatibility; correct proof reconnect and restart, bad proof/preclaim/protocol downgrade, concurrent host rejection, ownership absent from guest outputs; ACK rejection rollback and disconnected waiter cleanup; limits across many small batches, forged proxy, NAT thresholds, overflow, idle, limiter cleanup.

Credential tests: canonical origin separation, HTTPS/WSS equality, malformed origin, replacement/restart persistence/forget fallback suppression, atomic failure, symlinks and permissions, unsupported platform behavior. Existing invitation, revocation, E2EE, agent scoping and browser-bundle separation regressions remain mandatory. Test actual new-host open flow and saved-key private flow against ephemeral real relay servers; don't rely only on mocked policy.

Run package tests/typechecks/build after focused checks. Lifecycle requires read-only pyratz review followed by fixes/rechecks, and browser visual QA of default/advanced desktop/mobile states including open, private, error, replace/forget, and share creation. If a real plugin host is unavailable, state fixture coverage limits explicitly. No reload of live Paseo, deploy, publication, pushes or hosted policy changes are authorized by this implementation plan.

## Local verification and rollout boundary

The implementation was exercised with real ephemeral open/private relays and
fixture-backed Paseo daemon/admin calls. Checks cover saved-key reuse, forgotten
legacy credentials, wrong-key rejection, protected-route restart ownership,
confirmed registration and rollback, connection quotas, and existing encryption
behavior. Tests are included in CI through `test:relay-access` and `test:plugin`.

Desktop (1280 × 900) and mobile (390 × 844) browser checks exercised the actual
SharePanel component through a React Native DOM adapter and deterministic RPC
fixtures. Screenshots were inspected; public sharing, private-key save/forget,
origin-change key clearing, discovery failure and legacy selection passed without
horizontal overflow or browser errors.

On 2026-09-23, the updated plugin was also tested in the running Paseo desktop
against loopback public and private relays. The user confirmed bidirectional
conversation through both local browser clients. Smoke checks confirmed policy
discovery, missing/wrong-key rejection, route registration, served browser assets,
WebSocket connectivity and revocation. Saved-key reuse/forget and relay-restart
recovery have automated coverage; additional manual checks remain optional.

The hosted relay policy and deployment configuration were not changed. Release
packaging, live-host rollout, Windows secure credential persistence, and measured
public capacity remain separate work. Local defaults are safeguards, not a
general-availability capacity guarantee.
