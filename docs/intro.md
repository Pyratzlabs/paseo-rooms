---
sidebar_position: 1
slug: /
---

# Documentation

Paseo Rooms lets engineers work together in a single Paseo agent conversation without giving collaborators access to the host's Paseo daemon, workspace, or credentials.

Use this documentation according to what you are trying to do:

- **Tutorials** teach the complete first-sharing workflow.
- **How-to guides** solve a specific operational task.
- **Reference** defines the protocol and its guarantees.
- **Explanation** describes why the system is shaped this way.

## What exists today

The current product has a Paseo desktop plugin, a laptop-side room server, and a public relay/web application. The public room client is served by the relay today. Its encrypted transport protects room payloads in transit from the relay, but it does **not** yet protect against a relay operator replacing the page itself. Trusted static-client delivery and package management are planned follow-up work, not current guarantees.

Start with [Share your first room](tutorials/share-your-first-room).
