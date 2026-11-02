# Paseo Rooms article handoff

`paseo-rooms.md` is an English draft for pyratz.com, written in Thomas's first-person voice from his account of the team's workflow. It has not been published. Confirm the byline when moving it into the CMS.

## Shared figures

The article and documentation reuse the same diagrams under `apps/docs/static/img/diagrams/`:

| Asset                       | Purpose                                                                 | Documentation page |
| --------------------------- | ----------------------------------------------------------------------- | ------------------ |
| `shared-conversation.svg`   | The original handoff and the shared-room workflow                       | Documentation home |
| `room-architecture.svg`     | Host, relay, browser delivery, and trust boundaries                     | Architecture       |
| `collaboration-roadmap.svg` | Current features, the observed self-message experiment, and future work | Why Rooms          |

These are architecture/workflow diagrams, not measured performance charts. Both SVG and 2400-pixel-wide PNG versions are included. Their editable source is `scripts/generate-doc-diagrams.py`; regenerate the SVGs with `python3 scripts/generate-doc-diagrams.py`, then run `npm run format --workspace @paseo-rooms/docs`. Re-export the PNGs from the SVGs at 2× before changing the article assets. SVGs include titles and descriptions, and the article supplies alt text and captions. The diagrams intentionally contain no customer data, live invite, or expiring address.

The draft uses relative image links so it can be reviewed from the repository. The article uses the PNG companions for CMS compatibility. Upload these three assets to the pyratz.com CMS and replace the relative image URLs with the CMS URLs. The same assets will be available under `https://paseo-rooms.pyratz.com/docs/img/diagrams/` after deployment. Keep the SVGs as the editable source.

## Before publication

1. Keep DNS until the article and documentation are reviewed, as requested. Complete the DNS/TLS cutover described in `docs/how-to/migrate-hosted-domain.md`, then deploy and check the product and documentation links. The draft's target hostname does not resolve yet as of 2 November 2026.
2. Confirm Thomas's byline and first-person account; the inspiration is the team's remote debugging/planning workflow, not an invented product attribution.
3. Keep the distinction between available human collaboration, the single-agent self-message test, and future distinct-agent coordination.
4. Verify the supported Paseo version in the plugin manifest. This draft does not claim compatibility beyond the currently supported 0.12.x series.
5. Check the three image captions and alt text after CMS import. Remove the draft front matter if the CMS does not use it.

External background references: [Paseo](https://paseo.sh/), [official plugin documentation](https://paseo.sh/docs/plugins). Feature and security claims come from this repository and the tested room flow. No usage, performance, or adoption numbers are claimed.

## Release prerequisites observed during preparation

- The public GitHub mirror's main branch was still at `5cb8c0d` on 2 November, behind GitLab main (`fd379c0`). Sync the reviewed release to the public mirror before sending readers to its clone instructions. This task did not push the mirror.
- [Port fix MR !33](https://gitlab.com/pyratzlabs/software/paseo-rooms/-/merge_requests/33) is open with a successful pipeline. Include it in the public release so plugin installation does not compete with Next.js for port 3000. The live local test checkout already has that fix, but GitLab main does not.
- Nothing in this branch was deployed, and the new DNS name was deliberately left until last. The site URLs in the draft are publication targets, not a claim that the cutover has happened.
