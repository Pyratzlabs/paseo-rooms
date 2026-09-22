---
sidebar_position: 1
---

# Install the Paseo plugin

The plugin adds the **Share session** action inside Paseo. It carries the
matching local room runtime from the same Git revision, so normal installation
does not require a separate checkout path or a `roomsPath` configuration file.

## Requirements

The plugin requires Paseo 0.8.x. The plugin uses the separate client/server entries introduced in 0.8. Check the Paseo
command that you will use for installation:

```bash
paseo --version
```

The project does not yet publish a stable release channel or package. Until it
does, use a local checkout, as described below. Do not install a plugin from an
untrusted checkout: its server code and its manifest build commands run on the
Paseo daemon host.

## Install from a local checkout

Contributors can install the root plugin directly:

```bash
paseo plugin install /path/to/paseo-rooms
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

Configure `PASEO_ROOMS_RELAY_KEY` in the Paseo daemon's environment to use a
default relay. This authorizes the laptop to register with that relay and is
deliberately not bundled with the plugin. Alternatively, select a custom relay
and enter its registration key directly in the Share session panel; the local
room listener can start without a default relay key. For an always-custom
default, set `PASEO_ROOMS_PUBLIC_URL` and `PASEO_ROOMS_RELAY_URL` alongside
that key.

New public-room links use `https://paseo-rooms-9eb268.gitlab.io`, a GitLab Pages
client that connects to the public relay. `PASEO_ROOMS_CLIENT_URL` overrides
only the browser client origin placed in newly created links, for example for a
separately hosted static client. The relay stays at `PASEO_ROOMS_PUBLIC_URL`.
The Share session panel can also choose client and relay destinations per new
link; see [Choose a room client and relay](choose-a-client-and-relay).
