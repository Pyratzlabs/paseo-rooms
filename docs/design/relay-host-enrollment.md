# Easy installation and per-machine relay access

Status: proposal, not implemented. Based on main after MR !26 (Paseo 0.8 compatibility). The immediate audience is the Pyratz team; the same model must support public availability without distributing a global relay secret.

## Proposed product experience

A teammate installs the published Paseo Rooms release, opens **Share session**, and clicks **Connect this machine** once. A browser page identifies the relay, team, and machine being authorized. After sign-in and approval, Paseo displays **Connected to Pyratz Labs**. Creating a share link requires no relay URL, registration key, terminal command, or environment file.

Returning users go straight to **Create share link**. Collaborators still open the invitation URL without installing Paseo or obtaining a relay credential. Room invitations remain capability links: anyone holding one has the existing room permissions. Organization authentication of hosts does not silently make shared rooms team-only.

Hide client and relay choices under **Advanced settings**. Defaults are supplied by the release, with clearly named destinations. Self-hosters can choose **Use another relay**, enter its HTTPS/WSS origin once, and follow that relay's enrollment flow. Legacy manual keys remain an explicitly labeled compatibility option during migration. Changing the client does not change the relay, and changing the relay never forwards an existing credential.

Identity and eligibility are undecided. The user requested an explanation before choosing between GitLab, Google Workspace, or administrator-issued invitations. The flows below use GitLab only as an example, not an agreed dependency. Identity-provider selection is separate from relay authorization, so adding another provider later does not require changing the host protocol. An invitation-only option could instead bind a one-time enrollment to an administrator-approved teammate; its recovery and identity guarantees need to be specified before choosing it.

## What exists today

- `apps/relay-web/src/relay/relay.ts` accepts one shared `RELAY_KEY` at `/host` through `x-relay-key`. There is no persistent identity attached to a host connection.
- Route ownership is in memory and attached to a connection. A reconnect must register routes again.
- `apps/paseo-plugin/runtime.server.ts` starts the local room server; `relay-credentials.server.ts` can recover an endpoint-matched key from the previous local dotenv setup.
- `main.client.tsx` submits a custom relay key via trusted local RPC, retaining it only in panel state. The hosted default needs pre-provisioned configuration.
- Root installation currently prepares the full monorepo and runs verification. This is workable for development, but too slow and fragile as the normal team installation experience.
- Room protocol v2 encrypts payloads between host and browser. Registration credentials and room encryption material have different purposes and must remain separate.

## Architecture and credential separation

Add a small HTTPS enrollment/account service, PostgreSQL persistence, and a credential verifier used by the relay. These may run in the same deployment initially, with separate modules and interfaces. The relay remains responsible for routing; the account service handles membership, enrollment, credential lifecycle, and audit events. Do not build a general-purpose identity provider: use a maintained OAuth/OIDC implementation for browser login.

| Item                             | Purpose                                         | Stored by                                                                   |
| -------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| Browser login session            | Identify the person approving a machine         | Enrollment service; secure, HttpOnly browser cookie                         |
| Device authorization transaction | Bind approval to the requesting Paseo host      | Enrollment service and plugin server; short-lived                           |
| Host refresh credential          | Renew access for one enrolled machine           | Plugin server secret store; verifier hash on service                        |
| Host access token                | Authorize a short-lived connection to one relay | Plugin server memory; verifier hash and authorization metadata on service   |
| Room invitation and E2EE keys    | Admit a collaborator to one encrypted room      | Existing host/browser capability flow; never derived from relay credentials |

Use independent 256-bit random opaque access/refresh tokens, with a public identifier and a secret portion. Store only cryptographic digests of high-entropy secrets in the service database. Never put credentials in URLs, room invites, logs, telemetry, client bundles, React state, or plugin settings readable by the app. TLS is required except for explicit loopback development.

Tokens identify `organization_id`, `user_id`, `host_id`, credential generation, audience, expiry, and status through their server-side record. Bind them to the exact trusted service/relay origin. A token issued by relay A must fail at relay B; discovery must not silently redirect token-bearing requests. Do not embed a confidential OAuth client secret in the plugin.

### Initial proposed lifetimes

Access tokens last 15 minutes. Refresh credentials expire after 90 days of inactivity and rotate on use. Device authorizations expire after 10 minutes. These are proposed operating defaults, not existing behavior or externally mandated values.

A dropped response during refresh must not lock out a legitimate laptop: define and test a narrowly bounded, request-bound retry mechanism before implementation. Reuse of a rotated refresh credential outside that retry must revoke the credential family and require approval again. Serialize refresh requests per host locally and rotate atomically on the service. Credential revocation is independent of token expiry.

## Enrollment flow

Paseo can display a remote host's panel, so the browser and daemon may run on different machines. A device-authorization flow avoids depending on a loopback callback on the desktop user's computer. Use the established device-flow semantics for user codes, expiry, polling intervals, cancellation, and denial, rather than inventing a long-lived enrollment link. RFC 8628 describes this cross-device authorization model; it is distinct from the browser's sign-in to GitLab. [Device authorization standard](https://www.rfc-editor.org/rfc/rfc8628)

1. The plugin server starts an enrollment against an explicitly selected, trusted origin. The service returns a secret device code, a human-readable user code, verification URL, expiry, and polling interval.
2. Only the verification URL, user code, and status cross the local plugin RPC. Keep the secret device code in the plugin server. Offer both **Open browser** and a copyable URL/code for remote daemons.
3. The browser signs the user in using an authorization-code flow with exact redirect validation, CSRF protection, and PKCE where applicable. GitLab's OAuth interface can supply that identity; it must not issue our relay credential directly. [GitLab OAuth documentation](https://docs.gitlab.com/api/oauth2/)
4. The service verifies active organization membership and machine quota. It displays the requesting machine name, team, origin, and matching user code and requires explicit approval. A machine name is descriptive, not authenticated proof of device identity. Approval must warn against authorizing unsolicited codes.
5. The plugin polls according to the server interval; approval creates exactly one host and issues its credentials atomically. A code cannot enroll a second host. Denied/expired/cancelled transactions produce a clear retry state.
6. The plugin stores the refresh credential server-side, opens the relay connection, and reports **Connected** only once authentication is accepted. A second panel observes the same enrollment status instead of starting another flow.

Use OAuth security best practices for redirect handling and refresh-token protection; the exact rotation/retry implementation needs focused review. [OAuth security BCP](https://www.rfc-editor.org/rfc/rfc9700)

### Team membership

For the first rollout, the organization owner can invite named identities and remove members in the enrollment service. GitLab sign-in identifies the user, but email domain alone must not grant team access. Optional GitLab group synchronization is a follow-up connector: explicitly select a group and verify the required API permissions, nested membership policy, and revalidation behavior before enabling it. No broad GitLab API credential should ever be stored in a plugin.

Removal in our service immediately revokes that user's hosts. An external group connector needs a documented propagation bound and failure policy; a cached membership result is not proof of permanent membership. Until reliable sync exists, label membership as administrator-managed rather than promising automatic GitLab offboarding.

## Relay authorization and revocation

Replace the shared-key-only check at `/host` with a verifier that returns an authenticated host identity. Use `Authorization: Bearer <access-token>` for the new mode; retain `x-relay-key` only behind an explicit migration switch. Never fall back to the legacy key after a supplied bearer token fails validation.

Carry `host_id` and `organization_id` on `HostConnection`. Bind route registrations to that identity. Persist route ownership leases until expiry/revocation, so a disconnected host's known route cannot be claimed by another authorized machine. Reconnect by the same host is allowed; two simultaneous connections need an explicit replacement policy. Claims and ownership checks must be atomic and applied to register, unregister, forwarded responses, and socket events. A durable identity supplements the existing room capability, it does not replace it.

Expose **My machines** and team-admin **Machines** views with name, owner, last seen, and revoke controls. Revoking a host closes all its relay sockets and removes its routes; future connections fail. Target completion within 30 seconds across relay workers, using revocation notifications plus periodic validity checks bounded by the same window. At access-token expiry, require a newly authenticated connection; otherwise a long-lived WebSocket would bypass expiry.

Apply per-organization and per-host limits for active machines, connections, registered routes, concurrent guests, registration rate, and bytes forwarded. Apply unauthenticated rate limits to enrollment, polling, and failed handshakes. These limits are required before broad availability; a global shared key currently prevents useful attribution.

If the authorization store is unavailable, reject new enrollment/connections. Existing sockets may continue only within their last verified lease, no longer than the revocation bound, then close. Surface a temporary service problem rather than endlessly prompting for credentials. This trades availability for a defined revocation guarantee and must be tested deliberately.

## Local storage and plugin surfaces

Put credential lookup, enrollment, refresh, and revocation in a server-only credential manager keyed by canonical origin and host ID. The browser receives a projection such as `disconnected`, `authorizing`, `connected`, `expired`, or `revoked`, plus team and machine labels. Do not add secrets to general plugin settings merely because settings persist.

Preferred storage is the platform credential store. Validate support inside Paseo's daemon process on Linux, macOS, and Windows before selecting an adapter. If a credential store is unavailable, use a documented server-only fallback: owner-only directory/file on Unix, restricted user ACL on Windows, atomic writes, and no cloud-sync location. Report the fallback clearly in diagnostics. An environment credential may remain a supported headless override, always origin-scoped.

Uninstall/reinstall must not silently revoke a machine or copy its identity to another machine. Provide **Disconnect this machine** to revoke remotely and remove local credentials, with clear handling when the service is unreachable. Restoring a credential backup must never bypass server revocation.

## Installation and configuration delivery

Publish an immutable, tested plugin release source containing the root manifest, runtime entries, and prebuilt client/server artifacts. The normal install must not build Docusaurus or download the monorepo development toolchain. Keep the current checkout installation for contributors. The proposed user command is `paseo plugin install <release-source> --ref <tested-tag>`; no release source or tag is being advertised as available yet.

Release CI must run the exact supported Paseo compiler, an evaluator enforcing the cleanup contract, plugin UI tests, and installation/reload tests from a clean machine profile. Verify updates preserve the server-side host credential and hot-reload the client contribution. Publish checksums and a changelog, protect release tags, and retain a rollback release. Paseo plugins execute trusted host code; prebuilding improves reliability, not sandboxing.

The default relay and client originate from release configuration. A successful first-run authorization stores the host credential automatically. Routine use shows only connection status, **Create share link**, and active links. Advanced settings expose client selection, custom relay enrollment, machine management, and diagnostics with actionable recovery text. Do not expose a raw secret field in the standard hosted flow.

## Migration and delivery slices

1. **Release packaging:** produce a self-contained plugin release, clean-install/update smoke tests on Linux/macOS/Windows, and one canonical install guide. Keep existing keys working while packaging changes ship.
2. **Per-host identity:** add persistence, new access-token verification, identity-bound route ownership, individual revocation, and quotas. Exercise two independently authenticated hosts before onboarding UI work is declared complete.
3. **Team enrollment:** browser approval, administrator-managed membership, plugin credential storage/refresh, and first-run/recovery UI. A fresh teammate with no environment file must succeed without seeing a secret.
4. **Migration:** existing users authorize each machine once. A shared legacy key is not proof of a person's team membership and cannot automatically mint an individual host identity. Observe adoption, announce an expiry date, then disable the global-key mode on the hosted relay. Keep self-hosted legacy mode an explicit operator choice.
5. **General availability:** complete membership/offboarding behavior, abuse limits, recovery, privacy/retention policy, monitoring, support runbooks, and external security review of the authentication and release boundaries. Clear or explicitly accept baseline dependency advisories before launch.

Rollback must never silently reactivate revoked hosts or restore a leaked global key. During migration, feature flags may stop new enrollments while already enrolled, valid hosts continue. Keep schema changes additive until the migration window closes. Once the hosted shared-key mode is disabled, roll back only to a version that understands per-host credentials.

## Acceptance tests and launch gates

- Fresh teammate: install, browser approval, create link, exchange messages, revoke link; no shell configuration or secret entry.
- Remote daemon: approval completes on a different device without a callback to the host's localhost.
- Restart/update/reinstall: valid credentials survive; revoked credentials do not resurrect; missing keychain yields the documented fallback.
- Isolation: host A cannot register/unregister host B's known route, including while B is disconnected or the relay restarts. Two organizations cannot access one another's machine management.
- Offboarding: host/member revocation disconnects active traffic within 30 seconds and rejects reconnect. Test cross-worker propagation and authorization-store failure.
- Credential lifecycle: expiry, polling slowdown, duplicate approval, denied enrollment, refresh races, lost refresh responses, replay, stolen token, changed relay, and revoked credential backup.
- Privacy: bundle/log/error/URL inspection finds no registration or refresh secrets. Changing the UI host cannot obtain the server-side credential. Room payload confidentiality still depends on trusted client delivery and the existing E2EE model.
- Abuse: bounded device-code guessing, failed authentication, connections, routes, traffic, and idle sockets; alerts identify a host without logging capability URLs.
- Packaging: no private checkout paths, no manual build prerequisites beyond supported Paseo/runtime requirements, and a tested rollback path.

## Decisions to settle before implementation

Confirm the first identity provider and team eligibility source; choose the deployment owner and operating budget; validate platform secret-store support in Paseo; set launch quotas and the legacy-key retirement date. Choose the simplest eligibility model the team is comfortable with; no identity-provider decision has been made. GitLab identity plus administrator-managed invitations is one option, not a requirement. No production enrollment service, identity-provider registration, credential rotation, or rollout is authorized by this design document alone.
