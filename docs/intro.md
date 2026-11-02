---
sidebar_position: 1
slug: /
---

# Work together in one agent conversation

Paseo Rooms lets you invite a teammate into an existing Paseo coding-agent session. They open a link in a browser, see the conversation, and contribute to the same running agent. The host keeps Paseo, its workspace, and its tools on their machine.

<div className="rooms-diagram" role="region" aria-label="Shared conversation diagram; scroll horizontally on small screens" tabIndex={0}>
  <img src="/docs/img/diagrams/shared-conversation.svg" alt="Without Rooms, the host copies messages between an agent and a teammate. With Rooms, both people contribute to one shared conversation." />
</div>

<p className="rooms-diagram-hint">Scroll sideways to explore the diagram, or open it full-size below.</p>

[Open the full diagram](/img/diagrams/shared-conversation.svg).

## What you can do today

- **Join an existing conversation.** History loads from Paseo and new replies stream to everyone in the room.
- **Contribute in context.** Send attributed messages and answer supported structured questions and approvals. A display name helps the conversation; it does not verify identity.
- **Share an image.** Attach or paste a still PNG, JPEG, or WebP in an encrypted room. The agent and other room participants can see it.
- **Read the output together.** Markdown tables and Mermaid diagrams render in the room.
- **End access.** Revoke a link from the host's **Share session** panel.

The plugin currently supports **Paseo 0.12.x**. A host needs Paseo and the plugin; collaborators need a compatible browser and the complete invitation link. Rooms is an open-source experiment, not a managed team identity or permissions service.

## Start with a real session

1. [Install the plugin](how-to/install-the-plugin).
2. [Create a room and invite a teammate](tutorials/share-your-first-room).
3. [Manage access and recover from outages](how-to/manage-share-links).

Creating a link does not start a new agent: it shares the selected session. The hosted relay uses automatic discovery and does not require a registration key.

## How the pieces fit

The plugin runs a local room runtime beside Paseo. It connects outward to a relay; browser participants establish encrypted channels through that relay to the host. The default browser client is published separately on GitLab Pages. The relay routes traffic rather than storing a conversation database.

A room link grants conversation controls for one agent, not a general connection to the Paseo daemon. **Participants can still influence what that agent does with its host-side tools.** Invite people you would trust to contribute to that session, and keep the agent's permissions appropriate to the task.

Read [Architecture](explanation/architecture) for the visual overview and [Security and privacy](explanation/security-and-privacy) for the trust boundaries. [The protocol reference](protocol-v2) defines the wire format.

## What comes next

We are exploring whether the same shared context can help distinct agents collaborate under human supervision. A browser-mediated self-message test worked; that is a transport experiment, not a shipped multi-agent coordinator. See [Why Rooms, and what comes next](explanation/why-rooms).
