---
sidebar_position: 1
---

# Install the Paseo plugin

The plugin adds the **Share session** action inside Paseo. It carries the
matching local room runtime from the same Git revision, so normal installation
does not require a separate checkout path or a `roomsPath` configuration file.

## Requirements

The plugin requires Paseo 0.12.0 or newer within the 0.12 series on both the daemon
and connected app. All 0.12.x patch releases are accepted without a manifest update;
0.13 requires a compatibility review. Older versions are unsupported.
Check the Paseo command that you will use for installation:

```bash
paseo --version
```

The project does not yet publish a stable release channel or package. Until it
does, use a local checkout, as described below. Do not install a plugin from an
untrusted checkout: its server code and its manifest build commands run on the
Paseo daemon host.

## Install from a local checkout

Clone a trusted revision, then install the root plugin on the machine that runs the Paseo daemon:

```bash
git clone https://github.com/Pyratzlabs/paseo-rooms.git ~/paseo-rooms
```

The examples below use that local checkout:

```bash
paseo plugin install "$HOME/paseo-rooms"
paseo plugin reload paseo-rooms
```

Paseo runs the manifest's preparation commands, validates the plugin, and then
activates it. If preparation or startup fails, it keeps the current running
plugin. Re-run `paseo plugin reload paseo-rooms` after changing a local
checkout.

## Verify

Open an agent in Paseo and select **Share session**. Creating a link should start the room server when necessary and return a public room URL.

If it cannot start, inspect the plugin server logs with `paseo plugin logs
paseo-rooms`. The local runtime listens only on loopback by default and stores
its local token under the Paseo data directory. It starts on the first Share
session use and is stopped when the plugin reloads, is disabled or updated, or
when the Paseo daemon shuts down—there is no separate service to install.

The hosted Pyratz Labs relay at `https://paseo-rooms.pyratz.com` allows public registration: no registration key
is needed. Keep **Automatic discovery** selected in the Share session panel.
A private relay may require a key from its operator; enter it in the panel or
configure `PASEO_ROOMS_RELAY_KEY` in the Paseo daemon's environment. For a
custom default relay, set `PASEO_ROOMS_PUBLIC_URL` and
`PASEO_ROOMS_RELAY_URL`, with a key only when that relay requires one.

New public-room links use `https://pyratzlabs.github.io/paseo-rooms`, a GitHub Pages
client that connects to the public relay. `PASEO_ROOMS_CLIENT_URL` overrides
only the browser client origin placed in newly created links, for example for a
separately hosted static client. The relay stays at `PASEO_ROOMS_PUBLIC_URL`.
The Share session panel can also choose client and relay destinations per new
link; see [Choose a room client and relay](choose-a-client-and-relay).

## Update an existing directory installation

```bash
git -C "$HOME/paseo-rooms" pull --ff-only
(cd "$HOME/paseo-rooms" && npm ci --ignore-scripts --no-audit --no-fund && npm run verify:plugin-distribution)
paseo plugin reload paseo-rooms
```

Keep using the directory shown by `paseo plugin ls`; adjust the path above if
you installed elsewhere. Do not install the same plugin ID again to update it.
Prepare dependencies and matching distribution bundles before reloading a
changed directory checkout. The install manifest also performs these steps
when a directory is first installed.
The unqualified name `paseo-rooms` is not a published npm package.

Changes to default origins apply to new links. An explicitly saved relay or
client in Advanced settings remains selected until you change it.
