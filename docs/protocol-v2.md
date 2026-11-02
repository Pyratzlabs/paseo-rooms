---
sidebar_position: 1
---

# Paseo Rooms protocol v2 — pairwise encrypted shared rooms

**Status:** proposed, version `2`
**Audience:** implementers and security reviewers
**Supersedes:** the _Relay protocol v1_ section of `docs/plan.md` for new,
encrypted rooms only. v1 remains supported during migration.

## 1. Purpose and security claim

Protocol v2 lets several browser participants collaborate on one Paseo agent
session while the public relay forwards opaque records. The local room server
on the host laptop is the room authority: it owns the only Paseo daemon
connection, membership, and the allowlist of browser actions.

V2.0 uses one encrypted Paseo relay channel per browser-to-host connection.
The host fans each authorised room event out to every live participant over
their own channel. There is deliberately **no shared group key in v2.0**.

When the client bundle is obtained from a trusted source, this provides
confidentiality and integrity for room content against the relay and network
intermediaries. It does not hide route identifiers, connection/IP metadata,
frame sizes, timing, or room activity. The relay can drop, delay, reorder,
replay, and deny service.

### Current client-delivery limitation

The default browser client is published independently on GitHub Pages. A
same-origin relay client and custom client origins are also supported. Client
code is part of the trusted endpoint: a malicious delivery origin can replace
JavaScript and capture plaintext or the invitation before encryption.

Separate static delivery prevents the relay operator alone from replacing the
first page load when that operator does not also control the client origin.
It is not a verifiable, immutable or version-pinned delivery guarantee. Teams
can self-host both the frontend and relay to control both operators; they must
still trust their own delivery infrastructure. See [Security and privacy](explanation/security-and-privacy)
and [Run your own relay](how-to/run-your-own-relay) for the supported choices.

## 2. Roles and trust

| Term                   | Meaning                                                                | Trust level                                                  |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| **Host**               | Paseo extension plus local room server on the laptop.                  | Trusted authority                                            |
| **Participant**        | One browser session with an invite.                                    | Trusted endpoint for content it can read                     |
| **Relay**              | Public server serving the shell in phase one and forwarding records.   | Untrusted for content; trusted only for availability/routing |
| **Route ID**           | Public random identifier selecting a registered host connection.       | Public metadata                                              |
| **Invite secret**      | 32-byte secret proving the participant holds the invitation.           | Secret capability                                            |
| **Host transport key** | Per-room X25519 keypair; its public key is pinned in the URL fragment. | Host trust anchor                                            |

The URL is a bearer invitation, not a real-world identity. A display name is a
session label only. The host makes all authorisation decisions from its live
room state, the explicit v2 action allowlist, and authoritative Paseo state.

### Relay registration policy

Hosts discover registration policy at `GET /.well-known/paseo-rooms`.
An `open` relay accepts protected v2 route registration without `RELAY_KEY`;
a private `key` relay requires the operator's key on the host connection.
Legacy v1 routes are supported only in key mode. The registration key controls
who may register rooms; it is separate from the invitation secret, transport
keys, and route ownership proof. Open registration does not grant access to
another host's room. See [relay access design](design/relay-host-enrollment.md)
and [Run your own relay](how-to/run-your-own-relay.md).

## 3. Cryptographic profile

V2.0 uses the published `@getpaseo/relay/e2ee` encrypted channel, pinned as a
direct dependency. Its implementation uses TweetNaCl's Curve25519
`nacl.box.before` key agreement and XSalsa20-Poly1305 `nacl.box.after` record
protection with a fresh random 24-byte nonce per record.

| Purpose                       | Required construction                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| Pairwise key establishment    | Paseo encrypted channel, browser ephemeral Curve25519 key + per-room host Curve25519 key        |
| Pairwise record protection    | XSalsa20-Poly1305 with a fresh random nonce per record                                          |
| Route and invite randomness   | OS CSPRNG, 32 bytes each                                                                        |
| Application replay protection | Authenticated session IDs, strictly increasing sequence numbers, IDs, and bounded replay caches |
| Inner message encoding        | UTF-8 JSON with strict runtime validation and bounded records                                   |

The channel proves a host possesses the private half of the X25519 public key
pinned by the invitation: only that holder can produce a valid encrypted
`Welcome`. It does **not** authenticate the plaintext `e2ee_ready` message;
the client remains handshaking until a valid encrypted `Welcome` is received.

The channel does **not** provide forward secrecy against later compromise of
the host private key: a recorded client public key plus ciphertext can be
decrypted if the host's per-room private key is later obtained. Per-room,
in-memory host keys limit blast radius and are erased on room revocation or
restart, but this is compartmentalisation, not forward secrecy.

Ciphertext authentication alone does not reject replay. The application record
rules in section 7 are mandatory. Implementations must not treat successful
decryption as authorisation.

## 4. Room state and link

Each v2 room has only in-memory state in its first release:

```text
routeId       32 random bytes, base64url encoded
inviteSecret  32 random bytes
hostTransport fresh Curve25519 keypair
members       live participant records only
```

A restart invalidates the room. Its state must not be confused with persisted
v1 `data/rooms.json` entries.

The invitation shape is:

```text
https://client.example/r/<route-id>#v=2&i=<invite-secret>&hp=<host-public-key>&relay=wss%3A%2F%2Frelay.example
```

The fragment is never sent to the relay. The client parses it locally, keeps
it only in memory, and immediately calls `history.replaceState` to remove it
from visible browser history. The route ID is the only relay-visible room
identifier.

`relay` is optional additive v2.1 invite metadata. When present, it is the
canonical `wss://` relay origin selected by the host when creating the room;
clients connect to its fixed `/v2/rooms/<route-id>/ws` endpoint. Public relay
origins must use TLS. `ws://` is permitted only for loopback development.
Hosts authenticate their `/host` registration with a separate secret which is
never included in the invitation. Links without `relay` retain the client's
configured relay fallback for backwards compatibility.

## 5. Relay boundary

The public relay may expose only:

- `GET /r/<route-id>` for the static room shell while a host owns the route;
- `WS /v2/rooms/<route-id>/ws` for canonical outer records.

The outer record is strict canonical JSON, forwarded without interpretation:

```json
{ "v": 2, "type": "handshake" | "secure", "data": "<base64url bytes>" }
```

Unknown types including deferred group records, unknown fields, duplicate
fields, non-canonical JSON, padding, invalid base64url, binary WebSocket
frames, and decoded records outside `1..65536` bytes are rejected. Compression
is disabled. V2 routes must reject all v1 HTTP and WebSocket room paths, and
v1 routes must reject the v2 WebSocket path.

The room-side `V2EncryptedTransportAdapter` maps this text wrapper to Paseo's
browser-neutral `Transport` API. Handshake messages are text; encrypted
messages are carried as `ArrayBuffer` so Paseo's negotiated binary ciphertext
mode remains unambiguous. The outer WebSocket wrapper remains text JSON.

## 6. Connection and admission

1. The browser opens `WS /v2/rooms/<route-id>/ws` and starts a fresh Paseo
   encrypted channel using `hp` as the host public key.
2. The host creates the responder channel with the room's private key. It
   releases no title, history, presence, or agent state at this stage.
3. The first encrypted record is a strictly decoded `JoinRequest`:

   ```text
   { v, kind: "join", joinAttemptId, inviteSecret, displayName, capabilities }
   ```

4. The host checks the active invite in constant time, bounds and validates all
   fields, and rejects replayed `joinAttemptId` values. A new join obtains a
   random `memberId`. V2.0 treats reconnect as a new session; resumable
   membership is deferred until its state and replay rules are implemented.
5. The host sends encrypted `Welcome` with `{ sessionId, memberId,
nextClientSeq, room, history, participants, working }`. Receipt and
   successful decryption of this record authenticates the host to the browser.
6. Only after `Welcome` may the UI render room content, show presence, or
   enable actions.

Invite revocation blocks future joins. Removing a member closes its socket.
Revoking a room closes every socket, unregisters the v2 route, and erases its
invite, host key, membership, and room state.

## 7. Application records and fanout

Every post-welcome decrypted record is UTF-8 JSON:

```text
{ v, sessionId, seq, id, kind, payload }
```

Each direction has its own strictly increasing safe-integer sequence. Receivers
reject a wrong session, duplicate, lower, or gap sequence, duplicate ID,
unknown kind, or oversized payload and close the channel. The host keeps
bounded replay caches for application record IDs and join attempts. Runtime
decoders validate values required by each supported record kind; additional
hardening can make the JSON object shape canonical in a later revision.

Browser-to-host kinds are allowlisted: collaborator message, structured
question response, exact plan decision, and presence controls. The host
never accepts an arbitrary daemon method, agent ID, tool call, or permission
resolution from the browser. It re-reads authoritative pending Paseo state
before acting.

Host-to-browser records carry the initial timeline/history/question snapshot,
subsequent timeline events, presence snapshots, and status. The encrypted
application envelope supplies the host-assigned `sessionId`, `seq`, and `id`.
The host serialises an event once then encrypts and sends it individually to
each live participant.
This preserves host authenticity without giving participants a key capable of
forging a host event.

On relay or socket reconnect, all old virtual sockets are discarded. The
browser creates a new WebSocket and encrypted channel and rejoins from the
invitation. The host returns a bounded fresh snapshot followed by subsequent
events. Explicit removal and room revocation invalidate their in-memory state.

## 8. Deferred group mode

Shared epoch keys are deferred beyond v2.0. They reduce host encryption work
but not relay bandwidth, because the relay still sends one WebSocket frame per
participant. Any symmetric group-key holder could forge a host event unless
group records also use a separately pinned host signing identity.

If group mode is introduced later it must distribute new epoch keys over the
existing pairwise channels, sign canonical host events, rotate on each admitted
join and explicit removal, and keep history and private actions pairwise.

## 9. Implementation gates

1. Declare and pin `@getpaseo/relay` directly; verify its Node import and Vite
   browser bundle. Its published browser export currently names an unshipped
   source file, so the project keeps one explicit Vite compatibility alias to
   the published built artifact.
2. Test a Node encrypted-channel round trip using only the public E2EE API.
3. Before room wiring, test the outer record adapter with text handshake and
   binary encrypted payload mapping, including size and malformed-wrapper
   failures.
   A later signing/group-key protocol must first replace JSON with deterministic
   CBOR and add independent byte-level fixtures.
4. Before claiming resistance to a hostile relay, run an E2E suite that records,
   tampers, replays, reorders, and cross-injects frames across two browser
   participants. It must prove no plaintext reaches the relay and no action is
   applied twice.
5. Conduct an independent security review before making production E2EE
   claims. Trusted static-client delivery is a separate subsequent milestone.

## 10. Versioning and migration

`v` is mandatory in links, outer records, and every decrypted application
record. V2 clients must not fall back to v1 endpoints after a failed v2
handshake. V1 browser APIs and plaintext room traffic remain available only to
explicit v1 routes during migration.
