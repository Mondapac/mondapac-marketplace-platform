# ADR-0028: Certification Claim Contract Amendments

**Status:** Accepted — 2026-10-07 (owner decision). Drafted by Mohammad (software-architect) with the
`certification` G2 design. Reviewed by Ali (cto) and Hassan (security-tester) on 2026-10-07:
accept with changes, applied below (CD 19.4). Accepted before the `catalog` G2 (board requests 13 item 1 and 15 item 1). No owner decision is
changed: every rule below either restates an approved G1 answer or settles a point both G1 briefs
left to this ADR.
**Amends:** ADR-0010 decisions 3 and 8; ADR-0012 decisions 2 (adds a second-admin rule for relaxing revisions), 3, 5, 6 and 8; ADR-0005 decision 3
(table row "Certificate expiry"). The amended ADRs are not edited; this ADR is read with them.
**Relates to:** ADR-0006 decisions 3 and 5, ADR-0008 decisions 5 and 6, ADR-0009 decisions 2 and
3 (V1, V3), ADR-0018 decision 4, ADR-0019 R1 and decision 10, ADR-0022, ADR-0024 decision 6,
ADR-0026 decision 9 (Accepted 2026-10-07: certification types, issuers, claim basis policies and the Market
`defaultTimezone` are never admin-editable settings; they change only through the use cases and
second-admin rules of this design);
`docs/modules/certification/brief.md` (s5, s6, s8 item 16, s11), `docs/modules/catalog/brief.md`
(s5, s6, s11), `docs/design/domain/certification.md` (cited as "CD 4.2")

## Context
ADR-0012 decision 5 gave `certification` one enforcement point, `evaluateClaim`, and `catalog`
one rule: accept a tag only with a matching `ClaimDecision`. The G1 reviews of `certification`
and `catalog` (2026-10-03) found gaps in that contract: the signature lacks the seller's
attestation that decision 4 requires; the decision names certificate ids but not their versions,
while decision 8 snapshots versions; nothing says who owns the daily reconciliation or the
purchase-time check; there is no event for a material product change or a coverage change; the
manufacturer certificate's expiry zone is undefined (ADR-0005 measures expiry in the seller's
zone, and a manufacturer certificate has no seller); the owner's answers on issuer derecognition
(Q6) and "verified with issuer" (Q7) need a place in the contract; and the `catalog` G1 added
entry paths (revision publish and revert, platform category move, merge, archive, CAT-53) and the
rule that a decision is accepted only when its inputs match the state being stored. `catalog`
depends on `certification`, so `certification` cannot import `catalog` without a cycle.

## Decision
1. **Input.** `evaluateClaim` (batched as `evaluateClaims`, at most 100 queries) takes per query:
   the Offer owner's seller id, product id, **the product revision id the Offer sells**, variant id
   or none (asked once per variant on sale),
   type code, handling, **whether the per-Offer attestation is recorded**, and **every path, root
   first, of every platform category of the product's published revision**. A seller's shelf
   category is never an input. The Market comes from the `MarketContext` only. Inputs are taken by
   the caller from the state it will store, never from the request body, the acting admin or an
   acting-as session. The evaluation rule is unchanged from ADR-0012 decision 2: the strictest
   matching policy row wins (every category of every path and the handling together), and the
   type's default applies only when no row matches. Amends ADR-0012 decision 5.
2. **Output and its use.** `ClaimDecision` holds: allowed; basis; a closed reason code; the
   certificate kind, id, **version** (the seller submission or manufacturer revision), issuer id,
   type revision and validity end; the policy revision or "default"; badge data (decision 12);
   **the inputs it decided on**; the instant. It is valid only in the request that asked. It is
   never stored as an authorisation, re-presented, or accepted from a client or an Import file.
   The Offer accepts it only if the returned inputs equal the state being saved, in the Offer's
   write unit under its version; a writer that loses asks again. Amends ADR-0012 decision 5.
3. **Copy, not reference.** The tag `catalog` stores, and every copy of it (search, caches), is a
   copy for display and for selecting tags to ask again. It can only restrict (take an Offer off
   sale, mark a tag for re-evaluation), never permit. Amends ADR-0010 decision 3.
4. **Purchase moment.** Order placement (`ordering`) asks `evaluateClaims` again in the same
   request for every claim on every line. Until the answer is "allowed", the Offer cannot be
   bought with that claim. A re-evaluation still in flight never counts as allowed.
5. **Entry paths.** Every path that can create or keep a claim goes through `evaluateClaims`:
   Offer create and edit; handling, attestation and category change; publish of a product revision
   (approval, automatic publish with approval off, revert under VER-05), fanned out to every Offer
   of a PLATFORM product in idempotent batches; platform category move, merge and archive
   (CAT-50, CAT-53); match (CAT-45); promotion (CAT-44); Import (OFR-12); **Offer reactivated or
   unsuspended; a variant added to an Offer; a tag re-enabled**; handlers of every event of
   decision 6; the daily reconciliation run; order placement. Retire (CAT-48) and delete only take
   Offers off sale. A platform category move, merge or archive first asks `certification` whether
   the category may go, and is **refused while a claim basis policy row that could relax on its
   lapse** (`NOT_APPLICABLE` or `SELLER_REQUIRED`) names the category, until an admin moves those
   rows; a `SELLER_OR_MANUFACTURER` row can only get stricter on lapse and is flagged, not
   blocking. A failed claim-text check refuses the save. security-tester review is mandatory for each path (ADR-0012 decision 9).
6. **Events.** `certification` publishes, as triggers only: seller certificate submitted,
   approved (with kind initial, resubmission or renewal), changes requested, declined, expired,
   revoked, issuer confirmed, expiry warning due; manufacturer certificate approved, expired,
   revoked, suspended (names of ADR-0012 decision 6), **coverage changed**, expiry warning due;
   claim policy changed; type revised (with "claim terms changed"), activated, deactivated; issuer
   deactivated with its form. `catalog` publishes **`catalog.product-material-content-changed.v1`**
   when a published revision changes an attribute flagged material (manufacturer, ingredients,
   barcode); the flag is set by people on the attribute definition. Payloads hold ids and enums
   only. Amends ADR-0010 decision 8 and ADR-0012 decision 6.
7. **Manufacturer certificate review.** The approver is a person other than every admin who
   created or edited the record, a document or the coverage of the revision under review
   (broadens ADR-0012 decision 3's "different admin"). Coverage is part of an immutable revision
   and names, per product, the product revision it was checked against; a query for another
   product revision is "not covered" until a new coverage revision is approved; an entry narrowed
   to variants never covers a query without a variant. An edit after approval is a new pending revision that another person reviews, while the
   approved revision and its coverage stay live; approval of it publishes "coverage changed". To
   stop coverage at once, an admin suspends the certificate. Reinstatement after suspension is a
   re-review under the same rule. Amends ADR-0012 decision 3.
8. **Expiry zones.** A manufacturer certificate is valid through the end of its expiry date in
   the Market's default time zone, one instant for every Offer. A seller certificate keeps the
   seller's zone (ADR-0005 decision 3), measured with the seller's current non-provisional zone and
   never later than the boundary in the zone at approval, so a zone change never extends or revives
   a certificate; no seller zone means "not allowed". *(Amended 2026-10-08, seller-chosen zone: the seller boundary is the earliest of the boundary stored at approval, the boundary in the seller's current chosen zone and the boundary in the zone the approved address gives; the fixed read returns both zones. See `docs/design/domain/certification.md` 2.3 T2 and `docs/reviews/sellers-spike-3-zone-source.md`.)* **The zone used is independent of the
   caller:** it comes from one fixed read that returns the same answer to every actor; status
   records and review guards may use the provisional zone, the claim never does. Validity is computed at the instant of the
   question and never waits for the expiry job. Amends ADR-0005 decision 3.
9. **Dependency direction.** `catalog` and `ordering` depend on `certification`, never the
   reverse. `certification` reads product, variant and platform category existence through a port
   it declares and `catalog` implements (`CatalogReferences`, `MarketContext` only). `catalog`'s
   own handlers call `certification`'s facade (system rule) for a material content change and for
   retired platform categories, as `sellers` calls `identity` (ADR-0022 decision 2). `catalog`'s
   move, merge and archive of a platform category call a `certification` facade check **before**
   committing and are refused on its refusal or error (decision 5); the post-commit call is a
   backstop that flags rows and alerts admins.
10. **Reconciliation.** `catalog` owns the daily reconciliation run: it asks again for every
    active and suspended tag of both bases, per Market, in the worker. Amends ADR-0010 decision 3
    and ADR-0012 decision 6, which named the run without an owner.
11. **"No longer recognised".** An issuer deactivated in this form makes every approved
    certificate it issued, seller and manufacturer, invalid from that instant (part of the one
    validity measure, not a per-certificate write); `certification` publishes the issuer event and
    tells each affected seller why and what to do. `catalog`'s tag copy keeps the issuer id from
    the decision, so it selects the affected tags without asking. The other form, "no new
    certificates", leaves approved certificates valid until their own expiry.
12. **"Verified with issuer".** Only a human reviewer records an issuer's confirmation, on one
    submission or revision, through a contact channel registered for that issuer, confirming that
    certificate number and that holder. Badge data carries the flag only from the version the
    decision names; a renewal without a new confirmation does not have it; it never changes
    "allowed" and never applies to a self-declaration. The order snapshot (VER-06, V3) copies the
    decision and its badge data, flag included, as what the customer was shown; it authorises
    nothing later. Amends ADR-0012 decision 8.

## Consequences
- `catalog`'s G2 can design tags, re-evaluation and the reconciliation run against a fixed
  contract; `ordering`'s G1 inherits decisions 4 and 12.
- Every buy-side claim costs one more synchronous call; there is no cache, by design.
- A race between a tag write and a revoke is closed by the purchase-time check and the events,
  not by a cross-module transaction (ADR-0004 decision 5).
- `catalog` stores more in a tag copy (certificate version, issuer id, inputs) and implements one
  port of `certification`.
- A material content change suspends a manufacturer certificate as a whole (ADR-0012 decision 3
  as written), so one edit can take many Offers off the badge until re-review.
- The access rule of `evaluateClaims` needs no change to ADR-0018 decision 4: it uses the
  anonymous-and-system pair already approved for `identity.sellerAccessOf` and
  `sellers.sellingEligibility` (CD 7.4; confirmed by cto 2026-10-07). The `ClaimGuard` and
  `CatalogReferences` ports are named exceptions on the checked-in list, reviewed by
  security-tester, with a CI-enforced caller list.
- Relaxing a claim basis policy (for example a row to `SELLER_OR_MANUFACTURER`) or a type setting
  that feeds the claim needs a second admin; a certification type's verification mode never
  changes (CD 3.6, 3.7). This adds a second-admin rule for relaxing revisions to ADR-0012
  decision 2.
- A platform category named by a policy row cannot be retired until an admin moves the row, which
  adds a step to `catalog`'s category administration.
- The penetration-test scope of ADR-0024 decision 6 ("attempts to bypass CERT-21") covers every
  path of decision 5.

## Alternatives considered
- **Return only "allowed" and a basis** (no echoed inputs, no versions): `catalog` cannot detect a
  decision made on a state that changed before its write, and snapshots lose the version.
- **`certification` subscribes to `catalog`'s events or calls its facade:** a module cycle, which
  the boundary rules forbid; a read model of products in `certification` would duplicate
  `catalog`'s data for one check.
- **`certification` owns the reconciliation run:** it would need every tag, which is `catalog`'s
  data (ADR-0010 decision 2).
- **Manufacturer expiry in each Offer owner's zone:** one certificate would expire at several
  instants and badges would differ by seller for the same evidence.
- **Coverage edits applied at once, or the whole certificate back to review:** the first lets one
  admin widen coverage alone; the second removes the badge from every covered product for a
  one-product correction.
- **A stored "derecognised" status written into each certificate:** a fan-out that must finish
  before the effect holds; the issuer state in the validity measure takes effect in one write.
