# Catalog — G2 domain design

**Author:** Mohammad (software-architect) — 2026-10-07
**Status:** G2 approved 2026-10-07. Ali (cto) signed; Hassan (security-tester) accepted with conditions, all applied; Mojtaba's data design signed by Ali and accepted by Hassan with conditions, applied; Reza's `ux.md` complete; Jafar accepted with changes, applied; Hadi answered the product questions; owner decisions 2026-10-07: no review-time promise, default locale only required. Reviews recorded in 19.3 and 19.4. Reviewers: Ali (cto), Hassan (security-tester), Mojtaba
(database-designer), Reza (ui-ux-designer), Jafar (product-designer). Tier A. The owner gets a
Persian summary with the question of 19.1 only. The approvals of the Phase 4 designs of
`inventory` (PR #43), `pricing` (PR #44) and `cart` (PR #45) wait for this G2 (Ali A4); section 9.7
answers their requests.
**Ground truth:** `docs/modules/catalog/brief.md` (G1 approved 2026-10-03; sections, rules, owner
answers and acceptance criteria are cited as "brief s5", "Q6", "AC 20"); ADR-0001, ADR-0003,
ADR-0004, ADR-0005, ADR-0006, ADR-0007 (decisions 5 and 8), ADR-0008, ADR-0009, ADR-0010,
ADR-0012, ADR-0013, ADR-0015, ADR-0016, ADR-0017, ADR-0018 (decisions 3, 4, 6, 7), ADR-0019 (R1 to
R14, decisions 3 and 5 to 10), ADR-0020, ADR-0022, ADR-0023, ADR-0024 (decisions 1, 5, 6), ADR-0025,
ADR-0026 (Accepted 2026-10-07) and ADR-0028 (Accepted 2026-10-07; cited as "ADR-0028 d5");
`docs/design/domain/certification.md` ("CD 4.2"; G2 approved, PR #52) and its requests C-1 to C-8
(CD 18), `docs/modules/certification/ux.md` ("CUX 3.7"), `docs/design/domain/sellers.md`
("SL 7.1"), `docs/design/domain/identity.md` ("ID 8.1"),
`docs/design/domain/platform-foundations.md` ("PF 6.2"),
`docs/design/domain/platform-persistence-and-events.md` ("PP 3.1"),
`docs/design/panels/information-architecture.md` ("IA 3.1", PR #49); `docs/features/02-catalog-inventory.md`
(CAT-*, OFR-*), `10-versioning.md` (VER-01 to VER-06, VER-13), `09-internationalization.md`
(INTL-03, -10, -11, -13), `11-ai.md` (AIS-03, AIA-03);
`docs/architecture/horizontal-extensibility-architecture.md` s4.1 and s4.5; board requests 13 (via
`certification`), 15, 16 and 18 (`claude/tracks.md`); the Phase 4 drafts
`docs/design/domain/inventory.md` ("INV 3.5", branch `docs/inventory-g2-design`),
`docs/design/domain/pricing.md` ("PRC 6.1", branch `docs/pricing-g2-design`) and
`docs/design/domain/cart.md` ("CRT 7.1", branch `docs/cart-g2-design`). The code on `main` at
`e0297b2`: `modules/catalog/` is an empty shell.

## 1. Scope

A design, not an implementation: a signature appears only where it is the contract.

- **Decided here:** the domain model (2), the extension-point registry and `AttributeSchema`, which
  this module triggers (3), state machines (4), the certification tag and claim rules (5), claim
  text (6), Market and Vertical configuration (7), contexts and authorisation (8), the boundary
  (9), photos and files (10), personal data, audit and mail (11, 12), AI uses (13), Import (14),
  slices (15), dependencies (16).
- **Not changed here:** the facades, ports and events of `identity`, `sellers` and
  `certification`. What this design needs from them is a request in 18.
- **Applied, not amended:** ADR-0028 (the claim contract). One reading of decision 1 for a product
  that has never been published is a team decision (19.2 item 3), not an amendment.
- **In Mojtaba's data design** (`docs/design/data/catalog.md`, written from this model): tables,
  constraints, indexes, the statements of the fan-out and reconciliation, retention jobs (17.1).
- **In Reza's `docs/modules/catalog/ux.md`:** screens, states and copy, and the table of brief
  s12 (17.2).
- **Left open, with the reason:** the questions of 19.1 need the owner; the AU claim vocabulary and
  the tax-category guide wait for the halal authority and the tax adviser (brief s11); retention of
  original photos waits for counsel.

### 1.1 Scope by feature ID
| Feature | Priority | Where |
|---|---|---|
| CAT-40, CAT-41, CAT-43 (scope, platform product by admin, admin-only content) | P0 | 2.1, 4.1, 8.3 |
| CAT-01, CAT-50 (platform tree; seed at launch, editor after the first sale) | P0 | 2.1, 4.6, 7.2 |
| CAT-02 (attribute definitions per locale; seed), CAT-03 (default family by seed; editor P1) | P0 / P1 | 3.3, 7.2 |
| CAT-10, Simple and Configurable types | P0 | 2.1, 3.2 |
| CAT-14 (photos; no video) | P0 | 10 |
| CAT-30, CAT-31, CAT-32, CAT-36, VER-01 to VER-03, OFR-04 | P0 / P1 | 4.1 to 4.3, 7.3 |
| OFR-01, OFR-02, OFR-06, OFR-08 | P0 | 2.1, 4.4 |
| CERT-20 to CERT-22, CERT-15, CERT-45 (catalog's share) | P0 | 5 |
| Claim-text refusal (ADR-0012 d1; Q1, Q6) | — | 6 |
| Material content change event (ADR-0012 d3, ADR-0028 d6) | — | 5.7 |
| Tax category in the revision (ADR-0007 d5) | — | 2.1, 4.2 |
| IMP-10 (audit) | P0 | 11.3 |
| CAT-11, CAT-12, CAT-18, CAT-33, CAT-35, CAT-37, VER-04, VER-05, OFR-03 | P1 | 4.2, 4.3, 8.2 |
| CAT-44, CAT-46 (promotion, own-brand flag), CAT-45 (match; launch-required, Q5), CAT-48 (retire) | P1 | 4.1, 4.5 |
| CAT-51 to CAT-54 (seller categories as shelves) | P1 | 2.1, 4.6 |
| OFR-10 to OFR-12, OFR-14, OFR-16, OFR-17 (Import; not launch-required, Q5) | P1 | 14 |
| AIS-03, AIA-03 claim flag (optional for launch) | P1 | 13 |

Out of scope (brief s3): price, special price, Cost and the price-jump hold (`pricing`, ADR-0024);
stock (`inventory`); CERT-23, badge display, "Sold by" (STO-03) and the store page (storefront and
`search`, Phase 6); VER-06 snapshot and the purchase-time check (`ordering`, Phase 5); video;
Virtual, Downloadable, Grouped, Bundle, Booking types; CAT-04, -05, -06, -13, -15, -19, -20, -42,
-47, OFR-05, -07, -13, -15, -18; per-channel values; the other AI capabilities. **Store and
shelves:** the only store concept in this module is the seller category used as a shelf (CAT-52);
the store page itself is the storefront's.

### 1.2 Brief slices and where they are covered
| Slice (brief s11) | Covered in (this design's slice) |
|---|---|
| 1 Product model, variant ids, `ProductTypeHandler` registry | 2.1, 3, 15 (P1, 1) |
| 2 Category tree seed | 2.1, 7.2 (2) |
| 3 Attribute definitions and default family seed, material flag | 3.3, 7.2 (3) |
| 4 Working copy, revisions, base revision, tax category, `ProductRevisionPolicy` | 4.2, 4.3 (4) |
| 5 Claim-text refusal | 6 (5) |
| 6 Platform product by admin, CAT-43 | 4.1, 8.3 (6) |
| 7 Offer and own product, may-sell, SEL-12, one Offer rule, Offer-created event | 4.4 (7) |
| 8 Tags with `evaluateClaims` on every write, version check, variant fail-closed | 5 (8) |
| 9 Offer on a platform product and product search | 4.4, 9.1 (9) |
| 10 Submit and review queue, CAT-36, publish as entry path with fan-out, audit | 4.2, 4.3, 5.4 (10, 11) |
| 11 Re-evaluation from events, suspend, switch, restore, reconciliation | 5.5, 5.6 (12) |
| 12 Photos; delete and withdraw; material change event | 10, 4.1, 5.7 (13, 14) |
| 13 to 22 | 15.1 rows 15 to 26 |
| 23 Panel screens | 17.2 (27) |

### 1.3 Inputs from other documents
| Input | Answered in |
|---|---|
| CD 18 C-1: ADR-0028 on every entry path incl. Offer reactivated, variant added, tag re-enabled; refuse when `matchClaimTerms` fails; equal inputs under version; copies restrict; copy keeps certificate, version, issuer ids | 5.1 to 5.4, 6.3 |
| C-2: publish `catalog.product-material-content-changed.v1`; own handler calls `productMaterialContentChanged` | 5.7, 9.4, 9.5 |
| C-3: implement `CatalogReferences` incl. `publishedProductRevisions` | 9.3 |
| C-4: `assertCategoriesRetirable` before move, merge, archive; `platformCategoriesRetired` after commit; re-ask | 4.6 |
| C-5: consume certification events; issuer derecognition by issuer id from the copy; daily reconciliation over both bases and suspended tags | 5.5, 5.6 |
| C-6: warn Offer owners on `product-certification-expiry-warning-due` | 5.5, 12 |
| C-7: admin count of published products a proposed term list would match | 6.5; needs request X-1 |
| C-8: a category move under a parent named by a `SELLER_OR_MANUFACTURER` row is an entry path, audited | 4.6, 5.3 |
| CUX open point 9: product search for the manufacturer coverage picker | 9.2 (`admin-products.search`) |
| Board 15 (1) ADR-0028 inputs; (2) registry and `AttributeSchema` before slice 1; (3) ADR-0026 settings; (4) `sellers` facades; (5) nothing in the limited allow-list, protected keys; (6) image library and cookieless origin, security review list | 5; 3; 7.3; 9.6; 8.1, 8.2; 10, 16 |
| Board 16 (design track): screens and states of brief s12 | 17.2 |
| Board 18 (2) and (3): boundary rule "catalog imports neither pricing nor inventory"; no price, stock or "sellable now" in any answer | 9, 9.1, AC 6 test (15.1 slice 1) |
| ADR-0026: CAT-36, OFR-01, OFR-03 as editable settings with restrictive safe values | 7.3 |
| ADR-0029 (Ali, reserved): cookieless origin for public photos | 10.4; dependency of slice 13 |
| INV 13, PRC 6.1 CF1 to CF4, CRT 7.1 CC1 to CC3 | 9.1, 9.4, 9.7 |
| IA 3.1 and 8 item 2: which catalog keys open the Review queue tabs | 8.1 |

## 2. Domain model

### 2.1 Aggregates
Every aggregate root carries `marketId`, `tenantId` (ADR-0003 decision 3, ADR-0001) and a
`version` (PP 10). References to other modules are ids: seller id (minted by `identity`),
certificate, submission, revision, issuer and policy ids (minted by `certification`). Nothing is
shared between Markets: a product, category, attribute definition and Offer exist in exactly one
Market (brief s5, INTL-03). "Public" means public in that Market.

```
Product (scope PLATFORM | SELLER; one Market)
  |-- typeCode, familyCode (fixed after creation), productCode (unique per Market)
  |-- ownerSellerId (SELLER only), ownBrand flag (CAT-46)
  |-- Variant registry: variantId (stable, never reused), state (proposed | published | retired)
  |-- WorkingCopy (editable draft; autosaved; not a revision)
  |-- ProductRevision (V1, 0..n; immutable content)   --> decision (0..1), provenance per field
  |-- publishedRevisionId, pendingRevisionId, lifecycle status, flags (claim-text, photo takedown)
Offer (one seller, one product; at most one non-deleted per (seller, product))
  |-- sellerSku, condition, description per locale, handling, attestation record, shelf
  |-- status, offSale reasons (stored causes)
  |-- OfferTag (0..n; one non-removed per type): claim copy, status
  |-- history (V4, append-only)
PlatformCategory (tree per Market, optional root per Vertical)  --> CategoryRevision (V1)
AttributeDefinition (V1 revisions)   AttributeFamily (V1 revisions)
SellerCategory (shelf; one seller)   CategoryProposal (one seller)
ProductImage (uploaded photo; intake state; renditions)
ImportJob (one seller; P1)           AiListingSuggestion, AiClaimFlag (P1, 13)
```

| Aggregate | Holds | Invariants it owns |
|---|---|---|
| `Product` | Scope, `typeCode` (from the registry, 3.2), `familyCode`, `productCode`, owner seller id (SELLER), `ownBrand`, the variant registry, the working copy, revisions, the two revision pointers, lifecycle status (4.1), `claimTextFlaggedAt` (6.4), takedown marks (10.5), `promotedAt` | Type and family never change after creation (CAT-10). `productCode` unique per Market. A SELLER product has an owner, a PLATFORM product none. **Content of a PLATFORM product changes only through an admin use case**: the aggregate's content commands take an `AuthorKind` and refuse `seller` when scope is PLATFORM (CAT-43, AC 3), so no path (form, Import, AI accept) can bypass it. At most one published and one pending revision (VER-01). A Simple product has exactly one variant, created with the product and never retired while the product lives; it becomes `retired` only when its product is `discarded` (4.1), so consumers that received `variant-added` also receive `variant-removed` (Q-K15); a Configurable product has at least one non-retired variant (CC2, INV 13). A variant id is never reused or revived (2.3 M-1). A product has at most `maxVariantsPerProduct` non-retired variants (7.1; AU 100) |
| `ProductRevision` (entity of `Product`) | Revision number, base revision id (the published one it was built on), the attribute-schema version it was validated against, immutable content (name, short and full description per locale; attribute values; variant definitions with option values and labels; platform category ids (≥ 1); tax category code; image refs in order with alt text; per-field provenance for AIS-03), `contentHash`, author kind and account id, change classification (sensitive or minor, 4.3), status (4.2), decision (reviewer, instant, reason code, reason text) | Content never changes (VER-01). Created only from a complete working copy (CAT-31). A decision names this revision number (brief s5: approval is bound to what was reviewed) |
| `Offer` | Seller id, product id, `sellerSku` (unique per seller, CAT-10; **one per Offer**, no per-variant SKU in Phase 3; stock is per `variantId` in `inventory`; Hadi), condition code (Market list), description per locale, handling (`SEALED_ORIGINAL`, `REPACKED`, `PREPARED`, `FRESH`), attestation record (instant, account id, or none), shelf (a `SellerCategory` id of the same seller, or none), status (4.4), stored off-sale causes, `firstPublishedAt`, tags | At most one non-deleted Offer per (seller, product), drafts and pending included (OFR-02). A SELLER product accepts an Offer only from its owner (CAT-40). Deleted is terminal and the id is never reused. Seller id never changes (pricing's copy relies on it, PRC 2.3). The shelf belongs to the Offer's seller (CAT-52, AC 35). Handling and the attestation are written only by `own-offer.set-handling` and `own-offer.record-attestation` of a seller actor, never in acting-as, never through `own-offer.edit`, Import or a bulk action (brief s5; Ali B1). A tag is stored only with an allowed `ClaimDecision` whose inputs equal the state being saved (5.2) |
| `OfferTag` (entity of `Offer`) | Type code, status (5.3), the claim copy (5.4), the instant and cause of the last change, who removed it and when (removed by seller) | One non-removed tag per (Offer, type). The copy only restricts (ADR-0028 d3) |
| `PlatformCategory` | Parent id, slug (unique per Market), names per locale, optional Vertical root marker, status (`active`, `merged-into`, `archived`), V1 revisions of name and parent | Admin-only (CAT-50). The tree is acyclic. A category that is the only platform category of a published product revision is not archived or merged without a replacement (AC 4). Move, merge and archive pass `certification.assertCategoriesRetirable` first (4.6) |
| `AttributeDefinition`, `AttributeFamily` | Definition: code, data type, localizable flag, options with labels per locale, bounds, `material` flag (ADR-0012 d3), status; family: groups of attribute codes with required flags. V1 revisions; seeded (7.2) | Code unique per Market. A revision is never edited. `material` is set by people only (R10 spirit; brief s5). An option is never deleted while a published revision uses it; it is deactivated |
| `SellerCategory`, `CategoryProposal` | Proposal: seller id, names per locale, platform parent id, optional description, status (`pending`, `approved`, `rejected`, `cancelled`), reason code. Approved category: seller id, slug unique per (Market, seller), parent, status (`active`, `promoted`, `merged-into`, `archived`) | Only for a seller whose `mayProposeCategories` is true at the command (CAT-51). Pending cap per seller (CAT-54). Never in navigation, filters or `evaluateClaims` (CAT-52, ADR-0028 d1) |
| `ProductImage` | Uploader kind and id, owning product, intake state (10.3), content address of the stored original and of each rendition, pixel size, `takenDownAt` | Usable in a revision only when `clean`, owned by the same product (L2 of CD), and of purpose `product-photo` |
| `ImportJob` | Seller id, mode, error strategy, file hash, counters, state, error report ref | One running job per seller (brief s5). P1 (14) |

### 2.2 What is deliberately not an aggregate of `catalog`
| Thing | Why |
|---|---|
| Price, special price, Cost, price-jump hold | `pricing` (ADR-0024 decisions 1 and 4). No catalog answer carries them (AC 6) |
| Stock, purchase limits | `inventory` (ADR-0010 decision 2) |
| "Sellable now" | Composed at read time by cart and `ordering` from catalog's own Offer state, may-sell, price and stock (ADR-0024 decision 5). `catalog` stores no such flag |
| Whether a claim is allowed; certificates; policies; claim vocabulary; badge data | `certification` (ADR-0012 d5, ADR-0028). `catalog` holds a copy (5.4) |
| May-sell, allowed product types, may propose categories, store name, seller zone, AI switch | `sellers` (SL 7.1, 7.6) |
| Order snapshot of a line | `ordering` (VER-06, ADR-0028 d12) |
| Search index, storefront page | `search`, storefront (Phase 6), fed by catalog's events and facade |
| Audit log, photo bytes | Platform (audit writer; object store) |

### 2.3 Modelling choices that need a reason
| # | Choice | Reason | Cost |
|---|---|---|---|
| M-1 | **Variant identity lives on the product, not in the revision.** A variant id is minted when the seller adds a variant to the working copy (state `proposed`), becomes `published` when a published revision contains it, and becomes `retired` either when a published revision removes it (at that publish) or when a never-published variant is deleted from the working copy (at that save). Retired is final; an id is never reused or revived; a revert that would restore a retired variant is refused (4.2). **Every retirement emits `catalog.variant-removed.v1` in the unit that retires it**, at the draft save or at the publish (Ali B2): a `proposed` variant may already carry a price (PRC CF1 counts it priceable), so its removal at a save is announced too. The variants of a matched duplicate are not retired (the product is terminal; consumers re-key on `offer-moved`, 9.7) | `pricing`, `inventory` and certification coverage key on (Offer, Variant) and keep one-way tombstones (INV 3.3 M6, PRC 5.2 M5 (c)); the answer to their open question is "a removed Variant id never comes back". Variant ids must be stable across revisions so prices and stock survive a minor edit | Re-adding "the same" size after removal gives a new id; its price and stock start empty |
| M-2 | **The working copy is not a revision** (brief s5, ADR-0009 d2): one editable draft per product, autosaved, carried across devices; a submit freezes it into a revision | ADR-0009 has no draft revision; OFR-04 allows an incomplete draft | Two shapes for content (working copy, revision) |
| M-3 | **Offer pattern: current state with append-only history (V4), and a first-publish review only** (brief s5 team proposal, accepted at G1). While the first publication is pending, the Offer cannot be edited; an edit first takes it back to `draft` after a warning (4.4) | No Offer field is sensitive under VER-03 except the claim, which never goes to a queue (brief s8 item 6); later edits pass the claim-text check, `evaluateClaims` and audit (AC 33). V1 revisions would add a queue nobody asked for | The reviewer sees the Offer only at its first publication |
| M-4 | **A tag is an entity of the Offer, not a separate aggregate** | The tag write and its equality check run in the Offer's unit under the Offer's version (ADR-0028 d2); a separate aggregate would need a second lock | Fan-out writes touch whole Offers (small) |
| M-5 | **Off-sale is a set of stored causes on the Offer, never a computed "sellable" flag** | Catalog answers only for its own state (ADR-0024 d5). Causes it owns: `type-not-allowed` (SEL-12), `product-retired` (CAT-48), `product-not-listed` (product withdrawn, matched or claim-text flagged), `tag-suspended` (CERT-15). Each cause has its own clearing rule (4.4) | A cause from another module (may-sell, price, stock) is never stored here |
| M-6 | **Categories and tax category live in the revision** (brief s5, ADR-0009 d3) | A category change is a sensitive change with review; Offers inherit the product's tax category, so two sellers never classify one product differently (ADR-0007 d5) | `categoryPath` for `evaluateClaims` comes from the published revision, read per query |

## 3. Extension points: registry, `ProductTypeHandler`, `AttributeSchema` (ADR-0015 trigger; board 15 item 2)

This module pulls two platform triggers (brief s11): the extension-point registry and
`AttributeSchema`. The design below is the "registry design by Mohammad, approved by Ali before
slice 1" of the brief; Ali's approval of this section is a G2 item (19.2 item 1). No ADR: ADR-0001
decision 1 already decides the pattern; this fixes the mechanism.

### 3.1 `ExtensionPointRegistry` (`platform/extensions/`)
| # | Guarantee |
|---|---|
| 1 | Generic and module-free: `declarePoint<T>(pointId, ownerModule, validator)` and `register<T>(pointId, code, impl, registrant)`. `platform/` imports no module; the point's TypeScript interface is exported from the owning module's `contracts/` (`catalog/contracts/product-type-handler.ts`) |
| 2 | Registration happens at bootstrap only; the registry is sealed before the first request or job (like `PermissionRegistry`, PF 6.1). Boot fails on a duplicate code, a malformed code (`^[a-z][a-z0-9-]{1,31}$`), or a registrant that is neither the owning module nor a folder under `verticals/<vertical>/` |
| 3 | Core registers only structural types (`simple`, `configurable`); a Vertical's own type lives in `verticals/<vertical>/` and registers through the same call (ADR-0001 decisions 1 and 5; brief s5, Ali's ruling: one dimension) |
| 4 | Which registered types a Market offers is Market configuration (`catalog.productTypes`, 7.1); a type not listed for the Market is refused at product creation (and `sellers`' SEL-12 narrows further) |
| 5 | A CI literal check finds no Vertical, Market or certification type name in `modules/catalog/` outside seeds and tests (AC 5, AC 18) |
| 6 | Later points (`FulfillmentStrategy`, `PricingStrategy`, `OrderWorkflowExtension`) use the same registry, declared by their owners; nothing else is built now |

### 3.2 `ProductTypeHandler` (contract in `catalog/contracts/`)
```ts
interface ProductTypeHandler {
  readonly typeCode: ProductTypeCode;              // 'simple' | 'configurable' | a Vertical's code
  readonly variantModel: 'single' | 'options';     // single: exactly one variant, never retired
  validateAttributes(schema: AttributeSchema, values: AttributeValues): ValidationResult;
  validateVariants(schema: AttributeSchema, variants: readonly VariantDraft[]): ValidationResult;
  renderSummary(revision: ProductRevisionView): ProductSummary; // public fields only; no price, no stock
}
```
`computeAvailability` is not part of it (brief s8 item 1; ADR-0024 d5). Handlers are pure (no I/O),
so they may be called from `domain/`. `configurable` requires at least one option attribute of the
family with `select` type; each variant has one value per option attribute and the combination is
unique within the product.

### 3.3 `AttributeSchema` (kernel value type; first consumer)
```ts
// packages/shared-kernel (domain may import only the kernel)
interface AttributeSchema {
  readonly schemaRef: { familyCode: string; familyRevisionId: Id; definitionRevisionIds: readonly Id[] };
  readonly fields: readonly AttributeField[];
}
interface AttributeField {
  readonly code: string;
  readonly dataType: 'text' | 'long-text' | 'integer' | 'decimal' | 'boolean' | 'select' | 'multi-select' | 'date';
  readonly localizable: boolean;       // value per locale of the Market (CAT-02; no per-channel value)
  readonly required: boolean;          // from the family group
  readonly isVariantOption: boolean;   // a select used to define variants (configurable)
  readonly material: boolean;          // ADR-0012 d3; drives 5.7
  readonly claimChecked: true;         // every text value and option label reaches 6 (brief s5 default-deny)
  readonly bounds: { maxLength?: number; min?: number; max?: number; options?: readonly OptionRef[] };
}
validate(schema: AttributeSchema, values: AttributeValues, locales: readonly Locale[]): ValidationResult;
```
| # | Rule |
|---|---|
| 1 | A schema is built from the published revisions of one family and its definitions; a revision records the `schemaRef` it was validated with (brief s5 "base revision and schema version") |
| 2 | An `image`-typed attribute is not offered at launch (brief s5: image attributes would pass the photo pipeline; no source needs one) |
| 3 | The same type serves `sellers`' and `certification`'s fixed forms later; neither uses it today (brief s11). Moving them is not planned |
| 4 | Option labels and attribute names are customer-visible texts and pass the claim-text check when a definition revision is saved (6.2) |
| 5 | Monetary attributes do not exist (money is `pricing`'s) |

## 4. State machines

Every transition is one use case with one read-write unit (PP 3.1), time from `Clock`, and its
events in the same unit. **Versions and events (Q-K3):** the outbox keeps its unique
`(aggregate_id, aggregate_version)`; a unit that writes n events for one root (a publish with
`revision-published`, several `variant-added`/`-removed` and `material-content-changed`; a settle
with several tag events and `offer-listing-changed`) raises the root's version by n, one version per
event, in a fixed order. No amendment for an event sequence number is needed. Facade calls (`sellers`, `certification`) run before the
unit (PP 3.1 row 5; ADR-0019 decision 6 for models). A transition not listed is forbidden.

### 4.1 Product lifecycle
`draft` → `unpublished` → `published`; `unpublished` → `matched` (terminal);
`unpublished` | `published` → `withdrawn` (terminal, SELLER); `published` → `retired` (terminal,
PLATFORM); `draft` → `discarded` (terminal).

| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| (none) → `draft` | `own-product.create` (seller) or `platform-product.create` (admin). Seller guards: `sellingEligibility` yes (SL 7.2), setting `catalog.seller-can-create-product` on (7.3), type in the Market's list and in `allowedProductTypesOf` (SEL-12), family from the Market's seed. Admin guard: key `catalog.platform-product.edit` | Product with type, family, `productCode` (minted by the server from a Market sequence, never from input), a Simple product's single variant | CAT-10, OFR-01, CAT-41 |
| `draft` → `discarded` | `own-product.delete` of a product never submitted, or the prune job `catalog.prune-abandoned-drafts` after **180 days** without a working-copy save (ADR-0009 d7; system actor; the seller list shows the removal date from day 166) | **No physical delete of Offers or variants, ever (Q-K2).** In one unit: the product becomes `discarded` (the row stays; it leaves every list and read), its working copy and draft image masters are deleted; its draft Offer becomes `deleted` with `catalog.offer-deleted.v1` (consumers saw `offer-created`); each non-retired variant is retired with `catalog.variant-removed.v1` (a `proposed` variant may be priced); history rows stay (insert-only). No audit row (nothing was ever submitted; CD 3.1 precedent) | OFR-06, AC 32 |
| `draft` → `unpublished` | First submit (4.2 row 1) | — | CAT-30 |
| `unpublished` → `published` | First revision published (4.2 rows 3, 4) | Event `catalog.product-revision-published.v1` | CAT-30 |
| `unpublished` → `matched` | `product.match` in the first approval (4.5) | Terminal; the Offer moves; mail | CAT-45 |
| `unpublished` or `published` → `withdrawn` | `own-product.delete` of a submitted SELLER product (not promoted). Pending revision `superseded` | Terminal; revisions kept (VER-06 references them); its Offer `deleted` in the same unit; product leaves the seller's list; events `catalog.product-withdrawn.v1`, `catalog.offer-deleted.v1` | OFR-06, ADR-0009 d7 |
| `published` → `retired` | `platform-product.retire` (protected key), PLATFORM only; the confirm request carries the affected Offer count the page showed (brief s4 f 3); if the count in the unit differs, refused with `retire.count-changed` and the current count, so the admin confirms again. No `evaluateClaims` (ADR-0028 d5) | Terminal; every Offer gets cause `product-retired`; event `catalog.product-retired.v1`; mail to Offer owners | CAT-48 |
| `published` (SELLER) → `published` (PLATFORM) | `product.promote` (4.5) | Scope changes; not a status | CAT-44 |

Forbidden: deleting a submitted product; any change of type, family, scope back to SELLER, owner
seller, `productCode`; any seller content command on a PLATFORM product (AC 3); retirement of a
SELLER product (it is withdrawn instead); "un-retire".

### 4.2 Product revision: `pending` → `published` | `changes-needed` | `superseded`
| # | From → to | Trigger and guard | Effects |
|---|---|---|---|
| 1 | (working copy) → `pending` or `published` | `own-product.submit` (seller) or `platform-product.submit` (admin). Before the unit: `sellingEligibility` (seller); claim-text check over every checked field of the working copy (6; failure or unavailable refuses); for a SELLER product, `evaluateClaims` for every non-removed tag of the owner's Offer against the frozen revision being submitted (5.2; T4: refused with the list of tags that would no longer be allowed). For an already-published product this ask **stores nothing** (5.1a point 4); for a never-published product the copy names the submitted revision and the Offer stays unlisted (5.1a points 2, 5). In the unit: completeness for the schema (name, descriptions in the Market's **default locale only** by default, other locales optional and falling back by INTL-13 (owner decision 2026-10-07); the claim-text check runs on every filled locale; ≥ 1 platform category, tax category from the Market list, ≥ 1 clean image for a new product; CAT-31, brief s5), the base revision equals the current published one (else `revision.base-changed`), the setting `catalog.approval-required` read in this unit (ADR-0026 d2), classification by `ProductRevisionPolicy` (4.3) | Revision N with base, schema ref, provenance (server-built, 13.1), `contentHash`. **Published at once** when approval is off, or the product is published, the change is minor and no sensitive revision is pending (4.3), **except** that a revision adding or replacing any image always goes to review, whatever CAT-36 says (Hassan H1; 4.3). Otherwise **pending**; an existing pending revision becomes `superseded` (the client must send `replacePending: true` after the warning, brief s4 d 1). Event `catalog.product-revision-submitted.v1` |
| 2 | `pending` → `superseded` | A later submit (row 1), a withdrawal of the product, a promotion (CAT-44 sets aside the seller's pending revisions) | A reviewer with the page open gets `review.not-current-revision` |
| 3 | `pending` → `published` | `product-revision.approve` (key `catalog.product.approve`), naming revision N and the product version; N is the pending one (AC 29); the owner's `sellingEligibility` yes, else **skipped** in bulk (CAT-33) and refused singly with `seller.not-eligible`; claim text re-checked (vocabulary may have grown since submit); for a SELLER product every tag of the owner's Offer re-asked against N before the unit (5.1a point 3) | The previous published revision `superseded`; pointer moves; variant registry updated (M-1); publish fan-out (5.4); events `catalog.product-revision-published.v1`, `catalog.variant-added.v1` / `-removed.v1` per changed variant, `catalog.product-material-content-changed.v1` when a material attribute changed (5.7); audit; mail |
| 4 | (row 1, published at once) | As row 3 without a reviewer; the system records `autoPublished` with the setting value read | Same effects |
| 5 | `pending` → `changes-needed` | `product-revision.request-changes` (same key), naming N; a reason code from the Market list and optional text (CAT-32, AC 28) | Terminal for N; the working copy stays for the next submit; event `catalog.product-revision-changes-requested.v1`; mail with field, reason and next step |
| 6 | (old revision K) → new revision | `product-revision.revert` (VER-05; seller for SELLER, admin for PLATFORM): content of K copied into the working copy and submitted through row 1 (same policy, same checks, same entry path) | Refused with `revision.revert-restores-retired-variant` when K holds a retired variant id (M-1) |

Bulk approve (CAT-33, AC 30): the request carries `[{ productId, revisionId }]`, **at most 50 items**
(server-side cap; an oversized request is refused whole with `batch.too-large`, Hassan 3b); any id not found
in the request's Market refuses the whole request byte-identically (the SL 7.3 pattern); each item
is its own unit; ineligible sellers are skipped, not rejected; a not-current revision is skipped
with `review.not-current-revision`; a row whose revision needs the named photo check (8.3a: an
image added or replaced, or a first publication) is skipped with `review.checks-missing` (CAT-33
with Hassan H1; accepted by Hadi); a first approval of a never-published SELLER product is
**skipped** with `review.first-approval-needs-match-check` unless the request sets
`firstApprovalsConfirmed: true` (brief s4 c 5; Jafar). Result: counts per outcome, and **every
skipped row listed** with its product id, revision id and reason code, so the reviewer can open each.

Working-copy save (`own-product.save-draft`, `platform-product.save-draft`) and revert input
(Hassan M3, Ali B2): every `variantId` in the input must be an existing, non-retired variant of
**this** product, else the whole save is refused (`variant.unknown`, byte-identical for a foreign
or retired id); a new variant is sent without an id and the server mints it (`IdGenerator`). A save
that deletes a `proposed` variant retires it and writes `catalog.variant-removed.v1` in the same
unit (M-1); a `published` variant is retired only at the publish that removes it, which writes the
event in the publish unit.

**Variant limit (Ali, Phase 4 ruling).** Every variant add is checked against the Market's
`catalog.maxVariantsPerProduct` (7.1; AU 100) counting non-retired variants: at the working-copy
save, at submit, at publish (approve, auto-publish, revert) and in each Import row. Over the limit the
request is refused with `variant.limit-reached` (with `max`), nothing saved; at publish it refuses
the approval. The limit also bounds `offer-moved`'s `variantMapping` (9.4) to that many entries.

### 4.3 `ProductRevisionPolicy` (VER-02, VER-03; owned here)
A pure domain service: `classify(published, candidate, marketPolicy) → { sensitive: boolean,
reasons: SensitiveReason[] }`.

| Rule | Source |
|---|---|
| Sensitive fields come from Market (and later Vertical) configuration `catalog.sensitiveChanges` (7.1): AU = platform categories, tax category, name in any locale, primary image, **any image added or replaced** (Hassan, G1), **a variant removed** (Mohammad, G1) | VER-03, brief s5 |
| Anything else is minor | VER-03 |
| Approval off (CAT-36): every revision publishes at once; claim text and claims are still checked at submit and publish. **Exception (Hassan H1): a revision that adds or replaces an image always goes to review, whatever CAT-36 says**; text is machine-checked, photos are not, so a human looks at every new photo. The review page names the check "No certification mark or claim words in photos" | AC 27; Hassan H1 |
| A pending sensitive revision holds later edits: the next submit supersedes it and stays pending, even if the new delta is minor (brief s5 team proposal; AC 26) | — |
| A never-published product is always reviewed when approval is on | CAT-36 |
| A PLATFORM revision by an admin publishes at once (CAT-41: no seller queue); the publish fan-out still runs | CAT-41 |
| A tax category override by an admin (`catalog.tax-category.override`, protected) is an admin-authored revision on a SELLER product, published at once, audited (ADR-0007 d5, AC 36). Its content is the **current published revision with only the tax category changed**; it never pulls in a pending seller revision or the working copy (Hassan 1a). A pending seller revision stays pending and is rebased by the seller (`revision.base-changed` at its approval) | brief s5; Hassan 1a |

### 4.4 Offer: `draft` → `pending-first-publish` → `published` | `changes-needed`; → `deleted`
| From → to | Trigger and guard | Effects |
|---|---|---|
| (none) → `draft` | Created with the seller's own product (OFR-01, same form) or by `own-offer.create-on-platform-product` (OFR-02; a SELLER, unpublished, retired, other-Market or unknown product id answers a byte-identical `product.not-found`, Hassan M3; Import's `product_code` behaves the same way). Guards: `sellingEligibility`; type allowed (SEL-12); on a PLATFORM product: product `published` and not retired, setting `catalog.sell-from-catalogue` on (7.3); no non-deleted Offer of this seller on the product (`offer.exists-for-product`); `sellerSku` unique per seller | Event `catalog.offer-created.v1` (INV 3.5: upsert of stock needs it) |
| `draft` → `pending-first-publish` or `published` | `own-offer.submit` (for an own product it is part of the product submit). Claim text of the description (6); handling present; tags evaluated (5.2). Approval required read in the unit: on → pending; off → published. For an own product the Offer is published together with the product's first revision | — / `catalog.offer-published.v1` |
| `pending-first-publish` → `published` | `offer.approve` (key `catalog.product.approve`), naming the Offer version; owner eligible (else skipped); tags re-evaluated against the published revision (5.4) | Event; audit; mail |
| `pending-first-publish` → `changes-needed` → `draft` | `offer.request-changes` (reason code); the seller edits, which returns it to `draft` | Mail |
| `pending-first-publish` → `draft` | The seller edits (after a warning) | Leaves the queue |
| `published` → `published` (edit) | `own-offer.edit` (description, condition, shelf, SKU; closed input schema without handling, attestation or tag fields, B1): no queue (M-3); claim-text check; `evaluateClaims` for **every** non-removed tag (AC 11, AC 33); audit row. Handling and attestation change only through `own-offer.set-handling` and `own-offer.record-attestation`, which ask the same way and are refused in acting-as | History row |
| `published`: cause added / cleared (off sale ⇄ listed) | `type-not-allowed`: added by the handler of `sellers.allowed-product-types-changed.v1` after reading `allowedProductTypesOf`; cleared the same way when the type is allowed again **and every tag is re-asked** (Offer reactivation is an entry path, ADR-0028 d5). `product-retired`: added, never cleared. `product-not-listed`: added on withdraw, match, claim-text flag; cleared when the flag clears (6.4). `tag-suspended`: present while any tag is `suspended` (5.3) | Event `catalog.offer-listing-changed.v1` (`listed` boolean) when the set goes from empty to non-empty or back; mail |
| any non-deleted → `deleted` | `own-offer.delete` (OFR-06): on a PLATFORM product only the Offer; for an own SELLER product the product is withdrawn (4.1) | Terminal; event `catalog.offer-deleted.v1` (PRC CF2, INV 3.5); audit |

Rules: an Offer is **listed** when it is `published`, its product is `published`, and it has no
off-sale cause. Settings `seller-can-create-product` and `sell-from-catalogue` gate **creation only**:
switching one off, or a read failure that returns the safe value "off" (ADR-0026 d5), never adds an
off-sale cause and never hides an existing Offer or product (7.3). The handling, attestation and
tag commands are refused in an acting-as session (brief s5, AC 19).

### 4.5 Match (CAT-45) and promotion (CAT-44)
| Use case | Guard (in the unit unless noted) | Effects |
|---|---|---|
| `product.match` (key `catalog.product.match`) | Named pending revision N is the product's **first** (never published; AC 31); target is a published, not retired PLATFORM product of the same Market, type and family; the seller has no non-deleted Offer on the target; an explicit, total and injective variant mapping (every non-retired variant of the seller product → a distinct published variant of the target); before the unit: `evaluateClaims` for every tag of the moving Offer against the **target's** published revision (entry path, AC 7) | Product `matched` (terminal); N `superseded`; the same Offer id moves to the target with its tags re-decided (a tag not allowed is **suspended**, not dropped, so the seller sees why); the target's tax category applies; event `catalog.offer-moved.v1` with `fromProductId`, `toProductId` and the variant mapping pairs (PRC CF4); audit; mail to the seller |
| `product.promote` (key `catalog.product.promote`, protected) | SELLER product `published`, not `ownBrand` (AC 31); request names the published revision and its version; the admin's explicit confirmation "no certification claim in text or photos" (ADR-0010 d5; Q4); the legal clause flag in Market configuration (`catalog.promotionEnabled`, off until counsel approves the content-licence clause) | Scope becomes PLATFORM; pending seller revisions `superseded`; the seller's Offer continues; `evaluateClaims` for every Offer of the product (entry path; scope does not change inputs, but ADR-0028 d5 lists promotion); event `catalog.product-promoted.v1`; audit; mail |

Neither changes an Offer's seller. Match requires approval on in practice (brief s8 item 18; AU on).

### 4.6 Platform category tree (CAT-50, CAT-53; seed, editor after the first sale)
| Use case | Guard | Effects |
|---|---|---|
| Seed (system, deploy) | Versioned seed per Market (7.2); **only ever creates** missing categories; never edits, moves, merges or archives one (Ali B4). Every later tree change goes through the use cases below (slice 21), so `assertCategoriesRetirable` and the re-ask always run | — |
| `platform-category.create`, `.rename` (key `catalog.category-tree.edit`, protected) | Slug unique per Market; claim-text check on names (6.2) | Revision; event `catalog.platform-category-created.v1` |
| `platform-category.move`, `.merge`, `.archive` (same key) | **Bound (Q-K4):** the M1 marking stays in one unit; the use case is refused with `category.impact-too-large` when the tags to mark exceed the Market's `catalog.maxCategoryChangeTags` (7.1; AU 50,000, about 8 s in Mojtaba's estimate); `platform-category.impact` (9.2a) shows the count first, and the admin moves child categories in parts. Before the unit: `certification.assertCategoriesRetirable(ctx, ids)` for merge and archive and for **move** (ADR-0028 d5; C-4); a refusal or an error refuses the use case (`category.referenced-by-policy` with the type codes, or `category.check-unavailable`). In the unit: no cycle; archive or merge refused when a published revision would be left without a platform category (AC 4) | Audit (always, C-8: a move under a parent named by a `SELLER_OR_MANUFACTURER` row eases the rule, so every move is an audited entry path); in the same unit, every tag of every Offer under the affected subtree is marked `rechecking` (rule M1, 5.4); events `catalog.platform-category-moved.v1`, `-merged.v1`, `-archived.v1`. The own handler of these events then (a) calls `certification.platformCategoriesRetired` (system; backstop, C-4) for merge and archive, and (b) re-asks every tag of every Offer whose product's published revision is under the affected subtree, in idempotent batches (5.5) |

A merge rewrites no published revision (V1 is immutable): `categoryPath` resolution maps a merged
id to its target when building the query (the tree keeps `merged-into`), so published revisions keep
their recorded ids and the evaluation uses the live path. An archived id is dropped from the path.

### 4.6a Seller closure, suspension and erasure (Q-K11)
| Event in another module | What `catalog` does | Why |
|---|---|---|
| Seller suspended or closed (may-sell false) | Nothing in catalog's state. Offers stay, products stay; new writes refuse through `sellingEligibility` (4.1, 4.4); sale is refused by composition in cart and `ordering` (ADR-0024 d5) | May-sell is read live, never copied (ADR-0018 d4; 9.5) |
| Seller reinstated | Nothing; tags are re-asked by reconciliation (5.4 L4 row) | — |
| Seller erasure (CUS-03, designed with `ordering`, SL 14.2) | Catalog holds no personal data of the seller beyond account and seller ids (11.1). When that design lands it adds one consumed event; catalog's handler then deletes the seller's Offers (`offer-deleted`), withdraws its SELLER products (terminal, content kept as business content under the retention that design sets), and leaves promoted PLATFORM products as they are (content licence, 4.5). Request S-1 | Erasure and invoice retention are decided there, not here |

No data change is needed now (Mojtaba agrees).

### 4.7 Seller category and proposal (CAT-51 to CAT-54)
`pending` → `approved` | `rejected` | `cancelled`. Proposal by `own-category.propose`
(`mayProposeCategories` yes at the command; pending cap; claim-text check on names and
description). The CAT-54 pending cap is a **soft cap** (Q-K7, accepted): two concurrent proposals may
exceed it by one, since catalog has no per-seller root to serialise on; it is an anti-spam limit, not
a safety rule, and the next proposal is refused until the count is under the cap. Decision by `category-proposal.approve` / `.reject` (key
`catalog.category-proposal.decide`), always required regardless of CAT-36. On
`sellers.category-proposals-revoked.v1`, pending proposals become `cancelled` with reason
`permission-revoked` (CAT-51, AC 35). Promote (same id into the platform tree; free platform slug)
and merge (terminal) use the protected key `catalog.seller-category.promote-merge`, audited, with
events. CAT-53 says a merge moves the Offers' shelf; a platform category is never a shelf (CAT-52,
Hassan G1), so a merge **clears** the shelf on the seller's Offers and the admin may add the
platform category to the products through a revision (Hadi confirmed: CAT-53 is corrected to "a
merge clears the shelf; it does not move it"). A promoted category keeps its id and stops being a
shelf. Neither changes a published revision. Team decision 19.2 item 9.

## 5. Certification tags on Offers (CERT-20 to CERT-22, CERT-15, CERT-45; ADR-0028)

`catalog` never computes CERT-21. It asks `certification.evaluateClaims` and applies the answer
under the rules below. Every rule here is on Hassan's mandatory review list (brief s9).

### 5.1 Building the query (ADR-0028 d1; AC 8)
`ClaimQueryBuilder` (application layer) builds one `ClaimQuery` per (tag, variant on sale) from the
**state the use case will store**, never from the request body, the acting admin or an acting-as
session:

| Field | Source |
|---|---|
| `sellerId` | The stored Offer's seller id (for a create: `ActorContext.sellerId`, the only place it can come from) |
| `productId` | The stored Offer's product id (after a match: the target) |
| `productRevisionId` | The product's published revision **after** the change being saved. For a product never published, the **frozen submitted revision** (pending), never the working copy (team decision 19.2 item 3, ruled by Ali as a reading of ADR-0028 d1, not an amendment; conditions in 5.1a) |
| `variantId` | Each non-retired variant of that revision (a Simple product: its single variant). Never `null`: every sell unit has a variant id (M-1) |
| `typeCode` | The tag's type |
| `handling`, `attestationRecorded` | The Offer's values after the change |
| `platformCategoryPaths` | Every path, root first, of every platform category of that revision, resolved on the live tree (merged ids mapped, archived dropped; 4.6). Never a seller category (AC 11) |

Batches: at most 100 queries per call (CD 4.1); the fan-out splits larger sets.

**5.1a Submit-time asks (Ali's conditions on the d1 reading; B3).**
1. The revision named is a frozen submitted revision, never the working copy.
2. A submit-time answer never makes an Offer listed and never shows a badge: the Offer of a
   never-published product is not listed (4.4 rule) and is absent from `offerListings` (9.1).
3. Publish (4.2 rows 3, 4, 6) re-asks every non-removed tag against the revision being published,
   before the unit that moves the pointer; the pointer moves only with decisions whose inputs name
   that revision (5.2). A tag not allowed at that publish becomes `suspended` (cause `tag-suspended`).
4. A submit-time ask on an **already-published** product (the T4 check of 4.2 row 1) stores
   nothing: it only refuses or lets the submit through; tags keep the copy of the published revision
   until the publish re-asks. This point covers **only** the T4 check of existing tags; tags requested
   at a first submit are written as point 6 says (Hassan L4).
5. **Which tags the handlers and reconciliation see (B3, option chosen: exclude).** A tag whose copy
   names a revision that is `pending`, `superseded` or `changes-needed` (only possible on a product
   never published) is **excluded** from the certification-event handlers (5.5) and the daily
   reconciliation (5.6). It cannot be shown or used (point 2), and the publish re-ask (point 3) is the
   only way it becomes effective, so there is nothing for them to repair. The alternative ("use the
   pending revision") was rejected: it would let a handler decide on content nobody has approved.
   **Scope (Q-K12):** only revisions that were **never published** are excluded. A tag whose copy
   names a revision that was the published one when the tag was decided and has since been superseded
   (for example while a PLATFORM fan-out is settling) stays selectable by 5.5 and 5.6; it was
   effective, and the re-ask builds its query from the current published revision (5.1). Mojtaba's
   flag `copy_revision_published` ("was the published revision at decision time") implements this.
6. **Badge requests at the first submit (Reza, ux.md 7.10).** Before its first submit a product has
   no frozen revision, so `own-offer.add-tag` cannot ask for it (point 1). Instead `own-product.submit`
   and `own-offer.submit` accept `requestedTags: TypeCode[]` (closed schema; at most one per type;
   each a validated active type code of the Market; nothing about it is stored before the submit).
   - **When:** at submit, under the claim-bearing commands' rule (8.2 row of `.add-tag`): the server
     asks `evaluateClaims` for each requested type against the frozen revision being submitted
     (point 1), before the unit. If every requested type is allowed, the tags are written in the
     submit unit with status **`pending-publish`** (5.3) and copies naming that revision, **without
     badge data** (badge data is copied only when publish makes the tag `active`); the Offer is not
     listed, and the tags are excluded from 5.5 and 5.6 (point 5). The 5.2 rule applies unchanged
     (Hassan L3): the unit re-reads the Offer and product under version and writes a tag only when
     the decision's `inputs` equal the queries rebuilt from the state being saved; a lost race
     restarts from the ask (at most 3 attempts, then `conflict.retry`). On a later submit of a
     never-published product the set of `pending-publish` tags becomes exactly `requestedTags`
     (types left out are removed, the rest asked again against the new revision). If any is not allowed, the **whole submit is refused** with
     `claim.requested-tag-not-allowed` (per type: code and CUX 3.7 reason), the same no-silent-loss
     rule as T4; `unavailable` refuses with `claim.check-unavailable`.
   - **Acting-as:** a submit whose `requestedTags` is non-empty is refused with
     `access.acting-as-refused` (never silently dropped); with an empty list the acting admin may
     submit content.
   - **Publish:** yes, re-asked against the revision being published before the pointer moves
     (point 3); a tag not allowed then is `suspended` with its reason.
   - For `own-offer.submit` on a PLATFORM product (already published) the field works the same way
     against the published revision; there `own-offer.add-tag` is also available on the draft.
   - Allowing tags only after the first publication was rejected: the seller would learn about an
     unbacked badge only after approval (19.2 item 3), and the Offer would go live first without it.

### 5.2 Accepting a decision (ADR-0028 d2, d3; AC 7, 9, 10)
1. The use case asks **outside** its unit (PP 3.1 row 5), then opens one unit that re-reads the
   Offer (and the product's published revision pointer) under version.
2. A tag is written `active` only if, for **every** variant, `allowed` is true and the returned
   `inputs` equal the queries rebuilt from the state now being saved. Otherwise: for a seller's
   add, the add is refused with the reason of the first failing variant (CUX 3.7 words); for a
   write that keeps an existing tag, the tag becomes `suspended` (5.3).
3. A lost version race restarts the use case from step 1 (at most 3 attempts, then
   `conflict.retry`). No decision is kept for a later request.
4. **Fail closed:** `reason: 'unavailable'` or a facade error never activates a tag. For a seller's
   add or edit it refuses the save (`claim.check-unavailable`); in a handler or the reconciliation
   it leaves the tag in its current state, marks it `rechecking`, and retries (5.5). A `rechecking`
   or `suspended` tag never becomes `active` without a fresh allowed decision (AC 13).
5. Several variants: the basis of a seller certificate covers all variants. A manufacturer basis
   may cover some variants only; then the tag is not allowed (brief s5, fail-closed; AC 15).
   Per-variant tags are not built (19.2 item 4).
6. No use case input type has a decision, basis, certificate id, issuer id, tag status or
   provenance field; Import accepts only "requested type codes" (AC 9, AC 38).

### 5.3 Tag status
`pending-publish` → `active` | `suspended` | `removed`; `active` ⇄ `rechecking`; `active` |
`rechecking` → `suspended`; `suspended` → `active` | `rechecking`; `active` | `suspended` →
`removed` (terminal for that tag row).

| From → to | Trigger | Effect on the Offer | Seller sees (brief s4 table) |
|---|---|---|---|
| (none) → `pending-publish` | Requested at the first submit (`requestedTags` of `own-product.submit` or `own-offer.submit` on a never-published product; refused in acting-as), allowed by 5.2 against the frozen submitted revision (5.1a point 6) | Not listed (the product is unpublished); **no badge data stored or returned**; excluded from 5.5 and 5.6 | "Checked at submit, confirmed at publish" |
| `pending-publish` → `active` or `suspended` | Publish re-asks against the revision being published before the pointer moves (5.1a point 3); badge data copied only on `active` | `suspended` adds cause `tag-suspended` | Badge, or reason and next step |
| `pending-publish` → `removed` | Left out of `requestedTags` at a later submit, or the Offer is deleted or the product withdrawn | — | — |
| (none) → `active` | Seller adds a type in the Offer form (`own-offer.add-tag`; refused in acting-as), allowed by 5.2 | — | Type and basis |
| `active` → `rechecking` | A handler or the reconciliation selected the tag and has not settled it, or `evaluateClaims` was `unavailable` | Listed; the display copy carries **no badge data** while `rechecking` (cart and storefront show no badge); `ordering` asks fresh anyway (ADR-0028 d4) | "Checking your certificate" |
| `active` or `rechecking` → `active` (basis switched) | A fresh decision allows another basis (ADR-0012 d6) | — | New basis; event `catalog.offer-tag-basis-switched.v1` |
| `active` or `rechecking` → `suspended` | A fresh decision is not allowed on every basis | Cause `tag-suspended` added: the Offer is **off sale, not deleted** (CERT-15) | Reason and next step from the `ClaimReason` code (CUX 3.7), or the cause of the event (expired, revoked, issuer no longer recognised, handling or category, manufacturer certificate) |
| `suspended` → `active` | A fresh allowed decision (renewal approved, new certificate, policy change, reconciliation, seller changes handling back) | Cause removed when no tag is suspended | Badge back; mail |
| `suspended` → `removed` | `own-offer.remove-suspended-tag` with an explicit confirmation "sell without this badge" (brief s7 team proposal, accepted); refused in acting-as; who and when recorded | Cause removed when no other tag is suspended; Offer listed again without the badge | — |
| `active` → `removed` | `own-offer.remove-tag` | — | — |
| `removed` → (new `active` row) | Adding the type again: a new entry path (ADR-0028 d5 "tag re-enabled") | — | — |

### 5.4 The claim copy (ADR-0028 d3, d11; brief s6)
Stored per `pending-publish`, `active`, `rechecking` and `suspended` tag (no badge data for `pending-publish`): type code; basis; certificate kind, id and
version (submission or revision id); issuer id; type revision id; policy revision id or "default";
`validUntil`; the badge data of the decision (CD 4.5) — kept only while `active`; the hash of the
inputs it was decided on (product revision id, variant ids, handling, attestation, category paths);
`evaluatedAt`; the last `ClaimReason`. It is a **copy for display and for selecting tags to ask
again**; it never permits anything (AC 14). Every answer of this module that shows a tag shows its
basis (CERT-24, CERT-44). `certification.seller-certification-issuer-confirmed.v1` refreshes the
badge data of the tags whose copy names that submission (by re-asking, never by editing the copy).

**Entry paths and where each asks** (ADR-0028 d5; C-1):

| Entry path | Use case or handler | Scope of the ask |
|---|---|---|
| Offer create, edit (description, condition, shelf, SKU included: "ask on every write", AC 11) | `own-offer.create*`, `own-offer.edit` (content fields only; its input type has **no** handling, attestation or tag field, so an acting-as session cannot reach them through it; B1) | All tags of the Offer |
| Handling change; attestation recorded or withdrawn | `own-offer.set-handling`, `own-offer.record-attestation` (separate commands, refused in acting-as; 8.2) | All tags |
| Tag added or re-enabled | `own-offer.add-tag` | That tag |
| Tag requested at the first submit (Hassan M2) | `own-product.submit`, `own-offer.submit` with `requestedTags` (5.1a point 6) | The requested types, against the frozen submitted revision; written `pending-publish` without badge data; re-asked at publish |
| Product revision submit (SELLER) | 4.2 row 1 | The owner's Offer, against the submitted revision (T4) |
| Product revision publish (approve, auto, revert) incl. a variant added or removed | 4.2 rows 3, 4, 6 | Every Offer of the product; for PLATFORM products in idempotent batches through the fan-out job (below) |
| Platform category move, merge, archive (C-4, C-8) | Own handler of the category events | Every Offer under the affected subtree, batched |
| Match (CAT-45), promotion (CAT-44) | 4.5 | The moving Offer; every Offer of the promoted product |
| Offer reactivated (cause `type-not-allowed` cleared) | Handler of `sellers.allowed-product-types-changed.v1` | Every tag of the reactivated Offers |
| Admin tax-category override (4.3; L4) | `tax-category.override` | Every tag of the owner's Offer against the new revision (published revision plus the new tax category only, Hassan 1a), before the unit. A tag not allowed is **suspended** in the same unit as the override publish, never a refusal: a tax correction must not be blocked by a seller's tag; the confirm shows the admin the tags that would be suspended. If `evaluateClaims` answers `unavailable` (or fails), the affected tags go to `rechecking` in that unit (no badge) and are re-asked by the fan-out job; they never stay `active` (Hassan 1b). The override is audited (`catalog.tax-category.overridden`) and the seller gets the suspension mail with the CUX 3.7 reason |
| `allowedProductTypesOf` fails (L4) | Handler of `sellers.allowed-product-types-changed.v1` | Nothing asked: an error never clears `type-not-allowed` (fail closed); the handler retries and the event's inbox row stays open |
| Offer-description claim-text cause cleared (L4) | `own-offer.edit` only (the seller rewrites the description; the edit passes 6.1 and re-asks) | All tags of the Offer; the cause clears in that unit only when the new text passes |
| Seller reinstated after suspension (L4) | None: daily reconciliation (5.6) | No event of `sellers` changes a claim input: may-sell is not a `ClaimQuery` input and is never stored here (M-5); tags are not changed by a seller suspension; certificate changes during the suspension arrive by certification events (5.5). Reconciliation re-asks within a day as the backstop |
| Import row (OFR-12) | 14 | That row's tags (requested type codes only) |
| Certification events | 5.5 | Selected tags |
| Daily reconciliation | 5.6 | All `active`, `rechecking` and `suspended` tags |
| Order placement | `ordering` (Phase 5) | Not here |

Retirement (CAT-48), withdrawal and delete take Offers off sale without asking (ADR-0028 d5).

**Publish fan-out** (job `catalog.reevaluate-tags`, worker, system actor, per Market): the publish
unit writes one `TagReevaluationRequest` row per (product, cause, published revision id) and, for
**every** PLATFORM publish, marks every non-removed tag of the product's Offers `rechecking` in that
same unit, whatever the number of batches (Hassan M1, Ali). For a SELLER product the single Offer is
re-asked in the same use case before the unit and settled in it (5.1a point 3).

**Rule M1 (Hassan; same unit, every claim input).** Whenever a write changes an input of a
`ClaimQuery` (5.1) for tags it does not settle in the same unit, it marks those tags `rechecking`
in that unit: a platform category move, merge or archive (every tag of every Offer whose published
revision has a category in the affected subtree, 4.6), a published variant set change (publish that
adds or retires a variant), and every PLATFORM publish. `rechecking` carries no badge data (5.3), so
no stale badge is shown between the change and the re-ask. A contract test lists these writes. The job takes
requests in order, asks in batches of 100 queries, and settles each Offer in its own unit under
version. Idempotent: a request already settled for that revision id is a no-op; a newer revision
supersedes older requests of the same product. Target: settled within 5 minutes of publish for 1,000
Offers (measured in spike 2).

### 5.5 Certification events consumed (C-5; `presentation/subscribers/`, system actor, `runOnce`)
| Event (CD 8.3) | Selects (from catalog's own rows) | Action |
|---|---|---|
| `seller-certification-approved.v1` (any kind) | Tags of that seller and type, any status | Re-ask (restores suspended tags: brief s4 e 4) |
| `seller-certification-expired.v1`, `-revoked.v1` | Tags whose copy names that certificate | Mark `rechecking`, re-ask; not allowed → `suspended` (AC 12) |
| `seller-certification-issuer-confirmed.v1` | Tags whose copy names that submission | Re-ask (refresh badge data) |
| `product-certification-approved.v1` | Every `suspended` and `rechecking` tag of that type in the Market (see the note) | Re-ask |
| `product-certification-coverage-changed.v1` | Tags whose copy names that certificate (coverage may have narrowed), plus every `suspended` and `rechecking` tag of that type (it may have widened) | Re-ask |
| `product-certification-expired.v1`, `-revoked.v1`, `-suspended.v1` | Tags whose copy names that manufacturer certificate | Re-ask |
| `product-certification-expiry-warning-due.v1` (C-6) | Offers whose `active` tag copy names that certificate | Mail to each Offer owner (template `catalog.mail.manufacturer-certificate-expiring`, words of CUX EM10); no state change |
| `claim-policy-changed.v1` | Tags of that type (all Offers in the Market of that type) | Re-ask, batched |
| `certification-type-revised.v1` | `claimTermsChanged: true` → the claim-text rescan (6.4) | — |
| `issuer-deactivated.v1` (`derecognised`) | Tags whose copy names that issuer id (ADR-0028 d11) | Re-ask; (`closed-to-new`): nothing |
| `certification-type-deactivated.v1` / `-activated.v1` | Nothing (CERT-03 changes no validity; CD 3.1) | — |

Note on manufacturer approval and coverage: the event carries ids only. Catalog cannot know which
products a new coverage revision covers without asking `certification`. Since this module may not
read certification's tables, and the only tags that can gain from a new manufacturer certificate
are tags that are not `active` (an `active` tag is already allowed), the handler re-asks every
`suspended` and `rechecking` tag of that type in the Market, batched; the daily reconciliation is
the backstop. Volume: suspended tags are few by construction. No request to `certification` is
needed (alternative: a facade `coveredProducts(revisionId)`; 19.2 item 5). Served from the open
tags-by-type index with a status filter (Q-K5, accepted); a dedicated partial index on suspended and
rechecking tags is added only if the re-ask metric of 19.2 item 5 shows them above 5% of a type's tags.

Rules: tags whose copy names a revision that is not published are not selected (5.1a point 5);
one inbox row per event (ADR-0006 decision 5); selection and settling in bounded batches of
100 Offers, each Offer in its own unit; a repeat of the event changes nothing (AC 12). A batch that
fails twice raises an alert and leaves its tags `rechecking` (which shows no badge; ordering's fresh
check governs purchase).

### 5.6 Daily reconciliation (ADR-0028 d10; job `catalog.reconcile-tags`)
Per hosted Market, daily at 03:00 in the Market's `defaultTimezone` (a run time only; validity
boundaries are `certification`'s), system actor, in the worker: every `active`, `rechecking` and
`suspended` tag of both bases whose copy names a published revision (5.1a point 5) is re-asked in batches of 100, ordered by `evaluatedAt` ascending, each
Offer settled in its own unit. It repairs a lost event in both directions (AC 12, AC 13). Two
consecutive failed runs alert (brief s9). The run records counts (asked, kept, switched, suspended,
restored, unavailable) as a metric, not an audit row; each tag change is audited (11.3).

### 5.7 Material content change (ADR-0012 d3, ADR-0028 d6; C-2; AC 16)
When a published revision changes the value of an attribute whose definition is `material`
(manufacturer, ingredients, barcode; set by people), the publish unit writes
`catalog.product-material-content-changed.v1` (`productId`, `productRevisionId`,
`previousRevisionId`). Its own handler (system actor) calls
`certification.productMaterialContentChanged(ctx, productId, productRevisionId)`. A change to a
non-material attribute publishes nothing. The handler is idempotent by the inbox; the facade call
is idempotent on `certification`'s side (suspending a suspended certificate is a no-op).

## 6. Text without certification claims (ADR-0012 d1; Q1, Q6; AC 20 to 25)

### 6.1 The control
The server-side refusal is the control; `platform/ai`'s claim guard is defence in depth (R1). One
implementation of matching exists, in `certification` (CD 4.6). `catalog` calls
`certification.matchClaimTerms(ctx, texts)` (anonymous and system pair) **before** the unit of every
use case that writes a checked field, and refuses the save when any text matches or when the call
fails (`claim-text.found` with field and matched span; `claim-text.check-unavailable`; C-1, M8).
No override exists for anyone, admins included (brief s5).

**Payload of `claim-text.found`** (Reza, ux.md 7.2 item 2): per hit `field` (the field id of 6.2,
with the variant or option id where it applies), `locale`, `span` (start and end offsets into the
caller's own submitted text) and `typeCode` (the type whose term matched, from `matchClaimTerms`'
answer, CD 8.1), so the panel can choose the message kind. Never the term, the term list or any
other vocabulary data (the vocabulary is not published to sellers).

**Working-copy saves refuse per field, not per save** (Reza, ux.md 7.2 item 1). A draft save
(`own-product.save-draft`, `platform-product.save-draft`, autosave included) checks only the
checked fields whose value **changed** against the stored working copy. A changed field that matches,
or whose check is unavailable, is **not written**: it keeps its last saved value. Every other field
of the request is saved in the same unit, and the answer is a success with `refusedFields: [{ field,
locale, code: 'claim-text.found' | 'claim-text.check-unavailable' | 'text.invisible-character',
hits? }]`. Reasons:
- The rule "product content never asserts a certification" stays absolute: no claim word is ever
  stored, not even in a private draft, so no later path (submit, revert, AI context, an admin view,
  a leak) can carry it. Saving the draft and blocking only submit was rejected for that reason.
- Refusing the whole save would discard every other edit since the last save.
- Submit, publish and `claim-text.check` still check **every** checked field (the vocabulary may have
  grown since the field was saved).
- Non-text fields (categories, variants, tax category) are never refused by the matcher. A whole-save
  refusal stays only for structural errors (`conflict.stale`, `variant.unknown`, schema errors).

### 6.2 Which fields: default-deny (AC 21)
A registry `ClaimCheckedFields` in `catalog/domain/` lists every customer- or search-visible text
field: product name, short and full description, attribute names and text values, option and
variant labels, image alt text, image file name as shown (the server names files; the client's file
name is never stored or served), URL key (CAT-12), Offer description, seller category names and
descriptions, proposal names and descriptions, platform category names, attribute-definition names
and option labels (seed and editor), and SEO and brand fields when they come. A schema-based test
walks every content type of `catalog/contracts/` and fails when a string field is in neither the
checked list nor the explicit exempt list (exempt: `sellerSku`, internal codes, reason codes).

### 6.3 Plain text and invisible characters (brief s5)
Every text field is a `PlainText` value object (kernel): stored as given, rendered as text, no HTML
interpretation. Before matching, `PlainText` refuses bidi controls and default-ignorable characters
in every field (`text.invisible-character`). ZWNJ and ZWJ are accepted **only when both neighbouring
characters belong to a joining script** (a kernel list keyed by Unicode script, e.g. Arabic, Syriac
and the Indic scripts; not a Market list); anywhere else they are refused with the same code. Where
accepted they stay in the stored text, and the matcher strips ZWNJ and ZWJ **in every script**
before matching (CD 4.6; Hassan's ruling, 19.2 item 6; request X-4).

The panel's "Remove hidden characters" helper (ux.md 7.3) is allowed under Hassan's conditions
(3a): it runs only when the person presses it; it never removes ZWNJ or ZWJ; it never saves or
submits by itself (the person saves as usual and the server checks again); and it is offered only
for `text.invisible-character`, never for `claim-text.found`. It is convenience; the server stays
the control. NFKC, case folding, confusables and the separator and
digit passes are the matcher's.

**A ZWNJ or ZWJ outside a joining script survives the helper (confirmed).** Because the helper keeps
every ZWNJ and ZWJ, `text.invisible-character` can remain after it runs. The person fixes it by hand:
each `text.invisible-character` hit carries `{ field, locale, offset, character: 'ZWNJ' | 'ZWJ' |
'other' }`, so the panel can say "There is an invisible joining character here" and place the cursor
or selection at that offset; the person deletes it (one Backspace) and saves. A press-only
"remove this one character" action at a named offset would be a change to Hassan's 3a condition and
is **not** allowed unless he rules it; until then, manual deletion is the path.

### 6.4 When the vocabulary grows (Q6; AC 25)
On `certification-type-revised.v1` with `claimTermsChanged: true`, job `catalog.rescan-claim-text`
(per Market, batches of 100 texts per `matchClaimTerms` call) scans the **published** texts of
every product, Offer description, seller category and platform category, plus attribute-definition
names, option labels and category-proposal texts, each against the terms of **every** locale of the
Market, not only the text's own locale (Hassan L5). A product whose published
text now matches gets `claimTextFlaggedAt` and cause `product-not-listed` on all its Offers (off
sale, not deleted), with mail to the owner (SELLER) or an admin alert (PLATFORM). The flag clears
when a revision without a match is published (that revision is checked at submit like any other).
An Offer description that matches gets its own cause on that Offer only; it clears only through
`own-offer.edit` with a passing description, which re-asks every tag (5.4, L4). A failed rescan alerts and
retries; it never clears a flag.

### 6.5 Impact count before a vocabulary change (C-7)
`claim-terms.impact-count` (admin HTTP; access rule `permissions [certification.type.edit]`, the
key imported from `certification/contracts`, as `sellers` uses `identity`'s approve key, SL 6.1):
input = type code and the proposed term list per locale; output = the number of published products
and Offers whose published text would match, and `complete: true|false`. It runs the same scan as
6.4 in dry-run mode, synchronous, bounded (at most 20,000 texts or 10 seconds; beyond that it
answers `complete: false` with the count so far, which CUX shows as "at least N"). It needs a
matcher over **candidate** terms (`matchClaimTerms` uses published vocabulary only): request X-1,
ruled by Ali as a **`certification` facade method**, not a matcher exported from `contracts/`. Until
catalog slice 18 merges (with X-1), the endpoint does not exist and CUX's "We couldn't count" state
is what ships.

### 6.6 Seller-facing check (brief s4 a 4; Jafar)
`claim-text.check` (seller and admin HTTP; same keys as the form) runs 6.1 on given field values
without saving, for on-blur and the review step; it returns the same codes as a save. Rate limited
(8.4). The message kind (badge already set / certificate held / no certificate / descriptive type)
is chosen by the panel from the seller's own tags and `evaluateClaims` answers for the Offer form,
never from the matcher.

## 7. Market and Vertical behaviour, behind configuration

No Market code, country name, currency, language, Vertical name or certification type appears in
core code (ADR-0001 decision 5, ADR-0008 decision 6); they are configuration, seeds and tests only
(AC 5, AC 18). A literal check in CI covers `modules/catalog/` with the seed paths exempt by exact
path (SL 4 pattern).

### 7.1 The `catalog` section of `config/markets/<code>.json`
| Field | AU (launch) | ZZ (test fixture) | Used by |
|---|---|---|---|
| `productTypes` | `simple`, `configurable` | `simple` only plus a fixture Vertical type from `verticals/test-fixture/` | 3.1 rule 4 |
| `defaultFamily` | The seeded default family code | Its own | 4.1 |
| `taxCategories` | `taxable`, `gst_free`, each with a label key and the official guide link (ADR-0007 d5; values wait for the tax adviser) | Three different codes | 4.2 completeness, 4.3 |
| `sensitiveChanges` | `platformCategories`, `taxCategory`, `name`, `primaryImage`, `anyImage`, `variantRemoved` | `name`, `taxCategory` only | 4.3 |
| `conditions` | `new`, `used` (label keys) | `new` | Offer |
| `reviewReasons` | Codes with next-step keys (Reza and Jafar write them; brief s7) | Its own | 4.2 row 5, 4.4 |
| `photoLimits` | Set by Hassan (19.2 item 7): 10 MiB per file, 10 photos per product, 40 megapixels, longest edge of the upload ≤ 12,000 px, one frame; longest edge rendered 2,048 px | Small | 10 |
| `categoryProposalPendingCap` | 5 per seller | 1 | CAT-54 |
| `importLimits` | File ≤ 10 MiB, decompressed ≤ 50 MiB, 5,000 rows, 10,000 characters per cell (Hassan) | Small | 14 |
| `promotionEnabled` | `false` until counsel approves the content-licence clause (ADR-0010 d5) | `true` | 4.5 |
| `reconcileAtLocalTime` | `03:00` | `04:00` | 5.6 |
| `maxCategoryChangeTags` | `50000` (Q-K4) | `10` | 4.6, 9.2a |
| `maxVariantsPerProduct` | `100` (Ali, Phase 4 ruling) | `3` (so tests reach the limit) | 2.1, 4.2, 9.4 (`offer-moved`), 14 |
| `reviewChecks` | The four check codes and their label keys of 8.3a | Two codes | 8.3a |

Locales come from the Market's `supportedLocales` (INTL-10); the language tab is hidden when the
Market has one (brief s9). A Vertical override of `sensitiveChanges` is a later seam
(`ProductRevisionPolicy` takes the product's type, whose registrant tells the Vertical); no
trigger today.

### 7.2 Seeds (CAT-01, CAT-02, CAT-03; the editors come after the first sale)
Versioned seed files per Market in `modules/catalog/infrastructure/seed/` (exempt from the literal
check by exact path), applied by a `system` use case at deploy per hosted Market (the identity
role-seed pattern): platform category tree, attribute definitions with `material` flags, and one
default family. A seed **only ever creates** what is missing; it never edits, moves, merges or archives a
category, definition or family (Ali B4). Any change to an existing record goes through the editor
use cases (slice 21 for the tree), never through a seed PR. Names and option labels in seeds pass the claim-text check at apply time; a match fails
the deploy step loudly (a human wrote a claim word into seed data). AU seeds wait for Hadi's list
(Jafar for labels); ZZ seeds are a different tree, a different material attribute and a different
locale set, so tests prove the model generic.

### 7.3 Admin-editable settings (ADR-0026; board 15 item 3)
Declared in `modules/catalog/contracts/market-settings.ts`, read through the port
`CatalogMarketPolicy` (its adapter names the codes), changed by `catalog.market-settings.change`
(key `catalog.market-settings.edit`, protected; refused in acting-as; audit
`catalog.market-settings.changed`):

| Code | Type | AU default | **Safe value** (missing row or read failure; ADR-0026 d5) | Where read | Effect of the safe value |
|---|---|---|---|---|---|
| `catalog.approval-required` (CAT-36) | boolean | `true` (Q2) | `true` | In the submit unit (4.2 row 1, 4.4) | New submissions wait for review; nothing published is hidden |
| `catalog.seller-can-create-product` (OFR-01) | boolean | `true` | `false` | `own-product.create` only | New SELLER products refused (`setting.product-creation-off`); existing products, Offers, drafts and their edits and submits are unaffected |
| `catalog.sell-from-catalogue` (OFR-03) | boolean | `true` | `false` | `own-offer.create-on-platform-product` and the OFR-03 search hint only | New Offers on PLATFORM products refused; existing Offers stay listed |

`catalog.maxVariantsPerProduct` (7.1) is Market configuration, not an admin-editable setting: it
bounds contracts of other modules (the `offer-moved` re-key), so it changes only by a configuration
release with a mini-review of `inventory` and `pricing`. Lowering it never retires a variant; it only
refuses new adds.

**Rule (task requirement and ADR-0026 d6):** a setting is read only at a creation or submit
command. An Import row is such a command: each row reads OFR-01 ("My products") or OFR-03 ("Sell
from catalogue") as the form does (Hassan L9). The OFR-03 search hint only labels results and never
filters them. No handler, other job or read path reads OFR-01 or OFR-03, so a change or a read failure never
takes an existing Offer off sale or hides a product. Approval required is read at submit; a
revision that went to the queue under "on" stays pending if the setting turns off (the stricter
wins, ADR-0026 d6), and an admin decides it. Hassan reviews each safe value (ADR-0026 d5).

## 8. Contexts and authorisation

### 8.0 `ActorContext` and `MarketContext`
| Caller | Context | Where the seller id comes from |
|---|---|---|
| Seller Owner or Staff over HTTP | Authenticated, population `seller` | `ActorContext.sellerId` only (ID 4 rule 2; AC 37, 38) |
| Admin over HTTP | Authenticated, population `admin` | The stored record; another Market's id is "not found", byte-identical (AC 1) |
| `pricing`, `inventory`, cart, storefront, `ordering` through the facade | Their `CallContext` unchanged | The answer's records |
| `certification` through `CatalogReferences` | `MarketContext` only (named exception, CD 7.4) | None |
| Handlers, jobs | Envelope Market or one run per hosted Market; system actor | Rows selected |
| `platform/ai` capability calls (13) | The seller's `CallContext` (R3) | The aggregate the host use case loaded |

Repositories take the `MarketContext` (PP 4). Time from `Clock`. Every domain and integration test
runs on AU and ZZ.

### 8.1 Permission catalogue of `catalog`
Declared in `modules/catalog/contracts/permissions.ts`. P = protected (R11 of the identity brief;
brief s5 list, final with Ali and Hassan, 19.2 item 8). Default roles are a proposal on the roles
approved at identity G2 (ID 5.6); the mapping is the identity mini-review of request I-1.

| Key | Scope | P | Allows | Proposed default roles |
|---|---|---|---|---|
| `catalog.product.view` | platform | no | Marketplace products, Offers, revisions incl. reasons, queues (view), tag copies, admin product search (9.2) | Catalogue Moderator; Certification Reviewer; Operations and Support; Viewer |
| `catalog.product.approve` | platform | no | Approve, request changes, bulk approve for product revisions and first Offer publication (CAT-32, CAT-37 "Edit") | Catalogue Moderator |
| `catalog.product.match` | platform | no | CAT-45 at first approval | Catalogue Moderator |
| `catalog.product.delete` | platform | no | Withdraw a seller product or delete an Offer as admin; photo takedown (CAT-37 "Delete"; 10.5) | Catalogue Moderator |
| `catalog.product.promote` | platform | yes | CAT-44 (irreversible) | Platform Administrator |
| `catalog.platform-product.edit` | platform | no | Create, edit, submit, revert PLATFORM products (CAT-41) | Catalogue Moderator |
| `catalog.platform-product.retire` | platform | yes | CAT-48 | Platform Administrator |
| `catalog.tax-category.override` | platform | yes | Admin tax-category revision on a SELLER product (ADR-0007 d5) | Platform Administrator |
| `catalog.category-tree.edit` | platform | yes | Create, rename, move, merge, archive platform categories | Platform Administrator |
| `catalog.attribute.edit` | platform | yes | Attribute definitions, families, the `material` flag (unsetting it relaxes ADR-0012 d3) | Platform Administrator |
| `catalog.category-proposal.decide` | platform | no | Approve or reject seller category proposals (CAT-52) | Catalogue Moderator |
| `catalog.seller-category.promote-merge` | platform | yes | CAT-53 | Platform Administrator |
| `catalog.market-settings.view` / `.edit` | platform | no / yes | 7.3 | View: Catalogue Moderator, Viewer; edit: Platform Administrator |
| `catalog.own-product.view` | seller | no | Own products, Offers, revisions, reasons, tags, photos, Import reports | Store Manager; Catalogue and Stock; Customer Service |
| `catalog.own-product.edit` | seller | no | Create, edit, submit, delete own products and Offers; photos; handling and attestation; add and remove tags; sell without a suspended badge; revert | Store Manager; Catalogue and Stock |
| `catalog.own-import.run` | seller | no | Import (P1) | Store Manager |
| `catalog.own-category.propose` | seller | no | Propose categories (with SEL-26 on) | Store Manager |

Non-default verbs: `approve`, `match`, `promote`, `retire`, `override`, `decide`, `promote-merge`,
`propose`, `run`. **Review queue tabs (IA 8 item 2):** "Product revisions" (product revisions,
first Offer publication; later Import rows) opens with `catalog.product.approve`; "Category
proposals" with `catalog.category-proposal.decide`. The admin nav item `catalogue` shows with any
of `catalog.product.view`, `catalog.platform-product.edit`, `catalog.category-tree.edit`,
`catalog.attribute.edit`; the seller item `s_catalogue` with `catalog.own-product.view`.

### 8.2 Use cases and their access rules
`N` = `whenSellerNotApproved` (ID 5.2): **deny for every catalog use case** (brief s5; board 15
item 5; AC 37); no catalog entry joins the limited allow-list. "AA" = refused in an acting-as
session (and when the context cannot say, CD M5).

| Use case | Rule | AA | Notes |
|---|---|---|---|
| `own-products.list`, `own-product.read`, `own-offer.read`, `own-image.preview`, `own-revision.read`, `own-product.photos`, `own-offer.badge-options` | `permissions [catalog.own-product.view]` | — | Own seller only (repository takes the seller id from the actor); reads of 9.2a |
| `own-image.reorder` | `permissions [catalog.own-product.edit]` | allowed (content only) | 9.2a; working copy only |
| `own-product.create`, `.save-draft`, `.submit`, `.delete`, `.revert`; `own-image.upload`, `.remove`; `own-offer.create-on-platform-product`, `.edit`, `.submit`, `.delete`; `claim-text.check` | `permissions [catalog.own-product.edit]` | allowed (content only); the claim-bearing commands are the next row | `sellingEligibility` on every write; SEL-12 on create and submit; a tag in the submitted form is added through the next row's rule: `.submit` with a non-empty `requestedTags` is **refused in acting-as** (`access.acting-as-refused`; Hassan M1), with an empty list it is content only. `own-offer.edit` and `.create-on-platform-product` have closed input schemas with no handling, attestation or tag field (B1; L8); a create with initial handling, attestation or tags is a create followed by the next row's commands, so acting-as gets a draft without them. Ids resolved in the actor's own seller scope (M3); `own-image.upload` refuses a PLATFORM product |
| `own-offer.set-handling`, `.record-attestation`, `.add-tag`, `.remove-tag`, `.remove-suspended-tag` | `permissions [catalog.own-product.edit]` | refused | Brief s5, AC 19 |
| `catalog-products.search-for-offer` (OFR-03) | `permissions [catalog.own-product.view]` | — | ≥ 3 characters; Market from context; PLATFORM, published, not retired; per result whether the seller already has an Offer, whether the type is allowed |
| `own-category.propose`, `.cancel` | `permissions [catalog.own-category.propose]` | — | `mayProposeCategories` at the command |
| `own-import.*` | `permissions [catalog.own-import.run]` | refused (identity kept by the job; brief s5) | 14 |
| `own-listing.suggest-text` (AIS-03) | `permissions [catalog.own-product.edit]` | refused (R3) | 13 |
| `review-queue.list`, `revision.review-read`, `offer.review-read`, `revision.similar-products`, `admin-products.list`, `admin-product.read`, `admin-products.search` | `permissions [catalog.product.view]` | — | Store name through `sellerSummaries` per page (≤ 100 ids); AIA-03 flag on the review page (13); similar products and `matchable` (9.2) |
| `product-revision.approve`, `.request-changes`, `.bulk-approve`; `offer.approve`, `.request-changes` | `permissions [catalog.product.approve]` | — | 4.2, 4.4 |
| `product.match` | `permissions [catalog.product.match]` | — | 4.5 |
| `product.promote` | `permissions [catalog.product.promote]` | — | 4.5 |
| `admin-product.withdraw`, `admin-offer.delete`, `image.take-down` | `permissions [catalog.product.delete]` | — | 4.1, 10.5 |
| `platform-product.*` (create, save-draft, submit, revert, upload) | `permissions [catalog.platform-product.edit]` | — | CAT-41 |
| `platform-product.retire` | `permissions [catalog.platform-product.retire]` | — | Confirm carries the count shown |
| `tax-category.override` | `permissions [catalog.tax-category.override]` | — | 4.3 |
| `platform-category.*` | `permissions [catalog.category-tree.edit]` (create, rename, move, merge, archive); read and `platform-category.impact`: `catalog.product.view` | — | 4.6, 9.2a |
| `admin-product.offers` | `permissions [catalog.product.view]` | — | 9.2a (Offers tab) |
| `attribute-definition.*`, `attribute-family.*` | `permissions [catalog.attribute.edit]` | — | Unsetting `material` and removing a family's required field are relaxations recorded in audit. **Two-person rule (Hassan 2; ADR-0028 consequences)** for clearing `material`, archiving a definition whose current revision is `material` ("delete" is archive, Q-K6), and removing a `material` definition from a family: one admin requests (`attribute-definition.request-relaxation`, naming the definition id and its version), a **different** account id holding `catalog.attribute.edit` confirms (`.confirm-relaxation`); never in an acting-as session; the request expires after 72 h (proposal) and fails if the definition version changed; both account ids are in the audit row `catalog.attribute-definition.revised`. Lifecycle of a request: `open` → `confirmed` or `cancelled` (by the requester) or `expired` (job below); confirm after `expiresAt` is refused with `relaxation.expired` by the unit's own `Clock` check, whatever the job has done. **No races (Hassan, Low):** the request row has a `version`; confirm and cancel name it, and confirm, cancel and the expiry job each change state only from `open` with a conditional update on that version in their unit; the loser gets `conflict.stale` (job: skips the row) and nothing changes. **Definition revised while a request is open (Q-K14):** the unit that revises the definition (or archives it, or changes a family's membership of it) sets the definition's `open` request to `cancelled` in the same unit, with reason `definition-changed` and audit `catalog.attribute-relaxation.cancelled`; no new status. **"Delete" means archive (Q-K6):** a definition is never physically deleted (product revisions name it in their schema refs); the two-person rule covers archiving a material definition |
| `attribute-relaxations.list-open` (PA7 "Waiting for you") | `permissions [catalog.attribute.edit]` | refused | `open` requests of the Market, not expired, oldest first: request id, kind (`clear-material`, `archive`, `remove-from-family` with family id; `delete` merged into `archive`, since definitions are archive-only), definition id, code, name in the admin's locale and version, requester account id and display name (identity R-11, I-2), `requestedAt`, `expiresAt`, and allowed actions: `confirm` denied with `relaxation.same-admin` on the reader's own requests (shown with `mine: true`; `cancel` allowed there) |
| `catalog.expire-relaxation-requests` (job) | `system` | — | Worker, per hosted Market, every 15 minutes: each `open` request past `expiresAt` becomes `expired` in its own unit (conditional on `open` and its version, so a confirm or cancel that won is never overwritten), with audit `catalog.attribute-relaxation.expired` and the event `catalog.material-request-expired.v1` in the outbox; the own handler sends EC14 to the requester |
| `category-proposal.approve`, `.reject` | `permissions [catalog.category-proposal.decide]` | — | 4.7 |
| `seller-category.promote`, `.merge` | `permissions [catalog.seller-category.promote-merge]` | — | 4.7 |
| `market-settings.read`, `.change` | view / edit keys | refused | 7.3 |
| `claim-terms.impact-count` | `permissions [certification.type.edit]` | — | 6.5 |
| Facade read methods (9.1) | `anonymous` and `system` pairs | — | Never over HTTP (CI check, CD L3) |
| `CatalogReferences` | named exception (CD 7.4) | — | 9.3 |
| Handlers and jobs | `system` | — | 5.5, 5.6, 6.4 |

### 8.3 Where the hard rules of brief s5 are enforced
| Rule | Enforcement point | Test |
|---|---|---|
| CERT-21 via `evaluateClaims` only; equal inputs under version | `Offer.applyClaimDecisions` (domain) refuses a decision whose inputs differ from its own state; `ClaimQueryBuilder` the only builder | AC 7 to 11 |
| Every entry path asks | The table of 5.4; a test per row; a contract test lists every use case that changes an Offer's handling, attestation, product, category path or variant set, **or writes a tag (including `own-*.submit` with `requestedTags`, Hassan M2)**, and asserts it calls the builder | AC 10, 11; Hassan |
| Acting-as cannot reach claim inputs (B1/AA contract test) | A contract test runs every command of 8.2 marked "refused" in an acting-as session, plus `own-offer.edit`, `.create-on-platform-product` with handling, attestation or tag fields, and **`own-product.submit` and `own-offer.submit` with a non-empty `requestedTags`** (Hassan M1), and asserts refusal and no change | AC 19; B1 |
| Copies only restrict | No read of a tag copy in any use case that activates a tag; only `allowed` decisions activate | AC 13, 14 |
| CAT-43 | `Product` content commands refuse `AuthorKind.seller` on PLATFORM | AC 3 |
| One Offer per (seller, product), SKU unique per seller | Aggregate check plus Mojtaba's partial unique indexes | AC 2 |
| SELLER product accepts only its owner's Offer | `Offer.create` guard | AC 2 |
| Platform category ≥ 1; only category not removable | Revision completeness; category use case guard | AC 4 |
| Claim text refused, everyone, every field | 6.1, 6.2 registry and schema test | AC 20 to 25 |
| No price, stock, "sellable now" | No such field in `contracts/`; boundary rule "catalog imports neither pricing nor inventory" (ADR-0024 d5, slice P1) | AC 6 |
| Untouchable fields (L8) | Every command input is a **closed schema** (unknown fields refused, not ignored). The AC 38 forbidden fields are listed in `catalog/contracts/forbidden-input-fields.ts`: seller id, owner seller id, scope, `AuthorKind`, `productCode`, status, revision status, decision, reviewer, basis, certificate id, issuer id, tag status, claim copy, provenance, `autoPublished`, `material`, off-sale causes, variant id of a new variant; and on `own-offer.edit` / `.create-on-platform-product` also handling, attestation and tags (B1). A contract test posts each to every command and asserts refusal and no change | AC 38 |
| Ids in the actor's scope (M3) | Product, Offer and image ids in a seller command are resolved with the actor's seller id in the repository query; another seller's or Market's id answers byte-identical "not found". `AuthorKind` is derived only from `ActorContext` (population and acting-as), never from input. `own-image.upload` refuses a PLATFORM product. `variantId` rule of 4.2 | AC 1, 3, 37 |
| Approval bound to the reviewed revision | Guard in the approve unit | AC 29 |
| Seller shelf never an input; only the owner's shelf | `ClaimQueryBuilder` reads platform categories only; `Offer.setShelf` guard | AC 11, 35 |
| No model on decision paths | Allow-list (13.4) | AC 43 |

### 8.3a Named review checks (Reza, ux.md 7.6; Hassan H1)
Named checks are **stored and gating**. The approve request (`product-revision.approve`,
`offer.approve`) carries `checksConfirmed: CheckCode[]`; the unit records them on the decision
(code, reviewer, instant; append-only, audited with the decision). The approve guard refuses with
`review.checks-missing` (listing the codes) when a check **required for this revision** is absent.
The required set is derived by the server from the revision's classification (4.3), never from the
request:

| Check code | Required when |
|---|---|
| `photos-no-certification-mark` ("No certification mark or claim words in photos") | The revision adds or replaces any image (H1), and on every first publication |
| `category-fits` | Platform categories changed, or first publication |
| `tax-category-fits` | Tax category changed, or first publication |
| `not-a-duplicate` | First approval of a SELLER product (replaces `firstApprovalsConfirmed` for single approvals) |

The codes and labels are Market configuration (`catalog.reviewChecks`, 7.1, Vertical override
later); the mapping above is the AU seed. Bulk approve: an item that requires
`photos-no-certification-mark` is **skipped** with `review.checks-missing` (a photo is looked at one
revision at a time); the other checks may be confirmed once for the batch in the bulk request.
A check is a human's statement; no AI output ticks one (R2), and AIA-03 never pre-fills one.

### 8.4 Rate limits (set by Hassan at G2, 19.2 item 7)
| Item | Limit |
|---|---|
| Draft saves (autosave) | 60 per minute, 1,000 per 24 h per account (SL 6.5) |
| `claim-text.check` | 30 per minute and 1,000 per 24 h per account (Hassan L6) |
| Submits (product or Offer) | 30 per seller per hour |
| Photo uploads | 100 per seller per 24 h; 10 MiB per file; 40 megapixels, longest edge ≤ 12,000 px, one frame (Hassan, 19.2 item 7) |
| OFR-03 search, admin product search | 60 per minute per account |
| Bulk approve | At most 50 items per request; oversized refused whole (`batch.too-large`; Hassan 3b). Rows needing the named photo check are skipped (`review.checks-missing`); every skipped row is listed with its reason code (4.2) |
| Import | One running per seller; 5 starts per 24 h; file ≤ 10 MiB, decompressed ≤ 50 MiB, 5,000 rows, 10,000 characters per cell (Hassan) |
| AIS-03 calls | `platform/ai` budget; plus 50 per seller per 24 h |
| Facade batches | 200 keys for `offerSellUnits`, `offerListings` (PRC 6.2, INV 7.1, CRT 7.1), `offerTaxCategories`, `productsForOrder`; 100 ids for `CatalogReferences.*`; 100 queries per `evaluateClaims` call; oversized calls refused whole (L7) |

Per-account counters fail closed (`access.unavailable`), as SL 6.5.

## 9. Boundary

`catalog` imports the `index.ts` of `sellers`, `identity` and `certification` only (brief s3: one
direction; ADR-0028 d9). It imports neither `pricing` nor `inventory` nor `ordering` (ADR-0024 d5;
named boundary rule in slice P1). From `platform/` it needs: Market context, `Clock`, `IdGenerator`,
UnitOfWork, outbox, inbox and `runOnce`, scheduler, audit writer, permission registry and gate, the
extension-point registry (3.1), the Market settings store and reader (ADR-0026), Market
configuration, `platform/mail/`, the object store and file intake (10; ADR-0029), and for slices 25
and 26 `platform/ai`.

### 9.1 Public facade (`contracts/catalog.facade.ts`)
Every method takes a `CallContext` and calls one use case. Answers hold ids, codes and public
values; none carries a price, a stock number, Cost or "sellable now" (AC 6).

| Method | Returns | Access rule | Slice | Consumer |
|---|---|---|---|---|
| `offerSellUnits(ctx, offerIds)` (≤ 200) | Per Offer id found in the context's Market: `sellerId`, `productId`, `status` (`draft`, `pending-first-publish`, `changes-needed`, `published`, `deleted`), `listed` (catalog's own state, 4.4), and `sellUnits`: the variant ids that may carry a price or stock = the product's non-retired variants (`proposed` and `published`, M-1), each with its state. Unknown and other-Market ids are **absent**; a `deleted` Offer is present with `status: deleted` and no sell units | `anonymous` and `system` pair; in-process only | 7 | `pricing` CF1, `inventory` ownership check (INV 13). The caller compares `sellerId` with its actor (PRC 5.2) |
| `offerListings(ctx, keys: {offerId, variantId}[])` (≤ 200) | Published state only. Per key: `sellerId`, `productId`, `listed`, `variantBelongs` (the variant is `published` on the product's published revision), display data (product name and variant label in the request locale with the INTL-13 fallback, primary image key of the published revision), `publishedRevisionId`, and per tag of the Offer: `typeCode`, `status`, `basis` and, only for an `active` tag, the copied `BadgeData` (5.4); an `anonymous` caller receives `active` tags only (L3, rules below). Keys whose Offer is unknown, of another Market, deleted, never published, or whose product is not published are **absent** | `anonymous` and `system` pair | 11 | Cart CC1; storefront later; pricing H5 filter for raw ids |
| `offerTaxCategories(ctx, offerIds)` (≤ 200) | Per Offer: the tax category code of the product's published revision and its revision id | `system` | Designed now; built with `tax`/`ordering` (Phase 5) | `tax`, `ordering` |
| `productsForOrder(ctx, keys)` (≤ 200) | Snapshot inputs of VER-06 (revision id, `contentHash`, Offer id, tag copies) | `system` | Designed with `ordering`'s G2 (Phase 5); placeholder | `ordering` |

Rules for the read methods:
- **Advisory only (Ali; ADR-0025 d1):** `offerListings` and `offerSellUnits` run in a read-only unit
  without a transaction; their answers are advice for display and pre-checks. `ordering` re-checks
  in its own unit at placement and never treats `listed` as permission to buy.
- **Anonymous callers get active tags only (Hassan L3):** under the `anonymous` rule `offerListings`
  returns only `active` tags (type, basis, badge data); `rechecking` and `suspended` tags are
  returned, with status and basis and no badge data, only to the `system` caller.
- **Batch limits (Hassan L7):** 200 keys for `offerSellUnits`, `offerListings`,
  `offerTaxCategories` and `productsForOrder`; 100 ids for every `CatalogReferences` method. An
  oversized call is **refused whole** (`batch.too-large`), never truncated.
- **Read targets (Ali):** P95 ≤ 200 ms for `offerListings` (200 keys), the seller's product list
  page and the review-queue page, measured in spike 2 and in the slice tests' timing budget; a breach
  reopens the CQRS question (19.2 item 2).

The facade never says "this Offer is buyable with claim X" (AC 14); `ordering` asks
`evaluateClaims` itself (ADR-0028 d4). An HTTP route over any of these that takes raw ids is the
consumer's design and must filter through `offerListings` (PRC H5).

### 9.2 Admin product search (CUX open point 9)
`admin-products.search` (HTTP, `catalog.product.view`): query of at least 3 characters (name,
`productCode`), filters scope and status; per result: product id, code, scope, name in the admin's
locale, published revision id, and its variants (id, label, state). The certification coverage
picker (CA7) calls it; `certification` still validates ids through `CatalogReferences`. The
Certification Reviewer role needs `catalog.product.view` (8.1).

**For matching (Reza, ux.md 7.2 item 8; PA2, PA5):**
- `revision.similar-products(revisionId)` (`catalog.product.view`): for the first pending revision
  of a SELLER product only, up to 10 published, not retired PLATFORM products of the same Market,
  type and family, ranked by the same token search over name and code as above. A deterministic
  hint for the reviewer; it never matches anything and never orders the queue. Empty for any other
  revision.
- `admin-products.search` with optional `forRevisionId`: each result then carries `matchable:
  boolean` and, when false, one denial code checked in this order: `match.not-first-revision`
  (the named revision is not a SELLER product's first pending revision), `match.not-platform`,
  `match.retired`, `match.type-or-family-differs`, `match.other-market` (never shown: such products
  are absent), `match.offer-exists` (the seller already has an Offer on the target). `matchable` is
  advisory (ADR-0025 d1); `product.match` re-checks every guard of 4.5 in its own unit, plus the
  variant mapping, which the flag does not cover.

**Panel routes (Reza's IA additions, ux.md 7.8), checked against the use cases:**
| Route | Reads | Writes | Keys |
|---|---|---|---|
| `/offers/:id/review` | `offer.review-read` (the Offer, its product's published revision, tags with basis, named checks of 8.3a) | `offer.approve`, `offer.request-changes` | Page: `catalog.product.view`; actions: `catalog.product.approve`. Only for an Offer in `pending-first-publish`; otherwise the page shows its state with no actions |
| `/revisions/:id/match` | `revision.review-read`, `admin-products.search` with `forRevisionId`, `revision.similar-products` | `product.match` | Page: `catalog.product.view`; action: `catalog.product.match`. Only for a first pending revision of a SELLER product (4.5) |
| `/settings/catalogue` | `market-settings.read` | `market-settings.change` (refused in acting-as) | `catalog.market-settings.view` / `.edit` (protected) |

All three are consistent with 8.2; `offer.review-read` is the only use case added for them.

### 9.2a Panel reads (Reza, ux.md 7.2 items 3, 4, 8, 9, 10)
All are HTTP reads in read-only units (ADR-0025), answers advisory; every write re-checks.

**Badge options (`own-offer.badge-options`, item 3).** Input: `offerId`, optional preview values
`handling` and `attestationRecorded` (the form's unsaved choices). The server builds one
`ClaimQuery` per **active** certification type of the Market (`certificationTypes`) with 5.1's
builder, seller id from the actor and the preview values in place of the stored ones, and calls
`evaluateClaims` (≤ 100 queries per call). Answer per type: `typeCode`, `allowed`, `reason` (the
CUX 3.7 enum), `basis`, `badgeData` only when allowed (for the preview), plus `currentTag` (status
and basis of this Offer's tag of that type, if any); and `attestation.available` = handling (preview
or stored) is `SEALED_ORIGINAL` and at least one type's answer is allowed on, or refused only for a
missing attestation on, the manufacturer basis. `Cache-Control: no-store`; fresh on every call;
**nothing is stored** (a decision becomes a tag only through `own-offer.add-tag`, 5.2). For a product
with no frozen revision (never submitted), each type answers `reason: 'decided-at-submit'` with no
basis (5.1a: never the working copy). `claim.check-unavailable` when the facade fails. Rate limit:
the OFR-03 search limit (60 per minute).

**Sensitive fields (item 4).** `own-product.read` and `admin-product.read` return `maxVariants`
(7.1) and
`sensitiveFields`: the field ids (6.2 names) of the Market's `sensitiveChanges` (7.1) plus
`images` (always reviewed, H1), so the panel never hardcodes them. The submit answer returns
`classification: { outcome: 'published' | 'pending', sensitive, reasons: SensitiveReason[] }`
(4.3), reasons as codes (`platform-categories`, `tax-category`, `name`, `primary-image`,
`image-added-or-replaced`, `variant-removed`, `never-published`, `approval-required`).

**Review queue rows (item 8).** `review-queue.list` (oldest first, page of 50): per row `kind`
(`product-revision` | `offer-first-publication`), product id and name in the reviewer's locale,
seller id and store name (`sellerSummaries`, ≤ 100 ids per page), `firstPublication`, the
classification reasons above ("what changed"), `submittedAt` ("waiting since", an instant the panel
shows in the reviewer's zone), and the required checks of 8.3a. No AIA-03 flag in the list (R2: it
never orders or filters the queue).

**`platform-category.impact` (item 8).** Input: category id and the intended action (`move`,
`merge`, `archive`). Answer: counts of published products whose published revision names the
category or a descendant, of non-deleted Offers on them, of listed Offers, and of Offers with an
`active` tag; plus `complete` (bounded at 10 seconds, as 6.5: otherwise "at least N"). Advisory: the
confirm of 4.6 sends nothing from it, and the use case re-checks its own guards.

**Offers tab (`admin-product.offers`, item 8).** Per product, page of 50 by `firstPublishedAt`:
Offer id, seller id and store name, `sellerSku`, condition, status, `listed`, the stored off-sale
causes (admins may see them; anonymous callers never do, K-1), tags with status and basis and badge
data for `active` ones, and the allowed actions below.

**Allowed actions (item 8; the ID 8.6 pattern).** Every read of a product, revision, Offer, tag,
category, proposal and setting carries `actions: { [actionCode]: { allowed: boolean, denial?: code }
}`, computed by the same guard functions as the use cases for the reading actor (acting-as included).
Action codes are the use-case names of 8.2. Denial codes: `access.permission-missing`,
`access.acting-as-refused`, `seller.not-eligible`, `type.not-allowed`,
`setting.product-creation-off`, `setting.sell-from-catalogue-off`, `review.not-current-revision`,
`review.first-approval-needs-match-check`, `review.checks-missing` (codes listed),
`offer.locked-pending-first-publish`, `offer.exists-for-product`, `category.referenced-by-policy`
(with type codes), `category.check-unavailable`, `category.only-platform-category`,
`retire.count-changed` (at the action only), `match.*` (9.2), `promotion.disabled`. Throttling is
an error, not a denial: `request.throttled` with `retryAfterSeconds` for per-minute limits and
`request.daily-limit-reached` with `retryAfterSeconds` for 24-hour limits.

**Setting metadata (`market-settings.read`, item 9).** Per code of 7.3: `value`, `defaultValue`,
`safeValue`, `version` (sent back by `.change`; a stale version is `conflict.stale`), `changedBy`
(account id and display name through identity R-11, request I-2), `changedAt`, and
`safeValueInForce: true` when the store read failed and the safe value applies (ADR-0026 d5), in
which case `.change` is refused with `setting.store-unavailable`.

**Photos (`own-product.photos`, item 10; admin: inside `admin-product.read`).** Per image of the
working copy (seller) or of the revision being viewed (reviewer): `imageId`, a server-made `label`
("Photo 3"; client file names are never stored, 6.2), `state` (10.3), `refusalCode` (10.2 codes),
`thumbnailUrl` built by code (pending or draft: the API path, `no-store`, 10.4; public: the
cookieless origin), pixel width and height, bytes, `isPrimary`, `position`, `altText`. Reorder:
`own-image.reorder(productId, imageIds[], workingCopyVersion)` takes the **whole** list; it must be
exactly the working copy's image set (else `photos.order-mismatch`, nothing changed); it changes the
working copy only (the first is primary; a primary change is sensitive at submit, 4.3). Admins
reorder PLATFORM photos through `platform-product.save-draft`.

### 9.3 Ports
| Port | Declared in | Implemented by | Notes |
|---|---|---|---|
| `CatalogReferences` (C-3) | `certification/application/ports` (exported from its `contracts/`) | `catalog/infrastructure`, bound in the composition root (unbound fails boot once certification slice 13 merges) | `publishedProductRevisions(market, productIds)` → per id: exists, scope, current published revision id; `variantsOf(market, productId)` → variant ids with state; `platformCategoriesExist(market, ids)` → per id: exists and status. At most 100 ids per call, oversized refused whole (L7). `MarketContext` only, read-only unit, no actor (named exception, CD 7.4; on the checked-in list with its CI-enforced caller list). Retired variants are reported with state `retired` |
| `CatalogMarketPolicy` | `catalog/application/ports` | Adapter over the ADR-0026 store and Market configuration | 7.3 |
| `ProductPhotoStore` | `catalog/application/ports` | Adapter over `platform/storage` | 10 |
| AI capability declarations | `catalog/contracts/ai/` | — | 13 |

### 9.4 Events published
`catalog.<subject>-<past participle>.v1` (ADR-0006 decision 1); payloads from the closed vocabulary
(PP 5.3): ids, enums, booleans, instants; no actor, no text, no reason text (VER-13). Every event
ships in the slice that changes the state (brief s6).

| Type | Payload | Consumers |
|---|---|---|
| `catalog.product-revision-submitted.v1` | `productId`, `revisionId`, `scope` | Own: AIA-03 (slice 26) |
| `catalog.product-revision-published.v1` | `productId`, `revisionId`, `previousRevisionId`, `scope` | Own fan-out (5.4); `search` (Phase 6) |
| `catalog.product-revision-changes-requested.v1` | `productId`, `revisionId` | Own mail |
| `catalog.variant-added.v1` | `productId`, `variantId` | `inventory` (INV 3.5) |
| `catalog.variant-removed.v1` | `productId`, `variantId` (once per variant, in the unit that retires it: the working-copy save that deletes a `proposed` variant, or the publish that removes a `published` one; never followed by an add of the same id; B2) | `pricing` (CF2; at a draft save too, P-1), `inventory` (INV 3.5) |
| `catalog.product-material-content-changed.v1` | `productId`, `productRevisionId`, `previousRevisionId` | Own handler → `certification` (C-2) |
| `catalog.product-withdrawn.v1`, `-retired.v1`, `-promoted.v1` | `productId` | Own mail; `search` |
| `catalog.product-matched.v1` | `productId` (duplicate), `targetProductId` | Own mail |
| `catalog.offer-created.v1` | `offerId`, `productId`, `sellerId` | `inventory` (INV 3.5) |
| `catalog.offer-published.v1` | `offerId` | Own mail; `search` |
| `catalog.offer-deleted.v1` | `offerId`, `productId`, `sellerId` | `pricing` (CF2), `inventory` (INV 3.5) |
| `catalog.offer-moved.v1` | `offerId`, `fromProductId`, `toProductId`, `variantMapping: {from, to}[]` (ids only; at most `maxVariantsPerProduct` entries, AU 100, since the mapping covers the duplicate's non-retired variants) | `pricing` (CF4), `inventory` (request V-1) |
| `catalog.offer-listing-changed.v1` | `offerId`, `listed` | `search`, storefront (Phase 6) |
| `catalog.offer-tag-added.v1`, `-removed.v1`, `-suspended.v1`, `-restored.v1`, `-basis-switched.v1` | `offerId`, `typeCode`, `basis` (enum or null) | Own mail; `search` |
| `catalog.platform-category-created.v1`, `-moved.v1`, `-merged.v1` (with `targetCategoryId`), `-archived.v1` | `categoryId` | Own handler (4.6); `search` |
| `catalog.category-proposed.v1`, `-proposal-approved.v1`, `-proposal-rejected.v1`, `-proposal-cancelled.v1`, `catalog.seller-category-promoted.v1`, `-merged.v1` | ids | Own mail; storefront |
| `catalog.import-finished.v1` | `importJobId`, `sellerId` | Own mail |
| `catalog.material-request-expired.v1` | `requestId`, `definitionId` (no actor in the payload, PP 5.3; the handler reads the requester from its own row) | Own mail (EC14 to the requester) |

Type codes in payloads: `typeCode` of a tag is an enum of the vocabulary's "code" kind; Hassan
ruled it fits PP 5.3 provided the value is a validated vocabulary code (19.2 item 10; `sellers` kept type codes out of its payload for the same
reason, SL 7.4).

### 9.5 Events consumed (`presentation/subscribers/`, system actor, `runOnce`)
| Event | Handler | Effect |
|---|---|---|
| `certification.*` of 5.5 | `catalog.reevaluate-from-certification` | 5.5 |
| `certification.certification-type-revised.v1` (`claimTermsChanged`) | `catalog.rescan-claim-text` | 6.4 |
| `certification.product-certification-expiry-warning-due.v1` | `catalog.warn-offer-owners` | Mail (C-6) |
| `sellers.allowed-product-types-changed.v1` | `catalog.apply-allowed-types` | Reads `allowedProductTypesOf`; adds or clears `type-not-allowed`; clearing re-asks every tag (entry path); mail "this product type is no longer allowed for you" (AC 34) |
| `sellers.category-proposals-revoked.v1` | `catalog.cancel-pending-proposals` | 4.7 |
| Own events | Fan-out, category re-ask and backstop, material change, mail | 4.6, 5.4, 5.7, 12 |

No copy of a seller's access state is kept (ADR-0018 decision 4); may-sell is read live.

### 9.6 Calls to `sellers` (approved facade only; SL 7.1)
| Call | Where | Notes |
|---|---|---|
| `sellingEligibility(ctx, sellerIds)` | Every seller write; approve and bulk approve (skip, CAT-33); Import per row | Error = no (AC 17). CERT-12: separate from the claim |
| `allowedProductTypesOf(ctx, sellerId)` | Product create, Offer create, submit, Import row, the SEL-12 handler | Approved method of SL 7.1 (slice 9 there, always `all` until its slice 14) |
| `mayProposeCategories(ctx, sellerId)` | `own-category.propose` | Approved method of SL 7.1 (slice 13 there) |
| `sellerSummaries(ctx, ids)` | Review queue rows (store name), admin lists, mail (seller zone for times in mails) | ≤ 100 ids per call; a not-approved seller shows "not yet approved" |
| `publishedStoreProfile` | Not used | The storefront's (Phase 6) |

No new `sellers` method is needed. The AI switch is read by `platform/ai` through `sellers`' port,
not by this module (SL 7.6).

### 9.7 Phase 4 consumers: their expectations and this facade
| Their item | Expectation | This design | Status |
|---|---|---|---|
| PRC CF1 | Batch `offersForPricing`: `sellerId`, lifecycle, `productId`, priceable Variant ids; unknown and foreign absent | `offerSellUnits` (9.1). Priceable = non-retired variants, `proposed` included, so a seller can price before the first publish; method **name differs** | **Ruled (Ali, P-1):** pricing adopts `offerSellUnits`, treats `proposed` variants as priceable, handles a `deleted` Offer present in the answer, re-keys on `offer-moved` and consumes `variant-removed` at a draft save too (B2) |
| PRC CF2 | Offer deleted (`offerId`); Variant removed (`productId`, `variantId`) | `catalog.offer-deleted.v1` (adds `productId`, `sellerId`), `catalog.variant-removed.v1` on **every** retirement, at a draft save or at publish (B2) | Match (additive fields); P-1 |
| PRC CF3, CRT CC3 | `Offer` and `Variant` id types from `contracts/` | Exported as branded `Id<'Offer'>`, `Id<'Variant'>`, `Id<'Product'>` | Match |
| PRC CF4 | Event with the Variant mapping when an Offer moves to a platform product | `catalog.offer-moved.v1` | Match. No `variant-removed` is published for the matched duplicate's variants (the product is terminal): consumers re-key on `offer-moved`. **If pricing processes a variant-removed of that product it would retire a re-keyed series; none is sent** |
| PRC M5 (c), INV M6 | Can a removed Variant id come back? | **No, never** (M-1) | Answered; tombstones stay one-way |
| PRC "Vertical override when catalog exposes an Offer's vertical" | — | Not exposed now; the type's registrant gives the Vertical when needed | No conflict |
| PRC 2.3 seller copy | Offers never change seller | Invariant (2.1) | Match |
| INV 13 | Event names and versions; batch "Offer owned by seller X, Variant of its product, in Market M"; Simple has exactly one stable Variant id | Events 9.4; `offerSellUnits`; Simple invariant (2.1) | Match |
| INV 3.5 | Offer-created, Offer-deleted, Variant-added, Variant-removed | 9.4 | Match. **Conflict V-1, ruled (Ali):** `inventory` adds an idempotent handler of `catalog.offer-moved.v1` that re-keys stock from (Offer, fromVariant) to (Offer, toVariant); catalog slice 16 does not merge before it |
| INV 3.5 Variant-added clears a tombstone if newer | — | Never needed (ids not reused); harmless | No conflict |
| CRT CC1 | ≤ 200 (Offer, Variant) keys, anonymous, published state only: `sellerId`, sale state, Variant belongs, display data (title, Variant label, primary image reference), badge structure; unknown, foreign, deleted absent | `offerListings` (9.1). **Two refinements:** (a) sale state is `listed: boolean` only (no reason codes to an anonymous caller: off-sale causes reveal seller facts); (b) badge data only for `active` tags; a `rechecking` or `suspended` tag returns status and basis without badge data, so cart shows no badge. A never-published Offer is absent | **Ruled (Ali, K-1):** accepted with (a), (b); cart treats an absent key as unavailable and never treats `listed` as permission to buy (advisory, ADR-0025 d1); anonymous callers get `active` tags only (L3) |
| CRT CC2 | Every sell unit has a stable Variant id | Yes (M-1) | Match |
| Batch limits | 200 (pricing, inventory, cart) | 200 for both read methods | Match |
| Offer form composition | Price and stock parts composed in the client or BFF; catalog's backend calls neither (INV 5.1, PRC) | Same (brief s4 a 5) | Match |

## 10. Photos and files (CAT-14; brief s5; ADR-0004 d1, ADR-0009 d5, ADR-0016 d3, ADR-0029)

The first **public** file of the platform. `certification` built the private side (CD 9); this
module adds a public rendition path that needs ADR-0029's cookieless origin (Ali; T5 ruling of CD
9.4). Slice 13 cannot merge before ADR-0029 is Accepted.

### 10.1 What is stored where
| Object | Area | Key | Public? |
|---|---|---|---|
| Raw upload | Private intake area only while scanning and re-encoding run; **deleted as soon as intake ends** (clean or refused; Hassan M2) | Random id | Never (brief s5) |
| Master (re-encoded, all metadata stripped, the only kept copy of the photo) | Private area; not encrypted (business content, not personal; 11.1) | Random id | Never |
| Renditions of a photo in the **current published** revision | Public bucket served only by the cookieless origin (ADR-0029), keyed **per product**: `<productId>/<SHA-256 of the rendition bytes>-<size>` (Hassan L2) | Per product content address | Yes, immutable, long cache |
| Renditions of a photo only in a pending or changes-needed revision, or a draft | Private area | Per product content address | No: served by the API only (10.4) |

No Object Lock: a product photo is not legal evidence (brief s5).

### 10.2 Intake (AC 39)
Reuses `certification`'s intake components after they move to `platform/storage` intake (CD 8.2:
`MalwareScanner`, `DocumentInspector`; ADR-0029): streamed size limit (7.1), type by content only —
JPEG, PNG, WebP and HEIC/HEIF only if CD spike 2 found a decoder (else "convert to JPEG");
refused always: SVG, HTML, PDF, archives, GIF animations, polyglots; pixel and frame limits;
malware scan (error = refused); decode and re-encode in the sandboxed process with no network; all
metadata stripped incl. embedded thumbnails and location (brief s5); state `received` → `scanning`
→ `clean` | `refused` (same codes as CD 3.8 plus `file.too-many-pixels`). A photo is usable in a
working copy only when `clean`, of purpose `product-photo`, owned by the same product (and seller).

### 10.3 Image state
`received` → `scanning` → `clean` | `refused` (the raw upload is deleted at either end, M2);
`clean` → `public` (first published revision that contains it: renditions copied to the public
bucket in the publish handler, idempotent); `public` → `clean` when a publish leaves it out of the
current revision (its public renditions are **unpublished** by the same handler; the master stays for
revert and history; Hassan L2); `public` → `taken-down` (10.5). A rendition is never overwritten
(content address).

### 10.4 Serving
| Case | How |
|---|---|
| Published photo | Cookieless origin, `Content-Type` set by the server, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, no cookies accepted or set, immutable caching; the URL is built by code from the content key (R9 for AI surfaces too) |
| Pending or draft photo | Only the owning seller (`catalog.own-product.view`) and reviewers (`catalog.product.view`), and only as a **server-made rendition** (never the master or an upload): streamed by the API with `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox` (Hassan L1) (no signed links in Phase 3: ADR-0029, Hassan) |
| Raw upload, master | Never served to anyone |
| Origin (L1) | ADR-0029 must require the cookieless origin to be a **separate registrable domain** (not a subdomain of the panel or API domain), so no cookie scope or same-site rule can reach it |
| Alt text | Optional; the product name in the request locale when empty (brief s5) |

### 10.5 Takedown and retention
`image.take-down` (key `catalog.product.delete`, reason code, audited): deletes the public
renditions at once (cache purge per ADR-0029), marks the image `taken-down`; renderers skip it. If
it was the primary image the product keeps selling with the next image; if it was the only image,
the product gets the flag `photoTakenDownAt` and cause
`product-not-listed` until a revision with a clean photo is published. Retention (Hassan M2, which
settles the former owner question on originals): the raw upload never outlives intake; only the
metadata-free master is kept, for as long as a revision references it; a master referenced by no
revision (abandoned draft photos, ADR-0009 d7) is deleted after 30 days of inactivity of the working
copy.

## 11. Personal data, audit and history

### 11.1 Personal data (brief s9)
`catalog` holds little: account ids of revision authors, reviewers, attestation recorders and the
seller who removed a suspended tag; seller ids. Product and Offer content is business content
written for the public and is stored clear (as published content must be). The "changes needed"
free text is written by an admin about a listing; it is stored clear on the revision, shown only to
the owning seller and to holders of `catalog.product.view`, and never put in an event, the outbox,
a log or an audit `before`/`after` (VER-13; stored clear, ruled A by Hassan, 19.2 item 11).
Photos lose all metadata at intake, and the raw upload is deleted when intake ends (M2), so no
location data is kept. AI suggestions are stored with the draft and purged with it
(13). No catalog field goes to an AI provider beyond the allow-list of 13.

### 11.2 Never outside the module
No free text in events, outbox, audit before/after, logs or error bodies (AC 42); searches are POST
bodies; request bodies are not logged.

### 11.3 Audit (IMP-10; in the transaction of the change; ids, codes and booleans only; AC 42)
`catalog.product-revision.approved`, `.changes-requested`, `.auto-published` (system), `.reverted`;
`catalog.offer.first-publication-approved`, `.changes-requested`; `catalog.product.matched`,
`.promoted` (with the admin's no-claim confirmation flag), `.retired`, `.withdrawn` (seller or
admin), `.deleted-draft` is **not** audited (never submitted; 4.1); `catalog.offer.deleted`,
`.edited` (published Offer edits, AC 33), `.attestation-recorded`, `.attestation-withdrawn`,
`.handling-changed`; `catalog.offer-tag.added`, `.removed`, `.removed-while-suspended` (the
"sell without badge" confirmation), `.suspended`, `.restored`, `.basis-switched` (system actor for
handler-made changes), each with type code, basis, certificate kind, id and version, issuer id and
policy revision id (brief s5); `catalog.tax-category.overridden`; `catalog.platform-category.created`,
`.renamed`, `.moved` (C-8), `.merged`, `.archived`; `catalog.attribute-definition.revised` (with
`materialFlagCleared` and both requester and confirmer account ids when relaxing, 8.2);
`catalog.attribute-relaxation.requested`, `.cancelled`, `.expired`; `catalog.category-proposal.approved`, `.rejected`,
`.cancelled`; `catalog.seller-category.promoted`, `.merged`; `catalog.import.started` (file hash,
row counts); `catalog.image.taken-down`; `catalog.market-settings.changed`; `catalog.ai-claim-flag.
shown-and-decided` (AIA-03 R12: suggestion reference and hash, decision id). In acting-as, the
acting admin is recorded (IMP-06). A seller's own draft save or submit is history, not an audit
row (SL 9 pattern).

### 11.4 History
Revisions and their decisions (V1, append-only, no `UPDATE` of content; a trigger refuses it,
Mojtaba), Offer history rows (V4, append-only), tag status history (append-only). The seller sees
its own; admins with `catalog.product.view` see all.

## 12. Mail

Through `platform/mail/` from handlers of own events, in the worker, system actor; read, render,
send outside any unit, then `runOnce` (ID 9). Recipient: the Seller Owner's sign-in address and
locale through `identity`'s contact point (request I-2); times in the seller's zone from
`sellerSummaries`. Templates `catalog.mail.<template>`; copy by Reza and Jafar with ux-copy; values
escaped; no reason text other than the reviewer's own words to the owning seller. Until
`notifications` (Phase 6) mail is the only channel.

| Template | Trigger |
|---|---|
| Product published; changes needed (field, reason, next step) | Revision published (first, or after review), changes requested |
| Offer published; Offer changes needed | Offer events |
| Your product was linked to a shared product (CAT-45) | `product-matched` |
| Your product is now a shared product (CAT-44) | `product-promoted` |
| A shared product you sell was retired (CAT-48) | `product-retired`, one per Offer owner |
| Badge suspended, Offer off sale (with the cause and next step); badge restored | Tag events |
| Manufacturer certificate covering your product expires in N days (C-6; CUX EM10 words) | `product-certification-expiry-warning-due` |
| This product type is no longer allowed for you | SEL-12 handler |
| Published text now contains a claim word (Q6) | Rescan |
| Category proposal approved, rejected, cancelled | Proposal events |
| Import finished | `import-finished` |
| EC14: your request to relax a material attribute expired without a second admin (to the requester's sign-in address, I-2) | `material-request-expired` |
| To reviewers: new items in the queue, coalesced to one per Market per hour (proposal) | Submit events |

## 13. AI uses (ADR-0019; slices 25 and 26, optional for launch)

Designed only as far as this module's side; the rest waits for `platform/ai` part 1 (switch
evaluation, budget, `ClaimGuard`) and the provider ADR ("ADR 3" of ADR-0019). Both capabilities
are **seller-scoped** (they read seller text; ADR-0019 d7) and **off for a new seller until an
admin switches AI on for that seller** (owner decision, certification G1; SEL-25). No AI slice
starts before this module's facade is merged and certification's AI slices are done; one AI slice
at a time (ADR-0019 d8), and no AI slice merges during Phase 5 (Ali; CLAUDE.md placement rule).
Neither is on the path to the first sale.

**No AI tools at this G2** (Ali, informational): `catalog` publishes no AI tool declaration. A later
tool, if any, is READ only, goes through `offerListings` under the caller's unchanged `CallContext`
(R3, R4), and needs its own mini-review and Hassan's R15 review.

### 13.1 AIS-03 listing writer
| Topic | Design |
|---|---|
| Trigger | The seller presses "suggest" next to one text field in the SELLER product form or the Offer form: `own-listing.suggest-text` (synchronous, outside any unit; refused in acting-as, R3). Not on PLATFORM products, not in Import, not for admins |
| Input allow-list (R5) | The working copy's own text fields in the request locale (name, short and full description, the Offer description), the type and family codes, the platform category names of the working copy, the attribute values the seller entered. Never: photos (ADR-0019 d3; brief s3), another seller's data, tags, handling, attestation, tax category, prices (catalog has none), reviewer reasons. The input language is the request locale (brief s7 "input language" — Jafar confirms) |
| Output (closed schema, R9) | `{ field, suggestion: PlainText ≤ field max }` for the requested field only; schema-validated; rendered inert (no HTML, links, images). The server runs the claim-text check (6.1) on the suggestion before returning it; a match drops it (`ai.suggestion-withheld`); `platform/ai`'s `ClaimGuard` runs first (R1, defence in depth) |
| Never suggested (R13, R14) | Handling, attestation, tags, categories, tax category (category feeds `evaluateClaims`, R1), ingredients, allergens, origin, weight, health claims: the prompt instructs not to add facts, and the evaluation set checks that no fact absent from the input appears |
| Effect (R4) | A draft per field: accept, edit or reject; no "accept all"; Undo after accept. Nothing changes until the seller's own submit through 4.2 |
| Provenance (R6) | The server stores each suggestion (id, field, hash, prompt version) with the working copy. At submit it builds per field `typed`, `ai-unchanged` or `ai-edited` by comparing the submitted value with the suggestions **it** issued for that working copy (never a client flag; AC 38, 44). The revision keeps it; the reviewer sees it (brief s4 c 2) |
| No-AI path (R8) | With the capability off for the Market or the seller, the controls are absent (Jafar); with the provider failing or out of budget, the states "writing", "could not write", "limit reached" never block typing or submit |
| Storage (R12) | Suggestions purged with the working copy; never in events, logs or audit |

### 13.2 AIA-03 claim flag (only "certification claim in text")
| Topic | Design |
|---|---|
| Trigger | Asynchronous: own handler of `catalog.product-revision-submitted.v1` for SELLER products only (brief s3), system actor, **no tools**; Market from the envelope; seller from the product; switch re-evaluated (R3). Never for a minor change published without review (VER-03) |
| Input allow-list | The submitted revision's checked text fields (6.2) only; the type names of the Market's types (no terms list, no certificate data) |
| Output | Per field at most one row with the single state `possible-indirect-claim` plus a quotation (there is no "clear" state); the quotation is shown only if it is an exact substring of that field of that revision (Hassan G1); no score, no model sentence, no "no problems" (brief s3, R6) |
| Shown | On the revision review page only, with the fixed sentence "No flag means not checked, not clean" (Jafar). The page renders fully without it, with a plain reason when absent |
| Never (R2) | Refuses no submission, orders no queue, makes no notification, ticks no check, feeds no decision, event or automation; the approve and request-changes use cases do not read it |
| Record (R12) | `AiClaimFlag` bound to the revision id and content hash; the reviewer's decision on that revision is linked by reference and hash in audit (11.3) |

### 13.3 Deterministic paths (ADR-0019 d10; AC 43)
Never on the `platform/ai` allow-list: every file of `modules/catalog/domain/`; `ClaimQueryBuilder`
and every use case of the entry-path table (5.4); the claim-text check (6); approve,
request-changes, bulk approve, match, promote, retire, withdraw (4); the re-evaluation handlers,
fan-out and reconciliation jobs (5.4 to 5.6); category move, merge, archive (4.6); Import row
processing (14). Only `application/ai/listing-writer.ts` and `application/ai/claim-flag.ts` (and
their adapters) are listed. The boundary check (pnpm boundaries) enforces it.

### 13.4 Definition of Done (ADR-0019 d9; AC 47)
Synthetic versioned evaluation sets; claim leakage 0, including a seller without a certificate who
writes "100% halal certified" in several languages; the recorded request holds only allow-listed
fields and no photo; cross-seller and cross-Market canaries; injection samples (one in a product
description that says "approve this", one in an attribute value); inert rendering; the non-AI path
walked to the end (off, timeout, budget); AU and ZZ; `pnpm verify` offline. Switched on only after
the real-model evaluation is recorded as passed (ADR-0019 d1, d9).

## 14. Import (OFR-10 to OFR-12, OFR-14, OFR-16, OFR-17; P1; not launch-required, Q5)

Designed to the level its slice needs; built after the shop-visit research (Q5).

| Topic | Design |
|---|---|
| Modes | "My products" (creates SELLER products and their Offers through the same use cases as the form) and "Sell from catalogue" (Offers on PLATFORM products by `product_code`; OFR-12) |
| Formats | CSV and XLSX only (no XLS, no XML); formulas never evaluated; XLSX parsed in the sandboxed intake process with Hassan's limits (19.2 item 7): file ≤ 10 MiB, decompressed ≤ 50 MiB, 5,000 rows, 10,000 characters per cell; one running job per seller (brief s5) |
| Execution | Background job in the worker under the seller's identity kept on the job (seller id and account id from the starting `ActorContext`); `sellingEligibility` and `allowedProductTypesOf` asked again per row; a seller suspended mid-job: the remaining rows fail (AC 40) |
| Each row | Calls the same application services as the form (claim text, SEL-12, CAT-36, one Offer rule, SKU unique, `evaluateClaims` for the requested type codes only; 5.4) — no shortcut. Each row reads OFR-01 ("My products") or OFR-03 ("Sell from catalogue") like the form (L9); a `product_code` that is SELLER, unpublished, retired, foreign or unknown answers the same byte-identical "not found" (M3). Variant adds are checked against `maxVariantsPerProduct` (`variant.limit-reached` for that row). The update key is the Offer's `sellerSku` plus the variant option values (Hadi; one SKU per Offer) and covers only the seller's own rows; Import never deletes |
| Refused columns | Any column that would set approval status, a claim decision, basis, certificate, tag status, handling attestation or provenance is refused (OFR-12; brief s5). The attestation is never recorded from a file. A `status` column cannot publish |
| Images | File names referring to a ZIP of the same job pass the photo intake (10.2); a URL is never fetched (AC 40). Rows without a photo stay drafts (brief s7) |
| Price and stock columns | Not read by `catalog`. They are `pricing`'s and `inventory`'s; how they reach those modules is for their gates (ADR-0024 consequences) |
| Errors | Stop on errors (over a threshold) or skip error rows (OFR-14); a full report with row numbers (OFR-16), each cell starting with `=`, `+`, `-`, `@`, tab or carriage return neutralised (AC 41); the report readable only by the seller (AC 37) |
| Audit | `catalog.import.started` with file hash and counts (11.3) |

## 15. Slices

### 15.1 Order, size and security gates
Every slice is one branch and one PR (rule 13), tested on AU and ZZ (with the Brisbane, Sydney,
Adelaide and Perth fixtures where a time appears), with Mojtaba's sign-off when it has a migration
and Hassan's review (tier A; nearly every slice touches a CERT-21 entry path, a file surface, the
claim-text refusal or an AI surface). Sizes as ID 12.1: S, M, L, XL.

| # | Slice | Size | Needs first | Hassan checks |
|---|---|---|---|---|
| 0 | This G2 approved, incl. Ali's approval of section 3 (registry and `AttributeSchema`) | — | — | — |
| P1 | Platform: `ExtensionPointRegistry` (3.1), the `AttributeSchema` kernel type (3.3), `PlainText` with the invisible-character rule (6.3) if not yet in the kernel, the named boundary rule "catalog imports neither pricing nor inventory" (ADR-0024 d5), the literal check paths; shared-file PR announced on the board | M | 0 | Registry sealing; boundary fixtures; ZWNJ/ZWJ rule |
| 1 | `Product` (PLATFORM/SELLER, Market, code, variant registry), `simple` and `configurable` handlers, outbox and inbox | M | P1; identity 8a (registry) | AC 1, 5; type immutability; CC2 invariant |
| 2 | Platform category tree seed per Market | S | 1 | Seed claim-text check (after 5, re-run) |
| 3 | Attribute definitions with `material`, default family seed; schema builder | M | 1 | `material` flag only from seed or protected key |
| 4 | Working copy, autosave, revisions with base and schema ref, tax category, `ProductRevisionPolicy` (approval setting from Market configuration until 7.3's store exists); the "≥ 1 clean image" completeness rule is switched on only when slice 13 merges (until then no revision has images; slice 13 is on the first-sale path, so no product is sold without a photo; Q-K13) | L | 2, 3; `Revision<T>` and `ContentHash` (SL 2.4) | AC 26, 29, 36 (first half) |
| 5 | Claim-text refusal: `ClaimCheckedFields` registry and schema test (attribute-definition names, option labels and proposal texts included, every locale's terms; L5), `matchClaimTerms` call fail-closed, `claim-text.check` with L6 limits; ZWNJ/ZWJ joining-script rule | M | 4; certification slice 2 (`matchClaimTerms`) | AC 20 to 24; M8 cases through the matcher; no override; L5, L6 |
| 6 | Platform product by admin; CAT-43 in the aggregate | M | 5 | AC 3 incl. AI-accept and Import variants |
| 7 | Own product and Offer: identity, SKU, condition, description; separate `set-handling` and `record-attestation` commands refused in acting-as (B1); shelf field; `sellingEligibility`, SEL-12, OFR-01; one-Offer rule; `offer-created`; `offerSellUnits` (≤ 200, refused whole); closed input schemas and the forbidden-field list; ids in the actor's scope; variant-id rule and `variant-removed` at a draft save (B2) | L | 6; `sellers` slice 9 | AC 2, 17, 19 (handling, attestation), 37, 38; B1, B2, M3, L7, L8 |
| 8 | Tags: `ClaimQueryBuilder`, `evaluateClaims` on every Offer write, equality under version, variant fail-closed, tag status `active`/`removed`, claim copy, tag events; submit-time asks (5.1a) | L | 7; certification slices 1 and 10 | AC 7 to 11, 14, 15, 18, 19; the entry-path contract test; 5.1a points 1, 2, 4 |
| 9 | Offer on a PLATFORM product; `search-for-offer` (OFR-03); `sell-from-catalogue` | M | 8 | AC 1, 2 |
| 10 | Submit and review queue: completeness, approve named revision, changes needed with reason, bulk with skip, first Offer publication review, CAT-36 from the ADR-0026 store (declarations, port, safe values), audit, mail | L | 9; ADR-0026 store (platform; lands with `sellers` slice 15 or here, whichever is first) | AC 26 to 30, 33; safe values block creation only (7.3) |
| 11 | Publish as entry path: re-ask before the pointer moves (5.1a point 3), fan-out job, `rechecking` in the publish unit for every PLATFORM publish and variant set change (M1), `suspended` on publish; variant added/removed events; `offerListings` (anonymous: active tags only) | M | 10 | AC 10, 15; fan-out idempotence; `offerListings` publishes nothing unpublished; M1, L3, L7; P95 read target |
| 12 | Re-evaluation from certification events, suspend, switch, restore, "sell without badge", daily reconciliation (tags on unpublished revisions excluded, 5.1a point 5); issuer derecognition by copy; C-6 mail; re-ask metric (19.2 item 5) | L | 11; certification slices 9 and 11 | AC 12, 13, 19 (sell without badge); idempotence; fail closed on `unavailable`; B3 |
| 13 | Photos: intake reuse, raw upload deleted after intake, master, per-product public keys, unpublish of renditions that left the revision, cookieless public origin on a separate registrable domain, pending photos as sandboxed renditions, takedown; every image added or replaced goes to review with the named photo check | L | 10; ADR-0029 Accepted; certification slice 4 (intake); the image library approval (16.1) | AC 39; H1, M2, L1, L2; joins the penetration-test scope (ADR-0024 d6) |
| 14 | Delete and withdraw (OFR-06), `offer-deleted`, `product-withdrawn`; material change event and its handler (C-2) | S | 11 | AC 16, 32; C-2 before certification slice 15 |
| 15 | VER-04 diff, VER-05 revert (entry path; retired-variant refusal), CAT-35 filter | M | 11 | AC 10 (revert) |
| 16 | CAT-45 match with variant mapping; `offer-moved` | M | 12; **`inventory`'s `offer-moved` handler merged (V-1)**; pricing's re-key (P-1) | AC 7 (match), 15, 31; **launch-required** (Q5) |
| 17 | `CatalogReferences` (C-3) and `admin-products.search` (CUX 9) | S | 1 | Named exception, caller list; before certification slice 13 |
| 18 | Claim-term growth: rescan job over all checked texts in every locale (L5), flags, off sale and mail (Q6); impact count endpoint (C-7) | M | 5; certification slice 12; X-1 (certification facade method) for the count | AC 25; L5 |
| 19 | CAT-44 promotion and CAT-46 own-brand flag | M | 16 | AC 31; promotion disabled until the legal clause |
| 20 | CAT-48 retirement; SEL-12 follow-up (`type-not-allowed`, reactivation as entry path; an `allowedProductTypesOf` error never clears the cause); tax-category override: content = published revision with only the tax category changed, suspension settled in the same unit as the override publish, `unavailable` → `rechecking` and re-asked, audited, CUX 3.7 reason mail to the seller (L4, Hassan 1a, 1b, Ali) | M | 12; `sellers` slice 14 | AC 34; L4; 1a, 1b |
| 21 | Category and attribute editors: move, merge, archive with `assertCategoriesRetirable` (C-4), `rechecking` in the same unit (M1) and audited moves (C-8); definitions and families; the two-person rule for clearing `material`, archiving a material definition and removing it from a family (Hassan 2) | L | 12; certification slice 13 | AC 4, 10 (category paths); B4 (the only path for tree changes); M1; backstop |
| 22 | URL key, display statuses (CAT-18), locale selection | M | 10 | URL key claim check |
| 23 | Seller categories (CAT-51 to CAT-54) | M | 10; `sellers` slice 13 | AC 35 |
| 24 | Import (each row reads OFR-01 or OFR-03; `product_code` not-found byte-identical; Hassan's limits) | XL | 13, 16; after the research (Q5) | AC 40, 41; L9, M3; parser sandbox; penetration-test scope if in the launch build |
| 25 | AIS-03 | L | 5; this facade merged; certification slices 16, 17; `platform/ai` part 1; `sellers` slice 16; never merged during Phase 5 | R15 review; AC 22, 44, 46, 47 |
| 26 | AIA-03 claim flag | M | 25; never merged during Phase 5 | AC 45 to 47 |
| 27 | Panel screens (frontend; one PR per row of `ux.md`) | XL in all | Figma and F0 (ADR-0017); each after its backend slice | Frontend track |

**First sale (Phase 3 exit for `catalog`, brief s11):** P1, 1 to 14 and 17. **Launch-required, not
first sale:** 16 (CAT-45, Q5), 18 (Q6 behaviour), 20 (CAT-48 is the safety valve for a bad shared
product), 21 as soon as an existing category must move, merge or be archived (B4: never a seed PR; seeds only
create). **Optional or later:**
15, 19, 22, 23, 24, 25, 26. Slices with a migration: 1, 2, 3, 4, 7, 8, 10, 11, 12, 13, 18, 21, 22
(`product_url_keys`, Q-K9), 23, 24, 25, 26 (Mojtaba places them). About 28 backend PRs plus P1; no date until Javad has the measured
pace of `identity` and `sellers` (brief s8: "4 weeks" is not credible).

### 15.2 Platform triggers (ADR-0015 decision 3) pulled by `catalog`
| Trigger | Slice |
|---|---|
| Extension-point registry and `verticals/` (ADR-0001 d1) | P1 |
| `AttributeSchema` | P1, 3 |
| First public file and the cookieless origin (ADR-0029) | 13 |
| The ADR-0026 settings store (if `sellers` slice 15 has not landed it) | 10 |
| First fan-out job with per-aggregate units at volume | 11 |
| Not pulled: Redis, a CQRS read model (19.2 item 2), `platform/ai` (pulled by certification) | — |

### 15.3 Spikes (run, not merged)
| # | Spike |
|---|---|
| 1 | Prisma 7 with the variant registry and revision content as rows vs `jsonb` (Hossein, Mojtaba). **Decided by Mojtaba's data design (Q-K1, accepted):** rows for queried content (texts, categories, variants, images), `jsonb` for attribute values, descriptions, labels and the working copy; the spike checks Prisma ergonomics only. Domain conditions: revision content stays immutable either way, and every claim-checked text stays reachable by the rescan (6.4) |
| 2 | Fan-out and reconciliation at volume: 10,000 Offers, 2 types, batches of 100 against a fake `evaluateClaims` with certification's measured P95 (CD 4.2 rule 5); target 5 minutes per 1,000 Offers |
| 3 | `matchClaimTerms` latency for a full product form (≈ 40 texts) and the rescan over 20,000 texts |

## 16. Dependencies and ADRs

### 16.1 Dependencies (for the owner's bundled list; Ali rules)
| Need | Standard library? | Recommendation |
|---|---|---|
| Image decode, re-encode, resize, metadata strip | No | The image library approved with ADR-0029 (shared with certification's previews), run in the sandboxed process; permissive or LGPL licence, never AGPL |
| Cookieless public origin and CDN | Infrastructure | ADR-0029 (Ali, Kazem) |
| XLSX reading (Import) | No | A streaming XLSX reader with formulas ignored, inside the sandbox; chosen at slice 24 with Hassan |
| CSV reading | Partly | A small streaming parser; a package only if the slice shows a need |
| Unicode normalisation, confusables | — | `certification`'s matcher; nothing in catalog |

### 16.2 ADRs needed
| ADR | Status | Order |
|---|---|---|
| ADR-0029 "Object storage and file intake" incl. the cookieless origin (no signed links in Phase 3); must require the origin to be a **separate registrable domain** (Hassan L1) | Reserved; Ali writes | Accepted before slice 13 (on the first-sale path) |
| ADR-0026 (settings store) | Accepted 2026-10-07 | Store landed before slice 10 |
| ADR-0028 (claim contract) | Accepted 2026-10-07 | Applied here; reading of d1 for a never-published product accepted by Ali as a reading, not an amendment, with the conditions of 5.1a (19.2 item 3) |
| "ADR 3" of ADR-0019 (provider) | Existing plan | Before slice 25 |
| **ADR-0030 "Read-only raw SQL helper with a checked-in statement list"** (reserved on the board 2026-10-07 for certification's hot path; amends ADR-0025 1(b); catalog's statements join the same list): data access goes through Prisma; any raw SQL statement (the category-subtree query, the rescan scan, a reconciliation cursor, if Mojtaba needs one) is listed in a checked-in file with its reason, signed off by Ali and Hassan, and a boundary check refuses raw SQL elsewhere. Ali's conditions: each list entry names its owning module and touches only that module's schema; the helper is read-only; bulk writes (the `rechecking` marking of M1 included) stay in Prisma | Reserved; Mohammad drafts, Hassan reviews (board) | Accepted before the first catalog slice that uses raw SQL |
| No new ADR for the registry (ADR-0001 d1 decides; 3 fixes the mechanism), the variant contract (M-1) or the Offer pattern (M-3) | Ali confirms at G2 (19.2 item 1) | — |

## 17. Hand-offs

### 17.1 For Mojtaba (`docs/design/data/catalog.md`)
Schema `catalog`. Tables per aggregate root of 2.1 and their children; `outbox`, `inbox`; tag
re-evaluation requests (5.4); rescan progress (6.4); rate-limit counters. Decisions that are his:
revision content as rows or `jsonb` (spike 1); the variant registry with a one-way state check
(`retired` final, no id reuse); partial unique indexes: one non-deleted Offer per (Market, seller,
product), `sellerSku` per (Market, seller) among non-deleted Offers, one non-removed tag per (Offer,
type), at most one pending revision per product, `productCode` and URL key per Market, platform
category slug per Market, seller category slug per (Market, seller); the append-only trigger and
grants for revisions, decisions, Offer history and tag history (no `UPDATE` of content, no
`DELETE` except a never-submitted draft product with its working copy, draft Offer and draft
images); the selection indexes of 5.5 (tag copy by certificate id, by submission id, by issuer id,
by (seller, type), by (type, status)), of the fan-out (Offers by product) and of the category
re-ask (published revisions by platform category id, through a revision-category table); the
reconciliation's ordered scan (`evaluated_at`); the rescan's text scan. Every root has `version`;
children's foreign keys include `market_id` (PM6). Ids of other modules (seller, certificate,
issuer, policy) as plain `uuid`, no FK (C4 of the certification data design).

**Changes from the G2 reviews that `docs/design/data/catalog.md` must carry** (Mojtaba is writing it
now; this document does not edit it):
1. Images (M2, L2): no long-lived "original" object; a raw-upload object deleted at the end of
   intake, a `master` object per image, rendition keys prefixed by `product_id`; image state gains
   the `public` → `clean` return when a publish drops it; a retention job for masters referenced by
   no revision (30 days of working-copy inactivity). Drop any column or job that kept originals for
   a counsel-set period.
2. Variants (B2, M3): the outbox write of `variant-removed` in the working-copy save unit; a check or
   trigger that a retired variant never returns to `proposed`/`published`; variant ids only minted
   server-side (no client-supplied id accepted at insert).
3. Tags (B3, M1): the tag copy keeps the revision id it was decided on, indexed so 5.5 and 5.6 can
   exclude copies naming a non-published revision; bulk `rechecking` updates in the category and
   publish units must be bounded and indexed (Offers by product; published revisions by platform
   category id) so the same-unit marking of M1 fits the P95 targets.
4. Seeds (B4): seed tables or seed bookkeeping record "created by seed" only; no seed-driven update
   path for categories, definitions or families.
5. Two-person relaxation (19.2 item 8): storage for a pending `material`-flag clearing awaiting the
   second admin (requester, instant, confirmer), append-only.
6. Read targets (Ali): indexes for `offerListings` (200 keys), the seller product list and the
   review queue at P95 ≤ 200 ms; spike 2 measures them.
7. Raw SQL (ADR-0030): any raw statement (category subtree, rescan, reconciliation cursor) is listed
   on the checked-in raw-SQL list with its reason for Ali and Hassan; each entry names `catalog` as
   owner and touches only the `catalog` schema; the helper is read-only, so bulk writes (the M1
   `rechecking` marking) stay in Prisma.
8. Rate limits (L6) and Import limits: counters for `claim-text.check` per minute and per 24 h.
9. Two-person relaxation (Hassan 2): the pending request row carries definition id and version,
   kind (and family id), requester, confirmer (must differ), status (`open`, `confirmed`,
   `cancelled`, `expired`), `expires_at`, indexed by (Market, status, `expires_at`) for the expiry job
   and the "Waiting for you" list; covers clearing `material`, archiving a
   material definition and removing it from a family.
10. SKU (Hadi): one `sellerSku` per Offer; no per-variant SKU column in Phase 3; Import's update key
    is (seller, `sellerSku`, variant option values).
11. Bulk approve cap of 50 (Hassan 3b): no storage change; noted for request validation.
12b. Answers to data-design questions (data 13): Q-K1 rows vs `jsonb` as proposed (15.3 spike 1);
    Q-K5 by-type index with status filter, partial index only above 5% (5.5); Q-K7 soft pending cap
    (4.7); Q-K2 no physical delete of Offers or variants, the
    product row stays as `discarded`, prune after 180 days (4.1); Q-K3 version += n, one version per
    event (4 intro); Q-K4 refuse above `maxCategoryChangeTags` 50,000 with
    `category.impact-too-large` (4.6, 7.1); Q-K6 archive only, no `DELETE` grant on definitions
    (8.2); Q-K9 slice 22 has a migration (15.1); Q-K10 **nullable current-revision pointer** (NULL
    only inside the creating unit), no deferred FK, agreed; Q-K11 nothing new (4.6a); Q-K12
    `copy_revision_published` as proposed (5.1a point 5); Q-K13 image completeness on with slice 13
    (15.1); Q-K14 the revise unit cancels the open request with reason `definition-changed` (8.2).
12a. Tag status gains `pending-publish` (5.3), whose copy row holds no badge data; the relaxation
    request row gains `version` for the conditional updates of confirm, cancel and expiry (8.2).
12. Variant limit (`catalog.maxVariantsPerProduct`, AU 100): enforced in the application layer
    under the product's version (a count of non-retired variants in the save, submit and publish
    units); Mojtaba decides whether a check or index helps; Market configuration, no table.

### 17.2 For Reza (`docs/modules/catalog/ux.md`; brief s12; IA 5.2, 5.3)
The screens of brief s12 on the IA's templates and routes: seller `/catalogue` (T2 list with
product, revision, Offer and tag states), "Add a product" (search first, then "Didn't find it?"),
the product and Offer form (T6; sections of the family; the Offer part with handling as Radio with
examples, attestation hidden until the manufacturer basis is on, the tag list built from
`evaluateClaims` answers with CUX 3.7 reason words and CUX 3.9 attestation display, `CertChip` from
copied badge data only for `active` tags), photos (uploader, reorder with a keyboard alternative,
alt text), Import (stepper, P1); admin Review queue tab "Product revisions" (`/review?type=revision`)
and revision review (`/revisions/:id`, T3: diff, provenance, tags with basis, named checks, AIA-03
section, decisions, match and promote), platform products (`/catalogue/products`), category tree
and attributes (after the first sale), category proposals tab. From the API: the status codes of
4.1 to 4.4 and 5.3; refusal codes (`claim-text.found`, `claim-text.check-unavailable`,
`claim.check-unavailable`, `claim.revision-would-drop-tags`, `offer.exists-for-product`,
`type.not-allowed`, `setting.product-creation-off`, `setting.sell-from-catalogue-off`,
`seller.not-eligible`, `revision.base-changed`, `review.not-current-revision`,
`review.first-approval-needs-match-check`, `revision.revert-restores-retired-variant`,
`category.referenced-by-policy`, `category.only-platform-category`, `text.invisible-character`,
`file.*`, `access.acting-as-refused`, `ai.suggestion-withheld`); per action `allowed` and a denial
code (ID 8.6); the warning before a submit replaces a pending revision and before a handling
change; the affected-Offer count before retire, promote and category changes; queue-tab keys of
8.1. Open copy items: review reasons, the four claim-text message kinds (brief s5), the
photo-badge sentence (Q4, legal), the "no flag means not checked" sentence.

**Changes from the G2 reviews that `docs/modules/catalog/ux.md` must carry** (Reza is writing it
now; this document does not edit it):
1. Handling and attestation (B1): their controls are separate actions (`set-handling`,
   `record-attestation`), not fields saved with the Offer form; in an acting-as session they are
   disabled with `access.acting-as-refused`, and so are the tag actions.
2. Photos (H1): the seller is told that adding or replacing a photo always goes to review even when
   other edits publish at once; the revision review page has the named check "No certification mark
   or claim words in photos" in its checklist.
3. Never-published products (5.1a): tag states shown at submit are "checked at submit, confirmed at
   publish"; no badge appears before publish; a tag suspended at the first publish shows the CUX 3.7
   reason.
4. Tags on a published product under re-check (M1): after a category change or a shared-product
   publish, tags show "Checking your certificate" (no badge) until settled.
5. Tax-category override (L4): the admin confirm lists the tags that would be suspended.
6. Category editor (B4, after the first sale): every move, merge and archive is a confirmed action
   with the affected-Offer count; no tree change happens outside the editor.
7. Impact count (X-1): until catalog slice 18 the "We couldn't count" state is what ships.
8. `material` flag (19.2 item 8): clearing it is a request awaiting a second admin's confirmation.
9. Refusal codes to add: `variant.unknown`, `product.not-found` (byte-identical for a product the
   seller may not sell from), `batch.too-large` (none shown to sellers), `text.invisible-character`
   also for ZWNJ/ZWJ outside a joining script; limits for `claim-text.check` (30 per minute) when the
   on-blur check is rate limited.
10. Owner Q1 (19.1): the "waiting for review" page promises no review time.

**Answers to `ux.md` 7.2 items 1, 2, 7, 8 and 7.6 (and the IA additions) that `ux.md` must reflect:**
11. Draft save (6.1): a claim word refuses **only that field**; the save succeeds with
    `refusedFields`. 3.4 and the autosave status change from "Not saved" to "Saved, except
    {field}"; the refused field keeps its error and its typed text on screen (the server keeps the
    last saved value); the error summary lists only refused fields. Remove "see 7.2: whole-save or
    per-field".
12. `claim-text.found` hits carry `field`, `locale`, `span` and `typeCode` (6.1); no term list.
13. Named checks (8.3a) are **gating** and server-derived: PA2 shows only the checks the answer says
    are required, Approve is disabled until they are ticked, and `review.checks-missing` is a real
    code (drop "if the checks gate"). Bulk approve skips items needing the photo check.
14. `retire.count-changed` is confirmed, with the current count in the answer.
15. `revision.similar-products` and `matchable` with its denial codes (9.2) exist; PA2 "Possible
    matches" is always shown for a first approval of a SELLER product (it may be empty).
16. The three IA routes are confirmed as in 9.2 (`offer.review-read` added).
17. "Remove hidden characters" helper (6.3): pressed only, keeps ZWNJ/ZWJ, never saves or submits,
    offered only for `text.invisible-character`.
18. Bulk approve: at most 50 rows; `batch.too-large` (Hassan 3b).
19. No SKU field on `VariantRow` (Hadi: one SKU per Offer); "(required)" only on the default locale
    (owner decision 2026-10-07).
20. `material` relaxation: request and confirm by two different admins, with expiry (8.2).
21. Items 3, 4, 8, 9, 10 are answered in 9.2a. Changes for `ux.md`: before the first submit,
    badge options answer "decided at submit" (no preview); queue rows carry no AIA-03 flag; the
    daily limit has its own code `request.daily-limit-reached`; reorder sends the whole list.
22. ZWNJ/ZWJ outside a joining script (6.3): the error can remain after the helper; the panel
    places the cursor at the reported offset and the person deletes the character.
23. Variant limit: `variant.limit-reached` (with `max`) on adding a size beyond
    `maxVariantsPerProduct` (AU 100) at save, submit, approve and Import; the panel disables "Add a
    size" at the limit from the product read (`maxVariants`).
24. Badge requests at the first submit (5.1a point 6): `requestedTags` on `own-product.submit` and
    `own-offer.submit`; a type not allowed refuses the whole submit with
    `claim.requested-tag-not-allowed` (per type, CUX 3.7 reason); in acting-as the checkboxes are
    disabled and a non-empty list is refused with `access.acting-as-refused`; a requested tag shows
    "checked at submit, confirmed at publish" and no badge until publish.
25. PA7 "Waiting for you" reads `attribute-relaxations.list-open` (8.2); own requests show
    `mine: true` with Cancel and no Confirm (`relaxation.same-admin`); EC14 is sent by the handler of
    `catalog.material-request-expired.v1` (9.4, 12).

## 18. Requests to other modules
No port, facade or event of another module is changed by this document.

| # | To | Request | By slice |
|---|---|---|---|
| X-1 | `certification` (mini-review) | For C-7: a **facade method** (Ali's ruling; not a matcher exported from `contracts/`) matching a **candidate** term list against texts with the same matcher, e.g. `matchCandidateClaimTerms(ctx, typeCode, termsByLocale, texts)`, `system` and authenticated-admin pair. Until catalog slice 18, CUX's "We couldn't count" state ships | 18 |
| X-2 | `certification` (information) | The reading of ADR-0028 d1 for a never-published product, accepted by Ali as a reading (no amendment) with the conditions of 5.1a: frozen submitted revision, no listing or badge from a submit-time answer, re-ask at publish before the pointer moves, nothing stored by a submit-time ask on a published product | 8 |
| X-4 | `certification` (confirm; Hassan 19.2 item 6) | The matcher strips ZWNJ and ZWJ in every script before matching (CD 4.6) | 5 |
| X-3 | `certification` | The intake components (`MalwareScanner`, `DocumentInspector`, image re-encode) move to `platform/storage` intake as CD 8.2 foresees, with ADR-0029 | 13 |
| I-1 | `identity` (mini-review) | Register the keys of 8.1 and map them to default roles (R10); `catalog.product.view` for the Certification Reviewer role (9.2); no catalog use case in the limited allow-list (board 15 item 5); protected keys of 8.1 | 1, 10 |
| I-2 | `identity` | Reuse R-4 (contact point) and R-11 (admin display names), as `sellers` and `certification` | 10 |
| V-1 | `inventory` (PR #43; **ruled by Ali**) | An idempotent handler of `catalog.offer-moved.v1` that re-keys stock from (Offer, fromVariant) to (Offer, toVariant). The mapping has at most `catalog.maxVariantsPerProduct` entries (AU 100), so the re-key is bounded and fits one unit. Catalog slice 16 does not merge before it | Before catalog 16 |
| P-1 | `pricing` (PR #44; **ruled by Ali**) | Adopt `offerSellUnits` (not `offersForPricing`); treat `proposed` variants as priceable; handle a `deleted` Offer present in the answer; re-key on `offer-moved` (at most `catalog.maxVariantsPerProduct` mapping entries, AU 100; no `variant-removed` is sent for a matched duplicate's variants); consume `variant-removed` at a draft save too (B2) | Their slice 1 |
| K-1 | cart (PR #45; **ruled by Ali**) | `offerListings` returns `listed: boolean` without reasons and badge data only for `active` tags (anonymous: `active` tags only, L3); a never-published Offer is absent. Cart treats an absent key as unavailable and never treats `listed` as permission to buy | Their slice using CC1 |
| A-1 | `platform/ai` part 1 | Declare AIS-03 and AIA-03 (seller-scoped), their field allow-lists (13), the allow-list entries of 13.3 | 25 |
| PL-1 | Platform | `ExtensionPointRegistry`, `AttributeSchema`, `PlainText` (P1); the ADR-0026 store by slice 10 | P1, 10 |
| O-1 | `ordering` (Phase 5 G1) | `productsForOrder` shape for VER-06 is designed with its G2; ordering asks `evaluateClaims` at purchase (ADR-0028 d4) | Its G2 |
| S-0 | `sellers` | No new facade method. Only approved methods are used (9.6) | — |
| S-1 | `sellers` and `ordering` (information, with CUS-03) | When the seller-erasure design lands, publish an event catalog can consume to delete the seller's Offers and withdraw its SELLER products (4.6a) | Its design |

## 19. Review record and open points

### 19.1 For the owner (Persian summary, through Hadi)
Only true owner items; the seven G1 questions are answered.

| # | Question, in plain words | Team recommendation | State |
|---|---|---|---|
| 1 | Does the "waiting for review" page for a product promise a review time? (brief s7, asked with the page text) | No promised time at launch, as decided for certificates; the queue shows the oldest first | **Answered by the owner 2026-10-07: no promise.** Also answered: only the Market's default locale is required (4.2 row 1). Who reviews when the owner is away is an operations item (any person given the Catalogue Moderator role), not a design question |

The former question 2 (how long to keep original photos) is settled by Hassan's M2: the raw upload
is deleted as soon as scanning and re-encoding end, and only a metadata-free master is kept (10.5).

Told, not asked: a removed size or variant never comes back with the same identity (prices and
stock for it start fresh); while a badge is being re-checked the Offer stays on sale but shows no
badge; an Offer whose product changes category so a badge no longer fits is refused at submit
(seller) or suspended (shared product); every new or replaced photo is looked at by a reviewer even
when other edits publish at once; per-variant offer photos are not built at launch (19.2 item 12);
"Import" waits for the shop-visit research (Q5); Kosher and Vegan words are refused in text from
day one (Q1).

**To arrange, not questions (Ali's list):**
| Item | With whom | Needed by |
|---|---|---|
| The promotion (content-licence) clause and the photo-badge sentence | Counsel | Slice 19 (promotion); slice 13 copy |
| The AU claim vocabulary | The halal authority | Slice 5 (seed of `matchClaimTerms` terms, through certification) |
| AU tax categories (`taxable`, `gst_free`, guide links) | The tax adviser | Slice 4 |
| The image library | The owner's bundled dependency list (16.1) | Slice 13 |
| Photos (slice 13) are on the first-sale path and wait for ADR-0029 | Ali (ADR-0029), Kazem | Before slice 13 |

### 19.2 Team decisions at G2 (ruled)
| # | Point | Options | Recommendation | Ruling |
|---|---|---|---|---|
| 1 | Registry and `AttributeSchema` design (3), no new ADR | A: as 3. B: an ADR first | A | **A** (Ali) |
| 2 | CQRS read side for catalog reads (brief s9) | A: none in Phase 3; facade and panels read the write tables with indexes; `search` builds its read model from events in Phase 6. B: a read model now | A | **A** (Ali), with P95 ≤ 200 ms for `offerListings`, the seller list and the review queue (9.1); revisit at `search`'s gate or when a read target is breached |
| 3 | `productRevisionId` for an Offer on a never-published product (ADR-0028 d1 says "published revision") | A: the frozen submitted revision, re-asked at publish. B: no tags before the first publish | A | **A** (Ali: a reading, not an amendment, under the conditions of 5.1a; Hassan: provided publish re-asks and a draft Offer is never exposed). B3: tags on unpublished revisions are excluded from 5.5 and 5.6 |
| 4 | Tags per Offer or per (Offer, Variant) | A: per Offer, fail-closed over every variant. B: per variant | A | **A** (Ali) |
| 5 | Re-ask on manufacturer approval without knowing coverage | A: re-ask every suspended and rechecking tag of the type. B: a `coveredProducts` facade | A | **A** (Ali), plus a metric of how many tags each event re-asks; revisit after spike 2 |
| 6 | ZWNJ/ZWJ in text (6.3) | — | Kept, stripped before matching | **Confirmed** (Hassan) on condition: the matcher strips them in every script (X-4) and `PlainText` refuses them unless both neighbours are in a joining script (6.3) |
| 7 | Numbers: photo, rate, Import limits, fan-out target | — | Proposals | **Set** (Hassan): photos as proposed plus longest edge ≤ 12,000 px and one frame; rate limits as proposed except `claim-text.check` 30/min and 1,000/24 h (L6); Import file ≤ 10 MiB, decompressed ≤ 50 MiB, 5,000 rows, 10,000 characters per cell (7.1, 8.4) |
| 8 | Protected keys (8.1): the brief's list plus `catalog.attribute.edit` and `catalog.market-settings.edit` | — | Confirm | **Confirmed** (Ali, Hassan). Clearing the `material` flag, archiving a material definition and removing one from a family need a second admin: two different account ids holding `catalog.attribute.edit`, never in acting-as, the request names the definition version and expires, both ids audited (Hassan 2; 8.2) |
| 9 | Seller-category merge clears the shelf (4.7) | A: clear. B: move to the platform category | A | **A** (Ali); Hadi confirmed: a merge clears the shelf, it does not move it (CAT-53 corrected) |
| 10 | Tag `typeCode` in event payloads | A: enum code. B: ids only | A | **A** (Hassan): the value must be a validated vocabulary code |
| 11 | "Changes needed" text stored clear (11.1) | A: clear, never outside the module. B: encrypted | A | **A** (Hassan) |
| 12 | Offer photo per variant | A: not built. B: Offer photos, reviewed | A | **A** (Ali); Hadi corrects the feature row |
| 13 | `rechecking` keeps the Offer listed without a badge | A: listed, no badge. B: off sale | A | **A** (Ali) |
| 14 | A SELLER revision that would drop a tag (T4) | A: refuse submit. B: accept and suspend at publish | A | **A** (Ali); PLATFORM revisions and the admin tax override suspend (L4) |
| 15 | Weight required for every product | A: not required by `catalog`. B: required now | A | **A** (Ali; Hadi) |

### 19.3 Reviews
| Reviewer | Result | Date |
|---|---|---|
| Ali (cto) | **Signed.** Earlier: blockers B1 to B4, suggestions, rulings on 19.2, the d1 reading, CQRS, V-1, P-1, K-1 (19.4). Final conditions applied: ADR-0030 conditions (16.2), slice 20 settling | 2026-10-07 |
| Hassan (security-tester) | **Approved on conditions**, all applied: 1a, 1b tax override (4.3, 5.4, slice 20); 2 two-person relaxation (8.2, 11.3, 19.2 item 8); 3a hidden-character helper (6.3); 3b bulk cap 50 (4.2, 8.4). Earlier: H1, M1 to M3, L1 to L9 and rulings (19.4) | 2026-10-07 |
| Mojtaba (database-designer) | **Signed** the data design `docs/design/data/catalog.md` (17.1 items 1 to 12b applied; Q-K1 to Q-K15 answered); Ali signed it (B1, B2 applied) and Hassan accepted it with conditions, applied. Each migration still needs his sign-off | 2026-10-07 |
| Reza (ui-ux-designer) | **Signed** `docs/modules/catalog/ux.md` (17.2 items 1 to 25 applied) | 2026-10-07 |
| Jafar (product-designer) | **Accepted with changes**, applied in `ux.md` (fixes 1 to 9); accepted brief s12 | 2026-10-07 |
| Hadi (product-owner) | Answered: one SKU per Offer (2.1, 14); default locale only required, confirmed by the owner 2026-10-07 (4.2 row 1); CAT-53 merge clears the shelf (4.7). OFR-02 corrected in `docs/features/02-catalog-inventory.md` (no per-variant Offer photo, 19.2 item 12); proposal reasons and the narrower bulk approve accepted | 2026-10-07 |

### 19.4 Review record: where each change was applied
| Item | Change | Applied in |
|---|---|---|
| Ali B1 | `own-offer.edit` and Offer create have no handling, attestation or tag fields; `set-handling` and `record-attestation` are separate commands refused in acting-as | 4.4, 5.4 entry paths, 8.2, 8.3, slice 7, 17.2 |
| Ali B2 | `variant-removed` on every retirement, at a draft save or at publish | 2.3 M-1, 4.2 (working-copy save), 9.4, 9.7, 18 P-1, 17.1 |
| Ali B3 | Option chosen: tags whose copy names an unpublished revision are excluded from handlers and reconciliation until publish re-asks | 5.1a point 5, 5.5, 5.6, slice 12 |
| Ali B4 | Seeds only create; every move, merge or archive goes through slice 21; "seed PR" removed | 4.6, 7.2, 15.1 |
| Ali d1 reading and conditions | Frozen submitted revision; no listing or badge; re-ask before the pointer moves; a submit-time ask on a published product stores nothing | 5.1, 5.1a, 4.2 rows 1 and 3, 18 X-2 |
| Ali suggestions | P95 read targets; `offerListings` advisory (ADR-0025 d1); ADR-0030 raw SQL list; no AI slice merged in Phase 5; X-1 as a facade method, "We couldn't count" until slice 18 | 9.1, 16.2, 13, 15.1, 6.5, 18 |
| Ali Phase 4 rulings | V-1, P-1, K-1 | 9.7, 18, slice 16 |
| Hassan H1 | Image added or replaced always reviewed; named photo check | 4.2 row 1, 4.3, slice 13, 17.2 |
| Hassan M1 | `rechecking` in the same unit on every claim-input change | 4.6, 5.4 (rule M1), slice 11, 21 |
| Hassan M2 | Raw upload deleted after intake; only a metadata-free master kept; owner question 2 dropped | 10.1, 10.3, 10.5, 11.1, 19.1 |
| Hassan M3 | Variant-id rule; ids in the actor's scope; upload refuses PLATFORM; byte-identical not-found incl. Import; `AuthorKind` from `ActorContext` | 4.2, 4.4, 8.2, 8.3 |
| Hassan L1, L2 | Pending photos as sandboxed renditions; separate registrable domain in ADR-0029; per-product keys; unpublish renditions that left the revision | 10.1, 10.3, 10.4 |
| Hassan L3 | Anonymous `offerListings`: active tags only | 9.1, 9.7, 18 K-1 |
| Hassan L4 | Entry-path rows: tax override suspends; types error never clears; description cause clears through `own-offer.edit`; reinstatement by reconciliation | 5.4 |
| Hassan L5 to L9 | Rescan scope and locales; `claim-text.check` limits; batch limits refused whole; closed schemas and forbidden-field list; Import reads OFR-01/OFR-03, hint never filters | 6.4, 8.4, 9.1, 9.3, 8.3, 7.3, slices 5, 7, 18, 24 |
| Hassan 19.2 rulings | Items 3, 6, 7, 8, 10, 11 | 19.2, 6.3, 7.1, 8.4, 18 X-4 |
| Informational | No AI tools at this G2; a later tool is READ through `offerListings` | 13 |
| Owner Q1, Ali's arrange list | Q1 on a card; reviewer cover is operations; things to arrange | 19.1 |
| Reza ux.md 7.2 items 1, 2 | Per-field refusal on draft saves (no claim word ever stored); `claim-text.found` payload with `typeCode` | 6.1, 17.2 |
| Reza ux.md 7.6 | Named checks stored on the decision and gating, required set derived by the server; photo check of H1 | 8.3a, 7.1, 17.2 |
| Final conditions (Hassan 1a, 1b, 2, 3a, 3b; Ali ADR-0030, slice 20; Hadi SKU, locale, CAT-53) | See 19.3 rows | 2.1, 4.2, 4.3, 4.7, 5.4, 6.3, 8.2, 8.4, 11.1, 11.3, 14, 15.1, 16.2, 17.1, 17.2, 19, 20 |
| Hassan on `requestedTags` and relaxations | M1: acting-as refusal on `.submit` with `requestedTags`, and the B1/AA contract test; M2: `pending-publish` tag status with no badge data, the entry-path row and contract test; L3: 5.2 equality and retry for requested tags; L4: 5.1a point 4 limited to T4; Low: version checks on confirm, cancel and expiry | 5.1a points 4 and 6, 5.3, 5.4, 8.2, 8.3 |
| Mojtaba data 14 O6: Q-K15; relaxation kinds | A Simple product's single variant is retired only when its product is `discarded`, with `variant-removed`; relaxation kind `delete` merged into `archive` | 2.1, 8.2, 19.2 item 8, slice 21 |
| Mojtaba data 13: Q-K1, K5, K7 | Rows vs `jsonb` accepted (rescan reach and immutability as conditions); suspended-tag re-ask from the by-type index, partial index only above 5%; CAT-54 cap soft | 15.3, 5.5, 4.7, 17.1 |
| Mojtaba data 13: Q-K2, K3, K4, K6, K9, K10, K11, K12, K13, K14 | Draft delete keeps Offer and variant rows (`discarded` product, events, 180-day prune); version += n per event; `category.impact-too-large` above 50,000 tags; archive only; slice 22 migration; nullable pointer; closure/erasure table and S-1; superseded-but-once-published copies selectable; image completeness with slice 13; revise cancels the open relaxation | 4 intro, 4.1, 4.6, 4.6a, 5.1a point 5, 7.1, 8.2, 15.1, 17.1, 18 |
| Hadi: narrower bulk approve | Rows needing the named photo check are skipped; every skipped row listed with its reason code | 4.2, 8.4 |
| Reza ux.md 7.10 | `requestedTags` at the first submit (submit-time ask, whole submit refused if not allowed, refused in acting-as, re-asked at publish); `attribute-relaxations.list-open`; expiry job, `catalog.material-request-expired.v1`, EC14 | 5.1a point 6, 8.2, 9.4, 11.3, 12, 17.1, 17.2 |
| Ali Phase 4: `catalog.maxVariantsPerProduct` | Market configuration (AU 100); checked at save, submit, publish and Import; `variant.limit-reached`; bounds `offer-moved` mapping | 2.1, 4.2, 7.1, 7.3, 9.2a, 9.4, 14, 17.1, 17.2, 18 |
| Reza ux.md 7.2 items 3, 4, 8, 9, 10; ZWNJ after the helper | Badge options, sensitive fields, queue rows, `platform-category.impact`, Offers tab, allowed actions and throttle codes, setting metadata, photos read and reorder; manual removal at a reported offset | 9.2a, 8.2, 6.3 |
| Reza ux.md 7.2 items 7, 8; IA additions | `retire.count-changed`; `revision.similar-products`; `matchable` with denial codes; routes `/offers/:id/review`, `/revisions/:id/match`, `/settings/catalogue` confirmed; `offer.review-read` added | 4.1, 9.2, 8.2, 17.2 |

## 20. Follow-up changes
| File | Change | When, by whom |
|---|---|---|
| `docs/modules/catalog/brief.md` | G2 row; change-log rows: variant ids never reused (M-1); Offer pattern (M-3); seller-category merge clears shelves (19.2 item 9); no Offer photos (item 12); section 12 table from Reza | With G2 approval; Hadi |
| `docs/features/02-catalog-inventory.md` | OFR-02 per-variant image removed; CAT-53 "moves the shelf" corrected; CAT-31 weight note | Product track; Hadi |
| `docs/design/data/catalog.md` | New, from 17.1, including the review changes listed there | Mojtaba |
| `docs/modules/catalog/ux.md` | New, from 17.2, including the review changes listed there | Reza |
| ADR-0029 (reserved) | Separate registrable domain for the cookieless origin (L1) | Ali |
| ADR-0030 (reserved) | Raw SQL only on a checked-in list signed by Ali and Hassan (16.2) | Mohammad drafts (reserved), Hassan reviews |
| `docs/design/domain/platform-foundations.md` | Row 10 (registry) marked pulled; `AttributeSchema` and `PlainText` noted | Mohammad, with P1 |
| `docs/design/domain/inventory.md`, `pricing.md`, `cart.md` (PRs #43 to #45) | V-1, P-1, K-1; record "catalog G2 accepted CF1–CF4 / CC1–CC3 with the refinements of 9.7" | Their authors, after this G2 |
| `docs/design/panels/information-architecture.md` | Open point 2: catalog queue-tab keys (8.1) | Design track |
| `claude/adr-0019-follow-ups.md` | Catalog's deterministic paths (13.3) | Mohammad, with the G2 record |
| `config/markets/AU.json`, `test/fixtures/markets/ZZ.json`, schema | 7.1 (shared files: own PR, announced) | Slices 1 to 13; Hossein |
| `docs/modules/README.md`, the board | G2 status; requests of 18 | Orchestrator |
