# ADR-0048: Culture Choice at Signup, Default All Cultures

**Status:** Accepted — 2026-11-12, on the project owner's decision of 07:04Z in the multi-culture
build (package 2). Amends ADR-0047 decisions 3 and 7.
**Builds on:** ADR-0047 (culture as a catalog dimension; membership by request and review),
ADR-0001 decision 5 (core code never names a culture).

## Context
ADR-0047 decision 3 attached a new seller to the Market's default culture while the switch is off,
and decision 7 gave a buyer a stored choice with the Market's default cultures as the fallback. The
owner now wants the choice made at signup, by sellers and by buyers, and the default to be "all
cultures" (universal), not one culture. Certified cultures (a culture with a required certification
type) must still not be entered without a certificate, so "all" cannot mean "approved in all" for a
seller. Package 2 builds the seller side. The buyer side is package 4.

## Decision
1. **Sellers choose at signup.** The selection is an explicit list of Active culture codes of the
   Market, or `universal`, the default when nothing is sent. `universal` means every Active culture
   at the moment of signup; a culture added later is not added to the seller automatically. An empty
   list, an unknown code and an inactive code are refused with `validation.failed` (`cultures.N`,
   `unknown-or-inactive`; an empty list is `empty`, never read as "all").
2. **Certified cultures are never approved automatically.** For each selected culture with no
   required certification type, the membership is created `approved` at once by the system (no
   person decides; audited, and `sellers.seller-culture-status-changed.v1` is written). For each
   selected culture with a required certification type, the membership is created `requested`. It
   becomes `approved` only when an admin with the seller-review permission approves it and the
   seller holds a valid, approved, unexpired certificate of that type (read through the
   certification contract, fail closed). This replaces the automatic attach to the default culture
   in ADR-0047 decision 3; its review and certificate rules are unchanged.
3. **Where it runs.** `sellers` applies the selection through its facade (`applySignupCultures`), from
   its subscription on `identity.seller-registered.v1` with the default `universal` (an event carries
   no text, so an explicit list needs a step that has the list), and through a daily job that gives
   sellers with no membership row at all the same treatment (the test seed and sellers that predate
   this rule). A seller with any row is never touched again.
4. **Buyers (package 4).** A buyer chooses at signup too, and `universal` for a buyer means all
   Active cultures, including cultures added later, so a stored `universal` choice is not a frozen
   list. If the choice is dropped or invalid, ADR-0047 decision 7 applies. This ADR changes no
   buyer code.
5. **Unchanged.** The restrictive safe value on a settings read failure (ADR-0047 decision 2: the
   filter on, the Market's marked default culture only) and decision 5's visibility rule are
   unchanged. While the switch is off no filter applies, so approving a seller automatically in an
   uncertified culture changes nothing a buyer sees.

## Consequences
- A new seller of a Market with a certified default culture (such as the halal one) is `requested`
  there and not visible in it until a reviewer approves with a certificate, and approved in every
  uncertified Active culture at once. After the switch is turned on, a seller with no approved
  culture is hidden (ADR-0047 decision 3), so the first certified culture alone leaves a new halal
  seller hidden until reviewed; this is intended.
- The explicit list at signup needs the signup form to reach `sellers`. Identity cannot import
  `sellers`, and the seller id exists only after the email is confirmed. Until that step is
  designed (for example a first-session onboarding call of the facade), a signup always gets
  `universal`, and a seller narrows it later by request.
- `sellers.seller_cultures.requested_by` and `decided_by` are null when the system acted.
- The "universal" meaning for buyers (all Active cultures, later ones included) is a rule package 4
  must implement and test.
- Membership is not re-checked when a seller's certificate expires or is revoked (security review
  M2). Package 3 must close this before the visibility switch can be turned on, either by having
  the visibility function check the seller certificate for a certified culture, or by demoting the
  membership on the certification events.
- The required certification type of a culture is locked while any seller is approved in it
  (`culture.required-type-locked`, 409): catalog asks `sellers` through a facade method, fails
  closed, and re-checks after its own commit. The approval writers re-read the culture after their
  commit and take an approval back to `requested` if the culture became inactive or certified, so
  one side always sees the other (security review M1).
- The seed job attaches only sellers whose identity access state is pending or approved, never
  rejected or suspended ones, and runs at most 10 batches of 200 per run.
- Package 3a follow-ups (2026-11-12), all done in that package:
  - M2 is closed both ways: catalog's visibility rule checks for a certified culture that the
    seller holds a valid certificate of the type now (certification's type-codes-only facade
    method `sellerValidCertificateTypes`), and `sellers` demotes an approval to `requested` on
    the certificate expired and revoked events when no valid certificate of the type remains.
  - N1 (a failed revert of a required-type change): the simpler option, an outbox-driven retry.
    Catalog writes `catalog.culture-approvals-invalidated.v1` in its own unit and tries the
    demotion at once; the sellers consumer demotes and throws while approvals remain, so the
    outbox retries until none is left. No separate reconciliation job.
  - The demotion writes one unit per batch of 200 (database review nit 1).
  - N2: `cultureDemoteApprovals` left `SellersFacade` for a port that only
    `catalog/infrastructure/sellers-culture-members.ts` may import (boundaries rule
    `culture-demote-port-is-for-catalog-adapter`).
  - QA: the decision e2e covers an expired and a wrong-type certificate and another Market's
    seller. QC: `docs/design/data/catalog.md` notes `culture.required-type-locked`,
    `culture.locale-uncheckable` and the visibility facade.
  - Operations should alert on the log messages `catalog.culture-edit.required-type-revert-failed`
    and a dead-lettered `sellers.demote-on-culture-approvals-invalidated` delivery; the runbook
    entry is not yet written.
