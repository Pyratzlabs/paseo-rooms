# Pyratz Review Template

Use this template for Pyratz reports that preserve both child reviews. The report starts with a short gate summary, then concatenates the full adversarial/security review and the full code-quality review.

## Gate Summary

**Gate verdict:** APPROVE | APPROVE WITH ADVISORIES | REQUEST CHANGES | DO NOT MERGE

One concise paragraph explaining the gate decision and the highest-risk reason. The gate verdict must be the strictest applicable result from either child review.

- **Adversarial / security child verdict:** APPROVE | APPROVE WITH ADVISORIES | REQUEST CHANGES | DO NOT MERGE | BLOCKED
- **Code-quality child verdict:** APPROVE | APPROVE WITH ADVISORIES | REQUEST CHANGES | DO NOT MERGE | BLOCKED
- **Security / adversarial risk:** Low | Medium | High | Critical
- **Code-quality risk:** Low | Medium | High | Critical
- **Security review depth:** Concise | Standard adversarial checklist | Full adversarial checklist | Full red-team | Blocked
- **Quality review depth:** Concise | Standard | Deep | Blocked
- **Blocking reason:** None, or the child finding / failed gate / blocked review area that forces request-changes or do-not-merge.
- **Exact next action:** Merge, fix specific findings, run missing gate, or re-review after changes.

## Scope

- **Resolved target:** source branch / PR / local diff:
- **Resolved base:** target branch:
- **Diff range reviewed:**
- **Uncommitted changes:** Included | Excluded | N/A. Evidence:
- **Shared verification:** Commands run once for both passes, if any:
- **Blocked shared verification:** Commands or checks that could not run:

## Adversarial / Security Review

Paste the full preserved output from `nico-adversarial-review` here. Do not deduplicate, summarize, rewrite, or soften findings.

## Code Quality Review

Paste the full preserved output from `nico-code-quality-review` here. Do not deduplicate, summarize, rewrite, or soften findings.
