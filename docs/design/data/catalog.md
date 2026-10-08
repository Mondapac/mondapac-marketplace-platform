# Physical data model — `catalog` schema (G2)

**Author:** Mojtaba (database-designer) — 2026-10-07
**Status:** G2 approved 2026-10-07. Ali (cto) signed with B1 and B2 applied and Q-K8 ruled; Hassan (security-tester) accepted with conditions M1 to M3 and L1 to L5, applied (L4 not added, reason in 3.15); Mohammad answered Q-K1 to Q-K15. Nothing here exists yet. This document is the
specification the `catalog` migrations are written from; each migration still needs my sign-off.
It applies every item of D 17.1 (items 1 to 12; map in 12) and the rulings recorded in D 19.2.
Open points: sections 13 and 14.
**Ground truth:** `docs/design/domain/catalog.md` (Mohammad's G2 domain design, final for G2 and
signed by Ali and Hassan; cited as **D**, for example "D 5.4"); `docs/modules/catalog/brief.md` (G1
approved 2026-10-03, "brief s5"); `docs/design/data/platform.md` (**platform.md**; 10.2 grants, 10.9
partial indexes); `docs/design/data/identity.md` (**ID-data**, conventions C1 to C11);
`docs/design/data/sellers.md` (**SL-data**, S1 to S10); `docs/design/data/certification.md`
(**CE-data**, CE1 to CE7, the insert-only pattern of its 6.1 and the raw-helper terms of its 7.2);
`docs/design/domain/platform-persistence-and-events.md` (**P**; PM1 to PM8, I7, 4.2); ADR-0003,
ADR-0004, ADR-0006, ADR-0007, ADR-0009, ADR-0010, ADR-0012, ADR-0016, ADR-0024 (decisions 1, 5),
ADR-0025, ADR-0026, ADR-0028.
**Prisma models:** `prisma/schema/catalog.prisma` (new); `base.prisma` gains `"catalog"` in `schemas`
(shared file, in the PR of migration 1).

## 1. Scope and table list

The physical design of everything D asks the database to hold for slices 1 to 26 (D 15.1): tables,
constraints, access paths with measured plans for the hot reads, grants, the migration plan per
slice, retention and erasure. It does not change the domain model; where a mapping needed a choice D
did not make, the choice is mine and is listed in 13 for Mohammad.

ADR-0009 patterns: **V1** for product revisions, platform-category revisions, attribute-definition
and family revisions (root with pointers, insert-only revision rows); **V4** for revision decisions,
Offer history, tag history and Offer publication decisions (insert-only). The relaxation requests
carry a one-way status under a guard trigger (3.21).
**V2** and **V3** are not used (prices are `pricing`'s; the order snapshot is `ordering`'s).

**No price, Cost, stock, quantity or "sellable" column exists in this schema** (ADR-0024 d1, d5;
D 2.2). A catalog test of `pnpm test:db` fails if any column of schema `catalog` matches
`price|cost|amount|currency|stock|quantity|sellable|available` (11, follow-up 15).

| Table | Holds (D 2.1) | Pattern | Slice |
|---|---|---|---|
| `outbox`, `inbox` | Events of the module (PM1, PM4) | Queue | 1 |
| `products` | `Product` root: scope, type, family, code, owner, status, pointers, flags | V1 owner | 1; pointers 4; flags 13, 18 |
| `product_variants` | The variant registry (D 2.3 M-1) | Root child, one-way state, guard trigger | 1 |
| `product_code_counters` | The per-Market sequence for `productCode` (D 4.1) | Counter, one row per Market | 1 |
| `category_trees` | One row per Market: the tree version (serialises structural edits; cache key) | Counter | 2 |
| `platform_categories`, `platform_category_revisions`, `platform_category_revision_names` | `PlatformCategory` root, revisions of name and parent | V1 | 2 |
| `attribute_definitions`, `attribute_definition_revisions`, `attribute_definition_revision_options`, `attribute_families`, `attribute_family_revisions` | `AttributeDefinition`, `AttributeFamily` | V1 | 3 |
| `product_working_copies` | The working copy (D 2.3 M-2) | Mutable, one per product | 4 |
| `product_revisions`, `product_revision_texts`, `product_revision_categories`, `product_revision_variants` | Revision content | V1 revision, insert-only + trigger | 4 |
| `product_revision_decisions` | One terminal outcome per revision, with the named checks (D 8.3a) | V4, insert-only + trigger | 4; checks 10 |
| `rate_counters` | Every limit of D 8.4 | Transient counters | 4 |
| `offers`, `offer_history` | `Offer` root and its history (D 2.3 M-3) | Root; history V4 | 7 |
| `offer_tags`, `offer_tag_history` | `OfferTag` with the claim copy (D 5.4); tag history with the entry path | Entity of the Offer; history V4 | 8 |
| `offer_publication_decisions` | First-publication review of an Offer, with named checks | V4 | 10 |
| `tag_reevaluation_requests` | Fan-out and handler work items (D 5.4, 5.5) | Work queue | 11 |
| `product_images`, `product_image_renditions`, `product_revision_images` | `ProductImage`, its renditions, the revision's ordered images | Root; renditions and revision images insert-only | 13 |
| `claim_text_rescans` | Rescan progress (D 6.4) | Job state | 18 |
| `attribute_relaxation_requests` | Two-admin rule for `material` relaxations (D 8.2, 19.2 item 8) | One-way status, guard trigger | 21 |
| `product_url_keys` | URL key per Market (CAT-12) | Held / retired keys | 22 (Q-K9) |
| `seller_categories`, `seller_category_names`, `category_proposals` | `SellerCategory`, `CategoryProposal` | Roots | 23 |
| `import_jobs`, `import_job_errors` | `ImportJob` (outline) | Root; errors insert-only | 24 |
| `ai_listing_suggestions`, `ai_claim_flags` | AIS-03, AIA-03 (outline) | Purged with the draft; insert-only | 25, 26 |

```
           sellers / identity / certification (other schemas: ids only, no FK)
                     | seller_id, *_account_id, certificate_*, issuer_id, policy_revision_id
 category_trees (1 per Market)
 platform_categories --< platform_category_revisions --< platform_category_revision_names
   | (parent_id, merged_into_id: same-table FKs; no-cycle trigger)
 attribute_definitions --< attribute_definition_revisions --< ..._revision_options
   |-- attribute_relaxation_requests (open -> confirmed | cancelled | expired)
 attribute_families --< attribute_family_revisions
 product_code_counters (1 per Market)
 products (published_/pending_revision_id: same-product FKs)
   |--< product_variants (one-way state)            |-- product_working_copies (0..1)
   |--< product_revisions --< _texts, _categories >-- platform_categories
   |         |              --< _variants >-- product_variants (same product, never retired)
   |         |              --< _images >-- product_images --< product_image_renditions
   |         |-- product_revision_decisions (0..1)
   |--< offers (seller_id never changes; shelf: same-seller FK) >-- seller_categories
           |--< offer_history          |--< offer_publication_decisions
           |--< offer_tags --< offer_tag_history
 tag_reevaluation_requests, claim_text_rescans, rate_counters, product_url_keys,
 category_proposals, import_jobs --< import_job_errors, ai_*, outbox, inbox
```

Every table carries `market_id` and `tenant_id`. No table holds money: ADR-0007 has nothing to apply
here (the tax category is a code, D 2.3 M-6).

## 2. Conventions

ID-data C1 to C11, SL-data S1 to S10 and CE-data CE1 to CE5 apply unchanged: `market_id varchar(8)`
and `tenant_id text` with their CHECKs (C1); UUIDv7 ids from `IdGenerator`, `timestamptz(6)` from
`Clock`, no column defaults, no sequences, no enum types (C2); composite FKs `(market_id, <parent>_id)`
→ `(market_id, id)` with `ON UPDATE RESTRICT` (C3, PM6); FKs stay in the schema and "who did it"
columns are plain ids (C4); indexes lead with `market_id` (C7); codes from Market configuration are
`text` with a pattern CHECK, codes fixed by the design are closed lists (S8); READ COMMITTED (S9);
same-parent FKs carry the discriminating column (CE4); contract enums keep the domain's spelling
(CE5). Catalog-specific readings:

| # | Convention |
|---|---|
| CA1 | **Version (PM5, D 2.1).** Every root of D 2.1 has `version integer NOT NULL` CHECK `>= 1`: `products`, `offers`, `platform_categories`, `attribute_definitions`, `attribute_families`, `seller_categories`, `category_proposals`, `product_images`, `import_jobs`. Entities (variants, working copy, revisions, tags) have none: a change to them raises the root's version (P 10) |
| CA2 | **Model names start with `Catalog`** (C9): `CatalogProduct`, `CatalogOfferTag`, `CatalogOutbox`, with `@@map` |
| CA3 | **Insert-only tables** (D 11.4, 17.1): revisions and their content children, decisions, Offer history, tag history, publication decisions, revision images, renditions, category and attribute revisions, AI claim flags (relaxation requests carry a one-way status, 3.21). The application holds `SELECT, INSERT` only, **and** the CE-data 6.1 triggers refuse `UPDATE`, `DELETE` (row) and `TRUNCATE` (statement) for every role, the owner included, through one function `catalog.reject_mutation()` (5.1). No product, variant or Offer row is ever physically deleted (D 4.1, Q-K2): a discarded draft keeps its product row (`discarded`), its Offer (`deleted`) and its variants (`retired`); only the working copy, the draft image rows and AI suggestions are deleted (10.1) |
| CA4 | **Codes.** Product type codes, condition codes, tax category codes, review reason codes, review check codes, family and attribute codes are Market or registry configuration: `text` CHECK `^[a-z][a-z0-9_-]{0,63}$` (S8). Certification type codes in tags: the same pattern (a validated vocabulary code, D 19.2 item 10). Locales: the CE-data 3.3 BCP 47 CHECK |
| CA5 | **Text.** Customer-visible text is clear (business content, D 11.1) and gets the S7 class: no outer spaces, no C0/C1 control and no bidi formatting character, with a length bound per column. ZWNJ and ZWJ are allowed by the CHECK (D 6.3: the joining-script rule is `PlainText`'s, which a CHECK cannot express) |
| CA6 | **Per-locale text** that is queried (product name, category names) is a row per locale; text that is only read whole (Offer description, image alt text, variant labels, attribute values) is `jsonb` CHECK `jsonb_typeof = 'object'` with locale keys, validated by the aggregate. This is my answer to spike 1 (D 15.3): rows where a query or index needs them (categories, variants, images, names), `jsonb` where nothing queries inside (13 Q-K1 for Mohammad) |
| CA7 | **Variant ids are minted by the server** (D 17.1 item 2). The database cannot see who minted an id; it refuses anything that is not a UUIDv7: CHECK `substring(id::text, 15, 1) = '7'` on `product_variants.id` (PostgreSQL 16 has no `uuid_extract_version`), so a client-made v4 id that slipped through the closed input schema fails `23514`. Prisma has no `@default` on the column |

## 3. Tables

Columns of C1 are omitted. Hand-written SQL (CHECKs, partial indexes, triggers, grants) is listed per
migration in 8. "Privileges" lines are in 7.

### 3.1 `products` (slice 1; pointers slice 4; flags 13 and 18)

| Column | Type | Null | Slice | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | 1 | PK |
| `scope` | `text` | no | 1 | CHECK `PLATFORM`, `SELLER` (ADR-0010) |
| `owner_seller_id` | `uuid` | yes | 1 | C4. CHECK `products_owner_check`: `(scope = 'SELLER') = (owner_seller_id IS NOT NULL)` (D 2.1). Promotion (CAT-44) sets `scope` and clears the owner in one statement |
| `created_by_seller_id` | `uuid` | yes | 1 | The seller who created it; never updated (column grant). Keeps the origin after promotion without a history read |
| `type_code` | `text` | no | 1 | CA4 pattern; never updated (column grant; CAT-10) |
| `variant_model` | `text` | no | 1 | CHECK `single`, `options` (the handler's `variantModel`, D 3.2). Never updated. Target of the variant FK (3.2) |
| `family_code` | `text` | no | 1 | CA4; never updated |
| `product_code` | `text COLLATE "C"` | no | 1 | From `product_code_counters` (3.3), never input. CHECK `^[A-Z0-9][A-Z0-9-]{3,31}$`. **Unique `(market_id, product_code)`** (D 17.1). Never updated |
| `status` | `text` | no | 1 | CHECK `draft`, `discarded`, `unpublished`, `published`, `matched`, `withdrawn`, `retired` (D 4.1; `discarded` terminal, Q-K2) |
| `discarded_at` | `timestamptz(6)` | yes | 1 | CHECK `products_discarded_check`: `(status = 'discarded') = (discarded_at IS NOT NULL)`; CHECK `status <> 'discarded' OR (published_revision_id IS NULL AND pending_revision_id IS NULL)` (a backstop: a discarded product has no published or pending revision; "never submitted" itself is the use case's check. Added with the pointers in migration 4) |
| `own_brand` | `boolean` | no | 1 | CAT-46; insert writes `false` |
| `matched_into_product_id` | `uuid` | yes | 1 | FK `(market_id, matched_into_product_id)` → `products`. CHECK `(status = 'matched') = (matched_into_product_id IS NOT NULL)`; CHECK `<> id` |
| `promoted_at`, `retired_at`, `withdrawn_at` | `timestamptz(6)` | yes | 1 | CHECK `(status = 'retired') = (retired_at IS NOT NULL)`, the same for `withdrawn`; `promoted_at IS NULL OR scope = 'PLATFORM'` |
| `published_revision_id` | `uuid` | yes | 4 | V1 pointer. FK `(market_id, id, published_revision_id)` → `product_revisions (market_id, product_id, id)`: only a revision **of this product** (CE4). CHECK `status NOT IN ('published', 'retired') OR published_revision_id IS NOT NULL` |
| `pending_revision_id` | `uuid` | yes | 4 | **The one pending revision** (VER-01; D 17.1 "at most one pending revision per product"): one column, so the rule holds by construction, as CE-data 3.4. Same-product FK. CHECK `pending_revision_id IS NULL OR pending_revision_id IS DISTINCT FROM published_revision_id` |
| `pending_submitted_at` | `timestamptz(6)` | yes | 4 | Queue sort key, written with the pointer in the same statement. CHECK `(pending_revision_id IS NULL) = (pending_submitted_at IS NULL)` |
| `claim_text_flagged_at` | `timestamptz(6)` | yes | 18 | D 6.4 |
| `photo_taken_down_at` | `timestamptz(6)` | yes | 13 | D 10.5 |
| `last_changed_at` | `timestamptz(6)` | no | 1 | Every save of the root; the working-copy inactivity anchor (10.2) |
| `version`, `created_at` | | no | 1 | CA1 |

- Unique `(market_id, id)` (C3) and `(market_id, id, variant_model)` (target of 3.2).
- **Partial unique `(market_id, published_revision_id) WHERE published_revision_id IS NOT NULL`**: the
  join "published product of this revision" used by the category re-ask (A9) and the name search
  (A13); unique because a revision belongs to one product.
- **No `DELETE` grant** (Q-K2). `own-product.delete` of a never-submitted draft and the prune job set
  `discarded` (10.1); the row leaves every list and read by its status (A5 filters
  `status <> 'discarded'` over its existing index; drafts are a small share of a seller's rows).

### 3.2 `product_variants` (slice 1; D 2.3 M-1, D 17.1 item 2)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK. CA7 (UUIDv7 only, server-minted) |
| `product_id` | `uuid` | no | FK `(market_id, product_id, variant_model)` → `products (market_id, id, variant_model)` |
| `variant_model` | `text` | no | Copy bound by that FK |
| `state` | `text` | no | CHECK `proposed`, `published`, `retired` |
| `created_at` | `timestamptz(6)` | no | |
| `published_at`, `retired_at` | `timestamptz(6)` | yes | CHECK `(state = 'retired') = (retired_at IS NOT NULL)`; `state = 'proposed' OR published_at IS NOT NULL OR state = 'retired'` |

- **Simple variant never retired** (D 2.1): enforced by the guard trigger, not a CHECK, because of
  the one exception on discard (below, Q-K15): `single` → `retired` is refused (`23514`) unless the
  product is `discarded`. **Partial unique `(market_id, product_id)
  WHERE variant_model = 'single'`**: exactly one variant row for a Simple product (measured).
- Unique `(market_id, id)` and `(market_id, product_id, id)` (target of 3.10's same-product FK; also
  the count path of the variant limit, 6.3 A16).
- **Guard trigger `product_variants_guard`** (5.1; measured): refuses a change of `id`,
  `product_id`, `variant_model`, `created_at`; allows only `proposed → published`, `proposed →
  retired`, `published → retired`; refuses every `DELETE` (Q-K2). So a retired id is
  never revived and never re-enters `proposed` or `published` (D 17.1 item 2), for every role. A
  second trigger on `product_revision_variants` refuses a retired variant in any new revision (3.10).
- An id is never reused: ids are UUIDv7 from `IdGenerator`, and no variant row is ever deleted
  (Q-K2: a discarded draft retires its variants with `catalog.variant-removed.v1`).
- Simple products on discard: D 2.1 says a `single` variant is never retired, yet D 4.1 retires every
  non-retired variant of a discarded draft. The guard trigger's rule: `single` → `retired` only when the product row is already
  `discarded` (the discard unit updates the product first; the trigger reads it, same unit). Q-K15.
- The `catalog.variant-removed.v1` outbox row is written in the unit that sets `retired` (the
  working-copy save or the publish; D 2.3 M-1, B2). That unit raises the product's version by one per
  event, in a fixed order (Q-K3).

### 3.3 `product_code_counters` (slice 1)

PK `(market_id)`; `next_value bigint NOT NULL` CHECK `>= 1`; `tenant_id`. The creating unit takes the
next value with one Prisma `update … { nextValue: { increment: 1 } }` (one statement, row lock held
to commit), formats it into `product_code`, and inserts the product. Product creation is a few per
minute per Market, so the row lock is not a hot spot; a gap after a rollback is harmless. Seeded by
migration? No: the first creation `upsert`s the row (C10 pattern). Grants `SELECT, INSERT, UPDATE
(next_value)`.

### 3.4 `category_trees`, `platform_categories` and their revisions (slice 2)

`category_trees`: PK `(market_id)`; `version integer NOT NULL` CHECK `>= 1`. Every structural change of
the Market's tree (create, move, merge, archive, promote of a seller category) raises it with a
guarded `updateMany … where version = $v` in its unit. Two effects: (1) two moves that would form a
cycle together cannot both commit (the second is stale), which the per-row trigger alone cannot
guarantee under READ COMMITTED; (2) a process may keep the loaded tree in memory keyed by
`(market, version)` and check it with one primary-key read per request (A8). Not Redis; the
database stays the source of truth.

`platform_categories`:

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK. A promoted seller category keeps its id (D 4.7): the promotion inserts this row with that id |
| `parent_id` | `uuid` | yes | FK `(market_id, parent_id)` → `platform_categories`. CHECK `<> id`. NULL = a root |
| `vertical_root_code` | `text` | yes | Optional Vertical root marker (CA4); CHECK `vertical_root_code IS NULL OR parent_id IS NULL` |
| `slug` | `text COLLATE "C"` | no | CHECK `^[a-z0-9]+(-[a-z0-9]+)*$`, 2 to 80. **Unique `(market_id, slug)`** (D 17.1) |
| `status` | `text` | no | CHECK `active`, `merged`, `archived` |
| `merged_into_id` | `uuid` | yes | FK to `platform_categories`. CHECK `(status = 'merged') = (merged_into_id IS NOT NULL)` |
| `published_revision_id` | `uuid` | yes | Current revision (name, parent). FK `(market_id, id, published_revision_id)` → revisions of this category. Nullable (Q-K10, as CE-data 3.1): the creating unit inserts the root with NULL, then revision 1, then sets the pointer; NULL is never visible after commit. Plain FK, no deferred constraint |
| `created_by_kind` | `text` | no | CHECK `seed`, `admin` (D 17.1 item 4). Never updated |
| `version`, `created_at` | | no | CA1 |

- **No-cycle trigger** `platform_categories_no_cycle` (BEFORE INSERT OR UPDATE OF `parent_id`): walks
  the ancestors of the new parent one PK probe at a time (a loop, not a recursive query) and refuses
  the row if it meets itself, **or when the walk reaches the depth cap of 64** (`23514`; a 65th level
  is refused rather than accepted unchecked; Ali, Q-K8). Measured: moving a node under its own
  descendant and inserting a 65th level are both refused. SQL in 5.1. With the tree-version row it is a backstop to
  the aggregate's check (D 2.1 "acyclic").
- Index `(market_id, parent_id)` for the tree editor's child lists. The full-tree read (A8) is a
  sequential read of the Market's rows (2,000 rows: 0.6 ms).
- `platform_category_revisions` (insert-only): `id` PK; `category_id` FK; `revision_no` unique per
  category; `parent_id` (the parent at that revision, no FK: history may name an archived id, C4);
  `change_kind` CHECK `created`, `renamed`, `moved`, `merged`, `archived`; `author_kind` CHECK `seed`,
  `admin`; `author_account_id` (NULL iff seed); `created_at`. Unique `(market_id, category_id, id)`.
- `platform_category_revision_names` (insert-only): PK `(market_id, revision_id, locale)`; `name text`
  1 to 120, CA5.
- The seed only inserts (D 7.2, B4): the application has no grant that a seed could use to rewrite a
  category other than the editor's column list, and the seed use case has no update path. A test
  applies the seed twice and asserts no `UPDATE` reached the table (statement counter of the unit).

### 3.5 Attribute definitions and families (slice 3)

`attribute_definitions` (root): `id`; `code` CA4, **unique `(market_id, code)`**, never updated;
`data_type` CHECK `text`, `long-text`, `integer`, `decimal`, `boolean`, `select`, `multi-select`,
`date` (D 3.3; no `image`, no money), never updated; `localizable boolean`, never updated; `status`
CHECK `active`, `archived`; `published_revision_id` (same-definition FK, nullable as 3.4, Q-K10; families the same);
`archived_by_request_id uuid` (slice 21; FK `(market_id, id, archived_by_request_id)` →
`attribute_relaxation_requests (market_id, definition_id, id)`, unique `(market_id,
archived_by_request_id)`, CHECK `archived_by_request_id IS NULL OR status = 'archived'`; set once, at
archive); `created_by_kind` CHECK `seed`, `admin`; `version`; `created_at`.

`attribute_definition_revisions` (insert-only): `id`; `definition_id` FK; `revision_no`; `material
boolean NOT NULL` (ADR-0012 d3; set by people, D 2.1); `is_variant_option boolean`; `bounds jsonb`
(object: `maxLength`, `min`, `max`); `names jsonb` (locale → name, CA6); `author_kind` CHECK `seed`,
`admin`; `author_account_id`; `relaxation_request_id uuid` (slice 21: same-definition FK
`(market_id, definition_id, relaxation_request_id)` → `attribute_relaxation_requests (market_id,
definition_id, id)`; unique `(market_id, relaxation_request_id)`: a request is used once; NULL unless
this revision clears `material`); CHECK `NOT is_variant_option OR` the root's type is `select` cannot be expressed
across tables: aggregate (5). `created_at`.

`attribute_definition_revision_options` (insert-only): PK `(market_id, revision_id, option_code)`;
`labels jsonb`; `active boolean` (an option is deactivated, never deleted, D 2.1); `position
smallint`.

`attribute_families` (root): `id`; `code` unique per Market; `status`; `published_revision_id`;
`created_by_kind`; `version`; `created_at`. `attribute_family_revisions` (insert-only): `id`;
`family_id`; `revision_no`; `groups jsonb` (array of `{ groupCode, attributes: [{ code, required,
isVariantOption }] }`), `author_kind`, `author_account_id`, `relaxation_request_id` (same-family FK
`(market_id, family_id, relaxation_request_id)` → `attribute_relaxation_requests (market_id,
family_id, id)`; unique per Market), `created_at`.

**Two-person backstop triggers (Hassan M2; slice 21; SQL in 5.1; measured).** All `SECURITY
INVOKER`, fixed `search_path`, schema-qualified, through one helper
`catalog.relaxation_confirmed(market, request, definition, kind)` (a `STABLE` SQL function, no grant):
- `attribute_definition_revisions_relaxation` (`BEFORE INSERT`): when the definition's current
  revision has `material = true` and the new one `false`, `relaxation_request_id` must name a
  `confirmed` `clear-material` request of this definition (`23514`); any other revision with a
  request id is refused.
- `attribute_definitions_archive_relaxation` (`BEFORE UPDATE OF status, archived_by_request_id`):
  `active → archived` of a definition whose current revision is `material` needs
  `archived_by_request_id` naming a `confirmed` `archive` request of this definition (`23514`);
  `archived_by_request_id` changes only at that transition (`23001`).
- `attribute_family_revisions_relaxation` (`BEFORE INSERT`): compares the attribute codes of the
  family's current revision with the new one (`jsonb_array_elements`, codes resolved through the
  unique `(market_id, code)`); when a removed code is a `material` definition,
  `relaxation_request_id` must name a `confirmed` `remove-from-family` request for that definition
  and this family (the FK binds the family; `23514`). One material removal per revision (`23514`
  otherwise: the admin removes them one by one, each with its own request).
The use case remains the control (D 8.2); the triggers make the rule hold for a script or a bug.

The schema reference a product revision records (D 3.3 rule 1) is `family_revision_id` plus
`definition_revision_ids uuid[]` (3.9): ids of insert-only rows, so the schema a revision was
validated against can always be rebuilt.

### 3.6 `product_working_copies` (slice 4; D 2.3 M-2)

PK `(market_id, product_id)` (C7, 1:1); FK to `products`, `ON DELETE CASCADE` (C8: no meaning
without the product; deleted explicitly when a draft is discarded, 10.1); `content jsonb NOT NULL` CHECK object
(the incomplete draft: texts, attribute values, variant drafts naming registry ids, category ids, tax
category, image ids with alt text); `content_schema_version smallint`; `base_revision_id uuid` (the
published revision it was started from; FK same product); `last_saved_at`; `last_saved_by_account_id`.

Why `jsonb`: OFR-04 allows an incomplete draft, nothing queries inside it, and a submit validates and
freezes it into rows (3.9 to 3.11). The claim-text rule "no claim word is ever stored, not even in a
draft" (D 6.1) is the save use case's; the database cannot check it. AI suggestions are a separate
table purged with the draft (3.20). Grants `SELECT, INSERT, UPDATE, DELETE` (discard and prune, 10.1).
Index `product_working_copies_market_id_last_saved_at_idx` `(market_id, last_saved_at, product_id)`:
the prune job's range (A22); the seller list's "removed on" date (from day 166) reads `last_saved_at`
through the PK.

### 3.7 `product_revisions` (slice 4; V1)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `product_id` | `uuid` | no | FK `(market_id, product_id)` → `products`, RESTRICT |
| `revision_no` | `integer` | no | CHECK `>= 1`. Unique `(market_id, product_id, revision_no)` |
| `revision_kind` | `text` | no | CHECK `submission`, `revert`, `tax-override` (D 4.2 rows 1 and 6, D 4.3) |
| `base_revision_id` | `uuid` | yes | The published revision it was built on; same-product FK. CHECK `revision_kind <> 'tax-override' OR base_revision_id IS NOT NULL`: a tax override is always the published revision with one field changed (D 4.3, Hassan 1a) |
| `reverted_from_revision_id` | `uuid` | yes | Same-product FK. CHECK `(revision_kind = 'revert') = (reverted_from_revision_id IS NOT NULL)` |
| `family_revision_id` | `uuid` | no | Schema ref (3.5) |
| `definition_revision_ids` | `uuid[]` | no | Schema ref |
| `tax_category_code` | `text` | no | CA4 (Market list; ADR-0007 d5, D 2.3 M-6) |
| `attribute_values` | `jsonb` | no | Object; code → value or locale → value (CA6). Material-change detection compares two revisions in code (D 5.7); no index |
| `field_provenance` | `jsonb` | yes | Per field `typed`, `ai-unchanged`, `ai-edited` (D 13.1), server-built; object; no text |
| `sensitive` | `boolean` | no | Classification at submit (D 4.3) |
| `sensitive_reasons` | `text[]` | no | CHECK `<@ ARRAY['platform-categories','tax-category','name','primary-image','image-added-or-replaced','variant-removed','never-published','approval-required']` (D 9.2a codes); CHECK `sensitive OR cardinality(sensitive_reasons) = 0` |
| `content_schema_version` | `smallint` | no | |
| `content_hash` | `text` | no | `ContentHash` over the frozen content (ADR-0009). Plain SHA-256 is enough: the content is public business content, not personal (ADR-0009 d6 applies to personal fields). CHECK `content_hash ~ '^sha256:[0-9a-f]{64}$'` (`ContentHash`, `docs/design/domain/platform-audit.md` 6.3; replaces the length 1 to 128 placeholder; the plain kind only, as this row says; signed off by Mojtaba 2026-10-08) |
| `author_kind` | `text` | no | CHECK `seller`, `admin` |
| `author_account_id` | `uuid` | no | C4 |
| `acting_admin_account_id` | `uuid` | yes | Acting-as (IMP-06); CHECK `acting_admin_account_id IS NULL OR author_kind = 'seller'` |
| `submitted_at` | `timestamptz(6)` | no | |

- CHECK `revision_kind <> 'tax-override' OR author_kind = 'admin'`.
- Unique `(market_id, id)`, `(market_id, product_id, id)` (pointer and child target).
- Insert-only (CA3). Status is derived, as CE-data 3.5: **pending** = `products.pending_revision_id`;
  **published** = `products.published_revision_id`; **changes-needed**, **superseded while pending**
  = the decision row (3.12); **superseded after publication** = a `published` decision whose revision
  is no longer the pointer. Moving the pointer writes one decision row and one root update.

### 3.8 `product_revision_texts` (slice 4)

PK `(market_id, revision_id, locale)`; FK to `product_revisions`; `name text NOT NULL` (1 to 200);
`short_description text` (≤ 500), `description text` (≤ 10,000), all CA5. Insert-only. Completeness
(default locale required, others optional, D 4.2 row 1) is the aggregate's.

Read by: the list pages and `offerListings` names (PK probe per revision and locale, A2, A5, A6); the
OFR-03 and admin searches (trigram index, A13); the rescan (keyset by `revision_id` over published
revisions, A14).

### 3.9 `product_revision_categories` (slice 4)

PK `(market_id, revision_id, category_id)`; FK to `product_revisions`; FK `(market_id, category_id)` →
`platform_categories` (a revision names only platform categories of its Market, never a shelf: AC 11);
`position smallint` (order as entered). Insert-only. CHECK "≥ 1 per revision" is cross-row: aggregate.

**Index `(market_id, category_id, revision_id)`**: the category re-ask and the impact count (A9,
A10), joined to `products` by the published-revision partial unique. Old revisions stay in it (about
4 rows per product at the ceiling); measured below the read target (11).

### 3.10 `product_revision_variants` (slice 4)

PK `(market_id, revision_id, variant_id)`; `product_id`; FK `(market_id, product_id, revision_id)` →
`product_revisions (market_id, product_id, id)` and FK `(market_id, product_id, variant_id)` →
`product_variants (market_id, product_id, id)`: **a revision can name only variants of its own
product** (CE4; the database half of D 4.2's `variant.unknown`). `position smallint`; `option_key
text` = the canonical string of the option values (`size=l;colour=red`, built by the handler),
**unique `(market_id, revision_id, option_key)`** (the combination is unique within the product, D
3.2); `option_values jsonb`; `labels jsonb` (locale → label). Insert-only.

**Trigger `product_revision_variants_not_retired`** (BEFORE INSERT): refuses a variant whose registry
state is `retired` (measured). With 3.2's guard, no new revision, revert included, can carry a
retired id (D 4.2 row 6; D 17.1 item 2).

`option_key` is also the Import update key's variant part (D 14, 17.1 item 10): (seller,
`sellerSku`) finds the Offer, the option values find the variant of the product's working copy or
published revision. **There is no per-variant SKU column** (Hadi; D 2.1).

### 3.11 `product_revision_images` (slice 13)

PK `(market_id, revision_id, position)`; FK to the revision; `image_id` with FK `(market_id,
image_id, product_id)` → `product_images (market_id, id, product_id)` (an image of the same product,
D 2.1 `ProductImage` invariant; `product_id` copied and bound by the revision FK as in 3.10);
`alt_text jsonb` (locale → text, CA6). Unique `(market_id, revision_id, image_id)`. Insert-only.
Position 1 is the primary image. Index `(market_id, image_id)` for "which revisions use this image"
(takedown, master retention, A18).

### 3.12 `product_revision_decisions` (slice 4; checks slice 10; V4)

| Column | Type | Null | Notes |
|---|---|---|---|
| `revision_id` | `uuid` | no | PK `(market_id, revision_id)`: one terminal outcome per revision. FK to `product_revisions` |
| `outcome` | `text` | no | CHECK `published`, `changes-requested`, `superseded` |
| `publish_kind` | `text` | yes | CHECK `reviewed`, `auto`, `admin-authored` (PLATFORM by admin, tax override; D 4.3). CHECK `(outcome = 'published') = (publish_kind IS NOT NULL)` |
| `approval_required_read` | `boolean` | yes | The CAT-36 value read in the unit (D 4.2 row 4 `autoPublished`). CHECK `(publish_kind = 'auto') = (approval_required_read IS NOT NULL)` |
| `superseded_cause` | `text` | yes | CHECK `resubmitted`, `withdrawn`, `promoted`, `matched`; CHECK `(outcome = 'superseded') = (superseded_cause IS NOT NULL)` |
| `reason_code` | `text` | yes | Market `reviewReasons` (CA4). CHECK `(outcome = 'changes-requested') = (reason_code IS NOT NULL)` |
| `reason_text` | `text` | yes | The reviewer's optional words, clear (Hassan, D 19.2 item 11), ≤ 2,000, CA5. CHECK `reason_text IS NULL OR outcome = 'changes-requested'`. Never copied to events, audit or logs (VER-13) |
| `required_checks` | `text[]` | no | The checks the server derived for this revision (D 8.3a), CA4 codes each |
| `confirmed_checks` | `text[]` | no | The checks the reviewer confirmed (`checksConfirmed`) |
| `decided_by_kind` | `text` | no | CHECK `admin`, `seller` (a seller's resubmit or withdraw supersedes), `system` (auto-publish) |
| `decided_by_account_id` | `uuid` | yes | C4. CHECK `(decided_by_kind = 'system') = (decided_by_account_id IS NULL)` |
| `product_version` | `integer` | no | The product version the decision named (D 4.2 row 3) |
| `decided_at` | `timestamptz(6)` | no | |

- **CHECK `product_revision_decisions_checks_check`: `publish_kind IS DISTINCT FROM 'reviewed' OR
  required_checks <@ confirmed_checks`** (D 8.3a, Reza 7.6, Hassan H1): a reviewed publish without
  every required check cannot be stored, whatever the application does. The required set is
  server-derived (D 8.3a) and the database cannot recompute it; it holds the two sets together on the
  insert-only row. Codes, reviewer and instant are the row's ("stored on the decision").
- CHECK `cardinality(confirmed_checks) = 0 OR publish_kind = 'reviewed'`: checks are a human's
  statement on a review, never on an auto-publish (R2).
- Insert-only (CA3). Columns `required_checks`, `confirmed_checks` are created in slice 4 (empty
  arrays until slice 10 fills them), so slice 10 alters no insert-only table.

### 3.13 `offers` (slice 7; shelf column slice 23)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; never reused (a deleted row stays) |
| `seller_id` | `uuid` | no | C4. **Never updated** (no column grant; D 2.1, PRC 2.3) |
| `product_id` | `uuid` | no | FK `(market_id, product_id)` → `products`. Updated only by CAT-45 match (the Offer moves, D 4.5) |
| `seller_sku` | `text COLLATE "C"` | no | One per Offer (D 17.1 item 10). CHECK 1 to 64, no whitespace or control character (`^[!-~]+$` widened per Market later if needed) |
| `condition_code` | `text` | no | CA4 (Market `conditions`) |
| `description` | `jsonb` | no | Locale → text (CA6), object; claim-checked in the use case |
| `handling` | `text` | yes | CHECK `SEALED_ORIGINAL`, `REPACKED`, `PREPARED`, `FRESH`. NULL in a draft; CHECK `status IN ('draft', 'deleted') OR handling IS NOT NULL` (D 4.4: handling present at submit) |
| `attestation_recorded_at`, `attestation_account_id` | `timestamptz(6)`, `uuid` | yes | Both or neither (CHECK). Written only by `own-offer.record-attestation` (D 2.1, B1) |
| `shelf_category_id` | `uuid` | yes | Slice 23. FK `(market_id, shelf_category_id, seller_id)` → `seller_categories (market_id, id, seller_id)`: **the shelf belongs to the Offer's seller** (CE4; AC 35; measured) |
| `status` | `text` | no | CHECK `draft`, `pending-first-publish`, `changes-needed`, `published`, `deleted` |
| `off_sale_type_not_allowed`, `off_sale_product_retired`, `off_sale_product_not_listed`, `off_sale_tag_suspended`, `off_sale_description_claim_text` | `boolean` | no | The stored causes (D 2.3 M-5, 6.4). Booleans, not an array: each is a plain column in Prisma, a CHECK and an index predicate can name it, and adding a cause later is an `ADD COLUMN` plus a CHECK swap (8.2) |
| `listed` | `boolean` | no | **CHECK `offers_listed_check`: `listed = (status = 'published' AND NOT (<any cause>))`** (measured). Stored so a partial index and one-row reads can use it; it cannot disagree with the causes. The domain rule also needs "product published" (D 4.4): held by the transitions (5) |
| `submitted_at` | `timestamptz(6)` | yes | Last submit for review; queue sort. CHECK `status <> 'pending-first-publish' OR submitted_at IS NOT NULL` |
| `first_published_at` | `timestamptz(6)` | yes | |
| `deleted_at` | `timestamptz(6)` | yes | CHECK `(status = 'deleted') = (deleted_at IS NOT NULL)` |
| `version`, `created_at` | | no | CA1 |

- **Partial unique `(market_id, seller_id, product_id) WHERE status <> 'deleted'`**: one non-deleted
  Offer per (Market, seller, product), drafts included (OFR-02, AC 2; measured). The insert's `P2002`
  maps to `offer.exists-for-product`; never read-then-insert.
- **Partial unique `(market_id, seller_id, seller_sku) WHERE status <> 'deleted'`** (CAT-10, AC 2).
- Unique `(market_id, id)` and `(market_id, id, seller_id)` (target of the tag FK, 3.15).
- Index `(market_id, product_id, id) WHERE status <> 'deleted'`: the fan-out keyset and M1 marking
  (A7), the Offers tab (A12) and the match guard.
- Partial `(market_id, submitted_at, id) WHERE status = 'pending-first-publish'`: the
  first-publication half of the review queue (A6).
- "A SELLER product accepts an Offer only from its owner" (CAT-40) is not a constraint: the product's
  owner can change at promotion, after which other sellers may sell it. Aggregate (5).

### 3.14 `offer_history` (slice 7; V4)

`id` PK; `offer_id` FK; `offer_version integer` (the version after the change), **unique
`(market_id, offer_id, offer_version)`**; `change_kind` CHECK `created`, `edited`, `submitted`,
`publication-approved`, `changes-requested`, `published`, `handling-changed`,
`attestation-recorded`, `attestation-withdrawn`, `causes-changed`, `moved`, `shelf-cleared`,
`deleted`; `changed_fields text[]` (field ids of D 6.2, no values); snapshot after the change:
`product_id`, `status`, `seller_sku`, `condition_code`, `description jsonb`, `handling`,
`attestation_recorded boolean`, `shelf_category_id`, `listed`, `off_sale_causes text[]` (CHECK
`<@` the five cause codes); `actor_kind` CHECK `seller`, `admin`, `system`; `actor_account_id` (NULL iff
system); `acting_admin_account_id`; `occurred_at`. Index `(market_id, offer_id, occurred_at)` for the
history read. Insert-only (CA3). A tag-only change has no row here: it has one in 3.16.

### 3.15 `offer_tags` (slice 8; selection indexes slice 12)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK. A removed tag keeps its row; re-adding is a new row (D 5.3) |
| `offer_id`, `seller_id` | `uuid` | no | FK `(market_id, offer_id, seller_id)` → `offers (market_id, id, seller_id)`: the copy of the seller is the Offer's (CE4), so selection by (seller, type) needs no join. Never updated |
| `type_code` | `text` | no | CA4. Never updated |
| `status` | `text` | no | CHECK `pending-publish`, `active`, `rechecking`, `suspended`, `removed` (D 5.3, D 17.1 item 12a). `pending-publish`: requested at the first submit of a never-published product, re-asked at publish into `active`, `suspended` or `removed` |
| `basis` | `text` | yes | CHECK `SELLER`, `MANUFACTURER` (CD 4.1 `ClaimDecision.basis`) |
| `certificate_kind` | `text` | yes | CHECK `seller`, `manufacturer` |
| `certificate_id`, `certificate_version_id`, `issuer_id`, `type_revision_id`, `policy_revision_id` | `uuid` | yes | The copy (D 5.4, ADR-0028 d2, d11); C4, no FK. `policy_revision_id` NULL = the type default |
| `valid_until` | `timestamptz(6)` | yes | |
| `badge_data` | `jsonb` | yes | CD 4.5 `BadgeData`, object. **CHECK `offer_tags_badge_data_check`: `badge_data IS NULL OR status = 'active'`** (D 5.3: no badge while `pending-publish`, `rechecking` or `suspended`; measured) |
| `copy_revision_id` | `uuid` | yes | The product revision the decision named (D 17.1 item 3; B3). FK `(market_id, copy_revision_id)` → `product_revisions` |
| `copy_revision_published` | `boolean` | no | True when that revision was the product's published revision at the decision (D 5.1a point 5). The handler indexes below carry it in their predicate, so tags on a never-published product's frozen revision are excluded without a join |
| `inputs_hash` | `bytea` | yes | SHA-256 of the canonical inputs it was decided on (D 5.4); CHECK `octet_length = 32`. Not keyed: no personal input |
| `last_reason_code` | `text` | yes | The last `ClaimReason` (CUX 3.7 enum), CA4 pattern |
| `last_change_cause` | `text` | yes | The entry path or event of the last status change (closed list of 3.16) |
| `evaluated_at` | `timestamptz(6)` | no | Last ask; the reconciliation order (D 5.6) |
| `status_changed_at` | `timestamptz(6)` | no | |
| `status_seq` | `integer` | no | CHECK `>= 1`. 1 at insert; raised by exactly one with every `status` change and unchanged otherwise (trigger `offer_tags_status_seq`, `23514`). Names the history row of the current status (below) |
| `removed_at`, `removed_by_kind`, `removed_by_account_id` | | yes | CHECK `(status = 'removed') = (removed_at IS NOT NULL)`; kind CHECK `seller`, `system` |
| `created_at` | `timestamptz(6)` | no | |

- **CHECK `offer_tags_active_copy_check`**: `status <> 'active' OR (basis, certificate_kind,
  certificate_id, certificate_version_id, type_revision_id, copy_revision_id, inputs_hash, badge_data)
  all NOT NULL`. An `active` row without a full copy cannot exist (measured shape). `issuer_id` and
  `valid_until` are deliberately not in the list (Hassan L4): certification allows both to be NULL on
  an approved certificate (`issuer_id` NULL for a type without a registry, CE-data 3.5;
  `expiry_boundary_at` NULL when the submission has no expiry date, CE-data 3.6), so requiring them
  would refuse valid tags. Whether a type needs an issuer or an expiry is certification's rule,
  enforced in `evaluateClaims`.
- **CHECK `offer_tags_published_copy_check`** (Hassan M1): `status IN ('pending-publish', 'removed')
  OR copy_revision_published`. A tag that is `active`, `rechecking` or `suspended` always names a
  revision that was published at its decision, so the selection indexes below (predicate
  `copy_revision_published`) can never miss a live tag (measured).
- **CHECK `offer_tags_pending_publish_check`** (D 17.1 item 12a): `status <> 'pending-publish' OR
  (copy_revision_id IS NOT NULL AND NOT copy_revision_published AND badge_data IS NULL)`. A
  `pending-publish` tag names the frozen submitted revision, which is never the published one; so
  every selection index below (predicate `copy_revision_published`) excludes it **structurally**, and
  the D 5.5 handlers cannot reach it. The publish unit moves it to `active` (badge data and
  `copy_revision_published = true` set in the same `UPDATE`), `suspended` or `removed`.
- **Partial unique `(market_id, offer_id, type_code) WHERE status <> 'removed'`**: one non-removed
  tag per (Offer, type) (D 17.1). Also the "tags of these Offers" path of `offerListings`, M1 marking
  and settling (A2, A7).
- Selection indexes of D 5.5 (slice 12), each partial `WHERE status <> 'removed' AND
  copy_revision_published` (D 5.1a point 5; Hassan B3):
  - `(market_id, certificate_id)` — copy names that certificate (seller or manufacturer);
  - `(market_id, certificate_version_id)` — copy names that submission (issuer confirmed);
  - `(market_id, issuer_id)` — issuer derecognised (ADR-0028 d11);
  - `(market_id, seller_id, type_code)` — seller certification approved;
  - `(market_id, type_code, offer_id) WHERE status IN ('suspended', 'rechecking') AND
    copy_revision_published` — manufacturer approved or coverage widened (D 5.5 note); and the
    claim-policy re-ask of a whole type uses `(market_id, type_code, offer_id)` with `status <>
    'removed'` (the same index without the status narrowing: one index
    `offer_tags_market_id_type_code_open_idx`, the suspended subset is a filter over it at the
    measured volumes; Q-K5 accepted: a partial index only if suspended plus rechecking tags pass 5%).
  - Reconciliation (D 5.6): `(market_id, evaluated_at, id) WHERE status NOT IN ('removed',
    'pending-publish')` (D 17.1 item 12a: reconciliation skips `pending-publish`; the query repeats
    the predicate literally so the partial index matches). The daily run reads every other tag; it **joins** `product_revision_decisions` for `copy_revision_id` with
    `outcome = 'published'` instead of trusting `copy_revision_published`, so a wrong flag is repaired
    within a day (5).
- **Every status change has its history row** (Hassan, info; slice 8; SQL in 5.1; measured).
  Constraint trigger `offer_tags_history_present` (`AFTER INSERT OR UPDATE OF status`, `DEFERRABLE
  INITIALLY DEFERRED`): at commit, a row of `offer_tag_history` with this `tag_id`, `status_seq` and
  `to_status` equal to the tag's must exist, else `23001`. I chose a check over a trigger that
  **writes** the history row: the row's `entry_path`, actor, reason and cause event are known only to
  the use case (D 5.4), and a database-written row would hold a guess. Cost measured: +230 ms at
  commit for 11,242 tags (about 20 µs a tag; ≈ 1 s at the 50,000 bound of Q-K4); single-tag units
  under 1 ms.
- Column grant `UPDATE` excludes `id`, `offer_id`, `seller_id`, `type_code`, `created_at` (7).
- Hot table: the reconciliation rewrites `evaluated_at` of every tag daily and M1 rewrites `status`;
  both are non-HOT (indexed columns). Proposed per-table autovacuum: `autovacuum_vacuum_scale_factor =
  0.05`, `autovacuum_analyze_scale_factor = 0.05` (a `ALTER TABLE … SET (…)` in migration 8).

### 3.16 `offer_tag_history` (slice 8; V4; the ADR-0028 d5 entry-path record)

`id` PK; `tag_id` with FK `(market_id, tag_id, offer_id)` → `offer_tags (market_id, id, offer_id)`;
`offer_id`; `type_code`; `from_status` (nullable, the 3.15 list) and `to_status`; the copy after the
change (`basis`, `certificate_kind`, `certificate_id`, `certificate_version_id`, `issuer_id`,
`policy_revision_id`, `copy_revision_id`); `reason_code`; **`entry_path`** CHECK closed list of D
5.4: `offer-create`, `offer-edit`, `handling-change`, `attestation-change`, `tag-add`,
`revision-submit`, `revision-publish`, `revision-revert`, `category-change`, `match`, `promotion`,
`offer-reactivated`, `tax-category-override`, `import-row`, `certification-event`, `reconciliation`,
`seller-remove`, `seller-remove-suspended`, `offer-delete`, `product-withdrawn`, `product-retired`;
`status_seq integer` (the tag's `status_seq` after the change; **unique `(market_id, tag_id,
status_seq)`**, the target of the presence check of 3.15); `cause_event_id uuid` (the consumed event,
for handler rows); `actor_kind` CHECK `seller`, `admin`,
`system`; `actor_account_id` (NULL iff system); `acting_admin_account_id`; `occurred_at`.

One row per **status or basis change** (not per kept re-ask; a kept re-ask only updates
`evaluated_at`). With the `platform.audit_log` row of D 11.3 written in the same unit, every tag
change says which entry path made it. Index `(market_id, offer_id, occurred_at)`. Insert-only.

### 3.17 `offer_publication_decisions` (slice 10)

`id` PK; `offer_id` FK; `offer_version` (the version the request named), unique `(market_id,
offer_id, offer_version)`; `outcome` CHECK `approved`, `changes-requested`; `reason_code`,
`reason_text` (as 3.12); `required_checks`, `confirmed_checks text[]` with CHECK `outcome <>
'approved' OR required_checks <@ confirmed_checks` (D 8.3a); `decided_by_account_id NOT NULL`;
`decided_at`. Insert-only.

### 3.18 `tag_reevaluation_requests` (slice 11)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `kind` | `text` | no | CHECK `revision-published`, `category-changed`, `certification-event`, `types-reallowed` |
| `product_id` | `uuid` | yes | For `revision-published`. CHECK `(kind = 'revision-published') = (product_id IS NOT NULL)` |
| `product_revision_id` | `uuid` | yes | Same nullability as `product_id`; FK same product |
| `source_event_id` | `uuid` | yes | The event that created it (category, certification, sellers); NULL for a publish |
| `state` | `text` | no | CHECK `pending`, `settled`, `superseded` |
| `cursor_offer_id` | `uuid` | yes | Keyset position (Offer id) for a resumable run |
| `counts` | `jsonb` | no | `asked`, `kept`, `switched`, `suspended`, `restored`, `unavailable` (metric, D 5.6; 19.2 item 5) |
| `created_at`, `settled_at` | `timestamptz(6)` | | |

- **Partial unique `(market_id, product_id) WHERE state = 'pending' AND kind = 'revision-published'`**:
  a newer publish supersedes the older request in its unit (update then insert), so one pending request
  per product (D 5.4).
- Unique `(market_id, product_revision_id) WHERE kind = 'revision-published'`: a request for a
  revision is written once (idempotent publish handler).
- Unique `(market_id, source_event_id)` where not NULL: one request per consumed event.
- Claim index `(market_id, created_at, id) WHERE state = 'pending'`. The job runs under its scheduler
  lock (PM8) per Market, so no `SKIP LOCKED` is needed; requests are taken in order.
- Grants `SELECT, INSERT, UPDATE (state, cursor_offer_id, counts, settled_at)`; purge of settled rows
  after 30 days (10.3).

### 3.19 `product_images`, `product_image_renditions` (slice 13; D 10, D 17.1 item 1)

`product_images` (root):

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `product_id` | `uuid` | no | FK to `products`. Unique `(market_id, id, product_id)` (target of 3.11) |
| `uploader_kind`, `uploader_account_id` | `text`, `uuid` | no | CHECK `seller`, `admin` |
| `state` | `text` | no | CHECK `received`, `scanning`, `clean`, `refused`, `public`, `taken-down` (D 10.3; `public → clean` allowed) |
| `refusal_code` | `text` | yes | Closed `file.*` list (CD 3.8 plus `file.too-many-pixels`); CHECK `(state = 'refused') = (refusal_code IS NOT NULL)` |
| `raw_object_key` | `text` | yes | The raw upload in the intake area. **Kept until the object delete is confirmed** (Hassan M3): CHECK `product_images_raw_intake_check` `state NOT IN ('received', 'scanning') OR raw_object_key IS NOT NULL`; CHECK `product_images_raw_key_check` `state IN ('received', 'scanning', 'clean', 'refused') OR raw_object_key IS NULL`, so an image never becomes `public` while its raw upload may still exist. The intake unit ends in `clean` or `refused` with the key kept; after commit the object is deleted; a second unit clears the key once storage confirms (success or not-found). No column keeps an original |
| `master_object_key` | `text` | yes | The metadata-free master (M2). CHECK `state NOT IN ('clean', 'public', 'taken-down') OR master_object_key IS NOT NULL`; **CHECK `product_images_master_prefix_check`: `master_object_key IS NULL OR master_object_key LIKE product_id::text || '/%'`** (per-product prefix as renditions; Hassan L3) |
| `master_sha256` | `bytea` | yes | CHECK `octet_length = 32`; same nullability as the key |
| `media_type` | `text` | yes | Found by inspection: CHECK `image/jpeg`, `image/png`, `image/webp`, `image/heic`, `image/heif` |
| `pixel_width`, `pixel_height` | `integer` | yes | CHECK `BETWEEN 1 AND 12000` (Hassan, D 8.4) |
| `byte_size` | `bigint` | no | CHECK `> 0` |
| `taken_down_at`, `taken_down_by_account_id`, `takedown_reason_code` | | yes | All three iff `state = 'taken-down'` |
| `version`, `created_at` | | no | CA1 |

The client's file name is never stored (D 6.2). Index `(market_id, product_id, created_at)` (the
product's photos; the master retention job, 10.2); partial `product_images_market_id_created_at_raw_idx`
`(market_id, created_at) WHERE raw_object_key IS NOT NULL` (the sweep of 10.2: stuck intake **and**
unconfirmed raw deletes; it replaces the earlier intake-only partial index).

Hassan L3: column-level grant `UPDATE (state, refusal_code, raw_object_key, master_object_key,
master_sha256, media_type, pixel_width, pixel_height, taken_down_at, taken_down_by_account_id,
takedown_reason_code, version)` (`product_id`, uploader, `byte_size`, `created_at` never change); and
trigger `product_images_delete_guard` (`BEFORE DELETE`, SQL in 5.1) refuses a `DELETE` unless the row
is `received`, `scanning`, `clean` or `refused` (`23001`): a `public` or `taken-down` image is never
deleted (measured).

`product_image_renditions` (insert-only): PK `(market_id, image_id, size_code)`; `size_code` CHECK
closed list (`thumb`, `medium`, `large`; final with ADR-0029); `object_key text NOT NULL` with
**CHECK `object_key LIKE product_id::text || '/%'`** where `product_id` is copied and bound by FK
`(market_id, image_id, product_id)` → `product_images` (per-product key prefix, Hassan L2); `sha256
bytea` (32); `byte_size`, `width`, `height`; `created_at`. Whether a rendition is in the public bucket
follows the image `state` (`public`), not a column here, so the row stays insert-only.

### 3.20 `claim_text_rescans` (slice 18; D 6.4)

`id` PK; `source_event_id uuid` unique per Market (`certification-type-revised.v1`); `type_code`;
`state` CHECK `running`, `done`, `failed`; `phase` CHECK `products`, `offers`, `seller-categories`,
`platform-categories`, `attribute-definitions`, `proposals`; `cursor_id uuid` (keyset per phase);
`counts jsonb`; `started_at`, `finished_at`, `failed_at`. Grants `SELECT, INSERT, UPDATE`. A failed run
keeps its cursor and retries; it never clears a flag (D 6.4).

### 3.21 `attribute_relaxation_requests` (slice 21; D 8.2, D 17.1 items 5, 9)

One row per two-admin request, with its lifecycle on the row (D 8.2: `open` → `confirmed` |
`cancelled` | `expired`). Not insert-only: `status` moves once, out of `open`, and nothing else
changes after the insert except the columns that record that move (guard trigger below). The
history is the row plus the audit rows (`catalog.attribute-relaxation.requested`, `.cancelled`,
`.expired`, `catalog.attribute-definition.revised` with both account ids, D 11.3).

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK `(market_id, id)` as everywhere |
| `market_id`, `tenant_id` | as 2 | no | |
| `definition_id` | `uuid` | no | FK `(market_id, definition_id)` to `attribute_definitions`. Unique `(market_id, definition_id, id)`: target of the same-definition FKs of 3.5 (Hassan M2) |
| `definition_version` | `integer` | no | The root's version named by the request (D 8.2); the confirm unit refuses if it changed. CHECK `> 0` |
| `kind` | `text` | no | CHECK `clear-material`, `archive`, `remove-from-family` (D 8.2; `delete` merged into `archive`, Q-K6) |
| `family_id` | `uuid` | yes | FK `(market_id, family_id)` to `attribute_families`; CHECK `(kind = 'remove-from-family') = (family_id IS NOT NULL)`. Unique `(market_id, family_id, id)`: target of the same-family FK of 3.5 |
| `status` | `text` | no | CHECK `open`, `confirmed`, `cancelled`, `expired`. No default (C2; Ali B2): the application writes `open` |
| `requested_by_account_id` | `uuid` | no | C4 |
| `requested_at` | `timestamptz(6)` | no | |
| `expires_at` | `timestamptz(6)` | no | `requested_at + 72 h` (D 8.2 proposal) computed by the application from Market configuration. CHECK `expires_at > requested_at AND expires_at <= requested_at + interval '168 hours'` (a backstop against a misconfigured period, not the 72 h itself) |
| `confirmed_by_account_id` | `uuid` | yes | |
| `closed_at` | `timestamptz(6)` | yes | When `status` left `open` (confirm, cancel or the job) |
| `cancel_reason` | `text` | yes | CHECK `requester`, `definition-changed`; CHECK `(status = 'cancelled') = (cancel_reason IS NOT NULL)` (Q-K14) |
| `version` | `integer` | no | No default (C2; Ali B2): the insert writes 1. CHECK `>= 1` (CA1; D 17.1 item 12a). Confirm, cancel and the expiry job each run one conditional update `… SET status = $to, version = version + 1 WHERE market_id = $m AND id = $id AND status = 'open' AND version = $v` (Prisma `updateMany`, count checked): 0 rows means another of the three won, and the unit is refused or (job) skipped |

CHECKs (the database backstop for Hassan 2):
- `attribute_relaxation_requests_two_people_check`: `confirmed_by_account_id IS NULL OR
  confirmed_by_account_id <> requested_by_account_id`;
- `attribute_relaxation_requests_confirmed_check`: `(status = 'confirmed') = (confirmed_by_account_id
  IS NOT NULL)`;
- `attribute_relaxation_requests_closed_check`: `(status = 'open') = (closed_at IS NULL)`;
- `attribute_relaxation_requests_confirm_in_time_check`: `status <> 'confirmed' OR closed_at <=
  expires_at` (a late confirm cannot be stored even if the unit's `Clock` check were skipped; the
  unit's own refusal `relaxation.expired` stays the control).

Indexes:
- `attribute_relaxation_requests_market_id_status_expires_at_idx` `(market_id, status, expires_at,
  id)`: the expiry job (`status = 'open' AND expires_at < $now`, keyset by `(expires_at, id)`) and
  the PA7 list (`status = 'open' AND expires_at > $now ORDER BY expires_at, id`; with a fixed
  period, `expires_at` order is `requested_at` order, so "oldest first" needs no second index). A full
  index as D 17.1 item 9 names it, not a partial `WHERE status = 'open'`: the table is tiny (tens of
  rows a year), so the closed rows cost nothing and one index serves any future status filter.
- **Partial unique** `attribute_relaxation_requests_open_definition_key` `(market_id, definition_id)
  WHERE status = 'open'`: at most one open request per definition. A uniqueness constraint does not
  depend on the plan, so the 10.9 caveat does not apply. The request unit first closes a stale `open`
  row of the same definition past `expires_at` as `expired` (same audit and event as the job), so a
  new request never waits up to 15 minutes for the job. This replaces the earlier root pointer
  `attribute_definitions.pending_relaxation_request_id` (removed from 3.5).

Guard trigger `attribute_relaxation_requests_guard()` (`BEFORE UPDATE OR DELETE`, plus the
`TRUNCATE` trigger of 5.1; SQL in 5.1, measured):
- `DELETE` refused (`23001`);
- on `UPDATE`, `OLD.status` must be `open` (`23001` otherwise: a closed request never changes);
- every column except `status`, `confirmed_by_account_id`, `closed_at`, `cancel_reason` and
  `version` must be unchanged (`23001`; Ali B1, Hassan L1: `cancel_reason` is writable, so a cancel
  succeeds);
- `NEW.version = OLD.version + 1` (`23001`);
- when the row leaves `open`, `closed_at` must lie within ±5 minutes of `statement_timestamp()`
  (`23514`; Hassan L2). With the confirm-in-time CHECK this stops a back-dated `closed_at` from
  storing a late confirm; 5 minutes absorbs the skew between the application's `Clock` and the server.

Grants back it up with `UPDATE (status, confirmed_by_account_id, closed_at, cancel_reason, version)`
only (7).

**Definition changed (Q-K14):** the unit that revises or archives a definition, or changes a family's
membership of it, sets that definition's `open` request (found by the open partial unique) to
`cancelled` with `cancel_reason = 'definition-changed'`, by the same conditional update on `version`,
with audit `catalog.attribute-relaxation.cancelled`. It takes the definition root first, then the
request: the lock order of the confirm unit.

The confirm unit, in this order: lock the definition root (version check against
`definition_version`), update the request to `confirmed` (expected `version`), then apply the
relaxation: insert the definition's new revision with `relaxation_request_id` (`clear-material`), set
the root `archived` with `archived_by_request_id` (`archive`), or insert the family's new revision with
`relaxation_request_id` (`remove-from-family`); write the audit row with both account ids. The 3.5
triggers refuse each of those three changes without a `confirmed` request of the same definition and
kind (Hassan M2), and a request is used once (unique on each pointer). Lock order definition root → request (the request unit takes the same order), so
confirm and a second request cannot deadlock. The acting-as refusal is the use case's. Both ids are
account ids (pseudonymous, 9).

### 3.22 Seller categories and proposals (slice 23)

`seller_categories` (root): `id`; `seller_id`; `platform_parent_id` FK to `platform_categories`; `slug
text COLLATE "C"`, **unique `(market_id, seller_id, slug)`** (D 17.1); `description text` (≤ 1,000,
CA5); `status` CHECK `active`, `promoted`, `merged`, `archived`; `version`; `created_at`. Unique
`(market_id, id, seller_id)` (target of the shelf FK, 3.13). `seller_category_names`: PK
`(market_id, category_id, locale)`, `name` 1 to 120; mutable with the root (`SELECT, INSERT, UPDATE,
DELETE`).

`category_proposals` (root): `id`; `seller_id`; `names jsonb`; `platform_parent_id` FK;
`description`; `status` CHECK `pending`, `approved`, `rejected`, `cancelled`; `reason_code` (CHECK
required for `rejected`; `permission-revoked` for the CAT-51 cancellation); `decided_by_account_id`,
`decided_at` (NULL iff pending); `created_seller_category_id` FK `(market_id,
created_seller_category_id, seller_id)` → `seller_categories`, CHECK `(status = 'approved') =
(… IS NOT NULL)`; `version`; `created_at`. Partial `(market_id, seller_id) WHERE status = 'pending'`
(the CAT-54 cap count and the revocation handler) and `(market_id, created_at, id) WHERE status =
'pending'` (the admin tab). The cap value is configuration, so not a constraint; the count runs in
the proposing unit and the seller's proposals are serialised by… nothing: two concurrent proposals
can both pass a cap of 5 and make 6. Accepted (a soft cap; Q-K7).

### 3.23 `product_url_keys` (slice 22; CAT-12)

The SL-data 3.5 shape: `id`; `url_key text COLLATE "C"` (pattern of slugs, 2 to 120), **unique
`(market_id, url_key)`** (D 17.1); `product_id` FK; `state` CHECK `held`, `retired`; partial unique
`(market_id, product_id) WHERE state = 'held'`; `version`; `created_at`, `retired_at`. A retired key is
never reused. Migration 14 (slice 22; Q-K9 answered).

### 3.24 Import (slice 24; outline)

`import_jobs` (root): `id`; `seller_id`; `started_by_account_id`; `mode` CHECK `my-products`,
`sell-from-catalogue`; `error_strategy` CHECK `stop`, `skip`; `file_sha256 bytea` (32); `file_object_key`
(private, deleted with the job's retention); `state` CHECK `queued`, `running`, `finished`, `failed`;
row counters (`integer`, CHECK `>= 0`); `report_object_key`; `version`; `created_at`, `finished_at`.
**Partial unique `(market_id, seller_id) WHERE state IN ('queued', 'running')`**: one running job per
seller (brief s5). `import_job_errors` (insert-only): PK `(market_id, job_id, row_no, column_code)`,
`error_code`. No cell values are stored (the report file holds the neutralised cells). Designed in
full with slice 24.

### 3.25 AI (slices 25, 26; outline)

`ai_listing_suggestions`: `id`; `product_id`; `field_id`; `suggestion_sha256 bytea`;
`prompt_version text`; `created_at`; FK to `products`, deleted explicitly with the working copy
(10.1; D 13.1 storage). The text itself is not stored (D 13.1:
"id, field, hash, prompt version"). `ai_claim_flags` (insert-only): PK `(market_id, revision_id,
field_id)`; `quotation text` (≤ 500); `content_hash` (the revision's); `created_at`. Designed with
slice 25 after `platform/ai` part 1.

### 3.26 `outbox`, `inbox`, `rate_counters`

`outbox` and `inbox`: exactly ID-data 3.1 and 3.8 with the module name (`outbox_type_check`
`^catalog\.[a-z0-9-]+\.v[1-9][0-9]*$`; `inbox_handler_check` `^catalog\.[a-z0-9-]+$`; unique
`(market_id, aggregate_id, aggregate_version)`; claim index `(market_id, event_id) WHERE published_at
IS NULL`). Aggregate types: `product`, `offer`, `platform-category`, `attribute-definition`,
`attribute-family`, `seller-category`, `category-proposal`, `product-image`, `import-job`. Payloads ids,
codes, booleans (D 9.4). A unit writing n events for one aggregate raises its `version` by n, one version
per event in a fixed order; the unique key above is unchanged (Q-K3).

`rate_counters` (slice 4): the SL-data 3.11 shape (PK `(market_id, kind, key_hash)`, HMAC under this
module's rate-counter key, fixed window, `count >= 0`, reserve before the work, fail closed with
`access.unavailable`, hourly purge). Kinds, all in the CHECK from slice 4 (D 8.4): `draft-save.account.minute`,
`draft-save.account.day`, `claim-text-check.account.minute`, `claim-text-check.account.day` (30 and
1,000, Hassan L6; D 17.1 item 8), `submit.seller.hour`, `photo-upload.seller.day`,
`search.account.minute`, `import-start.seller.day`, `ai-suggest.seller.day`,
`reviewer-mail.market.hour`. The bulk-approve cap of 50 (D 17.1 item 11) and the facade batch
limits are request validation: **no storage**.

## 4. What is never stored

| Never | Instead |
|---|---|
| A price, special price, Cost, stock, quantity or "sellable now" | `pricing`, `inventory`; composed at read time (ADR-0024 d5). Column-name test (1) |
| A `ClaimDecision` as an authorisation; an "allowed" flag | The tag copy restricts only (ADR-0028 d3); `active` needs a fresh decision (D 5.2) |
| Badge data on a `pending-publish`, `rechecking` or `suspended` tag; a `pending-publish` tag selectable by a handler | CHECKs of 3.15 |
| The raw upload after intake; an original with metadata; the client's file name | Master only (3.19, M2) |
| A seller's access state, may-sell, allowed types, store name | Read live from `sellers` (D 9.6) |
| A per-variant SKU | One `sellerSku` per Offer (3.13) |
| Free text in `outbox`, `inbox`, `audit_log`, logs | Ids and codes (D 11.2) |
| AI suggestion text | Hash and prompt version only (3.25) |
| A "category path" copy on revisions | Category ids per revision; the path is resolved on the live tree (D 4.6) |

## 5. Invariants the database does not carry

| Invariant | Why not a constraint | Enforced by |
|---|---|---|
| State transitions of products, revisions, Offers, tags (D 4, 5.3) | Transitions | Aggregates under the root version; the variant guard is the exception (3.2) |
| An Offer is `listed` only while its product is `published` | Cross-table | Every product transition out of `published` writes the Offer cause or deletes or moves the Offer in the same unit (D 4.1, 4.4); a `test:db` case per transition |
| A SELLER product accepts only its owner's Offer (CAT-40) | Owner changes at promotion | `Offer.create` guard |
| ≥ 1 platform category, ≥ 1 clean image, completeness per locale | Cross-row, configuration | Submit guard |
| A Configurable product has ≥ 1 non-retired variant; at most `maxVariantsPerProduct` non-retired variants (D 17.1 item 12) | Cross-row; the limit is Market configuration (AU 100, ZZ 3) | Count in the save, submit and publish units under the product version (A16: index range on the existing unique, 0.06 ms). No CHECK or trigger: a database backstop would need the Market value; the product version already serialises every writer of the product's variants |
| `copy_revision_published` is true exactly when the named revision was published | Cross-table | Writer; reconciliation joins the decision table (3.15), so a wrong flag is repaired within a day |
| The required checks are the right set for the revision | Server derivation (D 8.3a) | Approve use case; the database holds `required ⊆ confirmed` |
| Tags of a category subtree marked `rechecking` in the move unit (M1) | Cross-table bulk write | Use case (A10); bounded by `catalog.maxCategoryChangeTags` (Q-K4) |
| Ids of other modules exist | Other schemas | Facades |
| No claim word in any stored text, drafts included | Matcher in `certification` | Use cases (D 6.1) |
| One proposal cap per seller | Configuration | Soft cap (3.22, Q-K7) |

### 5.1 Triggers

```sql
CREATE FUNCTION "catalog"."reject_mutation"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'catalog.%: append-only, % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END; $$;
-- Per insert-only table <t>, in the migration that creates it:
CREATE TRIGGER "<t>_no_update_delete" BEFORE UPDATE OR DELETE ON "catalog"."<t>"
  FOR EACH ROW EXECUTE FUNCTION "catalog"."reject_mutation"();
CREATE TRIGGER "<t>_no_truncate" BEFORE TRUNCATE ON "catalog"."<t>"
  FOR EACH STATEMENT EXECUTE FUNCTION "catalog"."reject_mutation"();
```

Insert-only tables: `platform_category_revisions`, `platform_category_revision_names`,
`attribute_definition_revisions`, `attribute_definition_revision_options`,
`attribute_family_revisions`, `product_revisions`, `product_revision_texts`,
`product_revision_categories`, `product_revision_variants`, `product_revision_images`,
`product_revision_decisions`, `offer_history`, `offer_tag_history`, `offer_publication_decisions`,
`product_image_renditions`,
`import_job_errors`, `ai_claim_flags`.

Other trigger functions (no grant, platform.md 10.2). **Rules for every catalog function** (Ali's
Q-K8 ruling, applied to all of them): `SECURITY INVOKER`; `SET search_path = pg_catalog, pg_temp` on
the function and every name schema-qualified; no dynamic `EXECUTE`; no `SECURITY DEFINER`. The
functions: `product_variants_guard()` (3.2), `product_revision_variants_not_retired()` (3.10),
`platform_categories_no_cycle()` (3.4), `attribute_relaxation_requests_guard()` (3.21),
`relaxation_confirmed()`, `attribute_definition_revisions_relaxation()`,
`attribute_definitions_archive_relaxation()`, `attribute_family_revisions_relaxation()` (3.5),
`offer_tags_status_seq()`, `offer_tags_history_present()` (3.15), `product_images_delete_guard()`
(3.19). Trigger functions are SQL inside the database, not application raw SQL, so they are outside
ADR-0030's list (Q-K8, ruled by Ali, closed). The bodies below were run on the throwaway cluster of
11; the migration copies them verbatim.

```sql
-- 3.4: no cycle; refuses at the depth cap instead of passing silently (Ali, Q-K8)
CREATE FUNCTION "catalog"."platform_categories_no_cycle"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur uuid := NEW.parent_id; depth integer := 0;
BEGIN
  WHILE cur IS NOT NULL LOOP
    IF cur = NEW.id THEN
      RAISE EXCEPTION 'catalog.platform_categories: cycle' USING ERRCODE = 'check_violation';
    END IF;
    depth := depth + 1;
    IF depth >= 64 THEN
      RAISE EXCEPTION 'catalog.platform_categories: depth cap 64 reached' USING ERRCODE = 'check_violation';
    END IF;
    SELECT c.parent_id INTO cur FROM "catalog"."platform_categories" c
     WHERE c.market_id = NEW.market_id AND c.id = cur;
  END LOOP;
  RETURN NEW;
END; $$;
CREATE TRIGGER "platform_categories_no_cycle" BEFORE INSERT OR UPDATE OF "parent_id"
  ON "catalog"."platform_categories" FOR EACH ROW EXECUTE FUNCTION "catalog"."platform_categories_no_cycle"();

-- 3.2: the Simple-variant rule of Q-K15 inside the guard (excerpt; the rest as 3.2)
  IF NEW.state = 'retired' AND OLD.state <> 'retired' AND NEW.variant_model = 'single' THEN
    SELECT p.status INTO p_status FROM "catalog"."products" p
     WHERE p.market_id = NEW.market_id AND p.id = NEW.product_id;
    IF p_status IS DISTINCT FROM 'discarded' THEN
      RAISE EXCEPTION 'catalog.product_variants: a single variant is retired only with a discarded product'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

-- 3.21
CREATE FUNCTION "catalog"."attribute_relaxation_requests_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'catalog.attribute_relaxation_requests: DELETE is not allowed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'catalog.attribute_relaxation_requests: a closed request never changes' USING ERRCODE = 'restrict_violation';
  END IF;
  IF (NEW.id, NEW.market_id, NEW.tenant_id, NEW.definition_id, NEW.definition_version, NEW.kind, NEW.family_id,
      NEW.requested_by_account_id, NEW.requested_at, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.id, OLD.market_id, OLD.tenant_id, OLD.definition_id, OLD.definition_version, OLD.kind, OLD.family_id,
      OLD.requested_by_account_id, OLD.requested_at, OLD.expires_at) THEN
    RAISE EXCEPTION 'catalog.attribute_relaxation_requests: immutable column changed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'catalog.attribute_relaxation_requests: version must rise by one' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.status <> 'open' AND (NEW.closed_at < statement_timestamp() - interval '5 minutes'
                            OR NEW.closed_at > statement_timestamp() + interval '5 minutes') THEN
    RAISE EXCEPTION 'catalog.attribute_relaxation_requests: closed_at outside tolerance' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;

-- 3.5 (Hassan M2): helper and the definition-revision trigger; the archive and family triggers follow
-- the same shape (family: EXCEPT of the codes of the current and the new `groups`, joined to
-- definitions by (market_id, code) and to their current revision, `WHERE material`)
CREATE FUNCTION "catalog"."relaxation_confirmed"(p_market varchar, p_request uuid, p_definition uuid, p_kind text)
  RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM "catalog"."attribute_relaxation_requests" r
    WHERE r.market_id = p_market AND r.id = p_request AND r.definition_id = p_definition
      AND r.kind = p_kind AND r.status = 'confirmed');
$$;
CREATE FUNCTION "catalog"."attribute_definition_revisions_relaxation"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE prev_material boolean;
BEGIN
  SELECT r.material INTO prev_material
    FROM "catalog"."attribute_definitions" d
    JOIN "catalog"."attribute_definition_revisions" r
      ON r.market_id = d.market_id AND r.id = d.published_revision_id
   WHERE d.market_id = NEW.market_id AND d.id = NEW.definition_id;
  IF prev_material AND NOT NEW.material THEN
    IF NEW.relaxation_request_id IS NULL OR NOT "catalog"."relaxation_confirmed"(
         NEW.market_id, NEW.relaxation_request_id, NEW.definition_id, 'clear-material') THEN
      RAISE EXCEPTION 'catalog.attribute_definition_revisions: clearing material needs a confirmed clear-material request'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.relaxation_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'catalog.attribute_definition_revisions: a relaxation request names only a material clearing'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END; $$;

-- 3.15: every status change has its history row, checked at commit
CREATE FUNCTION "catalog"."offer_tags_history_present"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
DECLARE cur record;
BEGIN
  SELECT t.status, t.status_seq INTO cur FROM "catalog"."offer_tags" t
   WHERE t.market_id = NEW.market_id AND t.id = NEW.id;
  IF cur.status_seq <> NEW.status_seq THEN RETURN NULL; END IF;  -- a later change in the unit checks itself
  IF NOT EXISTS (SELECT 1 FROM "catalog"."offer_tag_history" h
                  WHERE h.market_id = NEW.market_id AND h.tag_id = NEW.id
                    AND h.status_seq = cur.status_seq AND h.to_status = cur.status) THEN
    RAISE EXCEPTION 'catalog.offer_tags: status change without its offer_tag_history row'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER "offer_tags_history_present" AFTER INSERT OR UPDATE OF "status" ON "catalog"."offer_tags"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "catalog"."offer_tags_history_present"();

-- 3.19 (Hassan L3)
CREATE FUNCTION "catalog"."product_images_delete_guard"() RETURNS trigger LANGUAGE plpgsql
  SECURITY INVOKER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
  IF OLD.state NOT IN ('received', 'scanning', 'clean', 'refused') THEN
    RAISE EXCEPTION 'catalog.product_images: DELETE of a % image is not allowed', OLD.state
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END; $$;
```

## 6. Access paths

Volume assumption (planning ceiling, one Market; ZZ at a quarter): 2×10⁴ sellers; 5×10⁴ PLATFORM and
2×10⁵ SELLER products; 6×10⁵ variants; 7.8×10⁵ revisions (about 3 per product); 1.2×10⁶ revision
category rows; 4×10⁵ Offers, of which 50 PLATFORM products carry 1,000 Offers each; 2.5×10⁵ tags
(60% of Offers, 2% suspended, 1% rechecking); 2,000 platform categories (20 roots, 3 levels).
Measured on these numbers (11).

### 6.1 Named queries

| # | Query (D) | Shape | Index |
|---|---|---|---|
| A1 | `offerSellUnits` (≤ 200; D 9.1) | `offers` by `(market_id, id) = ANY`; then `product_variants` by `(market_id, product_id) = ANY` with `state <> 'retired'` | Unique `(market_id, id)`; unique `(market_id, product_id, id)` |
| A2 | `offerListings` (≤ 200 keys; D 9.1) | Five statements: Offers joined to products (published, `listed`); names by `(market_id, revision_id, locale)`; revision variants by `(revision_id, variant_id)`; primary image by `(revision_id, position = 1)`; tags by `offer_id = ANY` (anonymous: `status = 'active'` in the predicate) | PKs; tag partial unique |
| A3 | `offerTaxCategories` (≤ 200) | Offers → products → `product_revisions` by PK | PKs |
| A4 | `CatalogReferences` (≤ 100) | `products` by id; `product_variants` by product; `platform_categories` by id | PKs, uniques |
| A5 | Seller product list (D 9.1 read target), keyset 25 | `products WHERE market_id AND owner_seller_id = $s ORDER BY created_at DESC, id DESC`, name of the published or pending revision | Partial `(market_id, owner_seller_id, created_at, id) WHERE owner_seller_id IS NOT NULL` |
| A6 | Review queue, oldest first, page 50 (D 9.2a) | Two keyset sources merged in code: products `WHERE pending_revision_id IS NOT NULL ORDER BY pending_submitted_at, id`; Offers `WHERE status = 'pending-first-publish' ORDER BY submitted_at, id`; 50 from each, merged, cut to 50 | Partial `(market_id, pending_submitted_at, id) WHERE pending_revision_id IS NOT NULL`; partial `(market_id, submitted_at, id) WHERE status = 'pending-first-publish'` |
| A7 | Publish fan-out (D 5.4): Offers of a product, keyset 100; M1 marking of their tags | `offers WHERE market_id AND product_id = $p AND status <> 'deleted' AND id > $c ORDER BY id LIMIT 100`; one `updateMany` on `offer_tags` with `offerId in (…)` | `(market_id, product_id, id) WHERE status <> 'deleted'`; tag partial unique |
| A8 | Category tree and paths (D 4.6, 5.1) | Whole Market tree, cached in process by `category_trees.version` | Sequential read of the Market's rows; `category_trees` PK |
| A9 | Category re-ask selection: published products under a subtree (ids computed from A8) | `product_revision_categories WHERE market_id AND category_id = ANY($subtree)` joined to `products` on `published_revision_id` | `(market_id, category_id, revision_id)`; products partial unique on `published_revision_id` |
| A10 | M1 marking in the category unit; `platform-category.impact` counts (D 9.2a) | A9 → Offers → tags (`updateMany` or `count`); the unit counts first and refuses with `category.impact-too-large` above the Market's `catalog.maxCategoryChangeTags` (AU 50,000, ≈ 8 s by the measured 1.7 s per 11,242; test Market 10). Market configuration, no column or table (Q-K4) | A9, A7 |
| A11 | Certification-event selection (D 5.5) | Tags by certificate, submission, issuer, (seller, type), (type, unsettled) | 3.15 partial indexes |
| A12 | Offers tab of a product, page 50 by `first_published_at` (D 9.2a) | A7's index range, sorted in memory (at most ~10³ Offers per product today) | A7's index; a `(…, first_published_at, id)` index only when a product passes 10⁴ Offers |
| A13 | OFR-03 search, admin search, similar products (≥ 3 characters; D 9.2) | `product_revision_texts.name ILIKE $q` joined to `products` (published, scope, not retired) | **GIN trigram on `name`** (Option A of 6.2) |
| A14 | Rescan (D 6.4) | Keyset over `products` with `published_revision_id IS NOT NULL` by id, texts by PK | PKs; the published-revision partial unique |
| A15 | Reconciliation (D 5.6) | `offer_tags WHERE market_id AND status NOT IN ('removed', 'pending-publish') ORDER BY evaluated_at, id` keyset 100 | `(market_id, evaluated_at, id)` partial |
| A16 | Variant limit count (D 4.2) | `count(*) FROM product_variants WHERE market_id AND product_id = $p AND state <> 'retired'` | Unique `(market_id, product_id, id)`: a range of ≤ 100 + retired rows (0.06 ms). No new index |
| A17 | Offer history, tag history, revision list of a product | `(market_id, offer_id, occurred_at)`; unique `(market_id, product_id, revision_no)` | As listed |
| A18 | Takedown, master retention: revisions using an image | `product_revision_images (market_id, image_id)` | 3.11 |
| A19 | One Offer per (seller, product); SKU per seller; Import update key | Partial uniques of 3.13; `option_key` unique of 3.10 | As listed |
| A20 | Outbox claim; inbox | PM1, PM4 | ID-data 3.1, 3.8 |
| A22 | Prune abandoned drafts (D 4.1) | `product_working_copies WHERE market_id AND last_saved_at < $now - 180 d ORDER BY last_saved_at, product_id` keyset 100, joined to `products` by PK with `status = 'draft'` | `(market_id, last_saved_at, product_id)` (3.6). Not measured: a range scan over the oldest saves |
| A21 | Relaxation expiry job and PA7 "Waiting for you" (`attribute-relaxations.list-open`, D 8.2) | `WHERE market_id AND status = 'open' AND expires_at < $now` (job) / `> $now ORDER BY expires_at, id` (list); definition code, name and version by PK batch | `(market_id, status, expires_at, id)` (3.21). Not measured: ≤ 10² rows per Market a year |

**Not added, on purpose:** any index on `jsonb` columns (descriptions, attribute values, badge data:
nothing queries inside them); an index on `product_revisions (market_id, product_id, submitted_at)`
(revisions are read through pointers and the revision-number unique); a materialised category path
column (A8 makes it unnecessary at 2,000 categories and would turn a move into a subtree rewrite); a
`(market_id, scope, status)` index for the admin product list (served by A13 or a keyset by id until
a measured need); a per-locale index on names (A13 covers all locales).

### 6.2 Name search: trigram or not (a trade-off)

| Option | For | Against |
|---|---|---|
| **A (recommended).** `pg_trgm` in the `extensions` schema (the SL-data 9.2 pattern of `btree_gist`, platform PR, Ali and Hassan; no `USAGE` for `mondapac_app`) and `GIN (name extensions.gin_trgm_ops)` on `product_revision_texts` | Measured: a no-hit search drops from 310 ms (parallel sequential scan of 7.8×10⁵ names) to 0.09 ms; a common prefix from 50 ms to 25 ms. Prisma `contains` with `mode: 'insensitive'` emits `ILIKE`, which the index serves in a custom plan (platform.md 10.9) | A second extension under the 10.5 guard amendment; 25 MB index (10% of the heap) and slower revision inserts (one row per locale per submit: negligible). The opclass must be schema-qualified |
| B. No index until the platform catalogue grows | No extension | 310 ms worst case at the ceiling breaks the 200 ms target for a seller-facing search; fine at launch volume (≤ 10⁴ revisions: under 5 ms) |

**Decided: A** (Ali, 2026-10-07), on these conditions, following the `btree_gist` pattern (SL-data
9.2):
- the extension comes in **its own platform migration PR**, a shared file announced on the board
  before work starts (CLAUDE.md rule 13), before catalog migration 7;
- `CREATE EXTENSION pg_trgm SCHEMA extensions`; the PR does **not** create the `extensions` schema
  (it exists from the `btree_gist` migration); no `USAGE` on `extensions` for `mondapac_app`;
- its `down.sql` drops only the extension;
- Kazem confirms the managed provider supports `pg_trgm`; Hassan reviews the PR; platform.md 10.5
  guard 1 maps the extension (one more entry in the `btree_gist` amendment);
- catalog migration 7 creates `GIN (name extensions.gin_trgm_ops)`, and a `test:db` case shows the
  index **in use when the query runs as `mondapac_app`** (`EXPLAIN` of the A13 shape names the index).
  Expected because `ILIKE` is a `pg_catalog` operator and the index calls its opclass functions without
  a privilege check; not yet measured as `mondapac_app`, so the test is what proves it.

### 6.3 Raw SQL (ADR-0030; D 17.1 item 7): none

Prisma suffices for every catalog read and write; catalog adds **no** entry to the ADR-0030 list:

| Candidate (D 16.2) | Why Prisma suffices |
|---|---|
| Category subtree | The tree is loaded whole (A8: 2,000 rows, 0.6 ms) and walked in memory; no recursive CTE in the application |
| Rescan scan | Keyset over published products by id, texts by PK: plain `findMany` |
| Reconciliation cursor | Keyset on `(evaluated_at, id)` with a `cursor`/`gt` pair: plain `findMany` |
| `offerListings` consistency | Advisory (D 9.1, ADR-0025 d1): no answer is a decision, the copy only restricts, and `listed` is one row's column checked by a CHECK, so reading it in several statements can show a tag status from a later snapshot but never a permission. Unlike `evaluateClaims`, no "one statement per decision" rule applies |
| M1 marking | A Prisma `updateMany` with a nested `offerId: { in: … }` from A7 or A9 ids (writes stay in Prisma, Ali's condition) |

If spike 2 shows Prisma's relation-filter form of A9 planning worse than the measured join, the first
fallback is two Prisma statements (revision ids, then products by `publishedRevisionId in`), not raw
SQL.

## 7. Grants

Under platform.md 10.2: hand-written in the `migration.sql` that creates the table, in the block
`-- Grants (database-designer): docs/design/data/catalog.md section 7`, to `mondapac_app` only,
mirrored in `down.sql` (every `REVOKE` before any `DROP`), nothing from the "Never" row, the expected
map of the privilege test changed in the same PR. `GRANT USAGE ON SCHEMA "catalog"` in migration 1.
No sequence; no function gets a grant.

| Table | Privileges of `mondapac_app` | `DELETE` from | Reason |
|---|---|---|---|
| `outbox` | `SELECT, INSERT`, `UPDATE (published_at)` | Never | PM2 |
| `inbox` | `SELECT, INSERT` | Prune job | PM4 |
| `products` | `SELECT, INSERT`, `UPDATE (scope, owner_seller_id, status, discarded_at, own_brand, matched_into_product_id, promoted_at, retired_at, withdrawn_at, published_revision_id, pending_revision_id, pending_submitted_at, claim_text_flagged_at, photo_taken_down_at, last_changed_at, version)` | Never (Q-K2: discard is a status) | Type, family, code, creator immutable (CAT-10) |
| `product_variants` | `SELECT, INSERT`, `UPDATE (state, published_at, retired_at)` | Never (the guard refuses it for every role) | M-1 |
| `product_code_counters` | `SELECT, INSERT`, `UPDATE (next_value)` | Never | |
| `category_trees` | `SELECT, INSERT`, `UPDATE (version)` | Never | |
| `platform_categories` | `SELECT, INSERT`, `UPDATE (parent_id, status, merged_into_id, published_revision_id, version)` | Never | Slug, creator kind immutable; never deleted |
| `attribute_definitions`, `attribute_families` | `SELECT, INSERT`, `UPDATE (status, published_revision_id, version)`; definitions also `archived_by_request_id` (slice 21) | Never: "delete" means archive (Q-K6) | Code, type, localizable immutable |
| `product_working_copies` | `SELECT, INSERT, UPDATE, DELETE` | 4 (discard and prune, 10.1) | |
| `offers` | `SELECT, INSERT`, `UPDATE (product_id, seller_sku, condition_code, description, handling, attestation_recorded_at, attestation_account_id, shelf_category_id, status, off_sale_*, listed, submitted_at, first_published_at, deleted_at, version)` | Never (a discarded draft's Offer becomes `deleted`) | `seller_id` never changes (PRC 2.3) |
| `offer_tags` | `SELECT, INSERT`, `UPDATE` on every column except `id, offer_id, seller_id, type_code, created_at` | Never | |
| `tag_reevaluation_requests` | `SELECT, INSERT`, `UPDATE (state, cursor_offer_id, counts, settled_at)` | Purge (10.3) | |
| `product_images` | `SELECT, INSERT, DELETE`, `UPDATE (state, refusal_code, raw_object_key, master_object_key, master_sha256, media_type, pixel_width, pixel_height, taken_down_at, taken_down_by_account_id, takedown_reason_code, version)` | 13 (draft images of a discarded draft; master retention); the delete guard limits it to `received`, `scanning`, `clean`, `refused` | Hassan L3 |
| `claim_text_rescans` | `SELECT, INSERT, UPDATE` | Never | |
| `seller_categories`, `category_proposals` | `SELECT, INSERT, UPDATE` | Never | |
| `seller_category_names` | `SELECT, INSERT, UPDATE, DELETE` | 23 | Mutable names |
| `attribute_relaxation_requests` | `SELECT, INSERT`, `UPDATE (status, confirmed_by_account_id, closed_at, cancel_reason, version)` | Never (the guard refuses it) | One-way status (3.21) |
| `product_url_keys` | `SELECT, INSERT`, `UPDATE (state, retired_at, version)` | 22 (never-public keys, SL-data 3.5) | |
| `import_jobs` | `SELECT, INSERT, UPDATE` | 24 (retention) | |
| `ai_listing_suggestions` | `SELECT, INSERT, DELETE` | 25 | Purged with the draft |
| `rate_counters` | `SELECT, INSERT, UPDATE, DELETE` | 4 | Counters |
| Every table of the 5.1 insert-only list | `SELECT, INSERT` | Never | CA3 |

**`test:db` assertions** (CE-data 8, Hassan L-a): for each insert-only table, on the application
connection `UPDATE … WHERE false`, `DELETE … WHERE false` and `TRUNCATE` fail with `42501`; on the
owner connection `UPDATE` and `DELETE` **against a real row** inserted by the test fail with `23001`,
the row is unchanged afterwards, and `TRUNCATE` fails with `23001`; driven by the list in the
expected map. Also against real rows: the variant guard (`retired → published`, `published →
proposed`, any `DELETE`: `23001`; a v4 id: `23514`; a `single` variant retired while its product is
not `discarded`: `23514`), `products_discarded_check` and a `discarded` product with a revision
pointer (`23514`), a `DELETE` on `products` or `offers` as `mondapac_app` (`42501`), the not-retired revision trigger
(`23514`), the no-cycle trigger (`23514`), `offers_listed_check`, `offer_tags_badge_data_check`,
`product_revision_decisions_checks_check`, `offer_tags_pending_publish_check` (a `pending-publish` row
with badge data or with `copy_revision_published = true`: `23514`), the relaxation CHECKs of 3.21 (including `cancel_reason`) and its guard (`UPDATE`
of a `confirmed` row, of `requested_by_account_id` on an `open` row, `DELETE`: `23001`), a second
`open` request for one definition (`23505`), **a cancel of an `open` request that succeeds**
(`status = 'cancelled'`, `cancel_reason`, `closed_at`, `version + 1`; Ali B1, Hassan L1), a version
step other than one (`23001`), a back-dated `closed_at` (`23514`, L2), an expiry over 168 hours
(`23514`); the M2 triggers (clearing `material` with no request or with an `open` one, archiving a
material definition with none or with a cancelled one, removing a material definition from a family
with none: `23514`; the same three succeed with a `confirmed` request of the right kind; a request
used a second time: `23505`); `offer_tags_published_copy_check` (an `active` tag with
`copy_revision_published = false`: `23514`, M1); a tag status change or a new tag without its
history row (`23001` at commit) and a status change without `status_seq + 1` (`23514`); the image
CHECKs (`public` with a raw key, a master key under another product's prefix: `23514`), the image
delete guard on a `public` row (`23001`) and an `UPDATE` of `product_id` as `mondapac_app`
(`42501`); a 65th category level (`23514`); the shelf FK with another
seller's category (`23503`), and a child row in the other Market (PM6, `23503`). Column-level
`UPDATE` tables join the platform.md 10.4 column test.

## 8. Migration plan

### 8.1 Order (one PR with a migration open at a time)

| # | Slice | Migration | Contains |
|---|---|---|---|
| 1 | 1 | `catalog_products_core` | `CREATE SCHEMA "catalog"`; `reject_mutation()`; `outbox`, `inbox`; `products` (slice-1 columns); `product_variants` with guard trigger (including the Simple-variant rule), CA7 CHECK, single partial unique; `products.discarded_at` and `products_discarded_check`; `product_code_counters`; grants |
| 2 | 2 | `catalog_category_tree` | `category_trees`; `platform_categories` with the no-cycle trigger and function; revisions and names with triggers |
| 3 | 3 | `catalog_attributes` | The five tables of 3.5 (revisions' `relaxation_request_id` columns without their FKs; no `archived_by_request_id` yet) |
| 4 | 4 | `catalog_revisions` | `product_working_copies`; `product_revisions`, texts, categories, variants (with the not-retired trigger), decisions (check columns included); `rate_counters`; on `products`: `published_revision_id`, `pending_revision_id`, `pending_submitted_at`, their FKs and CHECKs (`NOT VALID` then `VALIDATE`), the published-revision partial unique, the seller-list and queue partial indexes; the `discarded`-without-revision CHECK (`NOT VALID` then `VALIDATE`); `product_working_copies_market_id_last_saved_at_idx` with `DELETE` granted |
| 5 | 7 | `catalog_offers` | `offers` (without `shelf_category_id`), `offer_history`; no `DELETE` on `products`, `product_variants`, `offers` (Q-K2) |
| 6 | 8 | `catalog_offer_tags` | `offer_tags` (copy, check constraints including `offer_tags_published_copy_check`, `status_seq` and its trigger, open-tag partial unique, autovacuum settings), `offer_tag_history` (with `status_seq` and its unique), then the deferred `offer_tags_history_present` constraint trigger |
| 7 | 9 | `catalog_name_search` | Trigram index of 6.2 (after the platform `pg_trgm` PR) |
| 8 | 10 | `catalog_review` | `offer_publication_decisions`; the Offer queue partial index |
| 9 | 11 | `catalog_fanout` | `tag_reevaluation_requests` |
| 10 | 12 | `catalog_tag_selection` | The five selection indexes and the reconciliation index of 3.15 |
| 11 | 13 | `catalog_images` | `product_images` (raw-key and master-prefix CHECKs, raw-key partial index, delete guard, column-level `UPDATE` grant), renditions, `product_revision_images`; `products.photo_taken_down_at` |
| 12 | 18 | `catalog_claim_text_rescan` | `claim_text_rescans`; `products.claim_text_flagged_at` |
| 13 | 21 | `catalog_attribute_relaxation` | `attribute_relaxation_requests` with its CHECKs, the two FK-target uniques, the status index, the open partial unique and the guard trigger; `attribute_definitions.archived_by_request_id` with its FK, unique and CHECK; the same-definition and same-family FKs from the revisions' `relaxation_request_id` and their uniques (`NOT VALID`, then `VALIDATE`); `relaxation_confirmed()` and the three M2 triggers. `down.sql`: drop the M2 triggers and functions, the FKs, uniques and the root column, then the guard trigger, its function and the table |
| 14 | 22 | `catalog_url_keys` | `product_url_keys` (Q-K9) |
| 15 | 23 | `catalog_seller_categories` | The tables of 3.22; `offers.shelf_category_id` and its FK (`NOT VALID`, `VALIDATE`) |
| 16 | 24 | `catalog_import` | 3.24 |
| 17 | 25, 26 | `catalog_ai_listing`, `catalog_ai_claim_flags` | 3.25 |

This matches D 15.1's list (1, 2, 3, 4, 7, 8, 10, 11, 12, 13, 18, 21, 23, 24, 25, 26) plus 9
(trigram, only with option A) and 22 (url keys). No migration: P1, 5, 6, 14, 15, 16, 17, 19, 20 —
every column those slices write exists earlier (match and promotion columns, all five off-sale
causes and the decision's check columns are created with their tables).

### 8.2 Safety on live tables

As SL-data 9.3 and CE-data 9.2: every migration starts with `SET lock_timeout = '5s'`. New nullable
columns are catalog-only changes. A CHECK or FK added to an existing table is `ADD … NOT VALID`
followed by `VALIDATE CONSTRAINT` in the same file (migrations 4, 13, 15). An index on a table that
holds rows in a deployed environment is `CREATE INDEX CONCURRENTLY`, alone in its file, hand-written
(SL-data spike S3) — this applies at least to migrations 7 and 10 (`offer_tags` and
`product_revision_texts` are the largest tables) and to every index of migration 4 on `products` if
an environment holds products by then. Adding an off-sale cause later: `ADD COLUMN … boolean` (nullable),
backfill `false` in batches by a worker job, then `SET NOT NULL` through the CHECK route of SL-data
9.3, then swap `offers_listed_check` (`DROP` and `ADD … NOT VALID`, `VALIDATE`) in one file.
Backfills never run inside a migration.

### 8.3 `down.sql` and reversibility

- Reverse order: `REVOKE` first; triggers before their tables; FKs added to existing tables and the
  pointer FKs before the tables they point at (down of 4 drops `products_published_revision_id_fkey`
  and `products_pending_revision_id_fkey` and the three columns before `product_revisions`; down of 15
  drops `offers_shelf_category_id_fkey` and the column before `seller_categories`; down of 13 the
  M2 triggers, the revision FKs and `archived_by_request_id` before the request table); children before parents; trigger functions after
  every table that uses them (`reject_mutation()` in down of 1). No `IF EXISTS`. Down of 1 leaves the
  empty schema and revokes its `USAGE`.
- The insert-only triggers do not fire on `DROP TABLE`, so `pnpm db:check-reversible` works; test
  setup never truncates insert-only tables (platform.md 8 item 8).
- A down drops data: development and CI only.
- My sign-off per migration: platform.md 8, the five points of 10.2, the hand-written block equal to
  this document, and the partial-index list of 8.4.

### 8.4 Prisma specifics

- Prisma expresses tables, types, keys, plain indexes and the composite FKs, including the pointer
  FKs whose fields overlap other keys (SL-data spike S2).
- Hand-written: every CHECK; `COLLATE "C"`; the triggers and functions; the grants (the current-revision
  pointers are nullable plain FKs, so no deferred constraint is needed, Q-K10);
  the autovacuum settings; the trigram index; and the partial indexes, invisible to Prisma, listed for
  the catalog test: `products_market_id_published_revision_id_key`,
  `products_market_id_owner_seller_id_created_at_idx`, `products_market_id_pending_submitted_at_idx`,
  `product_variants_market_id_product_id_single_key`, `offers_market_id_seller_id_product_id_open_key`,
  `offers_market_id_seller_id_seller_sku_open_key`, `offers_market_id_product_id_open_idx`,
  `offers_market_id_submitted_at_pending_idx`, `offer_tags_market_id_offer_id_type_code_open_key`, the
  five selection indexes and `offer_tags_market_id_evaluated_at_idx`,
  `tag_reevaluation_requests_market_id_product_id_pending_key`,
  `tag_reevaluation_requests_market_id_created_at_pending_idx`,
  `product_images_market_id_created_at_raw_idx`, `attribute_relaxation_requests_open_definition_key`,
  `category_proposals_market_id_seller_id_pending_idx`,
  `category_proposals_market_id_created_at_pending_idx`, `import_jobs_market_id_seller_id_running_key`,
  `product_url_keys_market_id_product_id_held_key`, `outbox_market_id_event_id_unpublished_idx`.
- Every partial-index predicate is a literal in the SQL Prisma sends as a parameter; the plans hold
  under unnamed statements (platform.md 10.9). This design relies on that section.

## 9. Personal data and erasure

| Data | Where | Form |
|---|---|---|
| Account ids (authors, reviewers, attestation, removers, requesters, confirmers, acting admin) | Revisions, decisions, histories, tags, relaxation rows | Clear uuid: pseudonymous identifiers. They resolve to a person only through `identity`; after `identity`'s erasure they resolve to nothing |
| Seller ids | Products, Offers, tags, categories, proposals, Import | Clear uuid; a seller is a business, the id is not personal by itself |
| Product, Offer, category text; reviewer reason text | Revisions, Offers, decisions | Clear business content (D 11.1, Hassan 19.2 item 11). A sole trader may write a name into public text: it is public by the seller's choice |
| Photos | Object storage | Master without metadata; raw upload deleted at intake end (M2): no location data is kept |
| Import file | Object storage | Private; deleted after the job's retention (24) |

No column is encrypted and catalog uses no `SubjectKeyService` key. **Erasure** (`identity`'s
CUS-03, later): catalog holds no field that key destruction must reach; account ids stay as opaque
ids, which is what the audit log does too. A closed or erased seller's products and Offers follow D 4.6a;
no data change now. When the seller-erasure design lands (CUS-03, D S-1), the consuming handler uses
existing columns and statuses only (Q-K11).

## 10. Retention, purge and jobs

### 10.1 Draft product delete

`own-product.delete` of a never-submitted product and the job `catalog.prune-abandoned-drafts`
(180 days without a working-copy save; D 4.1, Q-K2) run one unit per product, locks in the order
product → Offer → variants:
1. `products`: `status = 'discarded'`, `discarded_at`, `version` (expected version; the CHECK of 3.1
   refuses a product with a published or pending revision);
2. the draft Offer: `status = 'deleted'`, an `offer_history` row, `catalog.offer-deleted.v1`; each
   of its non-removed tags becomes `removed` (`removed_by_kind = 'system'`) with an
   `offer_tag_history` row, `entry_path = 'offer-delete'` (Hassan L5; normally none exist, since
   tags are first written at submit);
3. each non-retired variant: `retired` with `catalog.variant-removed.v1` (Q-K15 for a `single` one);
4. `DELETE` the working copy, the draft `product_images` rows (objects deleted after commit) and the
   AI suggestions.
Each event raises its aggregate's version by one (Q-K3). No audit row (D 4.1). No insert-only row is
changed; history rows stay. Lock order product → Offer → tags → variants.

### 10.2 Master retention (D 10.5, D 17.1 item 1)

`catalog.purge-unreferenced-masters`, daily per Market: images of products whose `last_changed_at`
is older than 30 days, in state `clean` or `refused`, with no `product_revision_images` row (A18) and
not named by the working copy (read in code). One image per unit: clear the keys, delete the row
(grant; the delete guard allows `clean` and `refused` only), delete the objects after commit.

Raw uploads (Hassan M3): intake ends with the key kept; after commit the object is deleted and a
second unit clears `raw_object_key` once storage confirms (success or not-found). The sweep, every
15 minutes per Market over `product_images_market_id_created_at_raw_idx`, takes rows with a raw key
older than 1 hour: still `received` / `scanning` → delete the raw object, then mark `refused`
(`file.intake-timeout`) and clear the key; already `clean` / `refused` → retry the delete, clear the
key on confirmation, and count failures (a metric; an alert after 24 h). The intake prefix also has a
storage lifecycle rule expiring objects within 24 h, required in ADR-0029 (O7): the backstop if the
delete and the sweep both fail.

### 10.3 Other retention

| Rows | Rule |
|---|---|
| `rate_counters` | Hourly: windows older than 48 h |
| `tag_reevaluation_requests` | Settled or superseded after 30 days |
| `inbox` | Platform prune job |
| Revisions, decisions, histories | Kept (ADR-0009 d7: published revisions kept; VER-06 references them) |
| Abandoned drafts | `catalog.prune-abandoned-drafts`, 180 days (10.1, 10.4) |

### 10.4 Jobs

| Job | Every | Lock key (PM8) | Work |
|---|---|---|---|
| `catalog.reevaluate-tags` | 1 min | `6604185390120384521` | A7, requests of 3.18 |
| `catalog.reconcile-tags` | Daily 03:00 Market zone | `2217309458861320097` | A15 |
| `catalog.rescan-claim-text` | On event, resumable | `7391146002835117703` | A14 |
| `catalog.purge-unreferenced-masters` | Daily | `4870913325561946201` | 10.2 |
| `catalog.sweep-raw-uploads` | 15 min, per hosted Market | `2649158803317752041` | 10.2: stuck intake and unconfirmed raw deletes |
| `catalog.purge-expired` | Hourly | `1158342076693420958` | 10.3 |
| `catalog.prune-abandoned-drafts` | Daily, per hosted Market | `8836021957413306627` | A22, 10.1: one product per unit, keyset by `(last_saved_at, product_id)` |
| `catalog.expire-relaxation-requests` | 15 min, per hosted Market | `5307714682290153049` | A21: each `open` row past `expires_at` → `expired` in its own unit (expected `version`), audit and `catalog.material-request-expired.v1` |

None equals Prisma Migrate's `72707369` or a key of identity, sellers or certification (a test
compares the registered keys).

## 11. Evidence

Measured on 2026-10-07 on PostgreSQL 16.15 in a throwaway cluster (C.UTF-8, 512 MB shared buffers),
with the core tables of this design (products, variants with the guard, revisions, texts, categories,
revision variants, platform categories with the cycle trigger, Offers with the cause CHECK, tags with
the copy CHECKs and partial indexes), seeded at the ceiling of 6 (AU 4×10⁵ Offers, 2.5×10⁵ tags,
7.8×10⁵ revisions, 1.2×10⁶ revision categories; ZZ a quarter, plus the 50 large PLATFORM products).
The cluster was deleted afterwards. Plans are custom (literal values), first run in the session.

| Read or write | Plan | Execution |
|---|---|---|
| A1 Offers by 200 ids | Index scan on `(market_id, id)` | 1.7 ms |
| A1 variants of those products | Bitmap scan on `(market_id, product_id, id)` | 1.2 ms |
| A2 Offers ⋈ products, 200 | Nested loop, PK probes | 4.6 ms |
| A2 names (195 revisions) | PK range | 4.0 ms (406 blocks read cold) |
| A2 revision variants | PK range with a filter | 1.0 ms |
| A2 tags of 200 Offers | Open-tag partial unique | 2.5 ms |
| **`offerListings` total** (five statements, cold) | — | **≈ 14 ms + planning ≈ 3 ms**: inside the 200 ms target |
| A5 seller list page | Backward scan of the seller partial index, name PK probes | 0.6 ms |
| A6 review queue page | Queue partial index, name probes | 1.1 ms |
| A7 fan-out page of 100 (1,000-Offer product) | Partial index range | 0.6 ms |
| A7 M1 marking, 592 tags of that product, one statement | Nested loop on the indexes | 77 ms |
| A8 whole tree (2,000 rows) | Sequential | 0.6 ms |
| A9 published products under a root (100 categories, 12,500 products) | Hash join, parallel scan of `products` | 109 ms |
| **A10 M1 marking for a root move: 11,242 tags** | A9 → Offers → tags | **1.7 s** (cold; 0.1 ms per tag) |
| A10 for a leaf move: 120 tags | Index nested loops throughout | 17 ms |
| A13 name search, sequential, no hit / common term | Parallel sequential scan | 310 ms / 43–50 ms |
| A13 with trigram GIN (25 MB, built in 4.5 s) | Bitmap index scan | 0.09 ms / 25 ms |
| A15 reconciliation page | Partial index | 0.7 ms |
| A11 tags of one certificate (154) | Partial index | 0.09 ms |
| A11 unsettled tags of a type, page 100 | Partial index | 0.7 ms |
| A16 variant count | Unique range | 0.06 ms |

Constraint behaviour, each observed (first run): the variant guard refused `retired → published`, `published →
proposed` and `DELETE` of a published row; the single-variant CHECK (since replaced by the guard rule,
re-measured below) refused retiring a Simple product's variant and the partial unique refused a second variant; the revision trigger refused
`UPDATE`, `DELETE` and the owner's `TRUNCATE` (`23001`); a retired variant in a new revision was
refused; a second open Offer for (seller, product) was refused; `listed = true` with a cause set was
refused; an Offer whose product is in another Market was refused (PM6); a shelf of another seller was
refused; badge data on a suspended tag was refused; a cycle in the category tree was refused.

**Re-run after the sign-off conditions** (2026-10-07, PostgreSQL 16.15, a second throwaway cluster,
deleted afterwards), with the variant guard carrying the Simple-variant rule in place of the old
single-variant CHECK (Ali's suggestion), the hardened cycle trigger, the 3.21 guard, the M2 triggers,
the image CHECKs and delete guard, and the tag history check; 10⁵ products (20% Simple), 5.8×10⁵
variants, 11,242 tags:

| Write | Execution |
|---|---|
| Publish 7 variants of one product (guard fires 7 times; first call in the session, incl. PL/pgSQL compile) | 1.1 ms (trigger 0.54 ms) |
| Retire 3 variants of one product | 0.74 ms (trigger 0.07 ms) |
| Discard unit, Simple variant retired (the guard reads the product row) | 0.38 ms (trigger 0.29 ms) |
| Bulk update of 1.16×10⁵ variants, guard on / off (not a request path; noisy) | 2.6–4.0 s / 2.3 s: ≈ 15 µs a row |
| M1 marking of 11,242 tags with their history rows, history check on / off | update 0.21–0.26 s, history insert 0.21–0.27 s; commit 0.23–0.25 s / 0.01 s |

Constraint behaviour of the re-run, each observed: a Simple variant retired while its product is
`draft` was refused, and allowed after the product was `discarded` in the same unit; any variant
`DELETE` was refused, for the owner too; a `discarded` product with a pending pointer was refused; a
65th category level and a cycle were refused; clearing `material` with no request or with an `open`
one was refused, and allowed with a `confirmed` one in the confirm unit; reusing that request was
refused (`23505`); the same admin confirming, a back-dated `closed_at`, a version step of 4 and any
change to a closed request were refused; **a cancel of an `open` request succeeded** (B1); archiving a
material definition with no request or a cancelled one was refused, and allowed with a `confirmed`
`archive` request; removing a non-material attribute from a family needed nothing, removing a
material one was refused without a request and allowed with a `confirmed` `remove-from-family`
request; a second open request and an expiry over 168 hours were refused; an `active` tag with
`copy_revision_published = false`, a tag insert or status change without its history row (at commit)
and a status change without `status_seq + 1` were refused; a master key under another product's
prefix, `public` with a raw key, a `public` image `DELETE` and an `UPDATE` of `product_id` as
`mondapac_app` were refused; `TRUNCATE` of the request table by the owner was refused.

Not measured: anything through Prisma; PostgreSQL 17; concurrent load (the M1 marking's row locks
against seller edits); the A6 merge with real queue sizes; the trigram index's insert cost under
load.

## 12. D 17.1 hand-offs: where each is applied

| Item | Applied in |
|---|---|
| Base list (tables per root, outbox, inbox, requests, rescan, counters, partial uniques, insert-only grants and triggers, selection indexes, ordered scan, text scan, versions, PM6, plain ids) | 1, 2, 3, 6.1, 7 |
| 1 Images: raw upload deleted at intake end, master, per-product rendition keys, `public → clean`, 30-day master retention; no originals kept | 3.19, 10.2 |
| 2 Variants: `variant-removed` in the save unit; retired never returns; server-minted ids | 3.2 (guard, CA7), 3.10 (trigger), Q-K3 |
| 3 Tags: copy keeps the revision id, indexed for exclusion; bounded, indexed M1 marking | 3.15 (`copy_revision_id`, `copy_revision_published`, partial predicates), A7, A10, 11, Q-K4 |
| 4 Seeds record "created by seed" only; no seed update path | `created_by_kind` in 3.4, 3.5; grants 7; seed test 3.4 |
| 5, 9 Two-person relaxation: requester, confirmer (different), definition id and version, kind and family id, status `open` → `confirmed` / `cancelled` / `expired`, expiry, index `(market, status, expires_at)` for the 15-minute job and the list | 3.21 (guard trigger, CHECKs, open partial unique, `cancel_reason` (Q-K14)), A21, 10.4 |
| 6 Read targets for `offerListings`, seller list, review queue | A2, A5, A6; 11 |
| 7 Raw SQL on the ADR-0030 list | 6.3: none needed |
| 8 Counters for `claim-text.check` per minute and 24 h | 3.26 |
| 10 One `sellerSku` per Offer; Import key SKU + option values; no variant SKU | 3.13, 3.10 `option_key` |
| 11 Bulk approve cap 50: no storage | 3.26 |
| 12 `maxVariantsPerProduct`: index or check | 5 and A16: no CHECK or trigger (Market value; product version serialises); no new index |
| 12a `pending-publish` tag status (no badge data; skipped by handlers and reconciliation); relaxation `version` for conditional confirm, cancel and expiry | 3.15 (status list, `offer_tags_pending_publish_check`, reconciliation predicate), A15; 3.21 `version` |
| D 8.3a named checks on the decision | 3.12, 3.17 (`required ⊆ confirmed` CHECK) |
| D 5.4 tax-override suspension in the override unit | 3.7 `revision_kind = 'tax-override'`, 3.12 `admin-authored`, 3.16 entry path `tax-category-override`; `unavailable` → `rechecking` is a status write of 3.15 in the same unit |
| D 9.2a panel reads | A6 (queue rows with kind), A10 (impact counts), A12 (Offers tab), `sensitive_reasons` codes in 3.7 |

## 13. Questions to Mohammad (closed)

Answered in D 19.4 and D 17.1 item 12b (2026-10-07); Q-K8 ruled by Ali at the data-design sign-off. Q-K15 confirmed by Mohammad in D 2.1 (2026-10-07).

| # | Point | Answer | Applied in |
|---|---|---|---|
| Q-K1 | Rows for queried content, `jsonb` for attribute values, descriptions, labels, working copy | **Closed.** Accepted, on two conditions: revision content stays immutable (CA3 triggers), and the 6.4 rescan reaches every checked text (A14 reads texts by PK; descriptions and labels in `jsonb` are read whole) | 2 CA6, 3.7 to 3.10, A14 |
| Q-K2 | Draft delete with events already sent; no prune period | **Closed.** No physical delete of products, Offers or variants: product `discarded`, Offer `deleted`, variants retired, with events; working copy and draft images deleted; 180-day prune job | 3.1, 3.2, 3.6, 7, 10.1, 10.4 (`catalog.prune-abandoned-drafts`), A22 |
| Q-K3 | Several events per aggregate in one unit vs one event per version | **Closed.** `version += n`, one version per event in a fixed order; outbox unique unchanged | 3.2, 3.26 |
| Q-K4 | Bound on M1 marking for a root move | **Closed.** One unit, refused with `category.impact-too-large` above `catalog.maxCategoryChangeTags` (AU 50,000; test Market 10). Market configuration, no storage | A10, 5 |
| Q-K5 | Suspended-tag re-ask from the by-type index | **Closed.** Accepted; partial index only if suspended plus rechecking pass 5% | 3.15 |
| Q-K6 | Delete or archive a definition | **Closed.** Archive only; no `DELETE` grant | 3.21 `kind`, 7 |
| Q-K7 | CAT-54 pending cap under concurrency | **Closed.** Soft cap accepted | 3.22 |
| Q-K8 | SQL in the cycle trigger vs ADR-0030 | **Closed (Ali).** Outside ADR-0030, on conditions: `SECURITY INVOKER`, no dynamic `EXECUTE`, fixed `search_path` and schema-qualified names, refusal at the depth cap. Applied to every catalog function | 3.4, 5.1 |
| Q-K9 | Slice 22 migration | **Closed.** Added to D 15.1 | 8.1 #14 |
| Q-K10 | Deferred FK or nullable pointer | **Closed.** Nullable pointer, NULL only inside the creating unit; no deferred FK | 3.4, 3.5, 8.4 |
| Q-K11 | Seller closure and erasure | **Closed.** No data change now (D 4.6a); erasure waits for CUS-03 (D S-1) | 9 |
| Q-K12 | Superseded but once-published copies | **Closed.** Selectable, via `copy_revision_published` as proposed | 3.15 |
| Q-K13 | Image completeness before slice 13 | **Closed.** The rule switches on when slice 13 merges | 8.1 #11 |
| Q-K14 | Open request after a definition change | **Closed.** The revise, archive or family-membership unit cancels it with reason `definition-changed`, audited | 3.21 (`cancel_reason`) |
| Q-K15 (closed: confirmed in D 2.1, Mohammad, 2026-10-07) | D 2.1 says a Simple product's variant is never retired; D 4.1 (Q-K2) retires every non-retired variant of a discarded draft | Proposal applied: the guard trigger allows `single` → `retired` only when the product is `discarded`, so consumers that saw `variant-added` get `variant-removed`. Alternative: leave the Simple variant `proposed` on discard and send no event. Please confirm in D 2.1 | 3.2 |

## 14. Open

| # | Point | Who |
|---|---|---|
| O1 | `pg_trgm` platform PR (approved by Ali, conditions in 6.2) | Kazem (provider support), Hassan (review); the PR author announces the shared file on the board |
| O2 | Spike 2 re-runs A2, A7, A10 through Prisma with concurrent seller edits (lock waits under M1) | Hossein, with me |
| O3 | Rendition size codes and object key format with ADR-0029 | Ali, Kazem |
| O4 | The rate-counter key (HKDF split as SL-data 4.4) | Kazem, Hassan |
| O6 | Closed: Q-K15 confirmed in D 2.1 (Mohammad, 2026-10-07) | — |
| O7 | Storage lifecycle rule expiring the intake prefix within 24 h, required by ADR-0029 (Proposed 2026-10-07, decision 3): the backstop if both the delete and the sweep of 10.2 fail (Hassan M3) | Ali (ADR-0029), Kazem |

## 15. Follow-up changes

| File | Change | When |
|---|---|---|
| `prisma/schema/base.prisma`, `catalog.prisma`; migrations of 8.1 with `down.sql` | As specified | Per slice; Hossein; my sign-off |
| Privilege map and catalog tests of `pnpm test:db` | Section 7 lists, the insert-only list of 5.1, the trigger cases, the partial indexes of 8.4, `catalog.outbox` in the outbox test, the "no money or stock column" name test (1) | With each migration |
| `docs/design/data/platform.md` 10.5 guard 1 | `pg_trgm` in the extension map (with O1) | Platform PR before migration 7 |
| `docs/adr/0029-*` (Proposed 2026-10-07) | Storage lifecycle rule: the intake prefix expires within 24 h (Hassan M3, O7) | With ADR-0029 |
| `docs/design/domain/catalog.md` | Done: Q-K15 confirmed in D 2.1 (Mohammad); Q-K8 ruled (Ali) | Before slice 1 |
