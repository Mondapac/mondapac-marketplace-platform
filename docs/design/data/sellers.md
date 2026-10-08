# Physical data model — `sellers` schema (G2)

**Author:** Mojtaba (database-designer) — 2026-10-07
**Status:** G2 review changes applied (2026-10-07; section 16 records each item). Reviewed by Ali
and Hassan (accept with changes); Mohammad answered section 13 in D 14.3. Nothing here exists yet;
this document is the specification the `sellers` migrations are written from, and each migration
still needs my sign-off. Open points: sections 13 and 14.
**Implemented:** slice 1 (2026-10-08) created `sellers.outbox`, `inbox`, `seller_files`, `seller_admin_settings`, `seller_tax_profiles` and `store_profiles` in migration `20261008074339_sellers_files`. Slice 2b (2026-10-08) added the slice-2 columns of `seller_files` (with `timezone_source` and `address_timezone` of the spike 3 record), `shop_slugs` and `rate_counters` in migration `20261008130000_sellers_file_details` (section 18). Slice 4a (2026-10-08) added `register_checks` in migration `20261008180000_sellers_register_checks` (section 21).
**Ground truth:** `docs/design/domain/sellers.md` (revised at G2, 2026-10-07, cited as **D**, for
example "D 7.3"); `docs/modules/sellers/brief.md` (G1 approved 2026-10-03; sections 5, 6, 7 and 11
read directly at G2, cited as "brief s5"; O9 closed, 14); the G2 review items
(`g2-reviews.md` of 2026-10-07: Ali's changes, Hassan's H1, M1 to M7, L1 to L11, Jafar's items);
`docs/design/data/identity.md` (**ID-data**; its conventions
C1 to C11 are reused here by number); `docs/design/data/platform.md` (**platform.md**; section 10
for roles and grants); `docs/design/domain/platform-persistence-and-events.md` (**P**; PM1 to PM8,
the `market_id` guard of P 4, the scheduler of P 7, the version rule of P 10);
`docs/design/domain/platform-foundations.md` (**PF**; section 4, `SubjectKeyService`); ADR-0003,
ADR-0004 (decisions 3 to 7), ADR-0005 (decisions 1 to 3), ADR-0006, ADR-0007, ADR-0009 (decisions
2, 6, 7), ADR-0018, ADR-0020 (decisions 1 and 6), ADR-0022, ADR-0023.
**Prisma models:** `prisma/schema/sellers.prisma` (new). One platform migration (the `btree_gist`
extension, 9.2) has no model.

## 1. Scope and table list

The physical design of everything D asks the database to hold for slices P2 and 1 to 19 (D 11.1), with
constraints, access paths, encryption columns, grants, the migration plan per slice, and the purge
of slice 18. It does not change the domain model. Where a mapping needed a choice D did not make,
the choice is mine (D 13.1) and is listed in 13 for Mohammad to confirm.

ADR-0009 patterns used: **V1** for the business file revisions and the store profile revisions;
**V2** for the tax registration periods; **V4** for the contact-detail history and the platform
audit log. **V3** is not used (no snapshot of another module's record).

| Table | Holds (D 2.1) | ADR-0009 pattern | Created in |
|---|---|---|---|
| `sellers.outbox` | Events of the module (PM1) | None: a queue | Slice 1 |
| `sellers.inbox` | Handled deliveries (PM4) | None | Slice 1 |
| `sellers.seller_files` | `SellerFile` root: origin, working draft, live contact, approved pointer, decision intent | V1 owner record (the pointer) | Slice 1; columns added in 2, 3, 5, 7a-decide |
| `sellers.seller_admin_settings` | `SellerAdminSettings` | None: changes audited (V4 in `platform.audit_log`) | Slice 1 |
| `sellers.seller_tax_profiles` | `SellerTaxProfile` root | None | Slice 1 |
| `sellers.store_profiles` | `StoreProfile` root and its published pointer | V1 owner record | Slice 1; pointer FK in 12 |
| `sellers.shop_slugs` | `ShopSlug` | None: held or retired | Slice 2 |
| `sellers.tax_registration_periods` | `TaxRegistrationPeriod` | V2 | Slice 3 |
| `sellers.register_checks` | `RegisterCheck`, one per file and identifier value | None: current result per value | Slice 4a |
| `sellers.rate_counters` | Lookup quotas and rate limits (D 6.5, 7.7): per account, admin, origin, seller file and Market | None: transient counters | Slice 2 |
| `sellers.business_file_revisions` | `BusinessFileRevision` | V1 revision | Slice 5 |
| `sellers.review_checks` | `ReviewCheck` | None: child of a revision | Slice 7a-read |
| `sellers.identifier_claims` | `IdentifierClaim` | None | Slice 7a-decide |
| `sellers.contact_detail_history` | V4 history of phone and contact email (D 2.3) | V4 append-only | Slice 10 |
| `sellers.admin_flags` | Flags for an admin: identifier-claim conflict (Hassan M3), register re-check (AC 35) (D 14.4 Q-M20) | None: open or cleared; clearing audited | Slice 7a-decide; code added in 11 |
| `sellers.store_profile_revisions` | `StoreProfileRevision` | V1 revision | Slice 12 |
| `sellers.seller_allowed_product_types` | The type-code set of `SellerAdminSettings` | None | Slice 14 |

Every table carries `market_id` and `tenant_id`, so the guard of P 4 needs no exemption line. No
table holds money: `sellers` has no amount in Phase 3, so ADR-0007's `bigint` plus `char(3)` rule
has nothing to apply to here. If a later slice adds an amount (a SEL-15 fee setting, for example),
it follows ADR-0007 decision 1 and arrives with its own data design change.

```
                          identity (other schema; ids only, no FK)
                                   | seller_id (minted by identity)
                                   v
 shop_slugs --(seller_id, plain)-> seller_files <-(market_id, seller_id)-- seller_admin_settings
                                   |  ^   |                                   |
           identifier_claims ------+  |   +-- register_checks            seller_allowed_product_types
           contact_detail_history -+  |   |
                                      |   +-- business_file_revisions --- review_checks
            approved_revision_id -----+       (pointer target: market_id, seller_id, id)
            decision_revision_id -----+
 seller_tax_profiles -- tax_registration_periods (EXCLUDE no overlap)
 store_profiles -- store_profile_revisions  (published_revision_id pointer)
 rate_counters (no FK; keyed hashes only)
 outbox, inbox (no FK)
```

## 2. Conventions

ID-data C1 to C11 apply unchanged: `market_id varchar(8)` and `tenant_id text` with their CHECKs
(C1); UUIDv7 ids, `timestamptz(6)` from `Clock`, no defaults, kinds and states as `text` plus CHECK
(C2); composite foreign keys `(market_id, <parent>_id)` → `(market_id, id)` with `ON UPDATE
RESTRICT` (C3); FKs stay inside the schema, and "who did it" columns are plain ids (C4); keyed
hashes are `bytea` with `octet_length = 32` (C6); indexes lead with `market_id` (C7); delete rules
(C8); no raw SQL (C10). The sellers-specific readings:

| # | Convention |
|---|---|
| S1 | **Version (C5, P 10).** Every aggregate root of D 2.1 has `version integer NOT NULL` with CHECK `>= 1`; the insert writes 1. D 2.1 says every root carries a version, so `shop_slugs` and `identifier_claims` have one too, although they change by single statements. A child row change goes through its root and raises the root's version |
| S2 | **Model names start with `Sellers`** (C9): `SellersSellerFile`, `SellersOutbox`, … mapped with `@@map`. Database names stay stable if model names change |
| S3 | **Primary keys of the four roots that share the seller id** (`seller_files`, `seller_admin_settings`, `seller_tax_profiles`, `store_profiles`): `seller_id uuid` as the primary key, plus unique `(market_id, seller_id)` as the C3 target and the batch-read key. Same shape as `identity.seller_access` |
| S4 | **Encrypted columns.** `<field>_ciphertext text`, written only by `SubjectKeyService.encrypt` under the **seller's** subject key (D 8.1) with the field label `sellers.<record>.<field>` (PF 4 row 3). Ciphertext is randomised and bound to Market, subject and label (PF 4 row 2), so it is never indexed, compared, sorted or unique. CHECK `char_length BETWEEN 1 AND <bound>` (from slice 2b: the envelope shape and `BETWEEN 41 AND <bound>`, 4.5); the bounds in section 3 are backstops sized from the plaintext limits of 13 (Q-M11) and the envelope format, which is still open (ID-data 11.4, K1). A NULL means "not entered", never "erased": after key destruction the ciphertext stays and decrypts to `subject-key.destroyed` (PF 4 row 6) |
| S5 | **Keyed identifier index.** `identifier_index bytea` (C6) = `IdentifierIndex.of(market, scheme, normalised)`, HMAC-SHA-256 under a stack secret (D 8.2). It is the only column that can back uniqueness and exact search on the identifier across sellers. It is **pseudonymous personal data**: whoever holds the secret can test a guessed identifier against it, and destroying the seller's key does not make it unlinkable. Erasure therefore deletes or clears every copy (10.4) |
| S6 | **Search keys in `COLLATE "C"`.** `store_name_key` and `shop_slugs.slug` are queried by prefix as a range, `key >= $p AND key < $p || U+10FFFF`, which Prisma expresses as `gte`/`lt` and which a btree serves in a generic plan (measured, 12). `LIKE $1` (Prisma `startsWith`) cannot use the index in a generic plan: measured 73 ms and 60,000 buffers against 0.1 ms and 29 buffers on 100,000 rows. `C` makes the range exact for any key: the database collation of the Compose image is glibc `en_US.utf8`, which ignores punctuation at the first level, so a range in it is not guaranteed to equal the prefix set |
| S7 | **Clear free text.** The only clear free-text column is the store name (public once approved, D 8.1). It gets the CHECK class of `identity.accounts.display_name` (no outer spaces, no C0/C1 control or bidi formatting character; ID-data 3.3, HF13) |
| S8 | **Codes from Market configuration** (review check codes, reject reason codes, ServiceArea codes, the identifier scheme, product type codes) are `text` with a pattern CHECK, never a closed list: a Market adds codes by configuration, not by migration (ADR-0003 decision 2). Codes the design itself fixes (states, kinds, `manual-register-check`, mismatch flags, rate-counter kinds) are closed lists |
| S9 | **Isolation.** READ COMMITTED everywhere. Every cross-row rule is a unique or exclusion constraint (slug, identifier claim, one pending revision, one approved revision, non-overlapping tax periods), so no writer needs `serializable` |
| S10 | **Delete rules.** `ON DELETE CASCADE` only for `review_checks` (from a revision) and `seller_allowed_product_types` (from settings). Everything else is `RESTRICT`: rows leave only through the purge or a use case, in the order of 10.2 |

## 3. Tables

Columns of C1 are omitted. **Personal** marks personal data (ADR-0018 decision 6). "Enc" = an
encrypted column under S4.

### 3.1 `sellers.seller_files` (slice 1; columns added in 2, 3, 5, 7a-decide)

| Column | Type | Null | Slice | Notes |
|---|---|---|---|---|
| `seller_id` | `uuid` | no | 1 | PK (S3). Minted by `identity` (ADR-0022 decision 1); also the subject id of the seller's key (D 8.1) |
| `origin` | `text` | no | 1 | CHECK `self`, `invitation` (from `identity.seller-registered.v1`, or from R-6 for a file the backfill creates; D 14.3 Q-M4) |
| `approval_required_at_registration` | `boolean` | no | 1 | The Market policy at creation (D 7.5, AC 19); for a backfilled file, the Market's value at backfill time (D 14.3 Q-M4). The automatic approval also reads the current policy, and the stricter wins (D 7.3, Hassan M1); the current policy is the ADR-0026 setting in the platform store, read in the deciding unit, not a column (D 14.1; mini-review D 19). A missing row gives `true`. A read error aborts the unit: `sellers.create-file` is retried by the inbox and never records a value it did not read; unit 1 of the automatic approval ends without approving and the file goes to a person. The read is never moved out of the deciding unit to make a fallback possible (Hassan L7) |
| `draft_complete` | `boolean` | no | 1 | Written by the aggregate on every save: `false` at creation. Serves the "Incomplete" tab only; submission re-checks completeness against the current Market configuration (6) |
| `last_changed_at` | `timestamptz(6)` | no | 1 | Every change of the file: draft save, submission, withdrawal, decision closure. The sort key of the "Incomplete" tab and the purge anchor (10.1). Equals `created_at` at creation |
| `store_name` | `text` | yes | 2 | Clear (D 8.1, T2 option B). CHECK S7 with length 1 to the domain limit (Q-M11) |
| `store_name_key` | `text COLLATE "C"` | yes | 2 | The search key: NFKC, case-folded, inner whitespace collapsed, by the application. CHECK `(store_name IS NULL) = (store_name_key IS NULL)`; CHECK `char_length BETWEEN 1 AND 400` (the application's key limit, Hassan L2: a key stays well under a btree entry) `AND store_name_key = btrim(store_name_key) AND store_name_key IS NFKC NORMALIZED AND store_name_key = lower(store_name_key COLLATE "C")` (an ASCII backstop, as `accounts_email_normalized_check`) |
| `business_name_ciphertext` | `text` | yes | 2 | **Personal**, Enc, label `sellers.seller-file.business-name`. CHECK envelope shape, length 41 to 2048 (4.5) |
| `phone_ciphertext` | `text` | yes | 2 | **Personal**, Enc, `sellers.seller-file.phone`. Live after approval (D 2.3). CHECK envelope shape, length 41 to 512 (4.5) |
| `contact_email_ciphertext` | `text` | yes | 2 | **Personal**, Enc, `sellers.seller-file.contact-email`. Never the sign-in address (D 10). Optional at onboarding (D 14.3 Reza 13; SEL-22's email is the sign-in email, D 14.4 Q-M19). CHECK envelope shape, length 41 to 2048 (4.5) |
| `address_ciphertext` | `text` | yes | 2 | **Personal**, Enc, `sellers.seller-file.address`: one JSON object with the fields of the Market's `address.format` (D 4.1), so a Market with other fields needs no migration. This is the **operating** address: the only one that drives `service_area_code`, `address_timezone` and `operating_timezone` (brief s7). CHECK envelope shape, length 41 to 16384 (4.5) |
| `registered_address_ciphertext` | `text` | yes | 2 | **Personal**, Enc, `sellers.seller-file.registered-address`: the registered business address in the same JSON shape, captured only when it differs from the operating address (brief s7; D 14.4 Q-M23, corrected). NULL means "same as the operating address". Never used for ServiceArea or time zone. Changed after approval only through an identity change (Q4). CHECK envelope shape, length 41 to 16384 (4.5) |
| `service_area_code` | `text` | yes | 2 | Clear. The ServiceArea the address fell in at the last save (D 4.3). CHECK `^[a-z0-9][a-z0-9-]{0,63}$` (S8) |
| `operating_timezone` | `text` | yes | 2 | Clear. IANA zone ID (ADR-0005 decision 1), never an offset: the zone of the address's region, a hint, or a zone the seller or an admin chose from the region's closed list (spike 3 record, `docs/reviews/sellers-spike-3-zone-source.md`). CHECK `^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+){0,2}$` and length at most 64; validity against the zone database and the region list is the application's (`TimezoneResolver`, `chooseZone`) |
| `timezone_source` | `text` | yes | 2 | Clear. Who set `operating_timezone` (spike 3 record, data design changes): CHECK `default`, `browser`, `location`, `seller`, `admin` (closed, S8). `location` is written only once the later location-hint slice exists; it is in the list now so that slice alters no CHECK |
| `address_timezone` | `text` | yes | 2 | Clear. The zone the operating address gives (the region's `default`, D 4.1), stored at every address save so that no read decrypts the address to derive it (4.3, zero unwrap) and the reviewer and `certification` (guardrail 3: the earliest boundary of the chosen and the address zone) can read it. CHECK as `operating_timezone`. No column for coordinates, ever |
| `draft_slug` | `text COLLATE "C"` | yes | 2 (Q-M25) | Clear. The shop slug the seller chose in the draft, normalised by the application. CHECK `^[a-z0-9]+(-[a-z0-9]+)*$` and `char_length BETWEEN 3 AND 50`, the rule of `shop_slugs_slug_check` (3.5); the reserved words stay in Market configuration, never in the CHECK. **No unique key and no index**: a draft slug is not held, and uniqueness is decided only when the first submission holds it in `shop_slugs` (T1). Not public while a draft; personal-adjacent for a sole trader (10.4); removed with the row |
| `identifier_scheme` | `text` | yes | 3 | Clear scheme code from Market configuration (`abn`, `zz-corp-no`). CHECK `^[a-z][a-z0-9-]{0,31}$` |
| `identifier_ciphertext` | `text` | yes | 3 | **Personal**, Enc, `sellers.seller-file.identifier`: the normalised value. CHECK envelope shape, length 41 to 512 (4.5) |
| `identifier_index` | `bytea` | yes | 3 | **Personal (pseudonymous)**, S5. CHECK `octet_length = 32`. CHECK: the three identifier columns are all NULL or all set |
| `approved_revision_id` | `uuid` | yes | 5 | V1 pointer (ADR-0009 decision 2). FK `(market_id, seller_id, approved_revision_id)` → `business_file_revisions (market_id, seller_id, id)`, RESTRICT: the pointer can only name a revision **of this seller** (measured) |
| `public_store_name` | `text` | yes | 7a-decide | The store name of the approved revision, copied in every unit that moves the pointer: a reviewer's approval, the automatic approval and an admin's edit of an approved seller (D 3.1, H1). CHECK `(approved_revision_id IS NULL) = (public_store_name IS NULL)` and S7. Why it exists: Q-M2 (confirmed) |
| `decision_intent` | `text` | yes | 7a-decide | CHECK `approve-requested`, `reject-requested`, `reapply-requested` (D 3.2) |
| `decision_attempt_id` | `uuid` | yes | 7a-decide | The attempt id of D 3.2 |
| `decision_revision_id` | `uuid` | yes | 7a-decide | Revision N. FK `(market_id, seller_id, decision_revision_id)` → `business_file_revisions (market_id, seller_id, id)`, RESTRICT |
| `decision_intent_since` | `timestamptz(6)` | yes | 7a-decide | CHECK: the four intent columns are all NULL or all set |
| `area_open_notified_code`, `area_open_notified_at` | `text`, `timestamptz(6)` | yes | **Conditional** | Only if the owner or Hadi accepts the "your area is now open" mail (D 10, Jafar 7): the ServiceArea code the seller was last mailed about and when, so the job mails once per file and area. CHECK both NULL or both set; the code CHECK as `service_area_code`. Not created unless accepted; then it arrives in that slice's migration (9.1) |
| `version` | `integer` | no | 1 | S1 |
| `created_at` | `timestamptz(6)` | no | 1 | |

- Unique `(market_id, seller_id)` (S3): C3 target, the batch read of `sellerSummaries` and
  `sellingEligibility` (`seller_id = ANY`), and the decoration of the list pages that come from
  `identity` (D 7.8).
- There is no `pending_revision_id`: "one pending revision at most" is a partial unique index on
  the revisions (3.2), a guarantee the database holds, where a pointer column would be a second
  copy the database cannot check (Q-M1, confirmed).
- **On an approved file the draft columns are frozen by the use cases, not by the database**:
  draft saves are refused (`file.change-request-required`), an identity change carries its values
  in the request and lands as a revision, and phone and contact email change only through
  `my-contact.save`, which also writes `contact_detail_history` (D 3.1, Hassan L2).
- `file-check-needed` (D 3.3; Ali change 1) is not stored: it is "`identity` says `approved` and
  `approved_revision_id IS NULL`", computed when the list decorates `identity`'s rows (A5).
- Indexes by query in section 7.
- **Zone CHECKs (slice 2; spike 3 record).** `seller_files_timezone_set_check`: `operating_timezone`,
  `timezone_source` and `address_timezone` are all NULL or all set (a zone exists only once an
  address was saved, and the save writes all three). `seller_files_timezone_address_check`:
  `operating_timezone IS NULL OR address_ciphertext IS NOT NULL` (no zone without an operating
  address; the address is never cleared, 3.1 S4). `seller_files_timezone_default_check`:
  `timezone_source <> 'default' OR operating_timezone = address_timezone` (the region default is the
  address's zone). "The chosen zone is on the region's list" and "a hint only for a draft whose zone
  nobody set" are configuration and transition rules: the aggregate's (`chooseZone`, 6).
- **Invariant I-S1 (Q-M25).** While a held `shop_slugs` row exists for the seller, `draft_slug`
  equals its `slug`. The database does not carry it (6); the application does: the submission
  holds `draft_slug`; `my-file.save-slug` with a different value deletes the never-public held row
  in the same unit (slice 5); the admin `seller.change-slug` writes both; the purge deletes both.
  Until slice 5 no held row exists, so the invariant holds trivially.
- **Implemented in slice 3** (migration `20261008160000_sellers_identifier_tax`, 2026-10-08, section
  20): the three identifier columns, their CHECKs and the partial index above.
- **Implemented in slice 2b** (migration `20261008130000_sellers_file_details`, 2026-10-08): the
  slice-2 rows above, their CHECKs and `(market_id, store_name_key)`; constraint names in 18.

### 3.2 `sellers.business_file_revisions` (slice 5; V1)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; also the `basisId` sent to `identity` (ADR-0022 decision 4) |
| `seller_id` | `uuid` | no | FK `(market_id, seller_id)` → `seller_files`, RESTRICT |
| `kind` | `text` | no | CHECK `onboarding`, `identity-change` |
| `revision_no` | `integer` | no | CHECK `>= 1`. Unique `(market_id, seller_id, revision_no)` |
| `status` | `text` | no | CHECK `pending`, `approved`, `rejected`, `withdrawn`, `superseded` (D 3.1) |
| `author_kind` | `text` | no | CHECK `seller`, `admin` |
| `author_account_id` | `uuid` | no | C4. NOT NULL because D creates a revision only from a person's submission (Q-M15) |
| `content_ciphertext` | `text` | no | **Personal**, Enc, `sellers.business-file-revision.content`: the sorted-key JSON of D 2.4 rule 2 (store name, business name, operating address, registered address when it differs, identifier, contact details at that moment, tax registration answer). One ciphertext per revision: nothing ever queries inside it, and the reviewer reads it whole |
| `content_schema_version` | `smallint` | no | CHECK `>= 1`. The JSON shape of the content, so a later field is a new version and old revisions still decode. Not the envelope version, which the ciphertext carries itself (PF 4 row 2) |
| `content_hash` | `text` | no | `SubjectKeyService.hmac(…, 'sellers.business-file.content', …)` (D 2.4 rule 2). CHECK `content_hash ~ '^hmac-sha256:[0-9a-f]{64}$'` (`ContentHash`, `docs/design/domain/platform-audit.md` 6.3; replaces the length 1 to 128 placeholder; signed off by Mojtaba 2026-10-08). The general form `^(sha256|hmac-sha256):` is the upper bound; this column takes only the HMAC kind, because its content is personal (ADR-0009 decision 6) |
| `identifier_index` | `bytea` | yes | **Personal (pseudonymous)**, S5. The submitted value's index, clear, so the approval takes the claim without decrypting. NULL when the Market does not require an identifier and none was given |
| `operating_timezone`, `service_area_code` | `text` | no | Clear (D 8.1). CHECKs as on `seller_files`. Read by `sellerSummaries` and `sellingEligibility` with no key unwrap |
| `address_timezone` | `text` | yes | Clear. The zone derived on the server at every address save from the operating address only, copied at submit from `seller_files.address_timezone`; read by `approvedSellerZones` as `addressZone` with no key unwrap. Same zone CHECK pattern as `seller_files_address_timezone_check` when not NULL (`business_file_revisions_address_timezone_check`). Immutable by privilege (INSERT and SELECT only, like the rest of the revision). Not part of the content hash, because it is derived. NULL for a Phase-2 backfill revision (no decryption in the backfill, Q-M4); A18 answers `addressZone: null` for NULL, which `certification` turns into `seller-zone-missing` (fail closed) |
| `register_outcome` | `text` | no | Snapshot of the register check at submission (D 2.1): CHECK `not-performed`, `active`, `not-found`, `cancelled`, `unavailable` (D 3.4) |
| `register_mismatches` | `text[]` | no | CHECK `register_mismatches <@ ARRAY['business-name','indirect-tax-registration','postcode']` and `cardinality(register_mismatches) = 0 OR register_outcome = 'active'` |
| `register_checked_at` | `timestamptz(6)` | yes | CHECK `(register_outcome = 'not-performed') = (register_checked_at IS NULL)` |
| `created_at` | `timestamptz(6)` | no | The submission instant |
| `status_changed_at` | `timestamptz(6)` | no | Equals `created_at` while pending |
| `decided_at` | `timestamptz(6)` | yes | CHECK `(status IN ('approved','rejected','superseded')) = (decided_at IS NOT NULL)`: a superseded revision keeps the instant it was approved |
| `decided_by_account_id` | `uuid` | yes | C4. Identity changes only (D 3.1: onboarding decisions are recorded by `identity`) |
| `identity_decision_id` | `uuid` | yes | C4: `identity`'s decision id once decided (D 2.1). CHECK `identity_decision_id IS NULL OR kind = 'onboarding'` |
| `reject_reason_code` | `text` | yes | A code from `rejectReasons` (D 4.1), never text (Hassan's rule, D 3.1). CHECK `(reject_reason_code IS NOT NULL) = (status = 'rejected' AND kind = 'identity-change')`; pattern CHECK (S8) |
| `withdraw_cause` | `text` | yes | CHECK `edited`, `cancelled`, `reapply-refused` (D 7.4) |
| `withdrawn_by_kind` | `text` | yes | CHECK `seller`, `admin` (D 3.1, 7.4 `byKind`; Jafar 4: an admin's edit withdraws too) |
| `withdrawn_at` | `timestamptz(6)` | yes | The instant `my-file.read` shows ("withdrawn on {date}"). CHECK `(status = 'withdrawn') = (withdraw_cause IS NOT NULL)`, and `withdraw_cause`, `withdrawn_by_kind`, `withdrawn_at` all NULL or all set |

- **Partial unique `(market_id, seller_id) WHERE status = 'pending'`**: one pending revision per
  file, of either kind (D 3.1 forbids a pending revision while another is pending). Measured: the
  second pending insert is refused.
- **Partial unique `(market_id, seller_id) WHERE status = 'approved'`**: at most one live approved
  revision; the others are `superseded`. A backstop to the pointer (3.1), cheap at this size.
- Unique `(market_id, seller_id, id)`: target of the two pointer FKs on `seller_files`.
- Partial `(market_id, identifier_index) WHERE identifier_index IS NOT NULL` (slice 7a-read): brief
  s7 says the reviewer sees **every** seller with the same identifier, in any state. A seller whose
  pending, rejected or withdrawn revision carries the value but whose draft has moved on is found
  only here (A8).
- An admin's edit of an approved seller (D 3.1, H1) is a revision with `author_kind = 'admin'`,
  `kind = 'identity-change'`, inserted and set `approved` in one unit; the CHECKs above hold for it
  unchanged (`decided_at` and `decided_by_account_id` set, no reject code).
- The latest rejected identity change that `my-file.read` returns (D 3.1, Jafar 5) is the highest
  `revision_no` of the seller when its status is `rejected`: one backward probe of the unique
  `(market_id, seller_id, revision_no)`. No dismissal column.
- Content never changes **by privilege**: the application holds `UPDATE` only on the status
  columns (section 8), so `content_ciphertext`, `content_hash`, `identifier_index` and the
  snapshot columns refuse with `42501`. That is the database half of "content never changes" (D
  2.1).

### 3.3 `sellers.review_checks` (slice 7a-read)

Primary key `(market_id, revision_id, check_code)`; FK `(market_id, revision_id)` →
`business_file_revisions (market_id, id)`, CASCADE (S10); `check_code text` with the S8 pattern;
`result text` CHECK `done`, `not-applicable`, `not-done` (`not-done` sets a check back and counts as missing; D 14.3 Reza 6); `observed_register_outcome text` nullable, CHECK
`active`, `not-found`, `cancelled`, and CHECK `(check_code = 'manual-register-check') =
(observed_register_outcome IS NOT NULL)` (D 2.1: the result the reviewer read); `recorded_by_account_id
uuid NOT NULL` (C4); `recorded_at`. A check may be recorded again while the revision is pending
(an upsert on the primary key); "only on the pending revision, never after the decision" is the
aggregate's (6). The approval guard reads the checks of revision N by the primary key range.

### 3.4 `sellers.register_checks` (slice 4a)

| Column | Type | Null | Notes |
|---|---|---|---|
| `seller_id` | `uuid` | no | FK to `seller_files`, RESTRICT |
| `identifier_index` | `bytea` | no | **Personal (pseudonymous)**, S5. PK `(market_id, seller_id, identifier_index)`: one row per file and value (D 2.1, "0..1 per identifier value"). Results are per file, never shared across sellers (D 7.7) |
| `outcome` | `text` | no | CHECK `active`, `not-found`, `cancelled`, `unavailable`. `not-performed` is the absence of a row |
| `mismatches` | `text[]` | no | The CHECKs of `register_mismatches` (3.2) |
| `definite_negative_at` | `timestamptz(6)` | yes | The first definite negative for this value. CHECK `outcome NOT IN ('not-found','cancelled') OR definite_negative_at IS NOT NULL`, and (slice 4a, section 21) `outcome <> 'active' OR definite_negative_at IS NULL`. The sticky rule (D 3.4: a later `unavailable` does not clear it) reads this column, so the latest outcome can be written as it is and the history of the value stays readable |
| `compared_values_ciphertext` | `text` | yes | **Personal**, Enc, `sellers.register-check.compared-values`. Written only if the register's agreement allows it (D 7.7; vendor review). Never the raw answer |
| `checked_at` | `timestamptz(6)` | no | Bound to the maximum age of D 7.7 at read time, against `Clock` |
| `checked_by_kind` | `text` | no | CHECK `seller`, `reviewer`, `job` |
| `checked_by_account_id` | `uuid` | yes | C4. CHECK `(checked_by_kind = 'job') = (checked_by_account_id IS NULL)` |
| `compared_file_version` | `integer` | no | Slice 5 (section 22; Hassan M1 residual): the `seller_files.version` the comparison read the draft at. CHECK `>= 1`. Every write states it; an `active` result is current only while the file is still at this version |

The current result of a file is the row for the file's current `identifier_index` (a primary key
probe). Every approval guard (reviewer, admin edit, automatic) reads the row for (seller, revision
N's `identifier_index`), also a primary key probe, so a re-lookup after submission counts and a
negative stays sticky (D 3.4, Hassan L3); `checked_at` older than `maxResultAge` (30 days) counts
as `not-performed`. Each new value adds a row; the per-account quota (3.11: 5 new values per 24 h)
bounds them.

### 3.5 `sellers.shop_slugs` (slice 2)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK. A surrogate, because the outbox needs a `uuid` aggregate id for `sellers.slug-changed.v1` (D 7.4) |
| `slug` | `text COLLATE "C"` | no | Clear, public. CHECK `^[a-z0-9]+(-[a-z0-9]+)*$` and `char_length BETWEEN 3 AND 50` (D 3.5, numbers proposed there). The reserved list is the application's (a checked-in list) |
| `seller_id` | `uuid` | no | Plain id, **no FK** (C4): a retired slug outlives the purge of its file (Q-M3, confirmed) |
| `state` | `text` | no | CHECK `held`, `retired` |
| `ever_public` | `boolean` | no | True once the slug was held while its seller had an approved revision (Hassan M6). Written `true` at insert when the seller already has one (an admin change after approval), and set `true` on the held row in the unit that first moves the seller's approved pointer. Never set back. CHECK `state = 'held' OR ever_public`: only a slug that was ever public can be retired |
| `held_at` | `timestamptz(6)` | no | |
| `retired_at` | `timestamptz(6)` | yes | CHECK `(state = 'retired') = (retired_at IS NOT NULL)` and `retired_at >= held_at` (one constraint, `shop_slugs_retired_at_check`) |
| `version`, `created_at` | | no | S1 |

- **Unique `(market_id, slug)`**: unique per Market (SEL-01, AC 2). A retired row keeps its key,
  so a retired slug is never held again by anyone (brief s7, D 3.5). The availability check and
  the "taken" answer at submission are this key: the insert's `P2002` maps to `slug.taken` (P 10),
  never read-then-insert.
- **Partial unique `(market_id, seller_id) WHERE state = 'held'`**: one held slug per seller. An
  admin change, in one unit, either **retires** the old row (`ever_public` true) or **deletes** it
  (`ever_public` false: the slug is released and anyone may hold it later; audit
  `sellers.slug.released`, D 3.5, 9), then inserts the new one. Before approval the seller may
  also change the slug: saving a different one deletes the held row in the same unit (after the
  withdraw warning if a pending revision holds it), with no audit row; the new slug is held at the
  next submission (D 14.4 Q-M21). The purge deletes the held row the same way (10.2). The
  application gets `DELETE` on this table from slice 5, the first slice that holds and so can
  release (8).
- The seller's draft choice is `seller_files.draft_slug` (3.1, Q-M25). It is not held, has no key
  here, and is checked against this table only as an advisory `slug.taken` at save; the unique
  key above, at the submission's insert, is the authority.
- The prefix search of the admin list is a range on `(market_id, slug)` (S6).
- The public read by slug (D 7.1, Hassan M5) reads `WHERE market_id = $1 AND slug = $2 AND state =
  'held'`: a retired slug never resolves, and the seller must then pass `sellingEligibility`.
- **Implemented in slice 2b** (migration `20261008130000_sellers_file_details`, 2026-10-08), with
  `slug` created `COLLATE "C"` by hand in the generated `CREATE TABLE` (spike S1: Prisma does not
  see it, so a catalog test reads `pg_attribute.attcollation` for `slug` and `store_name_key`).
- **One-way columns, for every role (Hassan L1, PR #105 review).** The `BEFORE UPDATE` trigger
  `shop_slugs_one_way` (function `sellers.shop_slugs_guard_update()`, owned by the migration role
  like `platform.subject_keys_guard_update`) raises `restrict_violation` (`23001`) when
  `OLD.ever_public AND NOT NEW.ever_public` or when `OLD.state = 'retired' AND NEW.state <>
  'retired'`. The column-level grant (8) already freezes the slug and its holder for the
  application; the trigger also holds against the owner and a manual script. It does not fire on
  `DELETE` (release before approval, the purge).

### 3.6 `sellers.identifier_claims` (slice 7a-decide)

Primary key `(market_id, identifier_index)` (S5): **one approved or suspended seller per
identifier value per Market** (brief s7, AC 21; D 3.6). Values in two Markets never collide,
because the Market is in the HMAC input (D 8.2). Columns: `seller_id uuid NOT NULL`, FK to
`seller_files`, RESTRICT, and unique `(market_id, seller_id)` (one claim per seller: an approved
identity change deletes the old row and inserts the new one in one unit); `revision_id uuid NOT
NULL`, FK `(market_id, seller_id, revision_id)` → `business_file_revisions (market_id, seller_id,
id)`, RESTRICT: the revision that took the claim; `claimed_at`; `version`, `created_at` (S1). The
second approval of one value fails on the primary key; the repository maps that constraint name to
its domain error (P 10). The seller-facing answer never depends on it (brief s7). When
`sellers.close-decision` re-takes a released claim (D 7.3, Hassan M3), it is the same insert; a
`P2002` there means another seller holds the value, and both sellers get an open
`identifier-claim-conflict` flag in `admin_flags` (3.13).

### 3.7 `sellers.seller_tax_profiles` and `sellers.tax_registration_periods` (slices 1 and 3; V2)

`seller_tax_profiles` (slice 1): `seller_id` PK and unique `(market_id, seller_id)` (S3), FK to
`seller_files`, RESTRICT; `version`; `created_at`. The root exists so that a recorded period
raises one version and carries the event `sellers.tax-registration-recorded.v1`, whose payload is
`sellerId` only; `tax` reads the period through `taxProfileOf` (D 7.4, Hassan L1).

`tax_registration_periods` (slice 3):

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `seller_id` | `uuid` | no | FK `(market_id, seller_id)` → `seller_tax_profiles`, RESTRICT |
| `registered_for_indirect_tax` | `boolean` | no | Clear (D 8.1). The platform decides nothing from it (ADR-0007 decision 6) |
| `effective_from_local` | `date` | no | The local date the person entered (ADR-0005 decision 3; D 2.4 rule 4). When the answer is "not registered", the period starts at the instant it is recorded (D 14.3 Reza 13): this column then holds that instant's local date in `effective_zone` |
| `effective_zone` | `text` | no | The IANA zone used to turn that date into `valid_from`: the seller's `operating_timezone` at recording (D 5). Stored so the instant can be explained later, even after the zone is corrected. CHECK as `operating_timezone` |
| `valid_from` | `timestamptz(6)` | no | 00:00 of `effective_from_local` in `effective_zone`, computed by the application (D 2.4 rule 4). Inclusive |
| `valid_to` | `timestamptz(6)` | yes | Exclusive; NULL = open. CHECK `valid_to IS NULL OR valid_to > valid_from` |
| `recorded_by_kind` | `text` | no | CHECK `seller`, `admin` (D 9: seller or admin) |
| `recorded_by_account_id` | `uuid` | no | C4 |
| `recorded_at` | `timestamptz(6)` | no | |

```sql
-- Hand-written: no two periods of one seller overlap (ADR-0009 V2; D 2.4 rule 4).
ALTER TABLE "sellers"."tax_registration_periods"
  ADD CONSTRAINT "tax_registration_periods_no_overlap_excl" EXCLUDE USING gist (
    "market_id" WITH =, "seller_id" WITH =,
    tstzrange("valid_from", "valid_to", '[)') WITH &&);
```

- Half-open ranges: a period that ends at the instant the next one starts is accepted; an overlap
  is refused (measured, 12). The equality on `market_id` and `seller_id` inside a GiST index needs
  `btree_gist` (9.2).
- **As of an instant** (`taxProfileOf(ctx, sellerId, at)`, ADR-0007 decision 7): `WHERE market_id
  = $1 AND seller_id = $2 AND valid_from <= $at AND (valid_to IS NULL OR valid_to > $at)`, which
  Prisma expresses without raw SQL (C10), on the btree `(market_id, seller_id, valid_from)`. At a
  handful of rows per seller the plan is a short range scan either way.
- Recording a new period closes the open one by setting its `valid_to` in the same unit, under the
  root's version. The application gets `UPDATE (valid_to)` only (section 8), so a period's answer
  and its start can never be rewritten, only closed. A period that has **not started** may be
  cancelled: a `DELETE` of that row only, audited, under the root's version, which also re-opens
  the previous period (its `valid_to` back to NULL) (D 14.3 Q-M13). "Not started" is a time rule
  against `Clock`, so the use case enforces it; `DELETE` is granted from slice 3.

**Implemented in slice 3** (section 20): the table, its CHECKs, the exclusion constraint and the
grant `SELECT, INSERT, UPDATE (valid_to), DELETE`.

### 3.8 `sellers.store_profiles` and `sellers.store_profile_revisions` (slices 1 and 12; V1)

`store_profiles` (slice 1): `seller_id` PK and unique `(market_id, seller_id)` (S3), FK to
`seller_files`, RESTRICT; `published_revision_id uuid` nullable, column and FK added in slice 12:
`(market_id, seller_id, published_revision_id)` → `store_profile_revisions (market_id, seller_id,
id)`, RESTRICT; `version`; `created_at`. Created empty by the handler of D 7.5. **Slice 20 (D 18; sign-off
recorded in D 18's review table):** `minimum_order_amount bigint` (minor units, ADR-0007) and
`minimum_order_currency char(3)` (ISO 4217), both nullable, clear (public commercial value, not
personal); `minimum_order_changed_at timestamptz(6)` and `minimum_order_changed_by_account_id uuid`
(no FK, ADR-0004 decision 3), nullable until the first change. Null = no minimum (D 18 decision 2).
Constraints: `store_profiles_minimum_order_pair_check` `(minimum_order_amount IS NULL) =
(minimum_order_currency IS NULL)`; `store_profiles_minimum_order_amount_check`
`minimum_order_amount > 0` (null passes); `store_profiles_minimum_order_currency_check`
`minimum_order_currency ~ '^[A-Z]{3}$'`; `store_profiles_minimum_order_changed_check`
`(minimum_order_changed_at IS NULL) = (minimum_order_changed_by_account_id IS NULL)`, and a set
amount implies a set change (`minimum_order_amount IS NULL OR minimum_order_changed_at IS NOT
NULL`). Equality with the Market's currency is not a constraint: the Market's currency is
`MarketConfig`, not a row in this schema (6); the use case checks it (D 18 decision 3) and the
facade re-checks before returning `minimumOrder`, so a row left from a Market currency change reads
as a fault, never as a minimum in the wrong currency. The upper bound (D 18 decision 3) is a per-Market
configuration value checked in the use case, not a CHECK. Read with the row of `sellerSummaries` (A1); no
new index.

`store_profile_revisions` (slice 12): `id` PK; `seller_id`, FK `(market_id, seller_id)` →
`store_profiles`, RESTRICT; `revision_no integer` CHECK `>= 1`, unique `(market_id, seller_id,
revision_no)`; unique `(market_id, seller_id, id)` (pointer target); `content_ciphertext text NOT
NULL`, **Personal**, Enc, `sellers.store-profile-revision.content`: one JSON object keyed by locale
holding Description, Policies, Meta and Social (D 2.1; one revision covers every locale, because D
has one published pointer); `content_schema_version smallint`; `content_hash text` (as 3.2);
`author_account_id uuid NOT NULL` (C4); `created_at`.
- No `status` column: D 3.7 publishes every save at once (Q4 of the brief), so the published
  pointer is the whole state. When a review state arrives, a nullable `status` is added (expand,
  9.3) and filled for existing rows in batches (Q-M17).
- No `UPDATE` grant at all: a revision is insert-only for the application.
- Public read (`publishedStoreProfile`, D 7.1): `store_profiles` by `(market_id, seller_id)`, or
  the slug through `shop_slugs (market_id, slug)` then the seller, then the revision by primary key:
  three index probes and one key unwrap (D 8.1; accepted until the storefront G2, D 16.2 item 7).

### 3.9 `sellers.seller_admin_settings` and `sellers.seller_allowed_product_types` (slices 1 and 14)

`seller_admin_settings` (slice 1): `seller_id` PK and unique `(market_id, seller_id)` (S3), FK to
`seller_files`, RESTRICT; `all_product_types_allowed boolean NOT NULL`;
`category_proposals_allowed boolean NOT NULL`; `ai_enabled boolean NOT NULL`; per setting a `<setting>_changed_at timestamptz(6)` and `<setting>_changed_by_account_id uuid`, both nullable until the first change (D 14.3 Reza 10); `version`;
`created_at`. **No column default** (C2): the handler of D 7.5 writes `true`, `false`, `false` at
creation, so a missing row is a fault and never silently a default (D 2.1). The AI switch reader
(D 7.6) and `allowedProductTypesOf` read one row by `(market_id, seller_id)`.

`seller_allowed_product_types` (slice 14): primary key `(market_id, seller_id, type_code)`; FK to
`seller_admin_settings`, CASCADE (S10); `type_code text` with the S8 pattern
`^[a-z0-9][a-z0-9._-]{0,63}$` until `catalog`'s registry fixes the format (Q-M12). With
`all_product_types_allowed` false the set is never empty (`types.empty`, D 14.3 Q-M12): a
cross-table rule, so the aggregate's (6). Rows, not an
array, for the reasons of ID-data 3.9 (`role_permissions`): no duplicate or malformed element, an
edit touches only the changed codes, and "which sellers allow type X" stays a set query.
"`all_product_types_allowed` is true ⇒ no rows" is the aggregate's (6). `catalog` reads the set
on every Offer command: one primary key range scan.

### 3.10 `sellers.contact_detail_history` (V4; slice 10, D 14.3 Q-M10)

`id` PK; `seller_id`, FK to `seller_files`, RESTRICT; `content_ciphertext text NOT NULL`,
**Personal**, Enc, `sellers.contact-detail-history.content` (the phone and contact email after the
change); `author_kind` CHECK `seller`, `admin`; `author_account_id uuid NOT NULL` (C4);
`changed_at`. Append-only by privilege: `SELECT, INSERT` (and `DELETE` from slice 18 for the
purge). Read only by `business-history.read` (D 6.2), which is audited per read (D 9). Index
`(market_id, seller_id, changed_at)` for that read.

### 3.11 `sellers.rate_counters` (slice 2; D 6.5, 7.7; Hassan L10)

One table for every limit of D 6.5 and the lookup quotas of D 7.7, in the shape of
`identity.sign_in_throttles` (ID-data 3.5), so Prisma's `upsert` has one declared primary key:

| Column | Type | Null | Notes |
|---|---|---|---|
| `kind` | `text` | no | Closed CHECK list, the rows of the table below. A new kind is a migration |
| `key_hash` | `bytea` | no | HMAC-SHA-256 of the kind's subject under the sellers rate-counter key (O3). CHECK `octet_length = 32`. PK `(market_id, kind, key_hash)`. No account id, seller id or address is stored in clear; the origin is the IPv4 address or the IPv6 /64, cut by the application before hashing (as identity HF3) |
| `window_started_at` | `timestamptz(6)` | no | Fixed window from the first reservation (D 14.3 Q-M7); its length is the kind's, in code |
| `count` | `integer` | no | CHECK `>= 0` |

| Kind | Subject | Limit (Hassan, D 6.5) | First used |
|---|---|---|---|
| `slug-check.account.minute`, `slug-check.account.day` | Account id | 30 per minute; 300 per 24 h | 2 |
| `save.account.minute`, `save.account.day` | Account id | 60 per minute; 1,000 per 24 h (`my-file.save-*`, `validate-identifier`, profile and contact saves) | 2 |
| `lookup.account` | Seller-side account id | 5 new identifier values per 24 h | 4a |
| `lookup.origin` | Origin | 30 per 24 h | 4a |
| `lookup.market` | The Market (a constant subject) | 1,000 per 24 h; alert at 80%; the periodic job stops at 50% | 4a |
| `lookup.admin` | Admin account id | 30 re-lookups per 24 h | 7a-read |
| `submit.file` | Seller id | 5 per 24 h (submit, submit again, request-change) | 5 |
| `withdraw.file` | Seller id (D 14.4 Q-M22) | 10 per 24 h (withdraw and cancel) | 5 |
| `bulk.admin` | Admin account id | 10 bulk requests per minute | 8 |
| `reviewer-notice.seller` | Seller id (Ali R-3) | 1 per fixed 6 h window | 5 |
| `reviewer-notice.market` | The Market (a constant subject) | 1 per fixed 15-minute window | 5 |

All kinds are in the CHECK from slice 2, so no later slice alters it (as ID-data 3.7 did for link
purposes); the two `reviewer-notice` kinds were added to the list before the slice-2 migration
merged (Ali R-3, 2026-10-08). Bulk size (50 ids) and the facade batch (100 ids) are request
validation, not counters.

- **Reserve before the work** (ADR-0023 decision 1, the pattern of ID-data 3.5): a reservation
  unit takes every counter that applies in a fixed order (kind, then key), so two units never wait
  on each other in a cycle; per counter (1) `updateMany` that restarts an ended window, (2) `upsert`
  on the primary key with `count: { increment: 1 }`. A returned count above the limit refuses: on
  `lookup.account` with `lookup.limit`, with no call and no `not-performed` result (brief s5); on
  `lookup.market` with `unavailable`; elsewhere with the rate-limit code. Nothing is released: an
  attempt that was made counts, **except** for the two `reviewer-notice` kinds below.
- **The `reviewer-notice` kinds (slice 5; Ali R-3, corrected 2026-10-08).** The handler that asks
  `identity` to notify reviewers reserves the two counters in **two separate units of one counter
  each**: `reviewer-notice.seller` first, then `reviewer-notice.market` only if the seller kind
  was due (not over its limit). No unit holds two counter locks, so the fixed order above is not
  needed for them. The reservation is **kept only when `identity` answers `reviewer-notice.sent`**;
  on every other outcome (every skipped reason, unavailable, an error, a timeout) each reserved
  counter is **released**. If the notice is coalesced at Market level, both counters are kept and
  the notice is marked handled. A release is one guarded decrement in its own unit:
  `updateMany … SET count = count - 1 WHERE market_id = $1 AND kind = $k AND key_hash = $h AND
  window_started_at = $w AND count > 0`, with `$w` the `window_started_at` the reservation
  returned. It therefore never touches a later window (a window that restarted in between changes
  nothing) and never goes below 0 (also `rate_counters_count_check`). It is never issued after
  `identity` has answered `sent` (or a coalesced answer). No other kind is ever released. The
  application's table-level `UPDATE` (8) covers the decrement; no new grant.
- **Fail closed** (Hassan L10): if the reservation unit cannot run or errors, the request is
  refused with `access.unavailable`, never let through, as ID 6.8. The 80% alert reads the
  `lookup.market` row after a reservation, in the same unit.
- The `lookup.market` row is one hot row per Market: at 1,000 calls per 24 h its lock lasts one
  statement. A save takes two counters per request, 60 per minute at most per account.
- Purge in `sellers.purge-expired` (hourly): rows whose window started more than 48 hours ago (the
  longest window is 24 hours). No index: the table is small and the purge scans it once an hour.
- **Implemented in slice 2b** (migration `20261008130000_sellers_file_details`, 2026-10-08): the
  table, its CHECKs (kind list of the table above, 13 kinds; `key_hash` 32 bytes; `count >= 0`)
  and `SELECT, INSERT, UPDATE, DELETE`.

### 3.12 `sellers.outbox` and `sellers.inbox` (slice 1; PM1 to PM4)

Exactly the columns, CHECKs, keys and indexes of ID-data 3.1 and 3.8 with the module name changed:
`outbox_type_check` is `^sellers\.[a-z0-9-]+\.v[1-9][0-9]*$`, so another module's type cannot be
stored here; `inbox_handler_check` is `^sellers\.[a-z0-9-]+$`. Unique `(market_id, aggregate_id,
aggregate_version)`; the claim index `(market_id, event_id) WHERE published_at IS NULL`. Aggregate
types used (D 7.4): `seller-file`, `shop-slug`, `store-profile`, `seller-admin-settings`,
`seller-tax-profile`. Payloads hold ids, codes, booleans and instants only (P 5.3; D 8.3); the
database cannot check that. "Every outbox has the same columns" is the catalog test of P 13; this
table is added to it. `platform.event_delivery` is unchanged: `sellers.<handler>` already fits its
`subscriber` CHECK.

`platform.audit_log` is unchanged: the actions of D 9 fit `audit_log_action_check`, and their
`before` and `after` hold ids, codes and booleans only (D 9).

### 3.13 `sellers.admin_flags` (slice 7a-decide; D 14.4 Q-M20)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `seller_id` | `uuid` | no | FK `(market_id, seller_id)` → `seller_files`, RESTRICT |
| `code` | `text` | no | Closed CHECK list: `identifier-claim-conflict` (7a-decide); `register-recheck` added by slice 11's migration (`DROP CONSTRAINT` and `ADD … NOT VALID`, then `VALIDATE`; 9.3) |
| `raised_at` | `timestamptz(6)` | no | |
| `cleared_at` | `timestamptz(6)` | yes | |
| `cleared_by_account_id` | `uuid` | yes | C4. CHECK `(cleared_at IS NULL) = (cleared_by_account_id IS NULL)` |

- **Partial unique `(market_id, seller_id, code) WHERE cleared_at IS NULL`**: one open flag per
  Market, seller and code; raising it again while open is an insert that the repository maps to
  "already open" (P 10).
- Clearing is an `updateMany` where the flag is open, by an admin with
  `sellers.seller-file.review`, with the audit row `sellers.admin-flag.cleared` in the same unit.
- The list filter of D 7.8 reads open flags: partial `(market_id, raised_at, id) WHERE cleared_at
  IS NULL`. `file-check-needed` stays computed (A5).
- Not personal: ids, a code, instants.

## 4. Encryption at rest and the keyed index

### 4.1 What is clear, what is encrypted (D 8.1, T2 option B)

| Data | Where | Form |
|---|---|---|
| Store name (draft), its search key, the approved store name | `seller_files` | Clear: public once approved, and the list searches it (D 8.1) |
| Slug | `shop_slugs` | Clear, public |
| Draft slug | `seller_files.draft_slug` | Clear, not public while a draft (Q-M25) |
| Business name, phone, contact email, operating and registered address, identifier (draft and live) | `seller_files` | Enc, one column per field (S4) |
| Revision content (everything the reviewer saw) | `business_file_revisions` | Enc, one column |
| Store profile texts | `store_profile_revisions` | Enc, one column (D 8.1) |
| Contact history | `contact_detail_history` | Enc |
| Register compared values | `register_checks` | Enc, only if the agreement allows it |
| Identifier index | `seller_files`, `business_file_revisions`, `register_checks`, `identifier_claims` | Keyed HMAC under the stack secret (S5) |
| Time zone, ServiceArea code, scheme code, states, kinds, outcomes, flags, booleans, type codes, ids, instants | Everywhere | Clear (D 8.1) |

The key belongs to `identity` (it creates the seller's key with `SellerAccess`, D 8.1; ID-data 3.2).
`sellers` never calls `createKey` or `destroyKey`, holds no key material and has no table of its
own for keys. Every encrypted value of one seller uses the same subject (the seller id), so one
`destroyKey` makes all of them unreadable at once (ADR-0009 decision 6).

### 4.2 Labels (PF 4 row 3; constants in `modules/sellers/infrastructure/`)

| Label | Column |
|---|---|
| `sellers.seller-file.business-name`, `.phone`, `.contact-email`, `.address`, `.registered-address`, `.identifier` | `seller_files.<field>_ciphertext` |
| `sellers.business-file-revision.content` | `business_file_revisions.content_ciphertext` |
| `sellers.register-check.compared-values` | `register_checks.compared_values_ciphertext` |
| `sellers.contact-detail-history.content` | `contact_detail_history.content_ciphertext` |
| `sellers.store-profile-revision.content` | `store_profile_revisions.content_ciphertext` |
| Hash purposes: `sellers.business-file.content` (D 2.4 rule 2), `sellers.store-profile.content` | `content_hash` columns |

Because the ciphertext is bound to its label (PF 4 row 2), a value copied from one column to
another, or from one seller's row to another seller's, does not decrypt: a database-level copy
bug fails loudly rather than leaking.

### 4.3 Cost of decryption, by read

| Read | Unwraps | Why |
|---|---|---|
| `sellingEligibility`, `sellerSummaries`, `approvedSellerZones` (D 7.1a), `allowedProductTypesOf`, `mayProposeCategories`, AI switch | **0** | Every condition reads clear columns: the approved pointer, `operating_timezone`, `address_timezone` of the approved revision, `identifier_index IS NOT NULL`, `public_store_name`, booleans (7) |
| Admin list page (25 rows), under `sellers.seller.view` | **0** | Clear fields only (Hassan M4): store name, slug, state codes, ServiceArea code, time zone, kinds, instants; owner name and sign-in email come from `identity` (D 7.8) |
| Seller's own form | 1 | One seller per request (PF 4 row 9) |
| `seller.read-details`, `review.read`, `reviewerBusinessDetails`, under `sellers.business-details.view` | 1 | The only admin reads that decrypt (Hassan M4); each writes the audit row `sellers.business-details.viewed` (D 9) in its unit, so a read-only use case writes one audit row: the read is then a write unit (ADR-0023 decision 1), with the decryption after it, outside the unit |
| `publishedStoreProfile` | 1 | Only for a held slug of an eligible seller (Hassan M5); no HTTP exposure without a read-model design (D 16.2 item 7) |
| `business-history.read` (slice 19) | 1 | One seller; audited per read (AC 26) |

Spike 2 of D 11.3 therefore measures one page plus one `identity` call, not 25 unwraps. Since the
key split the list may not show the business name at all (it is behind
`sellers.business-details.view`), so O7 is closed.

### 4.4 The identifier index secret

32 random bytes per Region Stack, required at boot, never logged (D 7.6), in the same class of
secret as identity's throttle secret (ID-data 3.5, H4). It is a different secret from it, checked
at boot, and backed up like the wrapping key (Hassan, G2). I propose that `sellers` derives two
keys from it with HKDF-SHA-256 and distinct labels, `sellers.identifier-index` and
`sellers.rate-counter` (3.11), so the module needs one secret and the two hashes can never be
compared (O3, Hassan to confirm). Rotation is not needed before launch (Hassan). Rotating the shared sellers secret also rotates every `identifier_index` (HKDF label `sellers.identifier-index`) as well as the rate-counter keys. It recomputes every index, which needs every seller's
identifier decrypted under that seller's key. That is a batch job, not a migration, and while it
runs, uniqueness depends on old and new values never being compared with each other. The procedure
is open (14, O3). A key-version column is not added now; if rotation needs one, it is an
additive change.

### 4.5 Ciphertext bounds (slice 2b; S4, Q-M11)

The envelope is now the `v1` format of `apps/api/src/platform/subject-keys/envelope.ts`: `v1.`
plus base64url (no padding) of a 12-byte nonce, the AES-256-GCM body and a 16-byte tag, so a
plaintext of N UTF-8 bytes gives `3 + ceil((N + 28) × 4 / 3)` characters. Each bound below takes the
Q-M11 limit at 4 bytes per character, then rounds up to the next power of two, which leaves room for
a JSON wrapper and a somewhat larger future envelope version. Every `*_ciphertext` CHECK also holds
the envelope shape (Hassan L2): `~ '^v[1-9][0-9]*\.[A-Za-z0-9_-]+$'` and a minimum of **41**
characters, the v1 envelope of an empty plaintext (`3 + ceil(28 × 4 / 3)`; measured with `sealField`
on 2026-10-08: 0, 1, 15 and 200 four-byte characters gave 41, 42, 61 and 1,107). So a CHECK reads
`x_ciphertext ~ '…' AND char_length(x_ciphertext) BETWEEN 41 AND <bound>`. A bound is a backstop against a bug
writing an unbounded value, not the field limit (the application checks that before encrypting).

| Column | Plaintext limit (Q-M11) | v1 maximum | CHECK `char_length BETWEEN 41 AND` |
|---|---|---|---|
| `business_name_ciphertext` | 200 characters | 1,107 | 2048 |
| `phone_ciphertext` | 32 characters | 211 | 512 |
| `contact_email_ciphertext` | 254 characters | 1,395 | 2048 |
| `address_ciphertext`, `registered_address_ciphertext` | JSON of at most 12 fields (the `address.format` schema caps it) of at most 120 characters, keys at most 32 | about 8,330 | 16384 |
| `identifier_ciphertext` (slice 3) | 64 characters (`IDENTIFIER_INPUT_MAX_LENGTH`; the real schemes are 9 to 11) | 382 | 512 |

Later ciphertext columns (revision content, register values, history, store profile
texts) get their bounds by the same rule in their slice's migration. O2 (14) stays open only for a
future envelope version that would not fit these bounds; such a version needs a migration that
widens them first.

## 5. What is never stored

| Never in the database | Instead |
|---|---|
| A business name, phone, contact email, address or identifier in clear | Ciphertext under the seller's key (4.1) |
| A plain or unkeyed hash of an identifier | The keyed index (S5); a plain hash of an 11-digit number is reversed by enumeration |
| The register's raw answer, its access key, the outbound URL | Outcome, flags, instant; compared values encrypted only if allowed (D 7.7) |
| A reject reason as text | A reason code (identity changes); onboarding reasons are `identity`'s, encrypted there (ID-data 3.11) |
| The access state (`pending`, `approved`, `rejected`, `suspended`), even as a read model | Read from `identity` per request (ADR-0022 decision 2) |
| "Approval required" as an editable value | The platform settings store of ADR-0026 (`platform` schema; its tables are in `docs/design/data/platform.md` when designed), seeded from Market configuration (D 2.2, D 14.1; mini-review D 19). Key: setting code sellers.approval-required (ruling O-3); no sellers table copies the current value; approval_required_at_registration (3.1) is the per-file snapshot ADR-0026 decision 6 allows |
| ServiceArea definitions | `config/service-areas/`; only the code is stored (D 4.3) |
| Personal data in `outbox`, `inbox`, `event_delivery`, `audit_log`, logs | Ids, codes, booleans, instants (D 8.3) |
| The seller's sign-in email | `identity` (D 10) |

## 6. Invariants the database does not carry

| Invariant | Why not a constraint | Enforced by |
|---|---|---|
| Which revision status follows which; a revision is created only from a complete draft; an edit of a held field withdraws the pending revision (D 3.1) | Transitions and cross-row reads | `SellerFile` aggregate, under its version |
| The pointer names the revision whose status is `approved` | Cross-row, cross-table | The approval unit sets both; the partial unique on `approved` and the same-seller FK narrow what can go wrong |
| Review checks change only while their revision is pending; the required checks of the Market are recorded before approval | Depends on the revision's status and on configuration | Aggregate; approval guard (D 7.3) |
| A definite negative is sticky for its value (D 3.4) | A transition rule | The aggregate reads `definite_negative_at`; the CHECK only forces it to be set with a negative outcome |
| The draft is complete for the Market (`draft_complete` true only when it is) | Fields are encrypted, and the rule is Market configuration | The aggregate computes it at each save; submission re-checks |
| The identifier is valid for the Market's scheme (format, checksum) | Ciphertext; scheme logic is code | `BusinessIdentifierScheme` (D 4.2) |
| Slug not on the reserved list; slug or store name not confusable with an approved seller's | A checked-in list and a distance measure | Application (D 3.5) |
| `all_product_types_allowed` true ⇒ no type rows; false ⇒ at least one row (`types.empty`) | Cross-table | `SellerAdminSettings` aggregate |
| `shop_slugs.ever_public` is set when the seller first has an approved revision | Cross-table | The unit that first moves the pointer sets it; the CHECK forbids retiring a slug that was never public (3.5) |
| I-S1: while a held `shop_slugs` row exists, `seller_files.draft_slug` equals its slug (Q-M25) | Cross-row, cross-table | Application: submission holds `draft_slug`; `my-file.save-slug` with a different value deletes the never-public held row in the same unit; `seller.change-slug` writes both; the purge deletes both (3.1) |
| Only a tax period that has not started is cancelled | Time against `Clock` | Use case under the root's version (3.7) |
| An approved file's draft is not edited (L2) | Depends on the pointer and the caller | Use cases (3.1) |
| Counters within their limits; a failed reservation refuses (L10) | Policy values and `Clock` | Reservation unit (3.11) |
| A `seller_id` exists in `identity`; account ids name real accounts; `identity_decision_id` is a decision | No cross-schema FK (ADR-0004 decision 3) | Events and facades |
| One seller per identifier among **approved and suspended** sellers only | The claim's life cycle follows `identity`'s state, which `sellers` does not store | The claim is taken in the approval unit and released on refusal or at erasure (D 3.6); the unique key does the rest |
| The register result's maximum age (30 days) | `Clock` | Read time, in every approval guard (3.4) |
| The four 1:1 rows (`seller_admin_settings`, `seller_tax_profiles`, `store_profiles`, `seller_files`) exist together | "At least one" needs a deferred constraint | The creation handler writes all four in one unit (D 7.5) |
| No personal data in payloads, audit values or logs | Not expressible | `defineEvent` vocabulary (P 5.3); audit allow-lists (D 9) |

## 7. Access paths

Volume assumption (as ID-data 9): one Market, Greater Brisbane, first year: 10² to 10³ sellers,
10⁴ as the planning ceiling. At that size most of these reads would also be fast as sequential
scans; the indexes below are for the plans to stay index scans as the table grows and in other
Markets, and each one has a named query.

| # | Query (D section) | Statement shape | Index |
|---|---|---|---|
| A1 | `sellerSummaries`, `sellingEligibility` for a set of ids (7.1, 7.2) | `seller_files WHERE market_id = $1 AND seller_id IN (…)`, then the approved revisions by primary key; since slice 20, `sellerSummaries` also reads `store_profiles` (the four `minimum_order_*` columns only) with the same predicate, one statement per batch, no N+1 | Unique `(market_id, seller_id)` on both tables; `business_file_revisions_pkey` |
| A2 | Seller's own file, review page, facades by one id | By `(market_id, seller_id)` | As A1 |
| A3 | Reviewer queue: pending onboarding revisions, oldest first; the identity-change queue the same with the other kind (7.8, "Awaiting review") | `business_file_revisions WHERE market_id = $1 AND status = 'pending' AND kind = $2 ORDER BY created_at, id` with keyset `(created_at, id) > ($c, $i)`, 26 rows | Partial `(market_id, kind, created_at, id) WHERE status = 'pending'` (slice 5) |
| A4 | "Incomplete" tab: never approved, no pending revision, most recently changed first (7.8) | `seller_files WHERE market_id = $1 AND approved_revision_id IS NULL AND draft_complete = false` and no pending revision (a Prisma `none` relation filter, served by the pending partial unique), keyset on `(last_changed_at, seller_id)` | Partial `(market_id, last_changed_at, seller_id) WHERE approved_revision_id IS NULL` (slice 6); also the purge (10.1) |
| A5 | Tabs from `identity` ("Changes needed", "Approved", …): a page of seller ids from R-6, decorated (7.8); `file-check-needed` is an "Approved" row whose `approved_revision_id` is NULL (D 3.3) | As A1 with ≤ 25 ids, plus the held slug: `shop_slugs WHERE market_id = $1 AND seller_id IN (…) AND state = 'held'` | A1; the held partial unique of 3.5 |
| A6 | Store name prefix search (7.8) | `seller_files WHERE market_id = $1 AND store_name_key >= $p AND store_name_key < $p‖U+10FFFF ORDER BY store_name_key LIMIT 26` | `(market_id, store_name_key)` (slice 2). Measured, 12 |
| A7 | Slug prefix search; slug availability; public read by slug (held only, Hassan M5) | Range or equality on `shop_slugs (market_id, slug)`; the public read adds `state = 'held'` | Unique `(market_id, slug)` |
| A8 | Exact identifier search; the reviewer's "every seller with this identifier, in any state" (brief s7; D 8.2) | `seller_files WHERE market_id = $1 AND identifier_index = $h`, plus `business_file_revisions` with the same predicate, plus `identifier_claims` by primary key; the seller ids are merged | Partial `(market_id, identifier_index) WHERE identifier_index IS NOT NULL` on `seller_files` (slice 3) and on `business_file_revisions` (slice 7a-read); `identifier_claims_pkey` |
| A9 | Current register result of a file; the approval guard's result for (seller, N's index) (Hassan L3) | `register_checks` by primary key | PK |
| A10 | Approval guard: checks of revision N | `review_checks` primary key range | PK |
| A11 | Reconciliation job: intents older than 5 minutes (D 7.3) | `seller_files WHERE market_id = $1 AND decision_intent IS NOT NULL AND decision_intent_since < $t` | Partial `(market_id, decision_intent_since) WHERE decision_intent IS NOT NULL` (slice 7a-decide): holds only the few in-flight rows |
| A12 | Decision event handler: revision by `basisId` (D 7.5) | `business_file_revisions` by `(market_id, id)` | PK |
| A13 | `taxProfileOf` as of an instant | 3.7 | `(market_id, seller_id, valid_from)` |
| A14 | Business history of a seller (VER-14; slice 19); the latest rejected identity change (Jafar 5) | Revisions by `(market_id, seller_id, revision_no)`; contact history by `(market_id, seller_id, changed_at)` | Unique of 3.2; index of 3.10 |
| A15 | Periodic re-check (slice 11): approved sellers whose current result is older than 90 days, at most 50% of the Market budget per window | Claims joined to `register_checks` by primary key, filtered by `checked_at` | `(market_id, checked_at)` on `register_checks`, added in slice 11 |
| A17 | Bulk request: every id in the request's Market, before any unit (Hassan M2) | `seller_files WHERE market_id = $1 AND seller_id IN (…)` with ≤ 50 ids, count compared | A1 |
| A16 | Outbox claim; inbox insert | PM1, PM4 | ID-data 3.1, 3.8 |
| A18 | `approvedSellerZones` for at most 100 ids (D 7.1a; request S-1 of `certification`; mini-review D 19, proposed by Mohammad, signed off by Mojtaba 2026-10-07). Slice 2: no read (answers `{ zone: null, addressZone: null }`); from slice 5 | As A1, in one read-only unit (ADR-0025), Prisma only (C10): (1) `seller_files` `findMany` where `{ marketId: $1, sellerId: { in: ids } }` selecting `sellerId`, `approvedRevisionId`; (2) for the non-null pointers, `business_file_revisions` `findMany` where `{ marketId: $1, id: { in: pointers } }` selecting `id`, `operatingTimezone` and `addressTimezone` (or the same as one nested relation select; Prisma may send it as two statements either way). `addressTimezone` is a clear, nullable column of the revision, added in slice 5 and copied at submit from `seller_files`, where `address_timezone` is derived on the server at every address save from the operating address only; NULL (a Phase-2 backfill revision) answers `addressZone: null`; no derivation and no key unwrap at read time. `marketId` is at the top level of both wheres (P 4.1); because `seller_id` is the primary key, the `market_id` predicate is what makes another Market's seller answer like an unknown id (D 7.1a row 2). Ids with no row or a NULL pointer answer `{ zone: null, addressZone: null }`. Two snapshots are safe: an approved revision's content never changes (3.2 grants), a superseded revision keeps its row (pointer FK RESTRICT), and the purge (10.1) never deletes a file with a pointer, so (2) always finds the revision (1) named, and the answer is the zone approved at (1). The status partial unique `..._approved_key` is a backstop, never this read's path (D 7.1a row 2; platform 10.9). No key unwrap | Unique `(market_id, seller_id)` on `seller_files` (A1); `business_file_revisions_pkey`, or unique `(market_id, seller_id, id)` if the relation keeps the three-column pointer (spike S2). Full indexes only, one probe per id; no new index, column or grant (`SELECT` is held, 8) |

**Not added, on purpose:**
- A GIN trigram index for "contains" search on the store name: D 7.8 asks for prefix search only.
  A trigram index costs every save and needs `pg_trgm`.
- An index on `seller_files.service_area_code` for the "outside service area" admin filter (D 10,
  16.2 item 5): it is one Market's few hundred rows; it arrives when the filter's query is written
  and measured.
- Any index on a `*_ciphertext` column (S4).
- `(market_id, created_at)` on `seller_files`: no list orders by creation.

The admin list combines a text search with an `identity` state tab only by first paging the
`sellers` side; D 7.8 says that combination is not offered in Phase 3, so no wider index is needed.

## 8. Grants

Under platform.md 10.2: hand-written in the `migration.sql` that creates the table, in the block
`-- Grants (database-designer): docs/design/data/sellers.md section 8`, to `mondapac_app` only,
mirrored in `down.sql` (every `REVOKE` before any `DROP`), nothing from the "Never" row, and the
expected map of the privilege test changed in the same PR. `GRANT USAGE ON SCHEMA "sellers"` is in
migration 2 (`sellers_files`). There is no sequence and no function for the application. The `extensions` schema
gets **no** grant at all (9.2).

`DELETE` follows Mohammad's rule (D 13.1: no `DELETE` except where the purge or a use case removes
rows) and arrives with the slice that first deletes from the table.

| Table | Privileges of `mondapac_app` (the Privileges line) | `DELETE` from | Reason |
|---|---|---|---|
| `outbox` | `SELECT, INSERT`, `UPDATE (published_at)` | Never (until the prune job) | PM2 |
| `inbox` | `SELECT, INSERT` | The platform prune job | PM4 |
| `seller_files` | `SELECT, INSERT, UPDATE` | 18 | Ordinary root; the purge deletes it |
| `business_file_revisions` | `SELECT, INSERT`, `UPDATE (status, status_changed_at, decided_at, decided_by_account_id, identity_decision_id, reject_reason_code, withdraw_cause, withdrawn_by_kind, withdrawn_at)` | 18 | Content immutable by privilege (3.2) |
| `review_checks` | `SELECT, INSERT, UPDATE` | Cascade only | Upsert while pending, `not-done` included; removed with its revision (a cascade needs no `DELETE` grant: ID-data 7) |
| `register_checks` | `SELECT, INSERT, UPDATE` | 18 | Latest result per value |
| `identifier_claims` | `SELECT, INSERT, DELETE` | 7a-decide | Never updated: a move is delete plus insert; released on refusal (D 3.6) |
| `shop_slugs` | `SELECT, INSERT`, `UPDATE (state, retired_at, ever_public, version)` | 5 (held, never-public rows: released by the seller before approval, by an admin, by the purge) | The slug and its holder never change |
| `admin_flags` | `SELECT, INSERT`, `UPDATE (cleared_at, cleared_by_account_id)` | 18 | Raised and cleared, never rewritten |
| `seller_admin_settings` | `SELECT, INSERT, UPDATE` | 18 | |
| `seller_allowed_product_types` | `SELECT, INSERT, DELETE` | 14 | A code row is added or removed, never edited |
| `seller_tax_profiles` | `SELECT, INSERT, UPDATE` | 18 | |
| `tax_registration_periods` | `SELECT, INSERT`, `UPDATE (valid_to)` | 3 | `DELETE` is granted in slice 3 because the repository's cancellation path ships in this slice (the cancel use case comes later). V2: a period is only closed; a future period may be cancelled (3.7, Q-M13) |
| `store_profiles` | `SELECT, INSERT, UPDATE` | 18 | |
| `store_profile_revisions` | `SELECT, INSERT` | 18 | Insert-only (3.8) |
| `contact_detail_history` | `SELECT, INSERT` | 18 | V4 append-only |
| `rate_counters` | `SELECT, INSERT, UPDATE, DELETE` | 2 | Counters; `UPDATE` also serves the guarded release of the two `reviewer-notice` kinds (3.11); purged after 48 hours |

Column-level `UPDATE` on four tables, under the four conditions of platform.md 10.2: none of these
tables has an `@updatedAt` column, so none is added; `version` is in the list where the table has
one and the root's save writes it (`shop_slugs`); `business_file_revisions` and
`tax_registration_periods` carry no `version`, because their root (`seller_files`,
`seller_tax_profiles`) holds it (S1). The test of platform.md 10.4 proves every other column
refuses with `42501`.

## 9. Migration plan

### 9.1 Order (one PR with a migration open at a time, `docs/process/parallel-tracks.md` rule 6)

Aligned with D 11.1 as revised at G2 (slices P1 and P2, 7a-read, 7a-decide, 7a-auto, 19).

| # | Slice | Migration | Contains |
|---|---|---|---|
| 1 | P2 (platform PR, before slice 3) | `platform_btree_gist` | `CREATE SCHEMA "extensions"`; `CREATE EXTENSION btree_gist SCHEMA "extensions"`; no grant. The same PR amends platform.md 10.5 guard 1 and adds the no-`USAGE` test (9.2, 9.6) |
| 2 | 1 | `sellers_files` | `CREATE SCHEMA "sellers"`; `outbox`, `inbox`; `seller_files` (slice-1 columns of 3.1); `seller_admin_settings`; `seller_tax_profiles`; `store_profiles` (without the pointer); schema `USAGE` and table grants |
| 3 | 2 | `sellers_file_details` | The slice-2 columns of `seller_files` (`timezone_source` and `address_timezone` included, spike 3 record) and their CHECKs; `(market_id, store_name_key)`; `shop_slugs`; `rate_counters`. **Implemented in slice 2b:** `20261008130000_sellers_file_details` (18) |
| 3a | 2 (Q-M25) | `sellers_draft_slug` | `seller_files.draft_slug` (`ADD COLUMN`, nullable, no default, `COLLATE "C"`) and `seller_files_draft_slug_check` (`NOT VALID` then `VALIDATE`, under `lock_timeout`); no index, no unique key, no grant change (the table-level grant covers it), no data change. **Implemented:** `20261008150000_sellers_draft_slug` (19) |
| 4 | 3 | `sellers_identifier_tax` | The identifier columns, their CHECK and partial index; `tax_registration_periods` with its exclusion constraint |
| 5 | 4a | `sellers_register_checks` | `register_checks`. **Implemented in slice 4a:** `20261008180000_sellers_register_checks` (21) |
| 6 | 5 | `sellers_business_file_revisions` | `business_file_revisions` (withdrawal columns included; nullable clear `address_timezone` with its zone CHECK `business_file_revisions_address_timezone_check`, NULL or a valid IANA zone) with its partial uniques and queue index; `seller_files.approved_revision_id` and its FK; `GRANT DELETE` on `shop_slugs` (Q-M21). **Implemented in slice 5a:** `20261008213000_sellers_business_file_revisions`, with `register_checks.compared_file_version` (22) |
| 7 | 6 | `sellers_list_index` | Partial `(market_id, last_changed_at, seller_id) WHERE approved_revision_id IS NULL` (9.3 decides whether `CONCURRENTLY`) |
| 8 | 7a-read | `sellers_review_checks` | `review_checks`; the partial `identifier_index` index on `business_file_revisions` |
| 9 | 7a-decide | `sellers_review_decisions` | `identifier_claims`; `admin_flags`; the decision-intent columns, CHECK, FK and partial index; `public_store_name` |
| 10 | — | (none) | Slice 8's grant-only migration is no longer needed: the `DELETE` on `shop_slugs` moved to slice 5 (Q-M21) |
| 11 | 10 | `sellers_contact_history` | `contact_detail_history` |
| 12 | 11 | `sellers_register_recheck` | `(market_id, checked_at)` on `register_checks`; `register-recheck` added to the `admin_flags` code CHECK |
| 13 | 12 | `sellers_store_profile_revisions` | `store_profile_revisions`; `store_profiles.published_revision_id` and its FK |
| 14 | 14 | `sellers_allowed_product_types` | `seller_allowed_product_types` |
| 15 | 18 | `sellers_purge_grants` | The `DELETE` grants of section 8 marked "18"; nothing else |
| 16 | 20 (D 18; for Mojtaba's sign-off) | `sellers_minimum_order` | The four nullable columns of 3.8 (`ADD COLUMN`, no default, no rewrite) and their five CHECKs, each `ADD CONSTRAINT … NOT VALID` then `VALIDATE` (9.3), under `lock_timeout`; no backfill (null = none); no grant change (`UPDATE` already granted). Down: drop the five CHECKs, then the four columns |
| — | Conditional | `sellers_area_open_notice` | The two columns of 3.1, only if the owner or Hadi accepts the "area open" mail (D 10), in the slice that builds it |

No migration: P1, 4b, 7a-auto, 7b, 8, 9, 13, 15, 16, 17 and 19.

### 9.2 The `btree_gist` extension (platform PR P2, before slice 3; Ali's O1 ruling)

The exclusion constraint needs `btree_gist` for the `=` on `market_id` and `seller_id`. Other
modules will need it for their V2 records (offer prices, commission rates, ADR-0009 decision 2), so
it is a platform migration in its own PR (D 11.1 P2), announced on the board, merged before slice
3's migration (ADR-0023 decision 5: "no later than"). Measured as a non-superuser database owner
(12):

- `btree_gist` is a trusted extension: the migration role (database owner) can create and drop
  it. Its 188 functions are owned by the bootstrap superuser, not by the migration role, so the
  migration role **cannot** revoke `PUBLIC`'s `EXECUTE` on them (warning "no privileges could be
  revoked"). The count is the contrib package of the server version measured (PostgreSQL 16);
  `CREATE EXTENSION` pins no `VERSION`, and the tests assert the schema and the privileges, not
  the function count.
- In its own schema `extensions` with no grant to `mondapac_app`, the application role cannot
  call any of them by name (`has_schema_privilege` false), and still inserts, updates and is
  refused on overlap: index maintenance needs no `USAGE` or `EXECUTE`.
- Consequence for platform.md 10.5 guard 1 ("a non-trigger function that `PUBLIC` may execute"
  fails the test): the narrow amendment of 9.6, approved by Ali, reviewed by Hassan in PR P2.
  The start-up self-check of 10.8 is unaffected: the functions' owner is not a role the
  application is a member of, and `extensions` gives it no `CREATE`. The bootstrap guard of
  platform.md 10.7 (every schema and relation owned by `mondapac_migrator`) also holds: the schema
  is the migrator's, and the extension creates functions and types, no relation.
- **Not on the application's `search_path`** (Hassan): nobody sets `search_path` for
  `mondapac_app` or the database, so it stays the default `"$user", public`. The exclusion
  constraint does not need it: a default operator class is found by type and access method, not
  by name (measured: the constraint was created with `extensions` off the migrator's path too).
- `down.sql`: `DROP EXTENSION btree_gist; DROP SCHEMA "extensions";`. It fails while a table uses
  the operator class, which is correct: migration 4's down drops the table first.
- Prisma: the extension is not declared in any model (the `postgresqlExtensions` preview feature
  stays off); spike S1 shows the drift check ignores it, a condition of PR P2 (Ali).
- Production (managed PostgreSQL): Kazem checks the provider's extension allow-list before the
  first deployed environment; not a merge blocker (Ali).

### 9.3 Safety on live tables

Today no deployed environment exists. The rules below apply to any migration that, when it merges,
would run against a deployed environment that holds `sellers` rows. Every migration starts with
`SET lock_timeout = '5s';` so a blocked `ALTER` fails instead of queueing every request behind it.

| Change | How |
|---|---|
| New nullable column with no default (slices 2, 3, 5, 7a-decide, 12) | `ALTER TABLE … ADD COLUMN`: a catalog change, brief `ACCESS EXCLUSIVE` lock, no rewrite |
| CHECK or FK on an existing table | `ADD CONSTRAINT … NOT VALID`, then `VALIDATE CONSTRAINT`. Prisma applies a file as one implicit transaction, so a `VALIDATE` in the same file as its `ADD COLUMN` or `ADD CONSTRAINT` gains no lock benefit (the earlier `ACCESS EXCLUSIVE` lock is held to the end). A populated live table puts `VALIDATE` in its own, later migration (`SHARE UPDATE EXCLUSIVE`; writes continue). The new columns are NULL in every existing row, so validation finds nothing |
| Index on an existing table (migrations 3, 4, 7, 8, 12) | With rows in a deployed environment: `CREATE INDEX CONCURRENTLY`, hand-written, **alone in its migration file**, because it cannot run in a transaction block. Whether Prisma applies a single-statement `CONCURRENTLY` file correctly is spike S3. Without such an environment: plain `CREATE INDEX` in the slice's migration |
| A NOT NULL column on an existing table | Avoided by design: every NOT NULL column of `seller_files` is created in slice 1 with the table. If one is needed later: add nullable, backfill in batches by `(market_id, seller_id)` keyset, add `CHECK (col IS NOT NULL) NOT VALID`, validate, `SET NOT NULL` (PostgreSQL then skips the scan), drop the CHECK |
| Rename or type change | Not planned. Expand (new column, dual write), backfill, contract in a later release |

Backfills, if any, run as a worker job in bounded batches (P 7), never inside a migration.

### 9.4 `down.sql` and reversibility

- Every `down.sql` mirrors its up in reverse: `REVOKE` first (platform.md 10.2), then indexes and
  constraints added to existing tables, then FKs between tables of the migration, then tables
  (children before parents), then columns added to existing tables. No `IF EXISTS`.
- Down of 2 (`sellers_files`) leaves the empty schema `sellers` and revokes its `USAGE`, as identity's migration 1
  does (the leftover check of platform.md 10.5 guard 2).
- Down of 6 drops `seller_files_approved_revision_id_fkey` before `business_file_revisions`; down
  of 9 drops `seller_files_decision_revision_id_fkey` and the intent CHECK before
  `identifier_claims`; down of 13 drops the pointer FK before `store_profile_revisions` (measured
  order, 12); down of 9 drops `admin_flags` too. Down of 6 also revokes `DELETE` on `shop_slugs`.
- Down of 3a (`sellers_draft_slug`) drops `seller_files_draft_slug_check`, then the column.
- Down of 1 (P2) drops the extension and the schema `extensions`; it runs after down of 4.
- A down drops columns and data: it is for an empty or development database. CI runs up, down, up
  (`pnpm db:check-reversible`) on every migration.
- My sign-off per migration: the checklist of platform.md section 8, the five review points of its
  10.2, the hand-written block equal to this document, and the partial-index list of 9.5.

### 9.5 Prisma specifics

- `prisma/schema/sellers.prisma`, models named by S2, each with `@@schema("sellers")`;
  `base.prisma` gains `"sellers"` in `schemas` (a shared file, in the PR of migration 2, `sellers_files`).
- Prisma expresses: the tables, the column types (`@db.Timestamptz(6)`, `@db.VarChar(8)`,
  `Bytes`, `@db.SmallInt`, `@db.Date`, `String[]`), primary and unique keys, plain indexes, and
  the composite FKs of C3, including the three pointer FKs whose fields overlap the primary key
  (`[marketId, sellerId, approvedRevisionId]`). Overlapping relation fields with the primary key
  are not measured with Prisma: spike S2. The fallback, if Prisma refuses them, is a pointer FK
  `(market_id, approved_revision_id)` → `(market_id, id)` and the same-seller rule left to the
  aggregate.
- Hand-written blocks appended to the generated `migration.sql`, as in platform.md section 6:
  every CHECK; the exclusion constraint; `COLLATE "C"` on `store_name_key`, `draft_slug` and `slug` (spike S1:
  whether Prisma's drift check sees a column collation; if it reports drift, the fallback is a
  `bytea` key of the UTF-8 bytes, which orders bytewise with no collation, measured by the same
  spike); the grants; and the partial indexes, invisible to Prisma (ID-data 8.4, A5) and listed for
  the catalog test:

```sql
CREATE INDEX "outbox_market_id_event_id_unpublished_idx" ON "sellers"."outbox" ("market_id", "event_id") WHERE "published_at" IS NULL;
CREATE INDEX "seller_files_market_id_identifier_index_idx" ON "sellers"."seller_files" ("market_id", "identifier_index") WHERE "identifier_index" IS NOT NULL;
CREATE INDEX "seller_files_market_id_last_changed_at_unapproved_idx" ON "sellers"."seller_files" ("market_id", "last_changed_at", "seller_id") WHERE "approved_revision_id" IS NULL;
CREATE INDEX "seller_files_market_id_decision_intent_since_idx" ON "sellers"."seller_files" ("market_id", "decision_intent_since") WHERE "decision_intent" IS NOT NULL;
CREATE UNIQUE INDEX "shop_slugs_market_id_seller_id_held_key" ON "sellers"."shop_slugs" ("market_id", "seller_id") WHERE "state" = 'held';
CREATE UNIQUE INDEX "business_file_revisions_market_id_seller_id_pending_key" ON "sellers"."business_file_revisions" ("market_id", "seller_id") WHERE "status" = 'pending';
CREATE UNIQUE INDEX "business_file_revisions_market_id_seller_id_approved_key" ON "sellers"."business_file_revisions" ("market_id", "seller_id") WHERE "status" = 'approved';
CREATE INDEX "business_file_revisions_market_id_kind_created_at_pending_idx" ON "sellers"."business_file_revisions" ("market_id", "kind", "created_at", "id") WHERE "status" = 'pending';
CREATE INDEX "business_file_revisions_market_id_identifier_index_idx" ON "sellers"."business_file_revisions" ("market_id", "identifier_index") WHERE "identifier_index" IS NOT NULL;
CREATE UNIQUE INDEX "admin_flags_market_id_seller_id_code_open_key" ON "sellers"."admin_flags" ("market_id", "seller_id", "code") WHERE "cleared_at" IS NULL;
CREATE INDEX "admin_flags_market_id_raised_at_open_idx" ON "sellers"."admin_flags" ("market_id", "raised_at", "id") WHERE "cleared_at" IS NULL;
```

- Exclusion constraints are not modelled by Prisma either; the catalog test also checks
  `tax_registration_periods_no_overlap_excl` by name and definition (`pg_constraint.contype =
  'x'`).

### 9.6 Amendment text for platform.md 10.5 guard 1 (to land in PR P2)

Written here for PR P2, where I apply it to `docs/design/data/platform.md` and Hassan reviews it;
platform.md is not edited before that PR (Ali's O1 ruling). The bullet of 10.5 "Guard 1 fails on: …
a non-trigger function that `PUBLIC` may execute" becomes:

> - a non-trigger function that `PUBLIC` may execute, **except** a member function of an extension
>   (`pg_depend.deptype = 'e'` with `refclassid = 'pg_extension'::regclass`) when all of these hold:
>   (a) the extension is named in the expected map together with its schema; (b) that schema is not
>   `public`; (c) `mondapac_app` has no `USAGE` on that schema and no role but the schema owner has
>   `CREATE` on it (`aclexplode(nspacl)`); (d) no `search_path` setting of `mondapac_app`, of any
>   role it is a member of, or of the database (`pg_db_role_setting`) names that schema. The guard
>   still fails on an extension that is not in the map, on a mapped extension in any other schema,
>   and when (c) or (d) stops holding. Today the map names one: `btree_gist` in `extensions`
>   (`docs/design/data/sellers.md` 9.2).

The expected map gains an `extensions` entry (`{ "extensions": { "btree_gist": "extensions" } }`)
and the schema `extensions` with **no** privilege for `mondapac_app`. New cases in `pnpm test:db`, on
the application connection: `has_schema_privilege('extensions', 'USAGE')` is false;
`current_setting('search_path')` does not name `extensions`; a direct call of one of the
extension's functions fails with `42501`; an insert that the exclusion constraint refuses still
fails with `23P01` (so the index works without `USAGE`). The leftover query of guard 2 needs no
change: down of P2 drops the schema. Points 10.7 (bootstrap ownership guard) and 10.8 (start-up
self-check) need no change (9.2).

## 10. Retention, purge and erasure (slice 18; D 8.4, D 14.2)

### 10.1 Which files the purge selects

`sellers.purge-abandoned-files`, a frequent job per hosted Market (P 7; ADR-0005 decision 6: the
cut-off is an instant, `now − fileRetention`, so no zone is involved):

```
seller_files WHERE market_id = $1
  AND approved_revision_id IS NULL          -- never approved (D 8.4)
  AND decision_intent IS NULL               -- no decision in flight (D 3.2)
  AND last_changed_at < $cutoff
  AND no pending revision                   -- Q-M5
ORDER BY last_changed_at, seller_id LIMIT 50
```

served by the partial index of A4. `fileRetention` waits for counsel (D 16.1 item 3); the job does
nothing until the Market configuration has a value, and its absence is never read as zero.

Before deleting, the use case asks `identity` (outside any unit) for the seller's state and skips
every seller that `identity` reports `approved` or `suspended` (D 8.4, Q-M5 confirmed). A seller
that `identity` reports `approved` with no approved revision (`file-check-needed`, D 3.3) is
therefore never purged. `identity`'s erasure use case refuses again unless the state is `pending`
or `rejected` and no `approved` decision ever existed (Hassan M7). Slice 18 must merge before seller
sign-up opens in a deployed environment (Hassan L11).

### 10.2 What one purge deletes (one unit per seller, re-validated under the root version)

**Re-validation first (Hassan M7).** The unit's first statement claims the root:

```
updateMany seller_files SET version = $v + 1
 WHERE market_id = $1 AND seller_id = $2 AND version = $v
   AND approved_revision_id IS NULL AND decision_intent IS NULL AND last_changed_at < $cutoff
```

with `$v` the version read at selection. No row changed means the file changed since it was
selected (a concurrent "submit again", a save, a decision): the seller is skipped and stays. One
row changed holds the file's row lock until commit. Every writer of the file raises the same
version, so a concurrent submission either committed first (the statement then changes nothing) or
waits on the lock and then fails as stale (P 10): the concurrent "submit again" never loses data,
and the purge never deletes a revision it did not see. The unit then checks "no pending revision"
(the partial unique of 3.2) under that lock and gives up if one exists.

Then, in this order, each statement with `market_id` and `seller_id` at the top level (P 4):
`review_checks` go with their revisions (cascade); `business_file_revisions`; `register_checks`;
`contact_detail_history`; `admin_flags`; `identifier_claims` (normally none); `tax_registration_periods`, then
`seller_tax_profiles`; `store_profiles.published_revision_id` set to NULL, then
`store_profile_revisions`, then `store_profiles`; `seller_allowed_product_types` (cascade), then
`seller_admin_settings`; the **held** `shop_slugs` row (the slug is released, brief s5); then
`seller_files` (where `version = $v + 1`). In the same unit, the outbox row
`sellers.seller-file-purged.v1` with aggregate version `$v + 1`, so the outbox unique key holds.
The pointers of `seller_files` are NULL by the selection, so the measured delete order (12) needs
no pointer reset. The `identity` side (R-9) runs in `sellers`' handler of that event (D 8.4, Q-M6
confirmed), at least once through the outbox and once through the inbox.

One seller per unit, up to 50 sellers per run: a failure rolls back one seller only, and a run is
bounded by `maxRunMs` (P 7). The job is safe to run twice and at once: the second runner's claim
statement changes no row.

### 10.3 What stays after a purge

| Stays | Why |
|---|---|
| Retired `shop_slugs` rows (opaque seller id) | A retired slug is never held again (brief s7); Q-M3. A purged file has none of its own: only a slug that was ever public is retired (3.5), and a purged seller never had an approved revision |
| `outbox`, `inbox`, `event_delivery` rows with the seller id | Ids only; pruned by their own jobs |
| `platform.audit_log` rows | Append-only, ids and codes only (platform.md 3.3) |
| Rate-counter rows of the seller's accounts and file | Keyed hashes only; gone within 48 hours (3.11) |
| The seller's subject key | `identity`'s to destroy (D 8.4; R-9) |
| Backups | The data counts as erased once backup retention has passed (ADR-0009 decision 6) |

The `identity` side (closing the accounts and `SellerAccess`, destroying the key) is not lost if the
process stops after the `sellers` unit commits: it runs from the purged event (10.2).

### 10.4 Erasure of an approved seller (later; CUS-03, D 14.2)

Not in Phase 3. For that design, the columns that destroying the key does **not** make unreadable,
and which must be deleted or overwritten: `store_name`, `store_name_key`, `public_store_name`, `draft_slug` (clear, personal-adjacent for a sole trader; deleted with the file row), the
held slug (public trading data, but still about a person for a sole trader), and every
`identifier_index` (`seller_files`, `business_file_revisions`, `register_checks`,
`identifier_claims`; S5). Everything else of the seller is ciphertext under the destroyed key.
Revisions that support invoices fall under legal retention first (ADR-0009 decision 6).
Erasure either clears `approved_revision_id` in the same unit that destroys the key, or leaves the revision's clear `operating_timezone` readable until it does. A18 then answers `null` for an erased seller, by design (D 7.1a row 2, purged file). The purge rule of 10.1 (never deletes a file with a pointer) governs only abandoned files; erasure is this section's rule. Decided with A18 in mind (Mojtaba F2).

### 10.5 Other retention

| Rows | Rule |
|---|---|
| Rate-counter rows | Hourly `sellers.purge-expired`: window started more than 48 hours ago |
| Withdrawn, rejected and superseded revisions of an approved seller | Kept: ADR-0009 decision 7 prunes "unpublished drafts after a configurable period", and no period is set. Open (14, O6) |
| Store profile revisions | Kept (each was published; ADR-0009 decision 7) |
| Old `register_checks` rows of values no longer used | Kept: a sticky negative must survive for its value. Bounded by the quota |

## 11. Volume and jobs

| Table | Rows expected (first year, one Market) | Growth control |
|---|---|---|
| `seller_files` and the three 1:1 roots | 10² to 10³ (10⁴ ceiling) | Purge of abandoned files (slice 18) |
| `business_file_revisions` | 1 to 5 per seller | None needed |
| `review_checks` | Market's check count per revision (about 5 to 10) | None needed |
| `register_checks` | 1 to a few per seller | Bounded by the per-account quota |
| `shop_slugs`, `identifier_claims`, `seller_allowed_product_types` | About one per seller; types tens per restricted seller | None needed |
| `tax_registration_periods`, `contact_detail_history` | A few per seller | None needed |
| `store_profile_revisions` | Tens per seller, each up to tens of kilobytes of ciphertext (TOAST) | Save rate limit of D 6.5; revisit at 10⁶ rows |
| `rate_counters` | A few rows per active account and file per window; under attack one per origin tried, for 48 hours | Hourly purge |
| `outbox` | About 10 to 30 events per seller over onboarding, plus admin actions | Kept as identity's (P 6.5) |

Nothing here approaches partitioning. `seller_files` is the update-heavy table (every draft save,
under its version); autovacuum defaults are enough at this volume, and its rows stay small because
the large values are TOASTed ciphertext.

| Job (P 7) | Every | Lock key (PM8, measured) | Work |
|---|---|---|---|
| `sellers.reconcile-decisions` | 1 minute (D 7.3) | `-3571191893713462933` | A11 rows older than 5 minutes; one unit per seller |
| `sellers.purge-expired` (Q-M7, confirmed) | 1 hour | `999926948550704151` | `rate_counters` rows |
| `sellers.purge-abandoned-files` | Frequent (slice 18) | `-4276354473761375432` | 10.1, 10.2 |
| Periodic re-check (slice 11, P2) | Named in that slice | Computed then | A15 in bounded batches; stops at 50% of the Market budget (3.11) |

None of the keys equals Prisma Migrate's `72707369`; the unit test of PM8 covers them.

## 12. Evidence

Measured on 2026-10-07 on PostgreSQL 16.15 in a throwaway database (ICU `en-US` default collation)
with throwaway roles shaped as platform.md 10.1 (a non-superuser owner, a `NOLOGIN` group, a login
member); everything was dropped afterwards.

| Verified | Used in |
|---|---|
| The exclusion constraint on `(market_id =, seller_id =, tstzrange [) &&)`: overlap refused; a closed period followed by one starting at its end accepted; the same seller id and range in another Market accepted | 3.7 |
| `btree_gist` created and dropped by the non-superuser owner (a real login, not `SET ROLE`); its functions owned by the bootstrap superuser; `REVOKE … FROM PUBLIC` by the owner has no effect; in schema `extensions` with no grant, the application login inserts, is refused on overlap, closes a period under `UPDATE (valid_to)`, runs the as-of query, and has no `USAGE`; another column's `UPDATE` fails (`42501`); the exclusion constraint was created by the owner with `extensions` off its `search_path` | 9.2, 8 |
| Prefix search on 100,000 rows under `plan_cache_mode = force_generic_plan`: `LIKE $1` filtered 60,113 rows (73 ms, 60,609 buffers), with the default and with `C` collation alike; the range on the `C` column was an index range scan (0.11 ms, 29 buffers) and returned exactly the `LIKE` rows | S6, A6 |
| Partial unique on pending revisions refuses a second one; the same-seller pointer FK accepts the seller's own revision and refuses another seller's; deleting a referenced revision is refused; the purge order (pointer NULL, revisions, file) succeeds; the down order (pointer FK, child, parent) succeeds | 3.1, 3.2, 9.4, 10.2 |
| Job lock keys (SHA-256 of `mondapac.job:<name>`, first 8 bytes, signed) | 11 |

Not measured: anything through Prisma (drift with a column collation, overlapping relation fields,
a `CONCURRENTLY` migration file, the extension and drift: spikes S1 to S3); PostgreSQL 17; glibc
`en_US.utf8` (the Compose image's collation; this session only had ICU `en-US`, where the punctuation
cases happened to agree); plans at real volume (no data yet).

**To measure in slice 5 (A18; Mojtaba F4, mini-review D 19):** Capture EXPLAIN (ANALYZE, BUFFERS) of both A18 statements, with 100 ids on the test data volume, in a generic plan (plan_cache_mode = force_generic_plan). Expected: index scans on seller_files_market_id_seller_id_key and on business_file_revisions_pkey (or the three-column unique). Record the result in 12.

## 13. Questions to Mohammad

### 13.1 Answered (D 14.3, 2026-10-07) and applied

| # | Point | Answer, and where it is applied here |
|---|---|---|
| Q-M1 | No `pending_revision_id` | Confirmed (3.1) |
| Q-M2 | Clear `public_store_name` | Confirmed, copied whenever the pointer moves, admin edit included (3.1) |
| Q-M3 | Retired slugs kept on purge | Confirmed (3.5, 10.3) |
| Q-M4 | Phase 2 sellers without a file | Backfill creates missing files only; `approval_required_at_registration` takes the Market value at backfill; no approval by `sellers` alone (Ali change 1); `file-check-needed` computed (3.1, A5); a backfilled revision leaves `address_timezone` NULL (no decryption in the backfill; A18 then answers `addressZone: null`, so `certification` answers `seller-zone-missing`) |
| Q-M5 | Purge skips pending, intent, `approved` and `suspended` | Confirmed (10.1) |
| Q-M6 | R-9 from the purged-event handler | Confirmed (10.2) |
| Q-M7 | Fixed 24-hour window; `sellers.purge-expired` | Confirmed (3.11, 11) |
| Q-M8 | Outcome and flags clear, compared values encrypted | Confirmed; brief s5 read directly agrees: "only the compared fields are kept … encrypted like the rest of the business data" (16.2) |
| Q-M9 | Admin edit of an approved seller | A revision by `admin`, approved in the same unit, with both keys and the reviewer guards (H1) (3.2) |
| Q-M10 | Contact history | Slice 10 (1, 3.10, 9.1) |
| Q-M11 | Plaintext limits | D 14.3 and Hassan: store name 100, business name 200, phone 32, contact email 254, address field 120, description 5,000, policy 10,000, meta 120/255/320, social URL 512. They fix the CHECKs of 3.1 and, with O2, the ciphertext bounds |
| Q-M12 | Type codes | Format from `catalog`'s G2; empty set refused (`types.empty`) (3.9, 6) |
| Q-M13 | Tax period corrections | No correction of a started period; a future period may be cancelled by `DELETE` (3.7, 8) |
| Q-M14 | `version` on slugs and claims; slug surrogate id | Confirmed |
| Q-M15 | `author_account_id` NOT NULL | Confirmed |
| Q-M16 | Migration count | Superseded by the G2 slice list (9.1) and Q-M24 |
| Q-M17 | No status on store profile revisions | Confirmed |
| Q-M18 | Identifier condition of may-sell | The approved revision's clear `identifier_index IS NOT NULL` when the Market's current configuration requires one (4.3) |

### 13.2 New at G2, answered (D 14.4, 2026-10-07) and applied

| # | Point | Answer, and where it is applied here |
|---|---|---|
| Q-M19 | Brief s5 (SEL-22) "email always mandatory" against an optional contact email | The brief means the sign-in email (`identity`); the contact email stays optional (3.1) |
| Q-M20 | Store of the admin flags | `sellers.admin_flags`, created in 7a-decide; `register-recheck` code with slice 11; clearing by `sellers.seller-file.review`, audited `sellers.admin-flag.cleared` (3.13, 8, 9.1, 10.2) |
| Q-M21 | Seller changes the slug before approval | Yes: the held row is deleted, no audit row; `DELETE` on `shop_slugs` moves to slice 5 (3.5, 8, 9.1) |
| Q-M22 | Withdraw limit key | Per seller file (3.11) |
| Q-M23 | Separate registered address | Yes (corrected after the first answer): optional, captured when it differs, encrypted, part of the revision content and of an identity change; only the operating address drives ServiceArea and time zone. `seller_files.registered_address_ciphertext` (slice 2) and the revision content (3.1, 3.2) |
| Q-M25 | Where the draft keeps the slug the seller chose (follow-up 8) | `seller_files.draft_slug`, nullable, clear, the `shop_slugs` slug rule as a CHECK, no key or index; saved by `my-file.save-slug`, which counts against both the save and the slug-check limits; the sixth completeness part; invariant I-S1 (3.1). Migration 3a (9.1, 19) |
| Q-M24 | P2 and 8 in D 11.1 | Done by Mohammad; after Q-M21 slice 8 has no migration (9.1), and D 11.1 already says so |

## 14. Open

| # | Point | Who |
|---|---|---|
| O1 | **Decided by Ali at G2:** own platform PR P2 before slice 3's migration; schema `extensions`; the narrow guard amendment of 9.6 written by me in that PR, reviewed by Hassan; spike S1 shows drift ignores the extension. Remaining: Kazem checks the managed provider's allow-list before the first deployed environment (not a merge blocker) | Kazem |
| O2 | Ciphertext envelope size (ID-data 11.4, K1), which fixes every `*_ciphertext` CHECK bound. **Slice 2b:** bounds sized from the `v1` envelope in code (4.5); open only for a later envelope version | Kazem, Hassan |
| O3 | The identifier index secret: where it lives per Region Stack (distinct from the throttle secret, boot check, backed up like the wrapping key: Hassan); the HKDF split into the index key and the rate-counter key (4.4, 3.11); rotation is not needed before launch (Hassan) | Kazem; Hassan confirms the split |
| O4 | Spikes, with Hossein: S1 Prisma drift with the extension (before P2 merges) and with `COLLATE "C"` columns (before slice 2's migration); S2 composite pointer FKs that overlap the primary key (before slice 5's); S3 a single-statement `CREATE INDEX CONCURRENTLY` migration under `prisma migrate deploy` (before the first deployed environment) | Hossein, with me |
| O5 | `fileRetention` (counsel; Hassan's view: 6 months for never-submitted drafts, 12 months for finally rejected files) and the ADR of D 14.2; slice 18 waits for both and must merge before seller sign-up opens in a deployed environment (L11). If counsel gives two periods, the purge selection of 10.1 splits by "ever submitted" (a revision exists), served by the same index | Owner (through Hadi); Ali |
| O6 | Pruning of withdrawn, rejected and superseded revisions of approved sellers (ADR-0009 decision 7 names a configurable period; none is set) | Hadi, counsel |
| O7 | Closed at G2: the list shows clear fields only under `sellers.seller.view` (Hassan M4), so no unwrap per row (4.3) | — |
| O8 | Erasure of an approved seller: the column list of 10.4 goes into the CUS-03 design | Mohammad, with `ordering` |
| O9 | **Closed 2026-10-07:** brief s5, s6, s7 and s11 read directly (`docs/modules/sellers/brief.md` in the worktree); the findings and the changes they caused are in 16.2 | — |
| O10 | The Prisma model file and the migrations of 9.1 | Hossein, per slice; each needs my sign-off |

## 15. Follow-up changes

This document changes no other file. After G2:

| File | Change | When |
|---|---|---|
| `docs/design/data/platform.md` | 10.5 guard 1: the text of 9.6; a pointer to 9.2 here | In PR P2; Mojtaba; Hassan reviews |
| `prisma/schema/base.prisma`, `sellers.prisma`; the migrations of 9.1 with `down.sql` | As specified | Per slice; Hossein |
| The privilege map and the catalog tests of `pnpm test:db` | Section 8 (column lists included); the partial-index list and the exclusion constraint of 9.5; `sellers.outbox` in "every outbox has the same columns"; `extensions` in the expected map and the tests of 9.6 | With each migration (9.6 in P2); Hossein |
| `.env.example` | The identifier index secret (D 17 already lists it): it now also keys the rate counters, so it is needed from slice 2, not 3 (O3) | Slice 2; shared-file PR |

## 16. G2 review record (2026-10-07)

### 16.1 Review items applied

Source: `g2-reviews.md` (Ali, Hassan, Jafar) and D 14.3, 16.4 as revised by Mohammad.

| Item | How it is applied here |
|---|---|
| Ali change 7: remove the comparison with the old slice list in 9.1 | 9.1: the paragraph is gone; the table follows the G2 slice list, with a "no migration" line |
| Ali change 7: `contact_detail_history` is slice 10 | 1 (table list), 3.10, 9.1 row 11 |
| Ali change 7 and Hassan M4: the key split | 4.3: the list reads clear fields only under `sellers.seller.view`; decrypting admin reads are under `sellers.business-details.view` and each writes `sellers.business-details.viewed`; O7 closed |
| Ali change 5: slices 7a-read, 7a-decide, 7a-auto, 19, P1, P2 | 1, 3.1, 3.3, 3.6, 7 (A8, A11, A14), 8, 9.1 |
| Ali change 1: no approval by `sellers` alone; backfill creates files only | 3.1 (`origin`, `approval_required_at_registration`, `file-check-needed` computed), A5, 10.1 |
| Ali's O1 ruling | 9.1 row 1 (own PR P2), 9.2 (`extensions` off the `search_path`, no `USAGE`, provider check not a merge blocker), 9.6 (amendment text and tests for that PR), 14 O1 |
| Hassan M6: retire only a slug that was ever public; `released` | 3.5 (`ever_public` with CHECK; delete on release; audit `sellers.slug.released`), 6, 8 (`DELETE` from slice 5 after Q-M21), 9.1 row 6, 10.3 |
| Jafar 4 and D 7.4: withdrawal cause, by kind and date | 3.2 (`withdrawn_by_kind`, `withdrawn_at`, CHECK), 8 |
| Jafar 5: only the latest rejected identity change | 3.2, A14 (no dismissal column) |
| Hassan L10 and his numbers | 3.11 (`rate_counters`: keyed by account, admin, origin, file and Market; fail closed with `access.unavailable`; every limit of D 6.5), 3.4 (`maxResultAge` 30 days), A15 (90 days, 50% budget), 8, 11 |
| Jafar 7: "area open" mail | 3.1 and 9.1: `area_open_notified_code` and `_at`, **conditional** on the owner's or Hadi's acceptance |
| Hassan M7: erasure re-check under the root version | 10.1, 10.2 (claim the root by a conditional version bump first; the concurrent submission wins) |
| Hassan L1: tax event `sellerId` only | 3.7 |
| Hassan M5: public read through the held slug only | 3.5, A7, 4.3 |
| Hassan L3: approval guard reads (seller, N's index) | 3.4, A9 |
| Hassan M2: bulk Market check before any unit | A17 |
| Hassan M3: claim re-taken; conflict flagged | 3.6, 3.13 (`admin_flags`) |
| Hassan H1 and Q-M9: admin edit of an approved seller | 3.2 |
| Hassan informational: index secret distinct, backed up, no rotation before launch | 4.4, O3 |
| Hassan L11: slice 18 before sign-up opens | 10.1, O5 |
| Q-M12, Q-M13 answers | 3.9, 6; 3.7, 8 (`DELETE` on tax periods from slice 3) |
| Mohammad's edits to this document (3.3 `not-done`, 3.9 per-setting change columns, 3.10 and 9.1 slice 10) | Kept as written |

### 16.2 O9: the brief read directly (s5, s6, s7, s11 against 3 and 13)

| Brief | Finding | Effect here |
|---|---|---|
| s5, register data: only compared fields kept, never the raw answer, encrypted like the rest of the business data, deleted with the file's retention; result bound to the current identifier, maximum age, set aside when the identifier changes | Matches 3.4 (`compared_values_ciphertext`; PK by identifier index) and 10.2 (purge deletes `register_checks`). Confirms Q-M8 | None |
| s5, SEL-22: "name, email and slug are always mandatory" | The sign-in email (D 14.4 Q-M19); the contact email stays optional | None |
| s5, tax registration: not held for review, applied from its date, audited | Matches 3.7 | None |
| s5, retention: the slug the file held is freed | Matches 10.2 (held row deleted) | None |
| s5, "other changes apply at once and their history is kept" | Store texts (V1) and contact details (V4, slice 10) | None |
| s5, the public profile is closed by default | Allow-list facade; nothing public in the schema but store name and slug | None |
| s6: business data, file, submissions with their checks, lookup results, profile revisions, admin-only settings; state and reasons are `identity`'s | Every item has a table in 1; nothing of `identity` is copied (5) | None |
| s6: blind keyed index for identifier uniqueness and list search; no personal data in paths or queries | S5, A8 | None |
| s7 (team proposal): the reviewer sees **every** seller with the same identifier, in any state | The draft index alone misses a seller whose revision carries the value but whose draft moved on | Partial index on `business_file_revisions.identifier_index` (3.2, A8, 9.1 row 8) |
| s7: identifier unique among approved and suspended sellers only; drafts, pending and rejected files hold no right | Matches 3.6 | None |
| s7: the operating address decides the area; a different registered address is captured separately | An optional registered address beside the operating address (D 14.4 Q-M23, corrected) | `registered_address_ciphertext` (3.1); in the revision content (3.2) |
| s7: "approval required" off affects only later sign-ups | `approval_required_at_registration` (3.1) | None |
| s11: slice order; the Market configuration in the database only with slice 15 | Matches 9.1 and 5 | None |

### 16.3 Reviews of this document

| Reviewer | Result | Date |
|---|---|---|
| Ali (cto) | Accept with changes (applied, 16.1) | 2026-10-07 |
| Hassan (security-tester) | Accept with changes (applied, 16.1); reviews 9.6 in PR P2 | 2026-10-07 |
| Mohammad (software-architect) | Q-M1 to Q-M24 answered (13.1, 13.2) | 2026-10-07 |

## 17. Mini-review 2026-10-07 (D 19): request S-1 and ADR-0026 (signed off by Mojtaba)

Proposed by Mohammad; **signed off by Mojtaba 2026-10-07** with his F1 applied. No table, column,
constraint, index, grant or migration changes.

| Change | Where |
|---|---|
| Access path A18 for the new facade read `approvedSellerZones` (D 7.1a), served by existing unique keys | 7 |
| `approvedSellerZones` added to the zero-unwrap reads | 4.3 |
| "Approval required" lives in the ADR-0026 platform store (accepted 2026-10-07), not in Market configuration only; the current policy is read in the deciding unit; a missing row gives `true`, a read error aborts the unit (Hassan L7) | 3.1 (`approval_required_at_registration` note), 5 |
| Mojtaba F1: A18 rewritten as two Prisma reads in one read-only unit (no join claim), with the snapshot argument; index cell names the full indexes | 7 (A18) |
| Mojtaba F2: erasure and A18 | 10.4 |
| Mojtaba F3: the setting code key (O-3 ruling) | 5 |
| Mojtaba F4: EXPLAIN of both A18 statements in slice 5 | 12 |

| Reviewer | Result | Date |
|---|---|---|
| Ali (cto) | Approve with conditions. O-1 accepted with the row 9 refusal; O-2 A; O-3 `<module>.<kebab-case>`; F4 is a merge condition on slice 15 | 2026-10-07 |
| Hassan (security-tester) | Accept with changes, L1-L8 applied; L9-L10 are follow-ups | 2026-10-07 |
| Mojtaba (database-designer) | Approved with F1 applied | 2026-10-07 |

## 18. Slice 2b migration `20261008130000_sellers_file_details` (2026-10-08; Mojtaba)

Written by Mojtaba from 3.1, 3.5, 3.11, 4.5, 8 and 9; the Prisma part generated with `prisma
migrate diff` from the previous schema, the rest hand-written. `pnpm db:check-reversible` (up,
down, up, then the drift check) passes on PostgreSQL 16.15. Each CHECK below was exercised once on a
scratch database (accepted and refused rows), and the application's `storeNameKey` output for
accented, full-width, Greek, Arabic, ligature and compatibility-letter names passes
`seller_files_store_name_key_check`. Spike 3's data changes for slice 2 (`timezone_source`,
`address_timezone` on `seller_files`, no coordinates) are signed off here; the revision columns (the revision's nullable `address_timezone` included, signed off with the slice 5 review) and
`kind` `zone-change` stay with slice 5.

| Table | Constraints and indexes added |
|---|---|
| `seller_files` (existing; not `NOT VALID`: new all-NULL columns, no deployed environment, 9.3) | `seller_files_store_name_check`, `_store_name_key_pair_check`, `_store_name_key_check`, `_business_name_ciphertext_check`, `_phone_ciphertext_check`, `_contact_email_ciphertext_check`, `_address_ciphertext_check`, `_registered_address_ciphertext_check`, `_service_area_code_check`, `_operating_timezone_check`, `_address_timezone_check`, `_timezone_source_check`, `_timezone_set_check`, `_timezone_address_check`, `_timezone_default_check`; index `seller_files_market_id_store_name_key_idx` (plain, not `CONCURRENTLY`: 9.3) |
| `shop_slugs` | `shop_slugs_pkey`; unique `shop_slugs_market_id_slug_key`; partial unique `shop_slugs_market_id_seller_id_held_key` (9.5); `shop_slugs_market_id_check`, `_tenant_id_check`, `_slug_check`, `_state_check`, `_ever_public_check`, `_retired_at_check`, `_version_check`; trigger `shop_slugs_one_way` with function `sellers.shop_slugs_guard_update()` (3.5, Hassan L1) |
| `rate_counters` | `rate_counters_pkey (market_id, kind, key_hash)`; `rate_counters_market_id_check`, `_tenant_id_check`, `_kind_check` (13 kinds), `_key_hash_check`, `_count_check` |

Grants: `shop_slugs` `SELECT, INSERT, UPDATE (state, retired_at, ever_public, version)`;
`rate_counters` `SELECT, INSERT, UPDATE, DELETE`; `seller_files` unchanged. The privilege map and
the partial-index list of `pnpm test:db` are updated in the same PR.

**PR #105 review (Hassan L1, L2, I1, I4; Sajad's gaps), applied in place before merge, same
timestamp:** the one-way trigger on `shop_slugs` (3.5); the envelope-shape backstop and the minimum
of 41 on every ciphertext CHECK (4.5); the `store_name` CHECK written with `\u` escapes only (the
bidi and Arabic-letter-mark characters had been stored as literal, invisible characters; same
semantics, but a reviewer could not see them). Tests in `apps/api/test/db/sellers-files.db-spec.ts`
(both Market fixtures): the `attcollation` catalog check of spike S1 for `store_name_key` and
`slug` (in place since the first commit of this PR); every CHECK above with an accepted and a
refused case (all five ciphertext bounds and shapes, store name C1 and bidi characters, key NFKC,
every zone case); the trigger (`23001`); the guarded release with its `window_started_at` guard (a
stale window changes 0 rows); `seller_files_market_id_store_name_key_idx` in `pg_indexes`.

## 19. Slice 2 migration `20261008150000_sellers_draft_slug` (2026-10-08; Q-M25)

Written by Hossein from Mohammad's amendment Q-M25 (3.1, 3.5, 9.1 row 3a); for Mojtaba's sign-off.
The column is nullable with no default (a catalog change, no rewrite) and `COLLATE "C"` by hand
(Prisma does not see a collation, spike S1). `seller_files_draft_slug_check` has the rule of
`shop_slugs_slug_check`; it is added `NOT VALID` and then `VALIDATE`d under `lock_timeout = '5s'`
(Mojtaba decides whether the plain form is preferable: the column is all NULL, so both forms scan
nothing of consequence). No index, no unique key, no grant change, no data change. `down.sql`
drops the CHECK and then the column. Tests in `apps/api/test/db/sellers-files.db-spec.ts` (both
Market fixtures): `attcollation` `C` for `draft_slug`; the CHECK accepts `abc`, `a-b-c` and 50
characters, refuses 2 and 51 characters, upper case, a leading or trailing hyphen, a double hyphen
and non-ASCII; two files may hold the same draft slug; no index names the column; a repository
round trip; a write over a stale version changes 0 rows; the privilege map is unchanged.

The migration changes no data on purpose. `draft_complete` is consumed only at submission (slice 5),
which re-checks completeness against the current Market configuration (section 6), and no real
seller drafts exist before this slice; existing development rows stay stale (a draft with no slug
reads `draft_complete = false` or a value computed without the slug) until their next save, which
recomputes it. `BackfillSellerFiles` (the sellers job that fills missing files) was checked: it
creates files through `SellerFile.create`, which sets `draft_complete = false`, and never sets it to
true. Slice 2 tests also cover a deterministic lost-update case (the version bumped by another unit
between load and save changes 0 rows, `conflict.stale`) and a retired slug, own or another
seller's, read as `taken` through the Prisma `findBySlug` mapping.

## 20. Slice 3 migration `20261008160000_sellers_identifier_tax` (2026-10-08)

| Reviewer | Verdict | Date |
|---|---|---|
| Mojtaba (database-designer) | Approved with D1 to D3 applied | 2026-10-08 |

Written by Hossein from 3.1, 3.7, 4.5, 8 and 9 (the Prisma part by hand, because the schema change is
two columns' worth of model and one table; `pnpm db:check-reversible` runs up, down, up and the drift
check, and passes on PostgreSQL 16). It depends on the P2 migration
(`btree_gist` in schema `extensions`).

| Object | What it adds |
|---|---|
| `seller_files` (existing; columns nullable, no default: a catalog change, 9.3) | `identifier_scheme`, `identifier_ciphertext`, `identifier_index` (`bytea`). `seller_files_identifier_scheme_check` (pattern of 3.1), `_identifier_ciphertext_check` (envelope shape and `BETWEEN 41 AND 512`), `_identifier_index_check` (`octet_length = 32`), `_identifier_set_check` (all three NULL or all set). Each CHECK is added `NOT VALID` and then `VALIDATE`d in the same file (9.3; the file is one implicit transaction, so this gives no lock benefit, which is acceptable because no deployed environment holds rows). Partial index `seller_files_market_id_identifier_index_idx (market_id, identifier_index) WHERE identifier_index IS NOT NULL` (plain `CREATE INDEX`: no deployed environment holds rows, 9.3) |
| `tax_registration_periods` (new) | The columns of 3.7 plus `market_id` and `tenant_id` (C1). Primary key `id`; composite FK `(market_id, seller_id)` to `seller_tax_profiles`, `RESTRICT`; index `(market_id, seller_id, valid_from)`; CHECKs `_market_id_check`, `_tenant_id_check`, `_effective_zone_check` (the `operating_timezone` pattern, at most 64), `_valid_to_check` (`valid_to IS NULL OR valid_to > valid_from`), `_recorded_by_kind_check` (`seller`, `admin`); exclusion constraint `tax_registration_periods_no_overlap_excl` exactly as 3.7 |
| Grants | `tax_registration_periods`: `SELECT, INSERT, UPDATE (valid_to), DELETE` to `mondapac_app` (section 8; `DELETE` is granted here because the repository's cancellation path for a period that has not started ships in slice 3, Q-M13; the cancel use case comes later). Nothing else changes |

Decisions taken here (confirmed by Mojtaba in his review: DELETE grant now, bound 41 to 512, the gist exclusion, no FK for `identifier_scheme`):

- **Ciphertext bound 512** for `identifier_ciphertext`. A normalised identifier is at most 64
  characters (the application's input bound, `IDENTIFIER_INPUT_MAX_LENGTH`; the real schemes are 9 to
  11) of at most 4 bytes, so at most 382 characters in the `v1` envelope (4.5); 512 is the bound of
  `phone_ciphertext` and the next power of two.
- **The exclusion constraint's `market_id WITH =`** is on a `varchar(8)`: it needed no operator-class
  name, the default class is found by type (9.2). Measured by the db test below on both Market
  fixtures.
- **No unique key on `identifier_index`**: a draft gives no right to a number (brief s7). The claim
  is slice 7a-decide's `identifier_claims`.
- **`down.sql`** revokes the grant, drops the index and the four CHECKs, drops the table (its CHECKs,
  the exclusion constraint, the index and the FK go with it) and then the three columns.

Tests (`apps/api/test/db/sellers-files.db-spec.ts`, both Market fixtures; `outbox-catalog.db-spec.ts`;
`privileges.db-spec.ts` through `expected-privileges.ts`): every CHECK of the three columns with
accepted and refused rows (envelope shape, 41 and 512, scheme pattern, index length, all-or-none);
the partial index by `pg_indexes` and in the checked-in list; two files may hold one index; the
exclusion constraint refuses overlapping, nested, open-with-open and one-millisecond overlaps and
accepts an adjacent period and another seller's identical span, and is in the catalog test of
exclusion constraints by name and definition (`contype = 'x'`); every CHECK and the foreign key of the
periods table; `42501` for an update of any column but `valid_to`; a repository round trip that
closes the open period, answers "as of" an instant and keeps the local date and zone; a cancellation
that re-opens the previous period; a lost race on the root's version changes nothing, and of two
parallel recordings exactly one commits.

## 21. Slice 4a migration `20261008180000_sellers_register_checks` (2026-10-08)

| Reviewer | Verdict | Date |
|---|---|---|
| Mojtaba (database-designer) | Approved, with the notes below | 2026-10-08 |

Written by Hossein from 3.4, 3.11, 4.5 and 8 (the table by `prisma migrate diff`, the rest by hand;
`pnpm db:check-reversible` runs up, down, up and the drift check, and passes on PostgreSQL 16). It
has no dependency on an earlier migration beyond `seller_files`.

| Object | What it adds |
|---|---|
| `register_checks` (new) | The columns of 3.4 plus `market_id` and `tenant_id` (C1). Primary key `(market_id, seller_id, identifier_index)`; composite FK `(market_id, seller_id)` to `seller_files`, `RESTRICT` (so a result is never written under another Market's file, and a file with results is not deleted from under them). CHECKs `_market_id_check`, `_tenant_id_check`, `_identifier_index_check` (`octet_length = 32`), `_outcome_check`, `_mismatches_check`, `_definite_negative_check`, `_compared_values_ciphertext_check`, `_checked_by_kind_check`, `_checked_by_account_id_check` |
| Grants | `register_checks`: `SELECT, INSERT, UPDATE` to `mondapac_app` (section 8; `DELETE` stays with slice 18). The privilege map of `pnpm test:db` is updated in the same PR. No other grant changes; no index beyond the primary key (A9 is a primary key probe; A15 adds `(market_id, checked_at)` in slice 11) |

Decisions taken here (for Mojtaba to confirm):

- **`mismatches` is `NOT NULL`**, as 3.4 says, by a hand-written `ALTER COLUMN … SET NOT NULL`: Prisma
  emits a scalar list without it, and the drift check accepts the stricter column (measured).
- **`_definite_negative_check` is stricter than 3.4.** 3.4 requires the mark on a negative outcome;
  the CHECK also requires **no** mark on an `active` outcome. A successful lookup replaces a definite
  negative (the register is the authority; "Only after a successful re-lookup", D 3.4), and a later
  `unavailable` keeps it (AC 31). The domain's `registerCheckAfter` and the repository write exactly
  this; the CHECK is the backstop.
- **`compared_values_ciphertext` is never written in slice 4a.** The register's agreement is not
  reviewed (D 7.7, 16.2 item 3), so the column stays NULL and no field label
  `sellers.register-check.compared-values` exists in code yet. Its CHECK is in place: NULL or the
  envelope shape with `BETWEEN 41 AND 2048` (a 200-character business name and a postcode in a JSON
  wrapper at four bytes a character, rounded up to the next power of two, 4.5).
- **The sticky negative is kept without a read-modify-write.** `PrismaRegisterCheckRepository.record`
  inserts the row if absent (`createMany … skipDuplicates`), sets the mark only where it is still
  NULL, and then writes the latest answer (touching the mark again only to clear it for `active`).
  Each statement is atomic and every CHECK holds after each one (the mark is set before a negative
  outcome is written). Tested with parallel writers.
- **Quotas, in code and not in this migration.** The three `lookup.*` kinds were already in the slice-2
  CHECK (11). Each is reserved in a unit of its own that holds one counter, in the order account,
  origin, Market, stopping at the first refusal, so a refused attempt does not spend the next counter
  (D 7.7 describes one unit with all three; the Market budget therefore counts calls that were made,
  and a refused account cannot burn the Market budget). No unit holds two counter locks.
- **`down.sql`** revokes the grant and drops the table (its CHECKs, the primary key and the foreign
  key go with it).

Tests (`apps/api/test/db/sellers-files.db-spec.ts`, section "slice 4a", both Market fixtures;
`privileges.db-spec.ts` through `expected-privileges.ts`): every CHECK with accepted and refused rows
(outcome, flags, the mark on negative and active, checker kind and account, index length, ciphertext
bounds and shape, Market and tenant patterns, the NULL list); the primary key, the foreign key to a
missing file and to another Market, `RESTRICT` on the file, two sellers holding one value; `42501` on
`DELETE`; the repository round trip, the sticky negative through unavailable, a second negative and an
active answer, and three parallel writers on four values; no read or write across Markets; the
seller's save, read and the reviewer's read against PostgreSQL with the `fake` adapter (outcome, flags
and instants only in the row, the three quota counters, `lookup.limit` writing nothing, the `none`
Market reserving and writing nothing). No partial index and no exclusion constraint are added, so
`outbox-catalog.db-spec.ts` needed no change.

**Mojtaba's review (2026-10-08).** Reviewed the migration, `down.sql`, Prisma model, privilege map and the
register block of `sellers-files.db-spec.ts` against 3.4, 3.11, 4.5, 8 and 10.2. `pnpm db:check-reversible`
passes and `sellers-files` plus `privileges` db specs pass (107 tests, PostgreSQL 16). No edit to the SQL was needed.

- **(a) Stricter `definite_negative` CHECK: accepted.** It backs the rule "only a successful re-lookup clears a
  negative" and the repository's three-statement write satisfies it after every statement. Under READ COMMITTED
  one interleaving (writer A clears the mark with `active` between writer B's mark-set and B's outcome update)
  makes B's last statement violate the CHECK (`23514`): the unit rolls back and the answer is an error, never a
  corrupt row. That is fail-closed and rare (the row lock is held from the first `UPDATE`); the caller must treat
  `23514` from `record` as a failed store (file stays as before), not retry blindly.
- **(b) Three single-counter units: accepted** for the lookup kinds. No unit holds two counter locks, so the
  fixed-order rule has nothing to violate, and a refused account does not spend the Market budget. Cost: an
  origin refusal has already spent one account attempt (consistent with "an attempt that was made counts"). Section
  3.11 describes one unit for the lookup kinds; read it as superseded here for `lookup.*` (the order account,
  origin, Market stays).
- **(c) No seller retry after `unavailable` until the result ages out: accepted for 4a only.** It is a functional
  rule, not a schema fault (the row is replaceable at any time). It must not reach production Markets with a real
  register: the `recheckInterval` key (short, minutes to an hour) has to make an `unavailable` row due again before the
  first non-`none` adapter ships, without a schema change. Owner: product-owner / Hossein, tracked with the open question in the brief.
- **Erasure:** the purge (slice 18) must delete `register_checks` before `seller_files` (FK `RESTRICT`) and grants
  `DELETE` then; `identifier_index` is pseudonymous personal data and goes with the file (10.2).
- **Indexes:** none beyond the PK is right (A9 is a PK probe; the table has 1 to a few rows per seller). The unique
  `(market_id, seller_id, identifier_index)` leads on `market_id`.

**Not built in slice 4a (waits for a shared-file change):** the `sellers.registerLookup` keys of
Market configuration (D 4.1) are not in the schema of `platform/market-config` yet. The lookup is
built against a `RegisterLookupPolicy` port; until the keys land the provisional adapter answers
`none` for every Market, so no deployed Market reaches a register. The shape the configuration needs:
`sellers.registerLookup = { adapter, manualLinkTemplate?, maxResultAge (days), perAccountLimit,
perOriginLimit, marketDailyBudget, reviewerLimit, recheckInterval, legalSuffixes[] }`, with `adapter`
`none` as the default and checked at start-up against the adapters of `infrastructure/register-lookups/`
(`legalSuffixes` is not in the D 4.1 table: the name comparison of D 7.7 says "legal suffix list from
configuration").

**Staleness of an `active` result (Hassan M1, 2026-10-08; no migration).** The comparison skips a field
that is empty in the draft, and `register_checks` keeps no record of which fields were compared. The
result is therefore trusted only for the draft as it was: the state is `stale` when
`seller_files.last_changed_at` is later than `register_checks.checked_at` (both existing clear
columns), in addition to the age rule. `blocksApproval` is then true, `mismatches` are not shown, and
the reviewer view carries `staleReason` (`aged` or `draft-changed`); the seller still sees only
matched / not-matched / could-not-be-checked / nothing. Any saved change of the draft counts (the
conservative reading), so an edit of the phone also asks the register again on the next identifier save.
The seller save asks again when the stored `active` result is older than `last_changed_at`, within the
same three quotas; a definite negative and an `unavailable` result are unchanged. Residual: an edit
saved between the draft read of a lookup and the write of its result is not seen (a window of one call).

**Race closed (Hassan, second review; no migration).** An `active` result is stamped with the instant
of the draft snapshot it was compared against (the file as the identifier save left it, read in that
unit: the later of its `last_changed_at` and the read instant), not with the time the register
answered. The write unit reads the file again: if its version is no longer the snapshot's, the result
is stored already stale (stamped one nanosecond before that edit). `registerStateOf`, `lookupDue` and
`registerCheckIsCurrent` share one rule (`last_changed_at > checked_at` means stale). Residual: an edit
whose stamp was taken before the snapshot read but that commits after the write unit's re-read is not
seen (also an edit stamped in the same millisecond as the snapshot, or on an instance whose clock is
behind). Timestamps cannot detect these, and a row lock at submit alone does not close them either.

**Slice 5 security condition (Hassan M1 residual; blocks the slice 5 merge).** The register result is
bound to the file version it was compared against. Add `compared_file_version` to `register_checks`
(migration signed off by database-designer). `runLookup` writes the snapshot's version and the write unit
keeps the existing re-read. `registerCheckIsCurrent` returns true for an `active` result only if
`compared_file_version` equals the file's current `version` and the age rule holds; a definite negative
keeps its behaviour. Submit evaluates `registerCheckIsCurrent` in the same transaction as the submit
transition, with the file row locked or under the submit's own version CAS on the version it checked. If
the result is not current, submit continues as "not performed" (manual check needed, `blocksApproval`
true) and never treats it as a clean `active`. Required tests on AU and ZZ: (a) a no-change identifier
save racing a general save that commits after the re-read; (b) an edit stamped in the same millisecond as
the snapshot; (c) an edit committed between the currency check and the submit transition. All three end
with the result not current.

Notes for later slices:

- **The tax answer is outside `last_changed_at`.** The comparison also reads `registeredForIndirectTax`
  from the tax profile. The slice that records the tax answer must make the register result stale too
  (bump the file's version and `last_changed_at`, or include the tax profile version in the rule), and
  must decide how a future-dated tax period is compared (today the period in force at the comparison
  instant is used).
- **`lookup.limit` counts repeat lookups.** The per-account limit counts every lookup that is due,
  including a repeat of the same value after a draft change or after aging, not only new values.

## 22. Slice 5a migration `20261008213000_sellers_business_file_revisions` (2026-10-08)

| Reviewer | Verdict | Date |
|---|---|---|
| Mojtaba (database-designer) | Pending | |
| Hassan (security-tester), the register version binding | Pending | |

Written by Hossein from 3.1, 3.2, 3.4, 3.11, 4.5, 8 and 9 (the table and the two columns by
`prisma migrate diff`, the rest by hand; `pnpm db:check-reversible` runs up, down, up and the drift
check). Slice 5a is schema, domain and repository only: no submit use case, no withdraw on edit, no
`onboardingSteps`, no reviewer notice (slice 5b), and no move of the approved pointer (7a-decide).
It depends on `seller_files` and `register_checks`.

| Object | What it adds |
|---|---|
| `business_file_revisions` (new) | The columns of 3.2 plus `market_id` and `tenant_id` (C1). Primary key `id`; unique `(market_id, seller_id, revision_no)` and `(market_id, seller_id, id)` (the pointer target); composite FK `(market_id, seller_id)` to `seller_files`, `RESTRICT`. 24 named CHECKs `business_file_revisions_<name>_check`: `market_id`, `tenant_id`, `kind`, `revision_no`, `status`, `author_kind`, `content_ciphertext`, `content_schema_version`, `content_hash`, `identifier_index`, `operating_timezone`, `address_timezone`, `service_area_code`, `register_outcome`, `register_mismatches`, `register_checked_at`, `status_changed_at`, `decided_at`, `decided_by_account_id`, `identity_decision_id`, `reject_reason_code`, `withdraw_cause`, `withdrawn_by_kind`, `withdrawn` (cause, who and instant together, and `status = 'withdrawn'` exactly with a cause). `register_mismatches` is `NOT NULL` by a hand-written `ALTER COLUMN` (as 21) |
| Partial indexes (9.5) | `business_file_revisions_market_id_seller_id_pending_key` (unique, one pending per file, either kind), `..._approved_key` (unique, one live approved), `business_file_revisions_market_id_kind_created_at_pending_idx` (the reviewer queue). Added to the catalog test `outbox-catalog.db-spec.ts`. The `identifier_index` partial index and `review_checks` stay with 7a-read |
| `seller_files.approved_revision_id` | Nullable `uuid`, no default (a catalog change, no rewrite). FK `seller_files_market_id_seller_id_approved_revision_id_fkey` `(market_id, seller_id, approved_revision_id)` to `business_file_revisions (market_id, seller_id, id)`, `RESTRICT` both ways, default `MATCH SIMPLE` (an empty pointer is not checked). Prisma accepts the overlapping fields (spike S2: no fallback needed). Nothing moves the pointer in 5a; the file repository now reads `hasApprovedRevision` from it, so a pointed file refuses every draft save |
| `register_checks.compared_file_version` | `integer NOT NULL`, CHECK `>= 1` (`NOT VALID` then `VALIDATE`, 9.3). See the decision below |
| Grants (section 8) | `business_file_revisions`: `SELECT, INSERT` and `UPDATE` on nine status columns, to `mondapac_app`; `shop_slugs`: `DELETE` (Q-M21, 9.1 row 6). `seller_files` and `register_checks` keep their table-level grants, which cover the new columns. `apps/api/test/db/expected-privileges.ts` is updated in the same PR |
| `rate_counters` | **No change** (see the block below) |

**`rate_counters` kinds (isolated for Mojtaba's sign-off).** 3.1, 7.3 and 3.11 name four kinds for
slice 5: `submit.file` (5 per 24 h), `withdraw.file` (10 per 24 h), `reviewer-notice.seller` (1 per
fixed 6 h window) and `reviewer-notice.market` (1 per fixed 15-minute window). All four are
already in `rate_counters_kind_check` since slice 2b (13 kinds; 3.11 says "no later slice alters it"; the
two reviewer-notice kinds were added before that migration merged, Ali R-3). The migration
therefore touches neither the CHECK nor the table, and the guarded release of the two
reviewer-notice kinds uses the table-level `UPDATE` of section 8. A db test asserts the four kinds
are accepted and an unknown `reviewer-notice.other` is refused. If Mojtaba wants the list changed,
that is a separate, additive step.

**Decisions taken here (for Mojtaba to confirm):**

- **`compared_file_version` is `NOT NULL`, and existing rows are backfilled with 1.** The column is
  added as `INTEGER NOT NULL DEFAULT 1` and the default is dropped at once: PostgreSQL stores a
  constant default in the catalog, so there is no rewrite and no batch job, and every later insert
  must state its version (the model has no default, and the drift check passes). Why 1 is safe: a
  result exists only after an identifier save, which raises the file to version 2 at least, and a
  version is never lowered, so a pre-existing row never equals its file's current version; it is
  not current, the next save asks the register again (or a reviewer decides on a manual check).
  A definite negative keeps its behaviour (it never depends on the version). No deployed
  environment holds rows today (9.3).
- **The rule is "equal", not "not older".** `draftChangedSince` is true when `lastChangedAt` is
  later than `checked_at` **or** the file's version differs from `compared_file_version`, in either
  direction. `registerStateOf`, `staleReasonOf`, `lookupDue`, `sellerResultOf` and
  `registerCheckIsCurrent` all take the file's version; the reviewer view and `my-file.read` pass
  the version they read in the same unit. `runLookup` writes the version of the snapshot it compared
  (the write unit's existing re-read still stamps a result already stale when the file moved). A
  later answer replaces the version of an earlier one; a slower writer with an older snapshot can
  therefore make a good result not current, which fails closed.
- **Consequence for the quota (not a schema fault).** A value the seller leaves and comes back to
  was compared against an older draft version, so its result is stale and the lookup is due again;
  it counts against `lookup.limit` (the note at the end of 21). The 4a tests that expected "a value
  that comes back is not asked again" only held because their clock did not move; they now assert
  the deterministic behaviour. Hadi may want a gentler rule for a value that comes back with
  nothing else changed; that is a product decision, not part of 5a.
- **Revision content bound: `BETWEEN 41 AND 32768`.** The 4.5 rule applied to the whole object:
  store name (100), business name (200), two addresses (about 6 KB of JSON each), identifier
  (64), phone (32), contact email (254) and the tax answer come to at most about 16,000 plaintext
  bytes, so about 21,400 characters in the v1 envelope, rounded up to the next power of two.
  `content_schema_version` is a `smallint >= 1`; v1 carries `schemaVersion` inside the sealed JSON
  as well, so the bytes are self-describing.
- **Content and hash.** The sealed text is the RFC 8785 canonical JSON of the content (the kernel's
  `canonicalJson`, sorted keys, nothing optional: absent members are `null`). The hash is
  `SubjectKeyService.hmac(market, sellerId, 'sellers.business-file.content', those bytes)` as
  `hmac-sha256:<hex>`. The label is `sellers.business-file-revision.content`. Opening the content
  and hashing it again reproduces `content_hash`. Both die with the seller's key.
- **`address_timezone` is copied, not derived.** `evaluateSubmission` copies the draft's stored
  `addressTimezone` (the region's default, set at the address save), never the operating zone and
  never a fresh derivation. A submission with no zone is refused as incomplete.
- **CHECKs beyond the text of 3.2**, each implied by it, for Mojtaba to confirm:
  `status_changed_at = created_at` while `pending` (3.2 "equals created_at while pending");
  `decided_by_account_id IS NULL OR kind = 'identity-change'` ("identity changes only");
  `register_outcome` includes `not-performed`, so the snapshot of a submission with no usable result
  is storable; `reject_reason_code` also has the S8 pattern.
- **`Revision<T>` stays in the `sellers` domain** (as `EffectivePeriod` did, 2.4): the sellers
  design names the kernel as its home, but a kernel change is a shared-file PR and no second
  module needs it yet.
- **A refused insert does not abort the unit.** The repository inserts with `createMany …
  skipDuplicates` (`ON CONFLICT DO NOTHING`, which covers the partial unique keys), then names the
  key that was taken (`revision.id-taken`, `revision.number-taken`, `revision.pending-exists`). A
  thrown unique violation would put the surrounding transaction in the aborted state.
- **The approved revision is read through the pointer** (`findApproved`: the pointer on
  `seller_files`, then the revision by that id). The status column and the partial unique are a
  backstop, not the authority (3.1).
- **`down.sql`** revokes both grants, drops the pointer FK, the table, the pointer column, the
  CHECK and the `register_checks` column.

**Open points (for Mojtaba, Hassan and Hadi; none blocks 5a):**

1. **`DELETE` on `shop_slugs` guard (Mojtaba C1, resolved in 5a).** The migration adds a
   `BEFORE DELETE` trigger `shop_slugs_no_delete_public` that refuses `state = 'retired' OR
   ever_public` for every role (3.5: a retired slug outlives the purge). A db test covers it.
2. **The pointer and the status are two facts.** Nothing in the database requires the revision the
   pointer names to be `approved`; the pointer FK only requires it to belong to this seller. The
   move of the pointer (7a-decide) must set status and pointer in one unit, and a test there asserts
   the pair.
3. **The repository does not yet change a revision's status.** Withdraw, supersede, approve and
   reject are domain transitions (`withdrawn`, `superseded`, `canTransition`) with no persistence
   until 5b and 7a-decide add the guarded `updateMany`s (each `WHERE status = 'pending'`, so a lost
   race writes nothing).
4. **Purge order (slice 18).** `business_file_revisions` has `DELETE` from nobody until then. The
   purge deletes the pointer's target only after clearing `approved_revision_id`, and deletes the
   revisions before `seller_files` (`RESTRICT` both ways).

**Tests** (`apps/api/test/db/sellers-business-file-revisions.db-spec.ts`, both Market fixtures;
`privileges.db-spec.ts` through `expected-privileges.ts`; `outbox-catalog.db-spec.ts` for the three
partial indexes): every CHECK with a refused row and the boundary values accepted; one
pending per file (either kind), one approved, the revision number, a freed slot after a
withdrawal; the FKs (missing file, another Market, a pointer to another seller's revision,
`RESTRICT` both ways); `42501` on the update of every non-status column and on `DELETE`; the
`shop_slugs` delete; the repository (insert, every read, Market isolation, the three refusals that
keep the unit usable, two and three concurrent submissions converging on one, the sealed content with
a real subject key, which another seller's key does not open, and the snapshot columns of
`evaluateSubmission`); the version binding of register results (the column, its CHECKs, the three
races of Hassan's condition at repository level); the four rate-counter kinds.

**Left for slice 5b as use-case tests (AU and ZZ), listed here so they are not lost:**

1. Hassan (a), at use-case level: `my-file.save-identifier` with no change racing a general save
   that commits after the write unit's re-read, then `submit`: the revision snapshot says
   `not-performed` and `blocksApproval` is true.
2. Hassan (b): an edit stamped in the same millisecond as the snapshot, then `submit`: the same.
3. Hassan (c): an edit committed between the currency check and the submit transition. The
   submit evaluates `registerCheckIsCurrent` in the same unit as the transition, with the file row
   locked or under its own version compare-and-set on the version it checked (the repository test
   shows the compare-and-set loses after the edit); the use case must also assert this end to end.
4. The submit itself: completeness against the current Market configuration, the ServiceArea with
   onboarding on, the slug hold, `submit.file` and `withdraw.file` reservations, the event, the
   handler's `reviewer-notice` reservation and release.
5. Withdraw on edit (one `UPDATE … WHERE status = 'pending'`) and the guarded release of the
   reviewer-notice counter.
6. `approvedSellerZones` reading the approved pointer and revision (7.1a rows 1 to 3 and 7), with a
   fixture approved revision; the ordering and caller-independence tests re-run with real rows; no
   identity-approved seller answers `null` after the backfill (7.1a row 2, Ali F2); the A18 plans
   recorded (12, Mojtaba F4).

**Carried to 5b and 7a (Mojtaba C2, Hassan L1, I2):** 7a-decide sets status and pointer in one unit
(a test asserts the pair; consider a deferred constraint trigger and a one-way status trigger
there). 5b and 7a update revision status with `WHERE status = <from>` and check the row count.
5b makes `register_checks` writes version-monotonic (`WHERE compared_file_version <= :new`; a
lower version never clears `definite_negative_at`), with a db test for the out-of-order case.
