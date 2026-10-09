# Speed mode

**Status:** Accepted by the owner, 2026-10-09 (decision card in the project thread «علت کندی و برنامهٔ یک‌هفته‌ای»).

## Context
By 2026-10-09 about 25% of the platform was coded. Most model usage went to re-reading long
documents and long session contexts, three role reviews per PR, small PRs, design documents
written ahead of code, and bookkeeping. The identity track alone used about 46% of usage.
The single-open-migration rule, Figma round trips and owner approvals added waiting time.

## Decision
1. Coding runs on the cheaper model. The stronger model is used only for security review of
   sensitive paths.
2. One fresh session per work package, with a handoff of 5 KB max. No session lives longer than a day.
3. CI is the main gate. One combined QA + QC review per batch of PRs. The security review stays
   mandatory, but only for the paths listed in CLAUDE.md.
4. One complete feature per PR.
5. No new G1/G2 or design documents. Existing docs are read by section, not whole.
6. The board and status docs are updated once a day.
7. The single-open-migration-PR rule is lifted. Rebase before merge, and regenerate the migration if needed.
8. Figma-first is paused for this period. UI is built from existing tokens and components.
9. At most four parallel build tracks, and one daily decision card for the owner.

## Consequences
- Fewer review passes per change means more reliance on tests and CI. Security-sensitive paths
  keep a dedicated review, and the independent penetration test is still required before real money.
- Figma falls behind the code and is back-ported later.
- The owner can lift speed mode at any time. The overridden rules then apply again.
