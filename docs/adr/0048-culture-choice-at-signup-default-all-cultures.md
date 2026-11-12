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
    the certificate expired and revoked events, and for every seller of a derecognised issuer,
    when no valid certificate of the type remains.
  - Review round of #848 (security M1): `sellerValidCertificateTypes` takes the asked type codes
    and answers by the one canonical `sellerCertificateValidAt` that `evaluateClaims` uses (issuer
    allow-list of active and closed-to-new, a required expiry present, both seller zones present,
    the earliest boundary across them). The reviewer's approval and the M2 re-check read it.
  - Security M2 of #848: a hidden category hides its whole branch for the culture. A row lower
    down cannot show it again, and a row made only to set a mark leaves `visible` null (inherit;
    migration `20261112160000_catalog_culture_categories_visible_inherit`).
  - Security M3 of #848: search re-indexes on a merge (both subtrees), an archive, an issuer
    derecognised and a type deactivated; the last two and a culture's status ask for the full
    resumable reindex (`search.request-offer-reindex`), since catalog's stamp cannot see them or
    the scope is the whole Market. Security L2: a document keeps the answer of the latest read
    (`indexed_at` is the instant the sync began reading; an older write or delete is dropped).
  - Package 2 fix found here: the signup job (`ApplySignupCultures`, system) called the
    anonymous-only culture reads; `activeCultures` and `culturesByIds` now have `system` twins.
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
  - Operations alerts on `catalog.culture-edit.required-type-revert-failed`, a dead-lettered
    `sellers.demote-on-culture-approvals-invalidated` delivery and `sellers.culture-guard.demote-failed`
    are tracked as risk R-11 in `docs/project/risk-register.md` (owner: Kazem, devops-engineer),
    to be in place before the switch of package 3b is turned on.
- Package 3b scope (ADR-0047 decisions 2, 3 and 5; nothing of it is built in 3a):
  - The switch: the `multi-culture` Market setting in `settings` (keys
    `settings.multi-culture.view` / `.manage`, seeded off, restrictive safe value). Preconditions
    when it is turned on: at least two Active cultures, each still with an approved seller after
    the one-time re-check below. The confirmation shows how many Offers and sellers each culture
    would show or hide, and how many approvals the re-check took back. Audited; turning it off
    deletes nothing. Security review of the setting (ADR-0026 decision 9).
  - The one-time re-check at switch-on: every membership in a culture with a required
    certification type is checked against `sellerValidCertificateTypes` (the M2 re-check, for all
    sellers); one without a valid certificate of the type goes back to `requested`.
  - The filter on every buyer read path while the switch is on, through catalog's shared filter
    (`culture_codes` with `&&` in search, `visibleCultureCodesForOffers` / `isOfferVisibleIn`
    elsewhere); a seller with no approved culture is shown nowhere (fail closed).
  - Its contract test: every buyer read path, with the switch on and an Offer visible only in
    another culture, on both Market fixtures; it fails when a buyer read path skips the filter.
