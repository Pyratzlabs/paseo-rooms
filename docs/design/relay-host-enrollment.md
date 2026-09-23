# Public and private relay access

Status: agreed design; local implementation follows [the implementation plan](relay-access-implementation.md). Hosted rollout and release packaging remain separate. The intended model is: anyone may use the public relay; private relay operators may require a registration key. This supersedes the earlier team/account enrollment proposal. No organization database, identity provider, or sign-in is required for the core product.

## User experience

| Relay mode            | Who may register rooms?                          | Plugin setup                                                      |
| --------------------- | ------------------------------------------------ | ----------------------------------------------------------------- |
| Public/open           | Anyone, subject to capacity and abuse limits     | Install and share; no account or registration key                 |
| Private/key-protected | Machines holding the operator's registration key | Enter the relay origin and key once; remember the key server-side |

The client selector chooses the website that displays the room. It is independent from relay selection. Put both selectors under Advanced settings; normal hosted usage should show Create share link and active links.

A custom relay URL does not necessarily imply a private relay. Its operator chooses the registration policy. The UI should ask for a key only when that relay requires one. Enter an origin such as `wss://rooms.example.com`, without `/host`; the plugin derives transport paths.

Guests only need their room invitation. Allowing anyone to register a room on the public relay must not grant access to anyone else's rooms. Public describes relay registration, not conversation visibility.

## How Paseo itself works

Checked Paseo v0.8.0 daemon source and official `getpaseo/paseo-relay` source at commit `3fc41c96c8c63f3a7109e832899cc57d473c4531` on 2026-09-22.

- The daemon opens an outbound relay WebSocket with routing parameters including server ID and role. That connection path does not supply a shared registration secret.
- The official relay parses server ID, role, protocol version, and connection ID, then applies routing and capacity admission. The inspected source does not require an account or registration key at that boundary. This describes the published implementation, not a claim about every deployment's edge configuration.
- The user enables relay and pairs a device through a QR code or pairing link. The link provides connection information and the daemon public key; endpoints establish an encrypted channel. The pairing link is sensitive, while the public key is not a shared relay-registration password.
- The relay is designed to forward traffic without access to conversation plaintext. Published operational controls bound active sockets, message sizes, memory, and slow-consumer behavior; these controls do not imply unlimited safe public capacity.

Sources: [connection parsing](https://github.com/getpaseo/paseo-relay/blob/3fc41c96c8c63f3a7109e832899cc57d473c4531/lib/paseo_relay/connection.ex), [WebSocket admission](https://github.com/getpaseo/paseo-relay/blob/3fc41c96c8c63f3a7109e832899cc57d473c4531/lib/paseo_relay/socket.ex), [Paseo connectivity](https://paseo.sh/docs/connectivity), [Paseo security model](https://paseo.sh/docs/security).

Paseo Rooms uses a different routing protocol and grants access to a single shared agent rather than the whole daemon. Adopt the separation of open transport and protected endpoint access; do not assume our protocol is interchangeable with Paseo's relay.

## Three distinct kinds of secret

1. **Private relay registration key:** operator-generated, configured on that relay and authorized host machines. Its sole purpose is restricting who can register rooms. Open relays do not require it.
2. **Room invitation secret:** generated per room by the existing host flow. It allows a guest to join that room and is carried by the share link. Keep the existing encrypted admission check.
3. **Endpoint encryption keys:** generated automatically for encrypted communication. They are not a relay access password and should never be entered manually.

Removing the public relay's registration-key requirement must leave room invitation checks, E2EE, local administrative authentication, and agent scoping intact.

## Changes needed in this repository

### Explicit server policy

Add an operator configuration such as `RELAY_AUTH_MODE=open|key`. Keep existing deployments key-protected by default. In key mode, a missing key must fail startup. Open mode must be explicitly selected; a missing environment variable must never accidentally publish an unrestricted relay.

Change `/host` authorization in `apps/relay-web/src/relay/relay.ts` to enforce the selected policy. In key mode, retain a server-side key comparison and fail closed on missing/wrong credentials. In open mode, do not require or distribute a global secret. Credentials must never appear in URL parameters or logs.

The current plugin and server both assume any configured relay requires a key. Update `runtime.server.ts`, room creation in `src/server.ts`, and `relay-client.ts` together so open registration actually works. Do not ship only a UI change or an empty hardcoded public key.

### Discover policy and remember private configuration

Offer a small HTTPS capability endpoint returning protocol compatibility and `registration: open|key`, never a secret. The plugin server queries the selected origin and returns only the policy/status to the UI. Bind any saved credential to that exact canonical origin, do not follow cross-origin redirects with credentials, and never transmit a saved key during unauthenticated discovery.

A failed discovery request should display a connection error, not silently switch to open mode. Older private relays may use an explicitly selected legacy key mode when discovery is unavailable. Public host admission remains the relay's decision regardless of the UI's displayed mode.

Persist private relay keys in a server-only credential store. Validate platform keychain access from the Paseo daemon; if unavailable, define a protected file fallback (owner-only Unix permissions, restricted Windows ACL, atomic writes). Do not use browser localStorage or app-readable plugin settings for secrets. Provide Replace key and Forget relay actions. Keep the current endpoint-matched dotenv fallback for migration.

### Public relay ownership and abuse controls

Open registration expands the abuse surface. Before enabling it on the hosted deployment, add measured limits on connection attempts, simultaneous sockets, routes, message sizes, queued bytes, traffic, and idle lifetimes. Bound both per-source usage and overall capacity; IP limits alone are insufficient and must tolerate teammates sharing a NAT. Define trusted proxy handling rather than accepting arbitrary forwarded-IP headers.

New protected rooms use an independent, random 32-byte ownership secret. Their route identifier is `o_` plus a domain-separated SHA-256 digest of that secret. Each registration proves ownership, including after a relay restart, without a relay ownership database. The secret stays on the host and is sent only to the relay over TLS; it is separate from the invitation secret. Another live connection cannot replace the current owner. The protected namespace prevents downgrade to a proofless legacy claim. Legacy routes remain available only on private relays. Room creation waits for registration acknowledgement before returning a link.

Keep alerts and temporary admission shutdown controls for overload. Open access does not promise unlimited free resources. No account system is required for the first version; add one only if a concrete future need justifies it.

## Installation

Publish a tested, immutable plugin release containing prebuilt runtime artifacts and the supported Paseo version requirement. The normal install should not build docs or download the full development toolchain. Retain checkout installation for contributors. Verify clean install, hot reload, and update on supported desktop platforms; preserve server-side private-relay configuration across upgrades.

Hosted defaults should work immediately: install, open Share session, create a link. Private-relay setup should require its URL and key only once. A published release source and tag remain to be created; none is implied available by this proposal.

## Rollout and acceptance criteria

1. Implement and test explicit open/key policy plus capability discovery locally. Preserve existing private behavior and reject invalid configuration.
2. Implement server-side private-key persistence and the simple default/advanced UI. Test fresh profiles with no dotenv file and existing profiles with blank preferences.
3. Validate route ownership and public abuse limits with two adversarial hosts, reconnect races, proxy addresses, overload, and relay restart.
4. Publish the plugin release, then explicitly switch the hosted relay to open registration after the checks pass. Stop distributing its old global key; do not change private relay operators' keys.

Required end-to-end tests: a new host uses the public relay with no key; a private relay rejects a missing/wrong key and accepts a saved correct key after restart; a custom open relay never asks for a key; guests cannot join without the room invitation; revocation works; cross-host route takeover fails; UI-host selection does not change registration authority; keys never appear in browser bundles, logs, or links.

Remaining rollout decisions: measured public operating limits/budget and the release distribution source. This implementation uses protected Unix credential files; secure credential saving on Windows requires a future platform adapter, so Windows uses session input only. These are implementation decisions, not a reason to introduce team accounts. This document does not itself change or deploy the public relay's authentication policy.
