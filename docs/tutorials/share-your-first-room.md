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

## Send an image

In an encrypted room, select **Attach image** or paste an image into the message box. You can attach one still PNG, JPEG, or WebP up to 2 MiB, with at most 8192 pixels per side and 16 million pixels total. Review the preview, optionally add a caption, and select **Send**. An image can also be sent without a caption. Select **Remove** to change the attachment before sending.

The original image bytes are forwarded to the agent. Everyone in this room can select the thumbnail to enlarge it; Escape closes the image. Images attached directly in Paseo are not imported into Rooms. Older rooms or hosts that do not support images do not show the attachment control.

Uploads show progress and the draft clears when delivery is confirmed. If delivery is uncertain, use **Check delivery** to look up the original attempt without sending it again. **Discard draft** lets you continue chatting; sending the same image as a new message could duplicate an earlier delivery. A daemon rejection whose delivery cannot be determined is also treated as uncertain.

Room images live in the host's memory while that encrypted room exists, including when everyone disconnects or the managed listener stops and starts in the same process. Revoking the room or restarting the host process removes them. A room can retain up to 32 MiB and 128 images; the host has a shared 128 MiB / 512-image limit. If the room is full, ask the host to create a new room. These limits include uploads in progress. Images never use a public media URL or the legacy HTTP message API.

## End access

Return to **Share session** in Paseo and choose **Revoke link**. Existing browser connections close and future visits to that link are rejected. A laptop or host-process restart also removes current encrypted rooms because their keys and membership live only in memory.
