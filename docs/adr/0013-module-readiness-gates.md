# ADR-0013: Module Readiness Gates Before Design and Coding

**Status:** Accepted — 2026-09-30 (owner decision)
**Relates to:** CLAUDE.md working rules, TEAM-PLAYBOOK-fa.md, PLAYBOOK-fa.md,
`docs/modules/`

## Context
The owner wants every critical part of the platform (product and catalog, orders,
vendors, sales, payments, and so on) reviewed with the owner and the relevant team roles
before design and coding start, so production begins from correct decisions. Phase 0
showed the value: reviewing before writing caught the certification-tag conflict and the
product-scope gap before any code existed. Reviewing every small slice would be too slow.

## Decision
1. **Gates per module, not per slice.** Each module passes two gates before its first
   slice is coded:
   - **G1 — Scope and capabilities:** goal, users and roles, feature IDs in and out of
     scope, priorities, business questions. Owner, product-owner, cto (plus
     product-designer when there is UI). Output: an approved module brief.
   - **G2 — Design:** domain model, state machines, module boundaries, API and events,
     physical data design, user flows, risks. software-architect, cto, database-designer,
     ui-ux-designer for UI, security-tester for sensitive modules. The owner reviews a
     summary and answers the decisions only they can make. Output: design doc (+ ADR if a
     decision crosses modules).
2. **Tiers by criticality** (register in `docs/modules/README.md`):
   - **A — G1 + G2 + security review:** identity, sellers (vendor management),
     certification, catalog (products, categories, offers), inventory, ordering,
     payments, commission-payouts, tax. *(Amended by ADR-0019: plus `assistant`.
     `platform/ai` is platform code, not a module: its design document is approved in
     parts by the CTO, with security-tester review.)*
   - **B — one combined gate:** cart, shipping, notifications, search, content (CMS, blog),
     legal, promotions. *(Amended by ADR-0024: plus `pricing`, which becomes
     tier A on the conditions of ADR-0024 decision 3.)*
   - **C — product-owner approval only:** reporting and other P2+ features without money,
     trust or personal-data impact.
3. **Definition of Ready.** No design work starts for a module without an approved G1 brief,
   and no code is written without an approved G2 (or the combined gate for tier B). The
   approval (who, date) is recorded in the brief. qc-release-manager fails a slice or phase
   whose module lacks it.
4. **Change control.** After the gates, slices proceed without new meetings. A change of
   scope or of a hard rule during coding triggers a mini-review of that change only,
   recorded in the brief's change log.
5. **Format.** One brief per module at `docs/modules/<module>/brief.md` from the template in
   `docs/modules/_template/brief.md`. The owner gets a Persian summary, questions one at a
   time, and a diagram for complex flows. Gates focus on decisions; easily reversible
   decisions are deferred on purpose.
6. **Pipelining.** The brief for the next module is prepared while the current module is
   being coded, so the team does not wait on reviews.
7. **"Sales management"** is not a single module: it maps to ordering, commission-payouts,
   promotions and reporting, each gated by its own tier.

## Consequences
- Roughly 10-15% more calendar time per module, mostly hidden by pipelining.
- Decisions are made once, visibly, and traceable to the owner.
- Phase 1 (technical skeleton) needs cto approval only.

## Alternatives considered
- Review every slice with the owner: too slow; owner attention spent on non-decisions.
- Review only at phase end: problems surface after code exists.
- No formal gate: relies on memory and habit; not enforceable by QC.
