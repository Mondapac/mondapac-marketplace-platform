# ADR-0031: Fail-Closed Placeholder Bindings for Unmerged Cross-Module Facades

**Status:** Proposed — 2026-10-08. Drafted for Ali's ruling of the same day on the catalog slice
order (`docs/design/domain/catalog.md` 15.1); needs Hassan's review and Ali's acceptance.
**Relates to:** ADR-0008 (module facades), ADR-0012 decision 1 (certification enforcement),
ADR-0013 (readiness gates), ADR-0018, `docs/design/domain/catalog.md` 6, 9.7, 15.1,
`docs/design/domain/sellers.md` (slice 9; the `sellingEligibility` stand-in of PR #94).

## Context
`catalog` slices 5 to 7 need `certification.matchClaimTerms`, `sellers.sellingEligibility` and
`sellers.allowedProductTypesOf`. None is merged, and Phase 4 (`inventory`, `pricing`, `cart`) waits
on catalog slice 7. Building in strict dependency order delays Phase 4 for weeks. A permissive
stub on `main` would put a hole in a hard rule (ADR-0012 decision 1; CERT-21 entry paths); a feature
flag only hides it. The same question recurs across `certification`, `sellers`, `pricing` and
`inventory`.

## Decision
1. **Fail-closed only.** A module may merge a slice that calls another module's not-yet-merged
   facade method through a port it owns, bound to a placeholder that behaves exactly as the real
   facade being down: a check answers "unavailable" (`claim-text.check-unavailable`), eligibility
   answers "no" for every id, an allow-list read answers "error" (a refusal). Never "all", never
   "yes", even where the real answer will be that: the placeholder must not guess. Introducing a
   placeholder is reviewed by Hassan in the PR that adds it; the PR names the consumer's existing
   fail-closed path that the placeholder triggers.
2. **No permissive fake outside tests.** Fakes live only in `**/*.fake.ts` under `test/` or
   `contracts/testing/`, which is excluded from the production build; `pnpm boundaries` fails on
   any import of them from non-test code. The composition root has one binding per port, no
   environment switch to another, and no `useFactory` or `useClass` selection reading config or
   `process.env`; `overrideProvider` appears only under test paths (boundaries rule).
   2a. **Branch-free.** The placeholder is a constant answer: it reads no input, config or
   environment. The port has no optional parameters with defaults. No consumer code catches a
   port error and substitutes a value, and no "fallback to placeholder or real" wrapper exists.
   Each consuming slice has a test with the placeholder bound, in production wiring, asserting
   the refusal end to end (HTTP, Import row and event handler) on both Market fixtures.
3. **One binding PR per dependency.** Replacing a placeholder by the real facade is its own small
   PR, reviewed by Hassan, and re-runs the consuming slice's acceptance cases against the real
   facade. The consuming slice's security sign-off is conditional until then. The binding PR
   deletes the placeholder class and its registry entry.
4. **Not launchable while a placeholder is bound.** Every placeholder must be replaced before the
   first sale. Each placeholder is a class marked `@FailClosedPlaceholder('<port>')` under
   `infrastructure/placeholders/`; the bound set is derived at start-up from the composition root,
   not hand-maintained, and logged. The API and worker refuse to start when the bound set is
   non-empty and the deployment environment is production (checked as the existing role and
   HOSTED_MARKETS checks are, with no override). A required CI check on the production deploy
   pipeline fails while the set is non-empty. Producer-side stand-ins such as the
   `sellingEligibility` one of PR #94 are marked and counted the same way. Bagher
   (qc-release-manager) confirms both at the release gate.
5. **Controls that are the rule itself are never stubbed.** Certification tags (`evaluateClaims`,
   catalog slice 8) have no placeholder; slices that depend on them keep their full order. Nor is
   any authentication, authorization or ownership check, any `payments` or `commission-payouts`
   call, any `pricing` price or Cost write or Cost-carrying read, or the AI claim guard ever a
   placeholder.
6. **Contracts first.** The producing module may merge a contracts-only PR (facade signature and
   v1 event schemas) so consumers build against fakes; its production binding answers "absent",
   which consumers already treat as not sellable. The contracts-only PR lists each consumer's
   handling of "absent" (cart K-1 for `offerSellUnits`) and is reviewed by Hassan.

## Consequences
- Phase 4 can code against `offerSellUnits` and `offer-created` before certification slice 2 and
  sellers slice 9 merge; `offer-deleted` and `offer-moved` still wait for catalog slices 14 and 16.
- Until bound, the running system cannot create checked content; that is the intended failure.
- Each placeholder adds one swap PR and one release-gate line item.

## Alternatives considered
- Strict dependency order: safest, but serialises three modules behind one.
- A permissive stub behind a feature flag: rejected; the flag is the hole.
- A matching test fake in production wiring: rejected by decision 2.

## Reviews
Ruling: Ali (cto), 2026-10-08, in the catalog thread. Hassan (security-tester): conditional approval, 2026-10-08; blockers B1 to B3 and the should-fix items are applied in this text, his confirmation is pending.
