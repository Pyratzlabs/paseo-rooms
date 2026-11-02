---
sidebar_position: 5
---

# Move the hosted domain

This is the operator checklist for moving the hosted product, documentation, and default relay from `paseo-rooms.pyratzlabs.fr` to `paseo-rooms.pyratz.com`. It is a prepared cutover; editing the repository alone does not change DNS or the running service.

The GitLab Pages client remains a separate, default frontend. Its configured relay origin moves to the new domain. The plugin's **Pyratz Labs** client preset and the documentation canonical URL also use the new domain. A link's embedded relay remains authoritative, so older links need their original relay hostname to keep working.

## 1. Prepare before changing DNS

- Build and verify the documentation, browser client, plugin, and CI configuration on the migration branch.
- Keep the public relay's registration policy `open`; changing its hostname must not reintroduce the registration-key requirement.
- Use the existing nginx-proxy stack on the VPS. Do not run the separate Caddy stack on ports already owned by nginx-proxy.
- Keep the old DNS record and virtual host. Avoid a redirect for WebSocket paths: both names should route to the same relay.
- Defer deploying the new default until the new hostname has valid DNS and TLS.

## 2. Add DNS last

Add the new record in the `pyratz.com` zone:

| Type | Name          | Value            |
| ---- | ------------- | ---------------- |
| A    | `paseo-rooms` | `188.165.200.34` |

That is the relay VPS's public IPv4 address observed on 2 November 2026; confirm it still belongs to the deployment before changing DNS. DNS-only mode is sufficient. If using a CDN proxy, ensure WebSockets and the ACME challenge are supported and use validated origin TLS. Do not add an AAAA record unless the server is actually reachable on that IPv6 address.

## 3. Configure and deploy both hostnames

After DNS resolves, set these GitLab CI/CD variables, preserving the existing SSH credentials, deploy target, capacity limits, and proxy configuration:

```dotenv
ROOMS_DOMAIN=paseo-rooms.pyratz.com
ROOMS_HOSTNAMES=paseo-rooms.pyratz.com,paseo-rooms.pyratzlabs.fr
RELAY_AUTH_MODE=open
```

Deploy the reviewed migration revision through the existing main-branch pipeline. CI passes `ROOMS_HOSTNAMES` into `compose.proxy.yml`; nginx-proxy and acme-companion use the same list for routing and TLS. The old and new hostnames reach **one** relay instance, not two competing route tables. Certificate issuance must succeed for both names.

A relay container replacement interrupts connections temporarily. Host runtimes should reconnect and register their rooms again. Avoid restarting the host plugins during this check, because their process-local room keys would be lost.

## 4. Verify before publishing

Check both hostnames with certificate verification enabled:

```bash
curl --fail https://paseo-rooms.pyratz.com/.well-known/paseo-rooms
curl --fail https://paseo-rooms.pyratzlabs.fr/.well-known/paseo-rooms
curl --fail --head https://paseo-rooms.pyratz.com/docs/
```

Both discovery responses must report `"registration":"open"`. Then:

1. Open the new product homepage and documentation. Check navigation and all three shared diagrams.
2. Update/reload a test plugin from the reviewed revision and create a new room with automatic discovery and no key.
3. Join through the default Pages client in a second browser; verify history, a message, and an image. Verify the Pyratz Labs same-origin client too.
4. Reopen an existing **complete** old invitation after its host reconnects. Confirm it still works, even if the new client asks to confirm the old relay origin.
5. Check the new HTTPS/WSS certificate chain and observe relay reconnects before publishing the article.

Deploying server defaults does not update already installed directory plugins or saved Advanced settings. Those users must update their checkout and reload the plugin, or select the new relay manually. Saved custom origins are not silently rewritten.

## Roll back

Keep the old hostname active throughout the cutover. If validation fails, restore the previous reviewed application revision and old `ROOMS_DOMAIN`, retaining both virtual hosts where possible. Do not rotate room secrets or restart host plugins as part of a hostname rollback. Continue serving the old origin until users have moved and no supported invitations depend on it.
