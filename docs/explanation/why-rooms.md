---
sidebar_position: 3
---

# Why Rooms, and what comes next

Rooms grew out of our team's remote planning and debugging workflow. A developer would ask for help with an agent session, send the problem to Thomas, and wait while he consulted his own agent and sent an answer back. Useful context had to travel between two people and two conversations.

In the office, Thomas could join the discussion at the developer's laptop. Remotely, screen sharing helped, but occupied the developer's environment while someone else investigated. A room lets a teammate contribute directly to the existing agent thread while the developer works on something else.

The same workflow can include a client who needs to answer business questions while a plan takes shape. Choose a session whose history and agent permissions are appropriate for the people invited.

The interaction model is familiar from pair programming and shared documents. The specific inspiration was that practical team workflow, rather than a claim of affiliation with another product.

## Why build on Paseo?

[Paseo](https://paseo.sh/) already runs coding agents and provides the history and live events Rooms needs. Its [plugin system](https://paseo.sh/docs/plugins) lets sharing appear alongside the selected session, with a client panel and daemon-side RPCs. Rooms uses the official TypeScript SDK rather than managing a second agent process or conversation store.

That keeps our contribution focused: invitation links, room-scoped operations, browser participation, encrypted routing, and shared rendering. The current integration supports Paseo 0.12.x; newer minor versions require a compatibility review.

## From people to agent participants

We tested an agent opening a room through a separate browser client and sending a message back into its own session. The message arrived, and the agent replied. The test ended after one exchange.

That verifies a useful building block: a browser participant can be driven by an agent. It does not demonstrate two independent agents completing a task together, autonomous coordination, or a safe unattended loop.

<div className="rooms-diagram" role="region" aria-label="Collaboration roadmap diagram; scroll horizontally on small screens" tabIndex={0}>
  <img src="/docs/img/diagrams/collaboration-roadmap.svg" alt="Today, people share one agent conversation. A single-exchange browser self-message experiment worked. Distinct-agent collaboration with explicit roles, scoped access, budgets and human oversight remains future exploration." />
</div>

<p className="rooms-diagram-hint">Scroll sideways to explore the diagram, or open it full-size below.</p>

[Open the full diagram](/img/diagrams/collaboration-roadmap.svg).

The next experiments should give distinct agents a bounded task and make authority explicit: who can speak, who can invoke tools, how turns are assigned, when the exchange stops, and which decisions require a human. A room display name alone is not an authenticated agent identity.

Other practical next steps include a clearer release and installation path, compatibility checks against new Paseo versions, and more reliable client delivery. These are directions for the project, not announced release commitments.
