---
sidebar_position: 1
---

# Install the Paseo plugin

The plugin adds the **Share session** action inside Paseo. It carries the
matching local room runtime from the same Git revision, so normal installation
does not require a separate checkout path or a `roomsPath` configuration file.

## Install a release

The plugin requires a Paseo build with Git plugin management. Install a release
branch or tag you trust:

```bash
paseo plugin add https://gitlab.com/pyratzlabs/software/paseo-rooms.git --ref <release-ref>
paseo plugin status paseo-rooms
```

Paseo checks out the revision, runs the explicit preparation commands in its
manifest, validates and compiles the candidate, then activates it. If
preparation or startup fails, Paseo keeps the current running plugin.

To receive approved release-branch updates:

```bash
paseo plugin update paseo-rooms
```

Use a tag or commit instead of a branch when you need a pinned, reproducible
installation.

## Install from a local checkout

Contributors can install the root plugin directly:

```bash
paseo plugin install /path/to/paseo-rooms
```

## Verify

Open an agent in Paseo and select **Share session**. Creating a link should start the room server when necessary and return a public room URL.

If it cannot start, inspect the plugin server logs with `paseo plugin logs
paseo-rooms`. The local runtime listens only on loopback by default and stores
its local token under the Paseo data directory. Before sharing, configure
`PASEO_ROOMS_RELAY_KEY` in the Paseo daemon's environment. This authorizes the
laptop to register with the relay and is deliberately not bundled with the
plugin. For a private relay, set `PASEO_ROOMS_PUBLIC_URL` and
`PASEO_ROOMS_RELAY_URL` alongside that key.
