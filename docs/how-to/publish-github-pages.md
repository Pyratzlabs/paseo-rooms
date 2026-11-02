---
sidebar_position: 4
---

# Publish the GitHub Pages client

The official repository is [Pyratzlabs/paseo-rooms](https://github.com/Pyratzlabs/paseo-rooms). Its independent browser client is deployed to `https://pyratzlabs.github.io/paseo-rooms/`. The product site, documentation and WebSocket relay remain separate from this static client.

## Repository setup

In GitHub, open **Settings → Pages → Build and deployment**, then select **GitHub Actions** as the source. This is a one-time administrator action. No custom DNS record is needed for the `github.io` address.

The repository's CI workflow builds and checks the Pages artifact on pull requests. A deployment runs only from `main`, after the quality, behavior, plugin and Pages-build jobs all pass. Only the deployment job gets `pages: write` and `id-token: write`; it uses the `github-pages` environment. Pull requests do not publish a site or get deployment credentials.

Check the current setting with:

```bash
gh api repos/Pyratzlabs/paseo-rooms/pages --jq '{html_url,build_type}'
```

The expected `build_type` is `workflow`. The site becomes available after the first successful main-branch deployment; enabling the setting alone does not publish the client.

## What the build publishes

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run test:pages
```

The build fixes Vite's base to `/paseo-rooms/` and stages only `index.html`, an identical `404.html`, the browser assets and `.nojekyll` under `.pages-site/`. It does not upload room state, daemon configuration, the plugin server bundle or the rest of the checkout.

GitHub Pages returns `404.html` for deep links such as `/paseo-rooms/r/<route-id>`. That response has HTTP status 404, but runs the room client at the original URL. Asset paths include the project prefix, and the client recognises room routes relative to that prefix. A browser test must exercise this deep-link path, not only the homepage.

The build's configured relay is `https://paseo-rooms.pyratz.com`. A v2 invitation's explicit relay still takes precedence after any required confirmation. Coordinate the new relay DNS/TLS cutover before releasing defaults that depend on it.

## Plugin migration

New plugin installations default to **GitHub Pages**. A saved **GitLab Pages** preset migrates to **GitHub Pages** when the updated plugin loads; **Custom client** and **Pyratz Labs** selections are preserved. Custom client URLs may include a deployment path such as `https://client.example/team`; keep the relay field as an origin without a path.

Existing invitations keep their original client URL and relay fragment. The migration does not move rooms or invalidate their keys. Keep the old static deployment available for old links; readers can receive new invitations using the GitHub client after the release. Do not delete the old client merely because its publisher was removed from this branch.

This workflow publishes the browser client only. It does not deploy or restart the relay VPS, change DNS, or install updated plugins on users' machines.
