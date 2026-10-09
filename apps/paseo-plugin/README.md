# Paseo Rooms plugin

The **Share session** Paseo extension and its laptop-side room runtime are
distributed together from the repository root. The root `paseo-plugin.json`
prepares the exact monorepo revision before Paseo validates, compiles, and
activates the plugin.

## Install

Paseo 0.10.3 or newer within the 0.10 series is required. Older versions are
unsupported. The supported installation path is a trusted local checkout:

```sh
paseo --version
paseo plugin install /path/to/paseo-rooms
paseo plugin status paseo-rooms
```

The plugin owns the room server in its daemon-side process. It starts one
loopback listener on demand, waits up to 10 seconds for its daemon connection,
keeps the admin token server-side, and closes the listener when Paseo reloads, updates, disables, or shuts down the plugin. A failed
or timed-out connection closes the listener so sharing can be retried. No
checkout path, detached child process, or `roomsPath` configuration is required.

After changing that checkout, apply it with `paseo plugin reload paseo-rooms`.
Git-hosted release installation and package management are deliberately
postponed until there is a stable release workflow.

## Runtime settings

`PASEO_ROOMS_PORT` changes the loopback port (default `3000`). `PASEO_HOME`
chooses the parent data directory; the room runtime stores its local state in
`$PASEO_HOME/paseo-rooms` (or `~/.paseo/paseo-rooms`).

Set `PASEO_ROOMS_RELAY_KEY` in the environment of the Paseo daemon to use the
configured default relay. That credential authorizes this laptop to register
rooms; it is intentionally never stored in the plugin or Git repository. A
relay selected directly in the Share session widget instead receives its
registration key with that individual request, so the local room listener can
start even when no default key is configured. New default links use
`https://paseo-rooms-9eb268.gitlab.io`, the independently deployed browser
client, and connect to the relay at `https://paseo-rooms.pyratzlabs.fr`.
For a private relay, set `PASEO_ROOMS_PUBLIC_URL` and
`PASEO_ROOMS_RELAY_URL`; its own client remains the default. Set
`PASEO_ROOMS_CLIENT_URL` to use any separately hosted client instead. These are
runtime credentials/settings, not installation paths.

Existing installations can keep their key in `~/.config/paseo-rooms.env`
(`$XDG_CONFIG_HOME/paseo-rooms.env` when set). If no relay key is supplied in
the daemon environment, the plugin reads `RELAY_KEY` from that file only when
its `RELAY_URL` matches the configured host endpoint exactly. Other settings
in the file are not imported, and the key never goes to the browser. The file
is parsed as dotenv data, not executed as a shell script.

## Updates and debugging

```sh
paseo plugin update paseo-rooms
paseo plugin logs paseo-rooms
```

Git plugin code and its manifest preparation commands are trusted, unsandboxed
code on the daemon host. Install only revisions you trust. A plugin update
restarts the in-memory room runtime, so existing share links are invalidated.

## Development build

`npm run build:plugin` at the repository root bundles this workspace's
`index.client.tsx` and `index.server.ts` into ignored `client/plugin.js` and
`server/plugin.js` artifacts. The root runtime entries load those artifacts.
This preserves the monorepo layout while satisfying Paseo's directory
boundaries; the browser bundle never contains the local room server.
The manifest runs this build before verification on installation and reload.
Edit the workspace sources, not the generated bundles.
