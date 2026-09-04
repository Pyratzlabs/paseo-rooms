---
sidebar_position: 3
---

# Choose a room client and relay

Each new room has two independent destinations:

- the **room client** is the browser application that renders the shared
  conversation;
- the **relay** routes that room's encrypted records between the browser and
  the host laptop.

The Share session panel remembers these choices and applies them to **new
links only**. Existing links retain the client host in their URL and, for v2.1
links, the relay selected when they were created.

## Supported combinations

| Relay             | Room client                        | When to choose it                                                                                                                                                                  |
| ----------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pyratz Labs relay | GitLab Pages client                | The default. The browser client is independently published at `paseo-rooms-9eb268.gitlab.io`.                                                                                      |
| Pyratz Labs relay | Pyratz Labs client                 | Use the **Pyratz Labs** preset when you prefer the same-origin hosted client.                                                                                                      |
| Pyratz Labs relay | Your client                        | Select **Custom client** and enter an HTTPS origin that serves a compatible Paseo Rooms client.                                                                                    |
| Your relay        | Your client                        | The self-hosted option: select both custom endpoints and supply your relay's host registration key.                                                                                |
| Your relay        | GitLab Pages or Pyratz Labs client | Useful when you want to operate routing infrastructure while continuing to use one of the published clients. The client asks for confirmation before connecting to a custom relay. |

All public combinations require HTTPS for the client and WSS for the relay.
For development on one laptop only, HTTP and WS are accepted for `localhost`,
`127.0.0.1`, and `[::1]`.

## Configure a new link in Paseo

1. Open **Share session** for the agent.
2. Under **Open room with**, select **GitLab Pages**, **Pyratz Labs**, or
   **Custom client**. For a custom client, enter its origin, for example
   `https://rooms.example.com`.
3. Under **Relay for new links**, keep the Pyratz Labs default or enter your
   relay origin, for example `wss://relay.example.com`.
4. When selecting a custom relay, enter its host registration key. This key is
   sent only from the trusted Paseo plugin to the local room server; it is not
   placed in the invite URL or exposed to the browser client.
5. Create the link. A custom-relay invite asks the browser participant to
   confirm the relay endpoint before opening the encrypted channel.

The relay field expects an **origin**, not `/host`: enter
`wss://relay.example.com`, not `wss://relay.example.com/host`.

## Trust and operational boundaries

The invite fragment carries the relay origin for a selected relay. Fragments
are not sent in ordinary HTTP requests, but the invite remains a bearer
capability: share it only with intended collaborators.

Selecting a separately operated client can improve auditability because the
relay operator no longer controls the first page load. It does not make an
untrusted client safe, and it does not hide routing metadata such as route IDs,
timing, and ciphertext sizes from the relay. Read [Security and privacy](../explanation/security-and-privacy)
for the precise guarantees and limitations.
