# Catalog — G2 domain design

**Author:** Mohammad (software-architect) — 2026-10-07
**Status:** Draft for G2 review. Reviewers: Ali (cto), Hassan (security-tester), Mojtaba
(database-designer), Reza (ui-ux-designer), Jafar (product-designer). Tier A. The owner gets a
Persian summary with the questions of 19.1 only. The approvals of the Phase 4 designs of
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
| `Product` | Scope, `typeCode` (from the registry, 3.2), `familyCode`, `productCode`, owner seller id (SELLER), `ownBrand`, the variant registry, the working copy, revisions, the two revision pointers, lifecycle status (4.1), `claimTextFlaggedAt` (6.4), takedown marks (10.5), `promotedAt` | Type and family never change after creation (CAT-10). `productCode` unique per Market. A SELLER product has an owner, a PLATFORM product none. **Content of a PLATFORM product changes only through an admin use case**: the aggregate's content commands take an `AuthorKind` and refuse `seller` when scope is PLATFORM (CAT-43, AC 3), so no path (form, Import, AI accept) can bypass it. At most one published and one pending revision (VER-01). A Simple product has exactly one variant, created with the product and never retired; a Configurable product has at least one non-retired variant (CC2, INV 13). A variant id is never reused or revived (2.3 M-1) |
| `ProductRevision` (entity of `Product`) | Revision number, base revision id (the published one it was built on), the attribute-schema version it was validated against, immutable content (name, short and full description per locale; attribute values; variant definitions with option values and labels; platform category ids (≥ 1); tax category code; image refs in order with alt text; per-field provenance for AIS-03), `contentHash`, author kind and account id, change classification (sensitive or minor, 4.3), status (4.2), decision (reviewer, instant, reason code, reason text) | Content never changes (VER-01). Created only from a complete working copy (CAT-31). A decision names this revision number (brief s5: approval is bound to what was reviewed) |
| `Offer` | Seller id, product id, `sellerSku` (unique per seller, CAT-10), condition code (Market list), description per locale, handling (`SEALED_ORIGINAL`, `REPACKED`, `PREPARED`, `FRESH`), attestation record (instant, account id, or none), shelf (a `SellerCategory` id of the same seller, or none), status (4.4), stored off-sale causes, `firstPublishedAt`, tags | At most one non-deleted Offer per (seller, product), drafts and pending included (OFR-02). A SELLER product accepts an Offer only from its owner (CAT-40). Deleted is terminal and the id is never reused. Seller id never changes (pricing's copy relies on it, PRC 2.3). The shelf belongs to the Offer's seller (CAT-52, AC 35). The attestation is written only by the form use case of a seller actor, never in acting-as, never from Import or a bulk action (brief s5). A tag is stored only with an allowed `ClaimDecision` whose inputs equal the state being saved (5.2) |
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

Every transition is one use case with one read-write unit (PP 3.1), time from `Clock`, one version
step, and its events in the same unit. Facade calls (`sellers`, `certification`) run before the
unit (PP 3.1 row 5; ADR-0019 decision 6 for models). A transition not listed is forbidden.

### 4.1 Product lifecycle
`draft` → `unpublished` → `published`; `unpublished` → `matched` (terminal);
`unpublished` | `published` → `withdrawn` (terminal, SELLER); `published` → `retired` (terminal,
PLATFORM); `draft` → (removed).

| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| (none) → `draft` | `own-product.create` (seller) or `platform-product.create` (admin). Seller guards: `sellingEligibility` yes (SL 7.2), setting `catalog.seller-can-create-product` on (7.3), type in the Market's list and in `allowedProductTypesOf` (SEL-12), family from the Market's seed. Admin guard: key `catalog.platform-product.edit` | Product with type, family, `productCode` (minted by the server from a Market sequence, never from input), a Simple product's single variant | CAT-10, OFR-01, CAT-41 |
| `draft` → (removed) | `own-product.delete` of a product never submitted | Product, working copy, its Offer (draft) and draft images removed; no event, no audit row (nothing was ever submitted; the certification precedent CD 3.1) | OFR-06, AC 32 |
| `draft` → `unpublished` | First submit (4.2 row 1) | — | CAT-30 |
| `unpublished` → `published` | First revision published (4.2 rows 3, 4) | Event `catalog.product-revision-published.v1` | CAT-30 |
| `unpublished` → `matched` | `product.match` in the first approval (4.5) | Terminal; the Offer moves; mail | CAT-45 |
| `unpublished` or `published` → `withdrawn` | `own-product.delete` of a submitted SELLER product (not promoted). Pending revision `superseded` | Terminal; revisions kept (VER-06 references them); its Offer `deleted` in the same unit; product leaves the seller's list; events `catalog.product-withdrawn.v1`, `catalog.offer-deleted.v1` | OFR-06, ADR-0009 d7 |
| `published` → `retired` | `platform-product.retire` (protected key), PLATFORM only; the confirm request carries the affected Offer count the page showed (brief s4 f 3). No `evaluateClaims` (ADR-0028 d5) | Terminal; every Offer gets cause `product-retired`; event `catalog.product-retired.v1`; mail to Offer owners | CAT-48 |
| `published` (SELLER) → `published` (PLATFORM) | `product.promote` (4.5) | Scope changes; not a status | CAT-44 |

Forbidden: deleting a submitted product; any change of type, family, scope back to SELLER, owner
seller, `productCode`; any seller content command on a PLATFORM product (AC 3); retirement of a
SELLER product (it is withdrawn instead); "un-retire".

### 4.2 Product revision: `pending` → `published` | `changes-needed` | `superseded`
| # | From → to | Trigger and guard | Effects |
|---|---|---|---|
| 1 | (working copy) → `pending` or `published` | `own-product.submit` (seller) or `platform-product.submit` (admin). Before the unit: `sellingEligibility` (seller); claim-text check over every checked field of the working copy (6; failure or unavailable refuses); for a SELLER product, `evaluateClaims` for every non-removed tag of the owner's Offer against the frozen revision being submitted (5.2; T4: refused with the list of tags that would no longer be allowed). For an already-published product this ask **stores nothing** (5.1a point 4); for a never-published product the copy names the submitted revision and the Offer stays unlisted (5.1a points 2, 5). In the unit: completeness for the schema (name, descriptions, ≥ 1 platform category, tax category from the Market list, ≥ 1 clean image for a new product; CAT-31, brief s5), the base revision equals the current published one (else `revision.base-changed`), the setting `catalog.approval-required` read in this unit (ADR-0026 d2), classification by `ProductRevisionPolicy` (4.3) | Revision N with base, schema ref, provenance (server-built, 13.1), `contentHash`. **Published at once** when approval is off, or the product is published, the change is minor and no sensitive revision is pending (4.3). Otherwise **pending**; an existing pending revision becomes `superseded` (the client must send `replacePending: true` after the warning, brief s4 d 1). Event `catalog.product-revision-submitted.v1` |
| 2 | `pending` → `superseded` | A later submit (row 1), a withdrawal of the product, a promotion (CAT-44 sets aside the seller's pending revisions) | A reviewer with the page open gets `review.not-current-revision` |
| 3 | `pending` → `published` | `product-revision.approve` (key `catalog.product.approve`), naming revision N and the product version; N is the pending one (AC 29); the owner's `sellingEligibility` yes, else **skipped** in bulk (CAT-33) and refused singly with `seller.not-eligible`; claim text re-checked (vocabulary may have grown since submit) | The previous published revision `superseded`; pointer moves; variant registry updated (M-1); publish fan-out (5.4); events `catalog.product-revision-published.v1`, `catalog.variant-added.v1` / `-removed.v1` per changed variant, `catalog.product-material-content-changed.v1` when a material attribute changed (5.7); audit; mail |
| 4 | (row 1, published at once) | As row 3 without a reviewer; the system records `autoPublished` with the setting value read | Same effects |
| 5 | `pending` → `changes-needed` | `product-revision.request-changes` (same key), naming N; a reason code from the Market list and optional text (CAT-32, AC 28) | Terminal for N; the working copy stays for the next submit; event `catalog.product-revision-changes-requested.v1`; mail with field, reason and next step |
| 6 | (old revision K) → new revision | `product-revision.revert` (VER-05; seller for SELLER, admin for PLATFORM): content of K copied into the working copy and submitted through row 1 (same policy, same checks, same entry path) | Refused with `revision.revert-restores-retired-variant` when K holds a retired variant id (M-1) |

Bulk approve (CAT-33, AC 30): the request carries `[{ productId, revisionId }]`; any id not found
in the request's Market refuses the whole request byte-identically (the SL 7.3 pattern); each item
is its own unit; ineligible sellers are skipped, not rejected; a not-current revision is skipped
with `review.not-current-revision`; a first approval of a never-published SELLER product is
**skipped** with `review.first-approval-needs-match-check` unless the request sets
`firstApprovalsConfirmed: true` (brief s4 c 5; Jafar). Result: counts per outcome.

### 4.3 `ProductRevisionPolicy` (VER-02, VER-03; owned here)
A pure domain service: `classify(published, candidate, marketPolicy) → { sensitive: boolean,
reasons: SensitiveReason[] }`.

| Rule | Source |
|---|---|
| Sensitive fields come from Market (and later Vertical) configuration `catalog.sensitiveChanges` (7.1): AU = platform categories, tax category, name in any locale, primary image, **any image added or replaced** (Hassan, G1), **a variant removed** (Mohammad, G1) | VER-03, brief s5 |
| Anything else is minor | VER-03 |
| Approval off (CAT-36): every revision publishes at once; claim text and claims are still checked at submit and publish | AC 27 |
| A pending sensitive revision holds later edits: the next submit supersedes it and stays pending, even if the new delta is minor (brief s5 team proposal; AC 26) | — |
| A never-published product is always reviewed when approval is on | CAT-36 |
| A PLATFORM revision by an admin publishes at once (CAT-41: no seller queue); the publish fan-out still runs | CAT-41 |
| A tax category override by an admin (`catalog.tax-category.override`, protected) is an admin-authored revision on a SELLER product, published at once, audited (ADR-0007 d5, AC 36) | brief s5 |

### 4.4 Offer: `draft` → `pending-first-publish` → `published` | `changes-needed`; → `deleted`
| From → to | Trigger and guard | Effects |
|---|---|---|
| (none) → `draft` | Created with the seller's own product (OFR-01, same form) or by `own-offer.create-on-platform-product` (OFR-02). Guards: `sellingEligibility`; type allowed (SEL-12); on a PLATFORM product: product `published` and not retired, setting `catalog.sell-from-catalogue` on (7.3); no non-deleted Offer of this seller on the product (`offer.exists-for-product`); `sellerSku` unique per seller | Event `catalog.offer-created.v1` (INV 3.5: upsert of stock needs it) |
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
| Seed (system, deploy) | Versioned seed per Market (7.2); creates missing categories, never edits one an admin changed | — |
| `platform-category.create`, `.rename` (key `catalog.category-tree.edit`, protected) | Slug unique per Market; claim-text check on names (6.2) | Revision; event `catalog.platform-category-created.v1` |
| `platform-category.move`, `.merge`, `.archive` (same key) | Before the unit: `certification.assertCategoriesRetirable(ctx, ids)` for merge and archive and for **move** (ADR-0028 d5; C-4); a refusal or an error refuses the use case (`category.referenced-by-policy` with the type codes, or `category.check-unavailable`). In the unit: no cycle; archive or merge refused when a published revision would be left without a platform category (AC 4) | Audit (always, C-8: a move under a parent named by a `SELLER_OR_MANUFACTURER` row eases the rule, so every move is an audited entry path); events `catalog.platform-category-moved.v1`, `-merged.v1`, `-archived.v1`. The own handler of these events then (a) calls `certification.platformCategoriesRetired` (system; backstop, C-4) for merge and archive, and (b) re-asks every tag of every Offer whose product's published revision is under the affected subtree, in idempotent batches (5.5) |

A merge rewrites no published revision (V1 is immutable): `categoryPath` resolution maps a merged
id to its target when building the query (the tree keeps `merged-into`), so published revisions keep
their recorded ids and the evaluation uses the live path. An archived id is dropped from the path.

### 4.7 Seller category and proposal (CAT-51 to CAT-54)
`pending` → `approved` | `rejected` | `cancelled`. Proposal by `own-category.propose`
(`mayProposeCategories` yes at the command; pending cap; claim-text check on names and
description). Decision by `category-proposal.approve` / `.reject` (key
`catalog.category-proposal.decide`), always required regardless of CAT-36. On
`sellers.category-proposals-revoked.v1`, pending proposals become `cancelled` with reason
`permission-revoked` (CAT-51, AC 35). Promote (same id into the platform tree; free platform slug)
and merge (terminal) use the protected key `catalog.seller-category.promote-merge`, audited, with
events. CAT-53 says a merge moves the Offers' shelf; a platform category is never a shelf (CAT-52,
Hassan G1), so a merge **clears** the shelf on the seller's Offers and the admin may add the
platform category to the products through a revision. A promoted category keeps its id and stops
being a shelf. Neither changes a published revision. Team decision 19.2 item 9.

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
   until the publish re-asks.
5. **Which tags the handlers and reconciliation see (B3, option chosen: exclude).** A tag whose copy
   names a revision that is `pending`, `superseded` or `changes-needed` (only possible on a product
   never published) is **excluded** from the certification-event handlers (5.5) and the daily
   reconciliation (5.6). It cannot be shown or used (point 2), and the publish re-ask (point 3) is the
   only way it becomes effective, so there is nothing for them to repair. The alternative ("use the
   pending revision") was rejected: it would let a handler decide on content nobody has approved.

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
`active` ⇄ `rechecking`; `active` | `rechecking` → `suspended`; `suspended` → `active` |
`rechecking`; `active` | `suspended` → `removed` (terminal for that tag row).

| From → to | Trigger | Effect on the Offer | Seller sees (brief s4 table) |
|---|---|---|---|
| (none) → `active` | Seller adds a type in the Offer form (`own-offer.add-tag`; refused in acting-as), allowed by 5.2 | — | Type and basis |
| `active` → `rechecking` | A handler or the reconciliation selected the tag and has not settled it, or `evaluateClaims` was `unavailable` | Listed; the display copy carries **no badge data** while `rechecking` (cart and storefront show no badge); `ordering` asks fresh anyway (ADR-0028 d4) | "Checking your certificate" |
| `active` or `rechecking` → `active` (basis switched) | A fresh decision allows another basis (ADR-0012 d6) | — | New basis; event `catalog.offer-tag-basis-switched.v1` |
| `active` or `rechecking` → `suspended` | A fresh decision is not allowed on every basis | Cause `tag-suspended` added: the Offer is **off sale, not deleted** (CERT-15) | Reason and next step from the `ClaimReason` code (CUX 3.7), or the cause of the event (expired, revoked, issuer no longer recognised, handling or category, manufacturer certificate) |
| `suspended` → `active` | A fresh allowed decision (renewal approved, new certificate, policy change, reconciliation, seller changes handling back) | Cause removed when no tag is suspended | Badge back; mail |
| `suspended` → `removed` | `own-offer.remove-suspended-tag` with an explicit confirmation "sell without this badge" (brief s7 team proposal, accepted); refused in acting-as; who and when recorded | Cause removed when no other tag is suspended; Offer listed again without the badge | — |
| `active` → `removed` | `own-offer.remove-tag` | — | — |
| `removed` → (new `active` row) | Adding the type again: a new entry path (ADR-0028 d5 "tag re-enabled") | — | — |

### 5.4 The claim copy (ADR-0028 d3, d11; brief s6)
Stored per `active`, `rechecking` and `suspended` tag: type code; basis; certificate kind, id and
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
| Product revision submit (SELLER) | 4.2 row 1 | The owner's Offer, against the submitted revision (T4) |
| Product revision publish (approve, auto, revert) incl. a variant added or removed | 4.2 rows 3, 4, 6 | Every Offer of the product; for PLATFORM products in idempotent batches through the fan-out job (below) |
| Platform category move, merge, archive (C-4, C-8) | Own handler of the category events | Every Offer under the affected subtree, batched |
| Match (CAT-45), promotion (CAT-44) | 4.5 | The moving Offer; every Offer of the promoted product |
| Offer reactivated (cause `type-not-allowed` cleared) | Handler of `sellers.allowed-product-types-changed.v1` | Every tag of the reactivated Offers |
| Import row (OFR-12) | 14 | That row's tags (requested type codes only) |
| Certification events | 5.5 | Selected tags |
| Daily reconciliation | 5.6 | All `active`, `rechecking` and `suspended` tags |
| Order placement | `ordering` (Phase 5) | Not here |

Retirement (CAT-48), withdrawal and delete take Offers off sale without asking (ADR-0028 d5).

**Publish fan-out** (job `catalog.reevaluate-tags`, worker, system actor, per Market): the publish
unit writes one `TagReevaluationRequest` row per (product, cause, published revision id) and marks
the product's tags `rechecking` only for a PLATFORM product with more than one batch of Offers (for
a SELLER product the single Offer is re-asked in the same use case, before the unit). The job takes
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
needed (alternative: a facade `coveredProducts(revisionId)`; 19.2 item 5).

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
in every field (`text.invisible-character`), **except ZWNJ and ZWJ**, which Persian and Arabic need;
they stay in the stored text and are removed by the matcher's normalisation before matching
(CD 4.6; Hassan confirms at G2, 19.2 item 6). NFKC, case folding, confusables and the separator and
digit passes are the matcher's.

### 6.4 When the vocabulary grows (Q6; AC 25)
On `certification-type-revised.v1` with `claimTermsChanged: true`, job `catalog.rescan-claim-text`
(per Market, batches of 100 texts per `matchClaimTerms` call) scans the **published** texts of
every product, Offer description, seller category and platform category. A product whose published
text now matches gets `claimTextFlaggedAt` and cause `product-not-listed` on all its Offers (off
sale, not deleted), with mail to the owner (SELLER) or an admin alert (PLATFORM). The flag clears
when a revision without a match is published (that revision is checked at submit like any other).
An Offer description that matches gets its own cause on that Offer only. A failed rescan alerts and
retries; it never clears a flag.

### 6.5 Impact count before a vocabulary change (C-7)
`claim-terms.impact-count` (admin HTTP; access rule `permissions [certification.type.edit]`, the
key imported from `certification/contracts`, as `sellers` uses `identity`'s approve key, SL 6.1):
input = type code and the proposed term list per locale; output = the number of published products
and Offers whose published text would match, and `complete: true|false`. It runs the same scan as
6.4 in dry-run mode, synchronous, bounded (at most 20,000 texts or 10 seconds; beyond that it
answers `complete: false` with the count so far, which CUX shows as "at least N"). It needs a
matcher over **candidate** terms (`matchClaimTerms` uses published vocabulary only): request X-1.
Until X-1 exists, the endpoint answers `count.unavailable` and CUX's "We couldn't count" state
applies.

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
| `photoLimits` | Proposal for Hassan (19.2 item 7): 10 MiB per file, 10 photos per product, 40 megapixels, longest edge rendered 2,048 px | Small | 10 |
| `categoryProposalPendingCap` | 5 per seller | 1 | CAT-54 |
| `importLimits` | 14 | Small | 14 |
| `promotionEnabled` | `false` until counsel approves the content-licence clause (ADR-0010 d5) | `true` | 4.5 |
| `reconcileAtLocalTime` | `03:00` | `04:00` | 5.6 |

Locales come from the Market's `supportedLocales` (INTL-10); the language tab is hidden when the
Market has one (brief s9). A Vertical override of `sensitiveChanges` is a later seam
(`ProductRevisionPolicy` takes the product's type, whose registrant tells the Vertical); no
trigger today.

### 7.2 Seeds (CAT-01, CAT-02, CAT-03; the editors come after the first sale)
Versioned seed files per Market in `modules/catalog/infrastructure/seed/` (exempt from the literal
check by exact path), applied by a `system` use case at deploy per hosted Market (the identity
role-seed pattern): platform category tree, attribute definitions with `material` flags, and one
default family. A seed creates what is missing and never edits a record an admin changed (CD 5.2
pattern). Names and option labels in seeds pass the claim-text check at apply time; a match fails
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

**Rule (task requirement and ADR-0026 d6):** a setting is read only at a creation or submit
command. No handler, job or read path reads OFR-01 or OFR-03, so a change or a read failure never
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
| `own-products.list`, `own-product.read`, `own-offer.read`, `own-image.preview`, `own-revision.read` | `permissions [catalog.own-product.view]` | — | Own seller only (repository takes the seller id from the actor) |
| `own-product.create`, `.save-draft`, `.submit`, `.delete`, `.revert`; `own-image.upload`, `.remove`; `own-offer.create-on-platform-product`, `.edit`, `.submit`, `.delete`; `claim-text.check` | `permissions [catalog.own-product.edit]` | allowed (content only); the claim-bearing commands are the next row | `sellingEligibility` on every write; SEL-12 on create and submit; a tag in the submitted form is added through the next row's rule. `own-offer.edit` and `.create-on-platform-product` have closed input schemas with no handling, attestation or tag field (B1; L8); a create with initial handling, attestation or tags is a create followed by the next row's commands, so acting-as gets a draft without them. Ids resolved in the actor's own seller scope (M3); `own-image.upload` refuses a PLATFORM product |
| `own-offer.set-handling`, `.record-attestation`, `.add-tag`, `.remove-tag`, `.remove-suspended-tag` | `permissions [catalog.own-product.edit]` | refused | Brief s5, AC 19 |
| `catalog-products.search-for-offer` (OFR-03) | `permissions [catalog.own-product.view]` | — | ≥ 3 characters; Market from context; PLATFORM, published, not retired; per result whether the seller already has an Offer, whether the type is allowed |
| `own-category.propose`, `.cancel` | `permissions [catalog.own-category.propose]` | — | `mayProposeCategories` at the command |
| `own-import.*` | `permissions [catalog.own-import.run]` | refused (identity kept by the job; brief s5) | 14 |
| `own-listing.suggest-text` (AIS-03) | `permissions [catalog.own-product.edit]` | refused (R3) | 13 |
| `review-queue.list`, `revision.review-read`, `admin-products.list`, `admin-product.read`, `admin-products.search` | `permissions [catalog.product.view]` | — | Store name through `sellerSummaries` per page (≤ 100 ids); AIA-03 flag on the review page (13) |
| `product-revision.approve`, `.request-changes`, `.bulk-approve`; `offer.approve`, `.request-changes` | `permissions [catalog.product.approve]` | — | 4.2, 4.4 |
| `product.match` | `permissions [catalog.product.match]` | — | 4.5 |
| `product.promote` | `permissions [catalog.product.promote]` | — | 4.5 |
| `admin-product.withdraw`, `admin-offer.delete`, `image.take-down` | `permissions [catalog.product.delete]` | — | 4.1, 10.5 |
| `platform-product.*` (create, save-draft, submit, revert, upload) | `permissions [catalog.platform-product.edit]` | — | CAT-41 |
| `platform-product.retire` | `permissions [catalog.platform-product.retire]` | — | Confirm carries the count shown |
| `tax-category.override` | `permissions [catalog.tax-category.override]` | — | 4.3 |
| `platform-category.*` | `permissions [catalog.category-tree.edit]` (create, rename, move, merge, archive); read: `catalog.product.view` | — | 4.6 |
| `attribute-definition.*`, `attribute-family.*` | `permissions [catalog.attribute.edit]` | — | Unsetting `material` and removing a family's required field are recorded as relaxations in audit |
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
| Every entry path asks | The table of 5.4; a test per row; a contract test lists every use case that changes an Offer's handling, attestation, product, category path or variant set and asserts it calls the builder | AC 10, 11; Hassan |
| Copies only restrict | No read of a tag copy in any use case that activates a tag; only `allowed` decisions activate | AC 13, 14 |
| CAT-43 | `Product` content commands refuse `AuthorKind.seller` on PLATFORM | AC 3 |
| One Offer per (seller, product), SKU unique per seller | Aggregate check plus Mojtaba's partial unique indexes | AC 2 |
| SELLER product accepts only its owner's Offer | `Offer.create` guard | AC 2 |
| Platform category ≥ 1; only category not removable | Revision completeness; category use case guard | AC 4 |
| Claim text refused, everyone, every field | 6.1, 6.2 registry and schema test | AC 20 to 25 |
| No price, stock, "sellable now" | No such field in `contracts/`; boundary rule "catalog imports neither pricing nor inventory" (ADR-0024 d5, slice P1) | AC 6 |
| Untouchable fields | Commands have no such fields; a contract test posts them and asserts no change | AC 38 |
| Approval bound to the reviewed revision | Guard in the approve unit | AC 29 |
| Seller shelf never an input; only the owner's shelf | `ClaimQueryBuilder` reads platform categories only; `Offer.setShelf` guard | AC 11, 35 |
| No model on decision paths | Allow-list (13.4) | AC 43 |

### 8.4 Rate limits (proposal; Hassan sets at G2, 19.2 item 7)
| Item | Limit |
|---|---|
| Draft saves (autosave) | 60 per minute, 1,000 per 24 h per account (SL 6.5) |
| `claim-text.check` | 120 per minute per account |
| Submits (product or Offer) | 30 per seller per hour |
| Photo uploads | 100 per seller per 24 h; 10 MiB per file |
| OFR-03 search, admin product search | 60 per minute per account |
| Import | One running per seller; 5 starts per 24 h |
| AIS-03 calls | `platform/ai` budget; plus 50 per seller per 24 h |
| Facade batches | 200 keys for `offerSellUnits`, `offerListings` (PRC 6.2, INV 7.1, CRT 7.1); 100 queries per `evaluateClaims` call |

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
| `offerListings(ctx, keys: {offerId, variantId}[])` (≤ 200) | Published state only. Per key: `sellerId`, `productId`, `listed`, `variantBelongs` (the variant is `published` on the product's published revision), display data (product name and variant label in the request locale with the INTL-13 fallback, primary image key of the published revision), `publishedRevisionId`, and per tag of the Offer: `typeCode`, `status`, `basis` and, only for an `active` tag, the copied `BadgeData` (5.4). Keys whose Offer is unknown, of another Market, deleted, never published, or whose product is not published are **absent** | `anonymous` and `system` pair | 11 | Cart CC1; storefront later; pricing H5 filter for raw ids |
| `offerTaxCategories(ctx, offerIds)` | Per Offer: the tax category code of the product's published revision and its revision id | `system` | Designed now; built with `tax`/`ordering` (Phase 5) | `tax`, `ordering` |
| `productsForOrder(ctx, keys)` | Snapshot inputs of VER-06 (revision id, `contentHash`, Offer id, tag copies) | `system` | Designed with `ordering`'s G2 (Phase 5); placeholder | `ordering` |

The facade never says "this Offer is buyable with claim X" (AC 14); `ordering` asks
`evaluateClaims` itself (ADR-0028 d4). An HTTP route over any of these that takes raw ids is the
consumer's design and must filter through `offerListings` (PRC H5).

### 9.2 Admin product search (CUX open point 9)
`admin-products.search` (HTTP, `catalog.product.view`): query of at least 3 characters (name,
`productCode`), filters scope and status; per result: product id, code, scope, name in the admin's
locale, published revision id, and its variants (id, label, state). The certification coverage
picker (CA7) calls it; `certification` still validates ids through `CatalogReferences`. The
Certification Reviewer role needs `catalog.product.view` (8.1).

### 9.3 Ports
| Port | Declared in | Implemented by | Notes |
|---|---|---|---|
| `CatalogReferences` (C-3) | `certification/application/ports` (exported from its `contracts/`) | `catalog/infrastructure`, bound in the composition root (unbound fails boot once certification slice 13 merges) | `publishedProductRevisions(market, productIds)` → per id: exists, scope, current published revision id; `variantsOf(market, productId)` → variant ids with state; `platformCategoriesExist(market, ids)` → per id: exists and status. `MarketContext` only, read-only unit, no actor (named exception, CD 7.4; on the checked-in list with its CI-enforced caller list). Retired variants are reported with state `retired` |
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
| `catalog.offer-moved.v1` | `offerId`, `fromProductId`, `toProductId`, `variantMapping: {from, to}[]` (ids only) | `pricing` (CF4), `inventory` (request V-1) |
| `catalog.offer-listing-changed.v1` | `offerId`, `listed` | `search`, storefront (Phase 6) |
| `catalog.offer-tag-added.v1`, `-removed.v1`, `-suspended.v1`, `-restored.v1`, `-basis-switched.v1` | `offerId`, `typeCode`, `basis` (enum or null) | Own mail; `search` |
| `catalog.platform-category-created.v1`, `-moved.v1`, `-merged.v1` (with `targetCategoryId`), `-archived.v1` | `categoryId` | Own handler (4.6); `search` |
| `catalog.category-proposed.v1`, `-proposal-approved.v1`, `-proposal-rejected.v1`, `-proposal-cancelled.v1`, `catalog.seller-category-promoted.v1`, `-merged.v1` | ids | Own mail; storefront |
| `catalog.import-finished.v1` | `importJobId`, `sellerId` | Own mail |

Type codes in payloads: `typeCode` of a tag is an enum of the vocabulary's "code" kind; Hassan
confirms it fits PP 5.3 (19.2 item 10; `sellers` kept type codes out of its payload for the same
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
| PRC CF1 | Batch `offersForPricing`: `sellerId`, lifecycle, `productId`, priceable Variant ids; unknown and foreign absent | `offerSellUnits` (9.1). Priceable = non-retired variants, `proposed` included, so a seller can price before the first publish; method **name differs** | Accept; rename on their side |
| PRC CF2 | Offer deleted (`offerId`); Variant removed (`productId`, `variantId`) | `catalog.offer-deleted.v1` (adds `productId`, `sellerId`), `catalog.variant-removed.v1` | Match (additive fields) |
| PRC CF3, CRT CC3 | `Offer` and `Variant` id types from `contracts/` | Exported as branded `Id<'Offer'>`, `Id<'Variant'>`, `Id<'Product'>` | Match |
| PRC CF4 | Event with the Variant mapping when an Offer moves to a platform product | `catalog.offer-moved.v1` | Match. No `variant-removed` is published for the matched duplicate's variants (the product is terminal): consumers re-key on `offer-moved`. **If pricing processes a variant-removed of that product it would retire a re-keyed series; none is sent** |
| PRC M5 (c), INV M6 | Can a removed Variant id come back? | **No, never** (M-1) | Answered; tombstones stay one-way |
| PRC "Vertical override when catalog exposes an Offer's vertical" | — | Not exposed now; the type's registrant gives the Vertical when needed | No conflict |
| PRC 2.3 seller copy | Offers never change seller | Invariant (2.1) | Match |
| INV 13 | Event names and versions; batch "Offer owned by seller X, Variant of its product, in Market M"; Simple has exactly one stable Variant id | Events 9.4; `offerSellUnits`; Simple invariant (2.1) | Match |
| INV 3.5 | Offer-created, Offer-deleted, Variant-added, Variant-removed | 9.4 | Match. **Conflict V-1:** INV does not consume `offer-moved`; after CAT-45 its stock items stay keyed by the old (Offer, Variant) pairs. Request: an `inventory` handler that re-keys on `catalog.offer-moved.v1` (mini-review there), or stock is re-entered by the seller |
| INV 3.5 Variant-added clears a tombstone if newer | — | Never needed (ids not reused); harmless | No conflict |
| CRT CC1 | ≤ 200 (Offer, Variant) keys, anonymous, published state only: `sellerId`, sale state, Variant belongs, display data (title, Variant label, primary image reference), badge structure; unknown, foreign, deleted absent | `offerListings` (9.1). **Two refinements:** (a) sale state is `listed: boolean` only (no reason codes to an anonymous caller: off-sale causes reveal seller facts); (b) badge data only for `active` tags; a `rechecking` or `suspended` tag returns status and basis without badge data, so cart shows no badge. A never-published Offer is absent | Accept with (a), (b): cart mini-review notes them |
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
| Uploaded original | Private draft area (no versioning or lifecycle expiry of non-current versions, as CD M7); not encrypted (business content, not personal; 11.1) | Random id | Never (brief s5) |
| Renditions (re-encoded, metadata-free) of a photo in a **published** revision | Public bucket served only by the cookieless origin (ADR-0029) | Content address: SHA-256 of the rendition bytes, plus the size suffix | Yes, immutable, long cache |
| Renditions of a photo only in a pending or changes-needed revision, or a draft | Private area | Content address | No: served through the API or a short-lived signed link (10.4) |

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
`received` → `scanning` → `clean` | `refused`; `clean` → `public` (first published revision that
contains it: renditions copied to the public bucket in the publish handler, idempotent);
`public` → `taken-down` (10.5). A rendition is never overwritten (content address).

### 10.4 Serving
| Case | How |
|---|---|
| Published photo | Cookieless origin, `Content-Type` set by the server, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'`, no cookies accepted or set, immutable caching; the URL is built by code from the content key (R9 for AI surfaces too) |
| Pending or draft photo | Only the owning seller (`catalog.own-product.view`) and reviewers (`catalog.product.view`): streamed by the API (`Cache-Control: no-store`) or a signed link valid ≤ 5 minutes on the cookieless origin if ADR-0029 provides signing (brief s5: short-lived and authorised) |
| Original | Never served to anyone |
| Alt text | Optional; the product name in the request locale when empty (brief s5) |

### 10.5 Takedown and retention
`image.take-down` (key `catalog.product.delete`, reason code, audited): deletes the public
renditions at once (cache purge per ADR-0029), marks the image `taken-down`; renderers skip it. If
it was the primary image the product keeps selling with the next image; if it was the only image,
the product gets the flag `photoTakenDownAt` and cause
`product-not-listed` until a revision with a clean photo is published. Originals are deleted after
the retention period (owner question 19.1 item 2; proposal: 30 days after the revision that holds
them is decided, never-submitted drafts after 30 days of inactivity); abandoned draft photos the
same (ADR-0009 d7). Until counsel answers nothing is purged (CD 9.5 pattern).

## 11. Personal data, audit and history

### 11.1 Personal data (brief s9)
`catalog` holds little: account ids of revision authors, reviewers, attestation recorders and the
seller who removed a suspended tag; seller ids. Product and Offer content is business content
written for the public and is stored clear (as published content must be). The "changes needed"
free text is written by an admin about a listing; it is stored clear on the revision, shown only to
the owning seller and to holders of `catalog.product.view`, and never put in an event, the outbox,
a log or an audit `before`/`after` (VER-13; 19.2 item 11 asks Hassan whether it must be encrypted).
Photos lose all metadata at intake. AI suggestions are stored with the draft and purged with it
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
`materialFlagCleared` when relaxing); `catalog.category-proposal.approved`, `.rejected`,
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
| To reviewers: new items in the queue, coalesced to one per Market per hour (proposal) | Submit events |

## 13. AI uses (ADR-0019; slices 25 and 26, optional for launch)

Designed only as far as this module's side; the rest waits for `platform/ai` part 1 (switch
evaluation, budget, `ClaimGuard`) and the provider ADR ("ADR 3" of ADR-0019). Both capabilities
are **seller-scoped** (they read seller text; ADR-0019 d7) and **off for a new seller until an
admin switches AI on for that seller** (owner decision, certification G1; SEL-25). No AI slice
starts before this module's facade is merged and certification's AI slices are done; one AI slice
at a time (ADR-0019 d8). Neither is on the path to the first sale.

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
| Formats | CSV and XLSX only (no XLS, no XML); formulas never evaluated; XLSX parsed in the sandboxed intake process with limits on file size, decompressed size, rows (proposal 5,000), cell length (proposal 10,000 chars); one running job per seller (brief s5). Hassan sets numbers (19.2 item 7) |
| Execution | Background job in the worker under the seller's identity kept on the job (seller id and account id from the starting `ActorContext`); `sellingEligibility` and `allowedProductTypesOf` asked again per row; a seller suspended mid-job: the remaining rows fail (AC 40) |
| Each row | Calls the same application services as the form (claim text, SEL-12, CAT-36, one Offer rule, SKU unique, `evaluateClaims` for the requested type codes only; 5.4) — no shortcut. The update key covers only the seller's own rows; Import never deletes |
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
| 4 | Working copy, autosave, revisions with base and schema ref, tax category, `ProductRevisionPolicy` (approval setting from Market configuration until 7.3's store exists) | L | 2, 3; `Revision<T>` and `ContentHash` (SL 2.4) | AC 26, 29, 36 (first half) |
| 5 | Claim-text refusal: `ClaimCheckedFields` registry and schema test, `matchClaimTerms` call fail-closed, `claim-text.check` | M | 4; certification slice 2 (`matchClaimTerms`) | AC 20 to 24; M8 cases through the matcher; no override |
| 6 | Platform product by admin; CAT-43 in the aggregate | M | 5 | AC 3 incl. AI-accept and Import variants |
| 7 | Own product and Offer: identity, SKU, condition, description, handling, attestation, shelf field; `sellingEligibility`, SEL-12, OFR-01; one-Offer rule; `offer-created`; `offerSellUnits` | L | 6; `sellers` slice 9 | AC 2, 17, 19 (handling, attestation), 37, 38 |
| 8 | Tags: `ClaimQueryBuilder`, `evaluateClaims` on every Offer write, equality under version, variant fail-closed, tag status `active`/`removed`, claim copy, tag events | L | 7; certification slices 1 and 10 | AC 7 to 11, 14, 15, 18, 19; the entry-path contract test |
| 9 | Offer on a PLATFORM product; `search-for-offer` (OFR-03); `sell-from-catalogue` | M | 8 | AC 1, 2 |
| 10 | Submit and review queue: completeness, approve named revision, changes needed with reason, bulk with skip, first Offer publication review, CAT-36 from the ADR-0026 store (declarations, port, safe values), audit, mail | L | 9; ADR-0026 store (platform; lands with `sellers` slice 15 or here, whichever is first) | AC 26 to 30, 33; safe values block creation only (7.3) |
| 11 | Publish as entry path: fan-out job, `rechecking`, `suspended` on publish; variant added/removed events; `offerListings` | M | 10 | AC 10, 15; fan-out idempotence; `offerListings` publishes nothing unpublished |
| 12 | Re-evaluation from certification events, suspend, switch, restore, "sell without badge", daily reconciliation; issuer derecognition by copy; C-6 mail | L | 11; certification slices 9 and 11 | AC 12, 13, 19 (sell without badge); idempotence; fail closed on `unavailable` |
| 13 | Photos: intake reuse, renditions, cookieless public origin, private pending photos, takedown | L | 10; ADR-0029 Accepted; certification slice 4 (intake); the image library approval (16.1) | AC 39; joins the penetration-test scope (ADR-0024 d6) |
| 14 | Delete and withdraw (OFR-06), `offer-deleted`, `product-withdrawn`; material change event and its handler (C-2) | S | 11 | AC 16, 32; C-2 before certification slice 15 |
| 15 | VER-04 diff, VER-05 revert (entry path; retired-variant refusal), CAT-35 filter | M | 11 | AC 10 (revert) |
| 16 | CAT-45 match with variant mapping; `offer-moved` | M | 12 | AC 7 (match), 15, 31; **launch-required** (Q5) |
| 17 | `CatalogReferences` (C-3) and `admin-products.search` (CUX 9) | S | 1 | Named exception, caller list; before certification slice 13 |
| 18 | Claim-term growth: rescan job, flags, off sale and mail (Q6); impact count endpoint (C-7) | M | 5; certification slice 12; request X-1 for the count | AC 25 |
| 19 | CAT-44 promotion and CAT-46 own-brand flag | M | 16 | AC 31; promotion disabled until the legal clause |
| 20 | CAT-48 retirement; SEL-12 follow-up (`type-not-allowed`, reactivation as entry path) | M | 12; `sellers` slice 14 | AC 34 |
| 21 | Category and attribute editors: move, merge, archive with `assertCategoriesRetirable` (C-4) and audited moves (C-8); definitions and families | L | 12; certification slice 13 | AC 4, 10 (category paths); B2 refusals; backstop |
| 22 | URL key, display statuses (CAT-18), locale selection | M | 10 | URL key claim check |
| 23 | Seller categories (CAT-51 to CAT-54) | M | 10; `sellers` slice 13 | AC 35 |
| 24 | Import | XL | 13, 16; after the research (Q5) | AC 40, 41; parser sandbox; penetration-test scope if in the launch build |
| 25 | AIS-03 | L | 5; this facade merged; certification slices 16, 17; `platform/ai` part 1; `sellers` slice 16 | R15 review; AC 22, 44, 46, 47 |
| 26 | AIA-03 claim flag | M | 25 | AC 45 to 47 |
| 27 | Panel screens (frontend; one PR per row of `ux.md`) | XL in all | Figma and F0 (ADR-0017); each after its backend slice | Frontend track |

**First sale (Phase 3 exit for `catalog`, brief s11):** P1, 1 to 14 and 17. **Launch-required, not
first sale:** 16 (CAT-45, Q5), 18 (Q6 behaviour), 20 (CAT-48 is the safety valve for a bad shared
product), 21 only if the tree must change after launch (otherwise a seed PR). **Optional or later:**
15, 19, 22, 23, 24, 25, 26. Slices with a migration: 1, 2, 3, 4, 7, 8, 10, 11, 12, 13, 18, 21, 23,
24, 25, 26 (Mojtaba places them). About 28 backend PRs plus P1; no date until Javad has the measured
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
| 1 | Prisma 7 with the variant registry and revision content as rows vs `jsonb` (Hossein, Mojtaba) |
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
| ADR-0029 "Object storage and file intake" incl. the cookieless origin and signed links | Reserved; Ali writes | Accepted before slice 13 |
| ADR-0026 (settings store) | Accepted 2026-10-07 | Store landed before slice 10 |
| ADR-0028 (claim contract) | Accepted 2026-10-07 | Applied here; reading of d1 for a never-published product: 19.2 item 3 (no amendment) |
| "ADR 3" of ADR-0019 (provider) | Existing plan | Before slice 25 |
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

## 18. Requests to other modules
No port, facade or event of another module is changed by this document.

| # | To | Request | By slice |
|---|---|---|---|
| X-1 | `certification` (mini-review) | For C-7: a facade method matching a **candidate** term list against texts with the same matcher (e.g. `matchCandidateClaimTerms(ctx, typeCode, termsByLocale, texts)`, `system` and authenticated-admin pair), or a pure matcher exported from `contracts/`. Without it the count answers `count.unavailable` | 18 |
| X-2 | `certification` (information; Hassan) | Confirm the reading of ADR-0028 d1 for a never-published product: `productRevisionId` is the revision being submitted or published (19.2 item 3) | 8 |
| X-3 | `certification` | The intake components (`MalwareScanner`, `DocumentInspector`, image re-encode) move to `platform/storage` intake as CD 8.2 foresees, with ADR-0029 | 13 |
| I-1 | `identity` (mini-review) | Register the keys of 8.1 and map them to default roles (R10); `catalog.product.view` for the Certification Reviewer role (9.2); no catalog use case in the limited allow-list (board 15 item 5); protected keys of 8.1 | 1, 10 |
| I-2 | `identity` | Reuse R-4 (contact point) and R-11 (admin display names), as `sellers` and `certification` | 10 |
| V-1 | `inventory` (mini-review of PR #43) | Consume `catalog.offer-moved.v1` to re-key stock items after CAT-45 (otherwise the moved Offer's stock is lost) | Before catalog 16 |
| P-1 | `pricing` (PR #44) | Use `offerSellUnits` (name differs from `offersForPricing`); priceable = non-retired variants incl. `proposed`; no `variant-removed` for a matched duplicate's variants (re-key on `offer-moved`) | Their slice 1 |
| K-1 | cart (PR #45) | `offerListings` returns `listed: boolean` without reasons, and badge data only for `active` tags; a never-published Offer is absent | Their slice using CC1 |
| A-1 | `platform/ai` part 1 | Declare AIS-03 and AIA-03 (seller-scoped), their field allow-lists (13), the allow-list entries of 13.3 | 25 |
| PL-1 | Platform | `ExtensionPointRegistry`, `AttributeSchema`, `PlainText` (P1); the ADR-0026 store by slice 10 | P1, 10 |
| O-1 | `ordering` (Phase 5 G1) | `productsForOrder` shape for VER-06 is designed with its G2; ordering asks `evaluateClaims` at purchase (ADR-0028 d4) | Its G2 |
| S-0 | `sellers` | None. Only approved methods are used (9.6) | — |

## 19. Review record and open points

### 19.1 For the owner (Persian summary, through Hadi)
Only true owner items; the seven G1 questions are answered.

| # | Question, in plain words | Team recommendation | State |
|---|---|---|---|
| 1 | Does the "waiting for review" page for a product promise a review time, and who reviews when you are away? (brief s7, asked with the page text) | No promised time at launch (as decided for certificates); any person you give the Catalogue Moderator role reviews; the queue shows the oldest first | Open |
| 2 | How long do we keep the original photo files a seller uploads (they may hold location data before we strip it; customers only ever see cleaned copies)? | 30 days after the review decision, and 30 days of inactivity for never-submitted drafts; counsel confirms; nothing is deleted before the answer | Open; with counsel |

Told, not asked: a removed size or variant never comes back with the same identity (prices and
stock for it start fresh); while a badge is being re-checked the Offer stays on sale but shows no
badge; an Offer whose product changes category so a badge no longer fits is refused at submit
(seller) or suspended (shared product); per-variant offer photos are not built at launch (19.2
item 12); "Import" waits for the shop-visit research (Q5); Kosher and Vegan words are refused
in text from day one (Q1).

### 19.2 Team decisions at G2 (proposals; Ali, Hassan, Mojtaba, Hadi rule)
| # | Point | Options | Recommendation |
|---|---|---|---|
| 1 | Registry and `AttributeSchema` design (3), no new ADR | A: as 3. B: an ADR first | A (ADR-0001 d1 decides; Ali approves 3 here) |
| 2 | CQRS read side for catalog reads (brief s9) | A: none in Phase 3; facade and panels read the write tables with indexes; `search` builds its read model from events in Phase 6. B: a read model now | A: no storefront traffic before Phase 6; revisit at `search`'s gate |
| 3 | `productRevisionId` for an Offer on a never-published product (ADR-0028 d1 says "published revision") | A: the revision being submitted or published, asked again at publish; nothing durable is stored from a decision on an unpublished revision. B: no tags before the first publish | A: the brief's flow A step 8 refuses an unbacked tag at submit "not to the queue"; B would let the seller learn only after approval |
| 4 | Tags per Offer or per (Offer, Variant) | A: per Offer, fail-closed over every variant (brief s5). B: per variant | A until a Market needs variant-narrowed manufacturer claims; B is a later mini-review |
| 5 | Re-ask on manufacturer approval without knowing coverage | A: re-ask every suspended and rechecking tag of the type (5.5 note). B: request a `coveredProducts` facade from certification | A: few suspended tags; no new contract |
| 6 | ZWNJ/ZWJ kept in text, stripped before matching (6.3) | — | Hassan confirms (brief s7) |
| 7 | Numbers: photo limits (7.1), rate limits (8.4), Import limits (14), fan-out target (5.4) | — | Hassan sets |
| 8 | Protected keys (8.1): the brief's list plus `catalog.attribute.edit` (the material flag) and `catalog.market-settings.edit` | — | Ali and Hassan confirm |
| 9 | Seller-category merge clears the shelf (4.7; CAT-53 says "moves") | A: clear the shelf. B: move the shelf to the platform category | A: a platform category is never a shelf (CAT-52, Hassan G1) |
| 10 | Tag `typeCode` in event payloads | A: as an enum code of the vocabulary. B: ids only, consumers read the type | Hassan rules on PP 5.3 |
| 11 | "Changes needed" text stored clear (11.1) | A: clear, never outside the module. B: encrypted under the seller's subject key | A (business content); Hassan rules |
| 12 | Offer photo per variant (OFR-02; brief s8 item 10) | A: not built; product photos only (ADR-0010 d2 names "description" for the Offer). B: Offer photos, every change reviewed | A; `docs/features/` row corrected by Hadi |
| 13 | `rechecking` keeps the Offer listed without a badge (5.3) | A: listed, no badge. B: off sale while rechecking | A: ordering's fresh check governs purchase (ADR-0028 d4); B would take many Offers off sale on every policy edit |
| 14 | A SELLER revision that would drop a tag (T4) | A: refuse submit with the tag list; the seller removes the tag or changes the revision. B: accept and suspend at publish | A: no silent loss; PLATFORM revisions use B (admin is shown the count) |
| 15 | Weight required for every product (CAT-31 open) | A: not required by `catalog`; shipping's gate decides. B: required now | A (Hadi) |

### 19.3 Reviews
| Reviewer | Result | Date |
|---|---|---|
| Ali (cto) | Pending | |
| Hassan (security-tester) | Pending | |
| Mojtaba (database-designer) | Pending (data design, 17.1) | |
| Reza (ui-ux-designer) | Pending (`ux.md`, 17.2) | |
| Jafar (product-designer) | Pending | |
| Hadi (product-owner) | Pending (19.2 items 12, 15; 19.1 text) | |

### 19.4 Review record: where each change was applied
| Item | Change | Applied in |
|---|---|---|
| (to be filled at review) | | |

## 20. Follow-up changes
| File | Change | When, by whom |
|---|---|---|
| `docs/modules/catalog/brief.md` | G2 row; change-log rows: variant ids never reused (M-1); Offer pattern (M-3); seller-category merge clears shelves (19.2 item 9); no Offer photos (item 12); section 12 table from Reza | With G2 approval; Hadi |
| `docs/features/02-catalog-inventory.md` | OFR-02 per-variant image removed; CAT-53 "moves the shelf" corrected; CAT-31 weight note | Product track; Hadi |
| `docs/design/data/catalog.md` | New, from 17.1 | Mojtaba |
| `docs/modules/catalog/ux.md` | New, from 17.2 | Reza |
| `docs/design/domain/platform-foundations.md` | Row 10 (registry) marked pulled; `AttributeSchema` and `PlainText` noted | Mohammad, with P1 |
| `docs/design/domain/inventory.md`, `pricing.md`, `cart.md` (PRs #43 to #45) | V-1, P-1, K-1; record "catalog G2 accepted CF1–CF4 / CC1–CC3 with the refinements of 9.7" | Their authors, after this G2 |
| `docs/design/panels/information-architecture.md` | Open point 2: catalog queue-tab keys (8.1) | Design track |
| `claude/adr-0019-follow-ups.md` | Catalog's deterministic paths (13.3) | Mohammad, with the G2 record |
| `config/markets/AU.json`, `test/fixtures/markets/ZZ.json`, schema | 7.1 (shared files: own PR, announced) | Slices 1 to 13; Hossein |
| `docs/modules/README.md`, the board | G2 status; requests of 18 | Orchestrator |
