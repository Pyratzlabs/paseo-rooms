# Paseo Rooms plugin

The **Share session** Paseo extension and its laptop-side room runtime are
distributed together from the repository root. The root `paseo-plugin.json`
prepares the exact monorepo revision before Paseo validates, compiles, and
activates the plugin.

## Install

Install a trusted release branch or tag from Git:

```sh
paseo plugin add https://gitlab.com/pyratzlabs/software/paseo-rooms.git --ref <release-ref>
paseo plugin status paseo-rooms
```

The plugin owns the room server in its daemon-side process. It starts one
loopback listener on demand, keeps the admin token server-side, and closes the
listener when Paseo reloads, updates, disables, or shuts down the plugin. No
checkout path, detached child process, or `roomsPath` configuration is required.

For contributor development from this monorepo:

```sh
paseo plugin install /path/to/paseo-rooms
```

## Runtime settings

`PASEO_ROOMS_PORT` changes the loopback port (default `3000`). `PASEO_HOME`
chooses the parent data directory; the room runtime stores its local state in
`$PASEO_HOME/paseo-rooms` (or `~/.paseo/paseo-rooms`).

Before sharing, set `PASEO_ROOMS_RELAY_KEY` in the environment of the Paseo
daemon. That credential authorizes this laptop to register rooms with a relay;
it is intentionally never stored in the plugin or Git repository. The default
public origin is `https://paseo-rooms.pyratzlabs.fr`; use
`PASEO_ROOMS_PUBLIC_URL` and `PASEO_ROOMS_RELAY_URL` together for a private
relay. These are runtime credentials/settings, not installation paths.

## Updates and debugging

```sh
paseo plugin update paseo-rooms
paseo plugin logs paseo-rooms
```

Git plugin code and its manifest preparation commands are trusted, unsandboxed
code on the daemon host. Install only revisions you trust. A plugin update
restarts the in-memory room runtime, so existing share links are invalidated.
