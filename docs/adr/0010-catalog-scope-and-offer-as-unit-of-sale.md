# ADR-0010: Catalog Scope, and the Offer as the Unit of Sale and of Certification Claims

**Status:** Accepted — 2026-09-30. Owner request; reviewed by product-owner, software-architect
and cto roles. **Decision 3 amended by ADR-0012** (manufacturer-certified claims).
**Relates to:** ADR-0002/0003 (market scoping), ADR-0004 (persistence, audit), ADR-0007
(tax category, order snapshots), ADR-0008 (modules), CAT-*, OFR-*, SEL-12/25/26,
CERT-15/20-24, IMP-03

## Context
The owner requires: (1) admins create platform ("public") products that any seller can
offer; (2) at approval, admins may promote a seller's product to the platform catalog;
(3) sellers may propose categories that, once approved, exist for that seller only and can
later be promoted to the platform tree — available only to sellers an admin has enabled,
off by default. The feature docs had no ownership model for products or categories, and
CERT-20/21 assumed one seller per product: once several sellers share a product, a
product-level Halal tag would let seller B display seller A's certification — exactly
what CERT-21 forbids.

## Decision
1. **Scope.** Product and Category carry `scope = PLATFORM | SELLER`, `owner_seller_id`
   (SELLER only), `market_id` and `tenant_id`. "Public" means public within one Market;
   nothing is shared across Markets (ADR-0002). Scope decides who may create Offers or use
   a category, not what customers see: SELLER products are sold publicly.
2. **Offer is the unit of sale.** Every product, whatever its scope, is sold only through
   Offers. `catalog` owns Offer identity, seller SKU (unique per seller), condition, offer
   description, certification tags and seller shelf categories. Price belongs to `pricing`
   and stock to `inventory`, both keyed by `offer_id`. At most one active Offer per
   (seller, product). A SELLER product accepts Offers only from its owner.
3. **Certification claims live on the Offer.** *(Amended by ADR-0028: per-Offer attestation, versioned claim inputs and every Offer entry path.)* `ProductCertificationTag` becomes
   `OfferCertificationTag`. CERT-21 keeps its strictness, re-anchored: an Offer can carry
   tag X only if the offering seller holds an approved, unexpired certification of type X.
   It is checked when tags are set (via the `certification` facade) and continuously
   (`certification.*-expired/revoked` events plus a daily reconciliation sweep suspend the
   tag and take the Offer off sale, CERT-15). Filters (CERT-23) and the buy box show only
   qualifying Offers; badges name the seller (CERT-24); order snapshots record the Offer's
   tags at purchase. Platform product content never carries a certification claim, and a
   product-level certification would need a new certification type (`applies_to=PRODUCT`)
   and a separate ADR. security-tester review of every Offer entry point (create, edit,
   match, promotion, bulk import, expiry handler) is mandatory.
4. **Platform content is admin-owned.** Admins create PLATFORM products directly; only
   admin roles can create revisions of PLATFORM content (enforced in the Product
   aggregate, not only RBAC). Every product needs at least one PLATFORM category.
5. **Promotion (SELLER → PLATFORM)** is an admin command available at approval and on any
   approved SELLER product (so it also works when CAT-36 is off). It is irreversible, names
   the `revision_no` being approved (optimistic concurrency), supersedes the seller's
   pending revisions, requires admin confirmation that the content contains no
   certification claims, and is blocked for products flagged "own brand / exclusive". The
   seller keeps selling through their Offer; order history is untouched. Before it ships,
   the Seller Terms need a content-licence clause signed off by legal.
6. **Match to an existing platform product** is allowed only at a product's first approval
   (never published, so no orders/carts/reviews point at it): same product type and
   attribute family, explicit variant mapping, fails if the seller already offers the
   target; the platform product's tax category wins; the Offer keeps its `offer_id` and is
   re-pointed (`catalog.offer-reassigned.v1`); the seller's tags are re-checked; the
   duplicate becomes `MatchedDuplicate` (terminal). Duplicate suggestions are advice only,
   never automatic.
7. **Categories.** The platform tree is admin-owned and rooted per Market (optionally one
   root per vertical, ADR-0001); it alone drives navigation, facets and category-based
   rules. A seller with the `sellers`-owned permission `can_propose_categories` (default
   off, audited) proposes a category anchored under a platform category. Proposal: Pending
   → Approved | Rejected | Withdrawn (approval always required, independent of CAT-36);
   revoking the permission withdraws pending proposals. An approved seller category is
   usable only by its owner, as a shelf on Offers, shown only on the owner's storefront.
   Admins may promote it (same id, scope PLATFORM, needs a free platform slug) or merge
   it into a platform category (terminal; Offer shelves remapped). Slugs are unique per
   Market for PLATFORM, per (Market, seller) for SELLER.
8. **Events** *(Amended by ADR-0028: material-content and coverage-changed events.)* (no personal data): `catalog.product-promoted.v1`,
   `catalog.product-matched.v1`, `catalog.product-retired.v1`, `catalog.offer-created.v1`,
   `catalog.offer-reassigned.v1`, `catalog.offer-tags-suspended.v1`,
   `catalog.category-proposed/approved/rejected/promoted/merged/archived.v1`. Every admin
   action above writes to the audit log.

## Consequences
- One product page can show several sellers with different certification status; the UI
  must make "who holds the certificate" explicit.
- The CERT enforcement path grows from one entry point to several; security review scope
  grows with it.
- Catalog import keys on the platform product code for Offers (OFR-12); seller SKUs are
  per seller.
- Priorities (MVP = Brisbane launch): scope model, Offer-level tags, admin-created platform
  products = P0; promotion, exclusive flag, manual match, retire, seller categories with
  their promotion/merge and the SEL-26 permission = P1 (owner decision 2026-09-30);
  similarity suggestions, bulk import of platform products, correction suggestions = P2.

## Alternatives considered
- Keep tags on the product: rejected — lets one seller's certificate cover another's sale.
- Seller categories inside the platform tree: rejected — pollutes navigation, facets and
  category rules; they stay seller shelves until promoted.
- Reversible promotion or match after publish: rejected — races with other sellers'
  Offers and breaks references from orders, carts and reviews.

## Owner decisions (2026-09-30)
1. Promotion consent: the Seller Terms content-licence clause plus the "own brand /
   exclusive" flag as a hard block; no per-promotion consent.
2. Manufacturer-level certification: yes, as an alternative basis for sealed goods where
   the category policy allows — see ADR-0012.
