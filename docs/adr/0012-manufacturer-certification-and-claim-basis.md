# ADR-0012: Manufacturer Certification and Claim Basis per Category

**Status:** Accepted — 2026-09-30 (owner decision; proposal by product-owner and
software-architect roles). Before the feature is released, a recognised halal authority
must confirm the category seed list and the principle, and legal must sign off the badge
and disclosure wording.
**Amends:** ADR-0010 decision 3 (resolves its open question 2)
**Relates to:** CERT-*, OFR-08, OFR-12, CAT-41/43/44/45, ADR-0009 (V3 snapshots)

## Context
ADR-0010 lets an Offer carry a certification tag only when the offering seller holds a
valid certificate of that type. The owner wants to relax this for halal: a seller without
a halal certificate may sell products whose **manufacturer** holds a valid halal
certificate (e.g. sealed packaged goods). Certification trust is the brand's core
differentiator, so the relaxation must stay explicit, evidence-based and fail-closed.

## Decision
1. **Claim basis.** A certification claim on an Offer rests on one of two bases:
   `SELLER` (the offering seller's certificate) or `MANUFACTURER` (an approved product
   certificate covering that product). Every claim is still a certification record attached
   to an Offer; product content never states a certification (CAT-41/43).
2. **Policy per category, fail-closed.** *(Amended by ADR-0028: strictest matching row wins; relaxing revisions need a second admin; categories in use cannot be retired.)* `ClaimBasisPolicy` (owned by `certification`,
   revisioned) maps (certification type, platform category or handling condition) to
   `SELLER_REQUIRED` | `SELLER_OR_MANUFACTURER` | `NOT_APPLICABLE`. With no matching row,
   the certification type's default applies; Halal's default is `SELLER_REQUIRED`. When
   several rows apply, the strictest wins. Proposed Halal seed (to be confirmed with a
   halal authority): `SELLER_REQUIRED` for fresh/unpackaged meat and poultry, butcher,
   deli, repacked or portioned goods, prepared food, in-store bakery;
   `SELLER_OR_MANUFACTURER` for sealed packaged, sealed frozen, confectionery, beverages,
   cosmetics. `SELF_DECLARATION` types may only use `SELLER`.
3. **Manufacturer evidence.** *(Amended by ADR-0028: coverage records the product revision; re-review by another person.)* `ProductCertification` (owned by `certification`):
   manufacturer, type, issuer from the registry (CERT-04), certificate number, issue and
   expiry dates, document (locked storage), and `ProductCertificationCoverage` listing the
   covered product ids (optionally variant ids). Brand alone never counts as coverage.
   State machine: DRAFT → PENDING_REVIEW → APPROVED | REJECTED; APPROVED → EXPIRED |
   REVOKED | SUSPENDED | SUPERSEDED (renewal); SUSPENDED → APPROVED after re-review. Review
   is always by a human admin; if an admin submitted it, a different admin approves. A
   material change to product content (manufacturer, ingredients, barcode — flagged by the
   domain layer) or the CERT-31 report threshold suspends it. MVP: admins submit; sellers
   submitting for their own or offered products is P1.
4. **Offer handling declaration.** Every Offer declares `handling` = `SEALED_ORIGINAL` |
   `REPACKED` | `PREPARED` | `FRESH` (OFR-08). A `MANUFACTURER`-basis claim needs
   `SEALED_ORIGINAL` and a per-Offer seller attestation that the stock is genuine, sealed
   and unaltered, recorded with time and actor. `REPACKED`, `PREPARED` and `FRESH` always
   require `SELLER`.
5. **One enforcement point.** *(Amended by ADR-0028: inputs echoed, version check, entry paths listed.)* `certification` exposes `evaluateClaim(seller, product,
   variant, type, handling, categoryPath)`, returning a `ClaimDecision` (allowed, basis,
   certificate ids, policy revision). The Offer aggregate accepts a tag only with a
   matching `ClaimDecision`; changing handling or category re-evaluates every tag. All
   entry points (create, edit, match, promotion, import, expiry/revocation handlers, policy
   changes) go through it. CERT-21 now reads: an Offer may carry tag X only if the seller
   holds a valid X certificate, **or** the category policy allows `MANUFACTURER` and an
   approved, unexpired product certificate of type X covers the product and the Offer is
   `SEALED_ORIGINAL` with an attestation.
6. **Continuous enforcement.** *(Amended by ADR-0028: reconciliation owner and derecognised issuers.)* `certification.product-certification-approved / expired /
   revoked / suspended.v1` and `certification.claim-policy-changed.v1` make `catalog`
   re-evaluate affected tags in idempotent batches: re-anchor to another valid basis
   (`catalog.offer-tag-reanchored.v1`) or suspend the tag and take the Offer off sale.
   One manufacturer expiry therefore affects every Offer of that product; Offer holders
   get 30/14/1-day warnings. The daily reconciliation sweep covers both bases.
7. **What customers see.** Two distinct badges: "Halal — certified seller: <name>"
   (stronger style) and "Halal — manufacturer certified by <issuer>; this seller is not
   halal-certified; sold in original sealed packaging". If both bases qualify, the seller
   badge is shown. The "Halal" filter includes both, with sub-options "Certified seller"
   and "Manufacturer certified".
8. **Snapshots and audit.** *(Amended by ADR-0028: purchase-moment copy of the attestation and "verified with issuer".)* Order lines record type, basis, certificate ids and revisions,
   issuer, number, expiry, handling and policy revision. Every certificate, coverage and
   policy change is in the audit log (CERT-32).
9. **Security.** Policy changes, product-certificate approval, coverage edits, handling
   changes and the fan-out handler join the mandatory security-tester scope.

## Consequences
- Small sellers can list certified packaged goods without their own certificate, which
  widens supply at launch, while fresh and handled goods keep the strict rule.
- A single certificate expiry can take many Offers off sale; renewal tracking matters.
- More moving parts in the trust path (policy, coverage, handling) — each needs tests and
  security review.
- A false handling declaration is the main abuse vector; mitigated by attestation, Seller
  Terms liability clause and CERT-30/31 reports.

## Alternatives considered
- Keep seller-only certification: rejected by the owner — blocks legitimate sale of
  certified packaged goods.
- Put the halal claim in product content: rejected — unverifiable text, conflicts with
  ADR-0010 and ACL risk.
- Coverage by brand: rejected — brands certify some lines and not others.
- Default `SELLER_OR_MANUFACTURER` when no policy exists: rejected — not fail-closed.
