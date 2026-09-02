---
sidebar_position: 1
---

# Install the Paseo plugin

The plugin adds the **Share session** action inside Paseo. It is installed locally because it starts and controls the local room-server companion process.

## Install from a checkout

The plugin requires a Paseo build that advertises plugin management. From a compatible Paseo checkout, run:

```bash
node packages/cli/dist/index.js plugin install /path/to/paseo-rooms/apps/paseo-plugin
node packages/cli/dist/index.js plugin ls
```

Configure `apps/paseo-plugin/paseo-rooms.config.json` for your machine. At minimum, set `roomsPath` to this repository's `apps/relay-web` directory. The default configuration is intentionally development-oriented; future package management will replace this checkout-based installation flow.

## Verify

Open an agent in Paseo and select **Share session**. Creating a link should start the room server when necessary and return a public room URL.

If it cannot start the server, check the configured path and use the plugin's server-side logs. See [the project source](https://gitlab.com/pyratzlabs/software/paseo-rooms) for the current configuration schema.
