---
sidebar_position: 1
---

# Share your first room

This tutorial takes you from a running Paseo conversation to a browser-based shared room.

## Before you begin

- Paseo desktop is running with the Paseo Rooms plugin installed.
- The plugin is configured to find this checkout and can start its local room server.
- You have an active Paseo agent session to share.

## Create the link

1. Open the agent's **Share session** panel in Paseo.
2. Select **Create share link**.
3. Copy the resulting URL and send it only to collaborators you intend to invite.

The link is a capability: anyone who receives it can enter the room while it remains active. It is not an account invitation.

## Join as a collaborator

1. Open the link in another browser or device.
2. Enter a display name when asked.
3. Read the shared timeline, send a message, or answer an agent question when one is presented.

The host's Paseo app remains the authority for the agent. The room exposes only the conversation controls explicitly supported by the room server.

## End access

Return to **Share session** in Paseo and choose **Revoke link**. Existing browser connections close and future visits to that link are rejected. A laptop or room-server restart also removes current encrypted rooms because their keys and membership live only in memory.
