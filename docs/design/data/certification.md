# Physical data model — `certification` schema (G2)

**Author:** Mojtaba (database-designer) — 2026-10-07
**Status:** G2 approved 2026-10-07: Ali (cto) approved for G2; Hassan (security-tester)
accepted with conditions, applied (section 17); Reza's `ux.md` complete. Nothing here exists yet. This document is the specification the `certification` migrations are
written from, and each migration still needs my sign-off. The review rulings of 2026-10-07 (Ali and
Hassan, relayed by the coordinator) and the hand-off list of D 16.1 items 1 to 11 are applied
throughout; section 16 maps each one, section 17 records the G2 review. Open points: sections 13
and 14.
**Ground truth:** `docs/design/domain/certification.md` (Mohammad's G2 domain design, cited as **D**,
for example "D 4.2"); `docs/adr/0028-certification-claim-contract-amendments.md` (Proposed, cited
as "ADR-0028 d3"); `docs/modules/certification/brief.md` (G1 approved 2026-10-03, cited as "brief
s5"); `docs/design/data/platform.md` (**platform.md**; section 10 for roles and grants, 10.9 for
partial indexes); `docs/design/data/identity.md` (**ID-data**; conventions C1 to C11 are reused by
number); `docs/design/data/sellers.md` (**SL-data**; conventions S1 to S10); `docs/design/domain/platform-persistence-and-events.md`
(**P**; PM1 to PM8, the guard of P 4, the raw-SQL rule of P 4.2); `docs/design/domain/platform-foundations.md`
(**PF**; section 4, `SubjectKeyService`); ADR-0003, ADR-0004 (decisions 3 to 7), ADR-0005
(decisions 1, 3, 5, 6), ADR-0006, ADR-0007, ADR-0009 (decisions 2, 5 to 7), ADR-0010, ADR-0012,
ADR-0016, ADR-0025.
**Prisma models:** `prisma/schema/certification.prisma` (new); `base.prisma` gains
`"certification"` in `schemas` (shared file, in the PR of migration 1).

## 1. Scope and table list

The physical design of everything D asks the database to hold for slices 1 to 17 (D 14.1): tables,
constraints, access paths with the three statements of `evaluateClaims` (D 4.2) and their measured
plans, encryption columns, grants, the migration plan per slice, retention, purge and erasure. It
does not change the domain model. Where a mapping needed a choice D did not make, the choice is mine
and is listed in 13 for Mohammad.

ADR-0009 patterns: **V1** for type revisions, policy revisions, seller submissions and manufacturer
revisions (owner record with a published or approved pointer, immutable revision rows); **V4** for
the two status histories, decision rows, review checks and issuer confirmations (append-only).
**V2** and **V3** are not used.

| Table | Holds (D 2.1) | Pattern | Slice |
|---|---|---|---|
| `outbox`, `inbox` | Events of the module (PM1, PM4) | Queue | 1 |
| `certification_types` | `CertificationType` root; `verification_mode` immutable here (D 16.1 item 4) | V1 owner | 1 |
| `certification_type_revisions` | `TypeRevision` settings | V1 revision, insert-only | 1 |
| `seller_certifications` | `SellerCertification` root: status, draft, pending and approved pointers | V1 owner | 1; draft columns 5 |
| `seller_certification_submissions` | `Submission` content | V1 revision, insert-only + trigger | 1 |
| `seller_submission_decisions` | One terminal outcome per submission (approved, changes requested, declined, withdrawn) | V4, insert-only + trigger | 1 |
| `type_revision_texts`, `claim_terms` | Per-locale names, descriptions and claim terms of a type revision | Insert-only + trigger | 2 |
| `issuers`, `issuer_contact_channels` | `Issuer` root and its registered contact channels | Root; channels insert-only (retired, never deleted) | 2 |
| `platform_subjects` | The Market's platform subject id for platform-key encryption (3.22) | One row per Market; insert-only | 2 |
| `relaxation_proposals` | Pending relaxations of type revisions, policy revisions, issuer and type reactivation (D 7.6) | State row; one pending per subject | 2; subjects added in 12, 13 |
| `uploaded_documents`, `document_previews` | `UploadedDocument` root and its preview pages | Root; previews insert-only | 4 |
| `rate_counters`, `seller_draft_quotas` | Upload, submit, issuer-request and save limits (D 7.5); the 200 MiB draft quota | Transient counters; one row per seller | 4 |
| `seller_certification_draft_documents` | Documents attached to a seller draft | Mutable link | 5 |
| `seller_submission_documents` | Documents of a submission | Insert-only + trigger | 5 |
| `seller_certification_history` | Status history of a seller certificate (CERT-17) | V4, insert-only + trigger | 5 |
| `issuer_requests`, `issuer_request_documents` | `IssuerRequest` and its files | Root; link insert-only | 6 |
| `submission_review_checks` | Review checks; latest row per (submission, check code) wins | V4, insert-only + trigger | 7 |
| `submission_scope_readings` | Location and scope as read by the reviewer (D 3.2 rule 5); latest wins | V4, insert-only + trigger | 7 |
| `seller_issuer_confirmations` | Issuer confirmation of a submission (0..1) | Insert-only + trigger | 7 |
| `certificate_number_index`, `document_index` | Keyed HMAC index rows for the duplicate hint (D 10.2) | Deleted on the seller's erasure only | 7 |
| `expiry_warnings` | One marker per (submission or revision, threshold) | Insert-only | 9 |
| `claim_basis_policies`, `claim_policy_revisions`, `claim_policy_rows`, `retired_category_flags` | `ClaimBasisPolicy` root, revisions, rows; flags of D 3.7 backstop | V1; rows insert-only + trigger | 13 |
| `product_certifications`, `product_certification_draft_coverage`, `product_certification_draft_documents`, `product_certification_draft_editors` | `ProductCertification` root and its draft | V1 owner | 14 |
| `product_certification_revisions`, `product_revision_coverage`, `product_revision_documents`, `product_revision_editors`, `product_revision_decisions`, `product_revision_review_checks`, `product_issuer_confirmations`, `product_certification_history` | Revision content, coverage, editors, decision, checks, confirmation, history | V1 revision and V4, insert-only + trigger | 14 |
| `ai_field_suggestions`, `ai_reading_results` | AIS-02 and AIA-01 outputs (D 13) | Designed with slice 16 | 16, 17 |

```
                      sellers / identity / catalog (other schemas: ids only, no FK)
                                 | seller_id, product_id, product_revision_id, category_id
 certification_types --< certification_type_revisions --< type_revision_texts, claim_terms
   |  (published_revision_id: same-type FK)
   |--< issuers --< issuer_contact_channels
   |--< seller_certifications (pending_/approved_submission_id: same-certificate FKs)
   |       |--< seller_certification_draft_documents >-- uploaded_documents --< document_previews
   |       |--< seller_certification_submissions --< seller_submission_documents >-- uploaded_documents
   |       |         |-- seller_submission_decisions (0..1)    |-- seller_issuer_confirmations (0..1)
   |       |         |--< submission_review_checks             |--< submission_scope_readings
   |       |--< seller_certification_history                   certificate_number_index, document_index
   |--< claim_basis_policies --< claim_policy_revisions --< claim_policy_rows
   |--< product_certifications (pending_/approved_revision_id) --< draft coverage, documents, editors
           |--< product_certification_revisions --< coverage, documents, editors, review checks
           |         |-- product_revision_decisions (0..1)   |-- product_issuer_confirmations (0..1)
           |--< product_certification_history
 issuer_requests --< issuer_request_documents      relaxation_proposals (subject: type, policy, issuer)
 expiry_warnings, rate_counters, seller_draft_quotas, retired_category_flags, outbox, inbox
```

Every table carries `market_id` and `tenant_id`. No table holds money: ADR-0007 has nothing to apply
to here.

## 2. Conventions

ID-data C1 to C11 and SL-data S1 to S10 apply unchanged: `market_id varchar(8)` and `tenant_id text`
with their CHECKs (C1); UUIDv7 ids, `timestamptz(6)` from `Clock`, no column defaults, states as
`text` plus CHECK (C2); composite foreign keys `(market_id, <parent>_id)` → `(market_id, id)` with
`ON UPDATE RESTRICT` (C3, PM6); FKs stay in the schema and "who did it" columns are plain ids (C4);
keyed hashes are `bytea` with `octet_length = 32` (C6); indexes lead with `market_id` (C7); no raw
SQL except the read helper of 7.2 (C10); encrypted columns `<field>_ciphertext` (S4); codes from
Market configuration as `text` with a pattern CHECK, codes fixed by the design as closed lists (S8);
READ COMMITTED (S9). The certification-specific readings:

| # | Convention |
|---|---|
| CE1 | **Version (PM5, S1).** Every root of D 2.1 (`certification_types`, `issuers`, `issuer_requests`, `seller_certifications`, `product_certifications`, `claim_basis_policies`, `uploaded_documents`) has `version integer NOT NULL` CHECK `>= 1`. Every outbox row names its root and the root's new version (I7), so a job that writes an event (expiry, warning, issuer confirmation) raises the root's version in the same unit |
| CE2 | **Model names start with `Certification`** (C9): `CertificationSellerCertification`, `CertificationOutbox`, … with `@@map` |
| CE3 | **Insert-only tables (Ali and Hassan ruling; D 16.1 item 2).** Submissions, decision rows, status histories, review checks, scope readings, issuer confirmations, document links of submissions and revisions, revision coverage and editors, type and policy revision content: the application holds `SELECT, INSERT` only, **and** a row trigger rejects `UPDATE` and `DELETE` and a statement trigger rejects `TRUNCATE` for every role, the owner included, as `platform.audit_log` (platform.md 3.4). One trigger function serves all of them (6.1). A state that changes over time is a **new row**: a submission's status is its decision row or its absence (3.4), a check's result is its latest row (3.10). The mutable state lives on the root: status and pointers |
| CE4 | **Same-parent FKs carry the discriminating column.** A child that must agree with its parent on a third column references a unique key that includes it: a submission's issuer must be of the submission's type (`(market_id, issuer_id, type_id)` → `issuers`), a type revision must belong to the type (`(market_id, type_id, type_revision_id)`), a pointer must name a child **of this root** (`(market_id, id, approved_submission_id)` → `(market_id, seller_certification_id, id)`), a coverage row's type equals its revision's. Each such key costs one extra unique index on a small table; each turns a cross-row rule of D into a constraint (measured, 12) |
| CE5 | **Values of contract enums keep the domain's spelling**: `SELLER_REQUIRED`, `SELLER_OR_MANUFACTURER`, `NOT_APPLICABLE`, `THIRD_PARTY_DOCUMENT`, `SELF_DECLARATION`, `SEALED_ORIGINAL`, `REPACKED`, `PREPARED`, `FRESH` (ADR-0012, ADR-0028 d1). States and kinds are lowercase kebab, as D writes them |
| CE6 | **Local dates are `date`**, never instants (issue and expiry dates, the issuer confirmation date): ADR-0005 decision 3. Every boundary derived from them is stored beside them as `timestamptz` with the IANA zone it was computed in (`text`, CHECK as `sellers.seller_files.operating_timezone`) |
| CE7 | **Platform key.** Manufacturer certificate numbers, documents and the expert reference of an issuer are encrypted under a **platform subject** per Market, not a seller (ruling; D 10.1). The subject id is kept in `certification.platform_subjects` (3.22; Ali's ruling on Q-C3, Hassan M-b). Manufacturer document files (`owner_seller_id` NULL) wrap their data key under it too (Hassan L-d) |

## 3. Tables

Columns of C1 are omitted. **Personal** marks personal data (ADR-0018 decision 6). "Enc" = an
encrypted column under S4, with the label `certification.<record>.<field>` listed in 4.2. Hand-written
SQL (CHECKs Prisma cannot express, partial indexes, triggers, grants) is listed per migration in 9.

### 3.1 `certification_types` (slice 1)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `code` | `text` | no | CHECK `^[a-z][a-z0-9-]{1,31}$` (D 2.1). Unique `(market_id, code)`: unique per Market (CERT-01). Never updated (no grant) |
| `verification_mode` | `text` | no | CHECK `THIRD_PARTY_DOCUMENT`, `SELF_DECLARATION`. **On the root, immutable per type code** (ruling H1; D 16.1 item 4): not in the column-level `UPDATE` grant (8), and every revision repeats it under the FK of 3.2, so a revision can never carry another mode |
| `status` | `text` | no | CHECK `active`, `inactive` (CERT-03). A reactivation is a proposal (3.20) |
| `published_revision_id` | `uuid` | yes | V1 pointer. FK `(market_id, id, published_revision_id)` → `certification_type_revisions (market_id, type_id, id)`: only a revision **of this type**. NULL only inside the creating unit (type, revision 1, pointer); a NULL read by `evaluateClaims` is `type-unknown`, fail closed |
| `version`, `created_at` | | no | CE1 |

Unique `(market_id, id)` (C3) and `(market_id, id, verification_mode)` (target of 3.2). Never
deleted (CERT-03): no `DELETE` grant.

### 3.2 `certification_type_revisions` (slice 1; texts and terms in 3.3, slice 2)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `type_id` | `uuid` | no | FK `(market_id, type_id, verification_mode)` → `certification_types (market_id, id, verification_mode)`: the revision's mode equals the type's (D 16.1 item 4) |
| `revision_no` | `integer` | no | CHECK `>= 1`. Unique `(market_id, type_id, revision_no)` |
| `verification_mode` | `text` | no | Copy bound by the FK above |
| `requires_issuer_registry`, `requires_document`, `requires_expiry` | `boolean` | no | D 2.1 |
| `default_basis` | `text` | no | CHECK `SELLER_REQUIRED`, `NOT_APPLICABLE`: **never** `SELLER_OR_MANUFACTURER` (brief s5, AC 4) |
| `auto_approve_self_declaration` | `boolean` | no | CHECK `NOT auto_approve_self_declaration OR verification_mode = 'SELF_DECLARATION'` (CERT-11) |
| `badge_icon_key` | `text` | no | Design-system icon key (ADR-0017), CHECK `^[a-z][a-z0-9-]{0,63}$`. Never an uploaded file |
| `change_reason` | `text` | yes | Optional admin text, at most 500 characters (D 3.7, Hadi; D 16.1 item 11). CHECK `char_length BETWEEN 1 AND 500` and the S7 class (no control or bidi character). Admin-written, never seller data. Applied here as well as on policy revisions: Q-C9 |
| `author_account_id` | `uuid` | no | C4 |
| `created_at` | `timestamptz(6)` | no | |

Unique `(market_id, type_id, id)` (pointer target). Insert-only (CE3): a save is a new row. Whether
the revision is published at once or waits for a second admin is the proposal of 3.20; the row
itself is the same either way.

### 3.3 `type_revision_texts` and `claim_terms` (slice 2)

`type_revision_texts`: PK `(market_id, type_revision_id, locale)`; FK `(market_id, type_revision_id)`
→ `certification_type_revisions`, RESTRICT; `locale text` CHECK BCP 47 shape
`^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$` (membership in the Market's `supportedLocales`
is the aggregate's, INTL-10); `name text` (1 to 100), `customer_description text` (1 to 2,000), both
clear, public, S7 class. Insert-only.

`claim_terms`: PK `(market_id, type_revision_id, locale, phrase)`; FK `(market_id, type_revision_id,
locale)` → `type_revision_texts`, RESTRICT (a term exists only in a locale the revision has);
`phrase text` CHECK `char_length BETWEEN 1 AND 100`, no outer spaces, S7 class. Human-written (R10);
no regular expression column exists. The matcher's normalisation (NFKC, case fold, confusables, D
4.6) is code: the database stores the phrase as written and the PK only stops an exact duplicate.
Insert-only.

Read path of the matcher and `ClaimGuard` (A6): every published revision of the Market, active or
inactive types (D 4.6): `certification_types (market_id)` → pointer → `claim_terms` by the PK
prefix `(market_id, type_revision_id)`. Tens of rows per type.

### 3.4 `seller_certifications` (slice 1; draft columns slice 5)

| Column | Type | Null | Slice | Notes |
|---|---|---|---|---|
| `id` | `uuid` | no | 1 | PK; the record id in `ClaimDecision.certificate.certificateId` |
| `seller_id` | `uuid` | no | 1 | Minted by `identity`; also the subject of the seller's key (D 10.1) |
| `type_id` | `uuid` | no | 1 | FK `(market_id, type_id)` → `certification_types` |
| `status` | `text` | no | 1 | CHECK `draft`, `in-review`, `approved`, `changes-needed`, `declined`, `expired`, `revoked` (D 3.1) |
| `pending_submission_id` | `uuid` | yes | 1 | The one pending submission (D 3.2). FK `(market_id, id, pending_submission_id)` → `seller_certification_submissions (market_id, seller_certification_id, id)`. **One column, so "at most one pending" holds by construction**; it replaces the partial unique index on a status column that no longer exists (CE3) |
| `approved_submission_id` | `uuid` | yes | 1 | V1 pointer. FK as above, same certificate. CHECK `approved_submission_id IS NULL OR approved_submission_id <> pending_submission_id` |
| `approved_boundary_at` | `timestamptz(6)` | yes | 1 | **Denormalised** copy of the approved decision's `expiry_boundary_at` (3.6), written in the unit that moves the pointer, which is the only writer of both. Why: the job's selection index (A9) must hold only `approved` records; on the decision row it would hold every expired and revoked one forever. CHECK `approved_boundary_at IS NULL OR approved_submission_id IS NOT NULL`. `evaluateClaims` does **not** read it: it reads the decision row (7.3), so a sync bug cannot widen a claim |
| `status_changed_at` | `timestamptz(6)` | no | 1 | Sort key of admin lists |
| `last_changed_at` | `timestamptz(6)` | no | 1 | Every draft save and transition; the purge anchor (10.1) |
| `draft_issuer_id` | `uuid` | yes | 5 | FK `(market_id, draft_issuer_id, type_id)` → `issuers (market_id, id, type_id)`: only an issuer of the same type and Market (AC 11). The issuer's state is checked at submit (D 3.2) |
| `draft_certificate_number_ciphertext` | `text` | yes | 5 | **Personal**, Enc |
| `draft_issue_date`, `draft_expiry_date` | `date` | yes | 5 | Clear (D 10.1). CHECK `draft_issue_date <= draft_expiry_date` when both are set |
| `draft_self_declared` | `boolean` | yes | 5 | The seller's own tick (R14) |
| `draft_self_declaration_note_ciphertext` | `text` | yes | 5 | **Personal**, Enc |
| `draft_field_provenance` | `jsonb` | yes | 16 | AIS-02 per-field codes (`manual`, `ai-accepted`, `ai-edited`); CHECK `jsonb_typeof = 'object'`; no value text |
| `version`, `created_at` | | no | 1 | CE1 |

- **Partial unique `(market_id, seller_id, type_id) WHERE status NOT IN ('declined', 'revoked')`**:
  T1 option A, at most one non-terminal certificate per seller and type (D 2.3). Measured: a second
  draft beside an approved one is refused. It is also the index of statement S1 (7.3): the
  statement repeats the predicate with literals in the SQL text, so the partial index serves it in
  any plan (platform.md 10.9).
- Unique `(market_id, id)` and `(market_id, id, type_id)` (targets of 3.5 and 3.15).
- **Deleting a never-submitted record** (`own-certificate.delete-draft`, D 3.1; D 16.1 item 10): one
  unit deletes the draft document links (3.11), the draft-area documents (3.12) and the root. "Refused
  when any submission exists" is held by the database: the submissions' FK to the root is RESTRICT,
  so the delete fails with `23503` while one row exists (measured). The repository maps that
  constraint name to `certificate.has-submissions`.
- The draft columns are encrypted per field, as in `sellers.seller_files`: nothing queries inside
  them, and the reviewer never reads the draft (only submissions).

### 3.5 `seller_certification_submissions` (slice 1; full use from slice 5)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK; `ClaimDecision.certificate.versionId` |
| `seller_certification_id` | `uuid` | no | FK `(market_id, seller_certification_id, type_id)` → `seller_certifications (market_id, id, type_id)` (CE4), RESTRICT |
| `seller_id`, `type_id` | `uuid` | no | Copies bound by that FK (type) and by the use case (seller); they let indexes and the HMAC rows of 3.17 lead with them without a join |
| `type_revision_id` | `uuid` | no | The type revision in force at submission (D 2.1). FK `(market_id, type_id, type_revision_id)` → `certification_type_revisions (market_id, type_id, id)` (CE4) |
| `submission_no` | `integer` | no | CHECK `>= 1`. Unique `(market_id, seller_certification_id, submission_no)` |
| `kind` | `text` | no | CHECK `initial`, `resubmission`, `renewal` |
| `issuer_id` | `uuid` | yes | FK `(market_id, issuer_id, type_id)` → `issuers (market_id, id, type_id)` (CE4, AC 11; measured). NULL for a type without registry |
| `certificate_number_ciphertext` | `text` | yes | **Personal**, Enc |
| `issue_date`, `expiry_date` | `date` | yes | Clear. CHECK `issue_date <= expiry_date` |
| `self_declared` | `boolean` | yes | |
| `self_declaration_note_ciphertext` | `text` | yes | **Personal**, Enc |
| `field_provenance` | `jsonb` | yes | Slice 16; as 3.4 |
| `content_schema_version` | `smallint` | no | CHECK `>= 1` |
| `content_hash` | `text` | no | `SubjectKeyService.hmac` (D 10.2); CHECK length 1 to 128 until `ContentHash` is fixed (SL-data 3.2) |
| `submitted_zone` | `text` | no | The seller's zone at submission (D 2.1), CHECK CE6 |
| `submitted_at` | `timestamptz(6)` | no | |
| `submitted_by_account_id` | `uuid` | no | C4 |

- Insert-only by grant and trigger (CE3). Status is derived: **pending** = the root's
  `pending_submission_id`; **approved, changes-requested, declined, withdrawn** = its decision row
  (3.6); **superseded** = an `approved` decision whose submission is no longer the root's
  `approved_submission_id`. No row stores "superseded", so approving the next submission writes one
  decision row and moves one pointer.
- Unique `(market_id, id)`, `(market_id, seller_certification_id, id)` (pointer target) and
  `(market_id, id, issuer_id)` (target of the confirmation FK, 3.16a).
- Reviewer queue and the issuer fan-out read these rows through the root's pointers and the
  indexes of 7.

### 3.6 `seller_submission_decisions` (slice 1; V4)

| Column | Type | Null | Notes |
|---|---|---|---|
| `submission_id` | `uuid` | no | PK `(market_id, submission_id)`: **one terminal outcome per submission**; FK → `seller_certification_submissions (market_id, id)` (PM6; measured: another Market's id is refused) |
| `outcome` | `text` | no | CHECK `approved`, `changes-requested`, `declined`, `withdrawn` |
| `approved_zone` | `text` | yes | The seller's zone at approval (T2). CHECK `(outcome = 'approved') = (approved_zone IS NOT NULL)` |
| `expiry_boundary_at` | `timestamptz(6)` | yes | 00:00 of the day after `expiry_date` in `approved_zone` (D 2.4 rule 2), computed by the application at approval. CHECK `expiry_boundary_at IS NULL OR outcome = 'approved'`. NULL on an approval when the submission has no expiry date |
| `reason_code` | `text` | yes | From the Market's `reasons` (S8 pattern). CHECK `(reason_code IS NOT NULL) = (outcome IN ('changes-requested', 'declined'))` (brief s5: no negative decision without a reason) |
| `reason_text_ciphertext` | `text` | yes | **Personal**, Enc (optional text, D 3.2 row 4) |
| `withdraw_cause` | `text` | yes | CHECK `edited`, `cancelled`, `revoked`; CHECK `(outcome = 'withdrawn') = (withdraw_cause IS NOT NULL)` |
| `actor_kind` | `text` | no | CHECK `seller`, `admin`, `system` (auto-approval of a self-declaration, D 8.4) |
| `actor_account_id` | `uuid` | yes | C4. CHECK `(actor_kind = 'system') = (actor_account_id IS NULL)` |
| `decided_at` | `timestamptz(6)` | no | |

Insert-only (CE3). The audit row of a decision carries the submission id, a keyed hash and the type
revision id (D 11); none of this table goes into it. Revocation of a certificate is a root
transition plus a history row (3.13); it does not touch the approved submission's decision row.

### 3.7 `issuers` and `issuer_contact_channels` (slice 2)

`issuers`:

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `type_id` | `uuid` | no | FK `(market_id, type_id)` → `certification_types` |
| `display_name` | `text` | no | Public (on the badge). CHECK 1 to 200, S7 class |
| `display_name_key` | `text COLLATE "C"` | no | NFKC, case-folded, inner whitespace collapsed by the application. **Unique `(market_id, type_id, display_name_key)`**: the issuer uniqueness rule (D 16.1): two registry entries of one type that a seller cannot tell apart are refused; the same name under another type or Market is allowed |
| `accreditation_number` | `text` | yes | Public accreditation reference (clear). CHECK 1 to 64. Partial unique `(market_id, type_id, accreditation_number) WHERE accreditation_number IS NOT NULL` |
| `state` | `text` | no | CHECK `proposed`, `active`, `closed-to-new`, `derecognised` |
| `expert_reference_ciphertext` | `text` | yes | The expert approval reference: who confirmed, when, a document or note reference (D 2.1). It may name a person (the halal expert), so it is Enc under the platform key (CE7). CHECK `state = 'proposed' OR expert_reference_ciphertext IS NOT NULL`: never `active` without one (brief s5, AC 19; measured) |
| `state_changed_at` | `timestamptz(6)` | no | |
| `state_changed_by_kind` | `text` | no | CHECK `admin`, `seed` |
| `state_changed_by_account_id` | `uuid` | yes | C4. CHECK `(state_changed_by_kind = 'seed') = (state_changed_by_account_id IS NULL)` |
| `version`, `created_at` | | no | CE1 |

- Unique `(market_id, id)` and `(market_id, id, type_id)` (target of every issuer FK, CE4).
- Never deleted (CERT-04): no `DELETE` grant. `derecognised` is terminal: the aggregate's, plus the
  proposal rule of 3.20 for `closed-to-new` → `active`.
- The full state history is in `platform.audit_log` (D 11); the row keeps the last change.

`issuer_contact_channels` (the registered channels of D 3.2 rule 7): `id` PK; `issuer_id`, FK
`(market_id, issuer_id)` → `issuers`; `kind` CHECK `email-domain`, `phone`, `web-page`; `value text`
(1 to 255; an organisation's contact, clear; Q-C4); `retired_at timestamptz(6)` nullable;
`created_at`. Unique `(market_id, issuer_id, id)` (target of 3.16). Grants `SELECT, INSERT, UPDATE
(retired_at)`: a channel a confirmation names is retired, never deleted or rewritten.

### 3.8 `issuer_requests` and `issuer_request_documents` (slice 6)

`issuer_requests`: `id` PK; `seller_id uuid`; `type_id`, FK to `certification_types`;
`typed_name_ciphertext text NOT NULL`, **Personal**, Enc (D 10.1); `state` CHECK `open`,
`issuer-added`, `not-accepted`; `answer_reason_code text` (S8), CHECK `(state = 'not-accepted') =
(answer_reason_code IS NOT NULL)`; `issuer_id uuid`, FK `(market_id, issuer_id, type_id)` →
`issuers`, CHECK `(state = 'issuer-added') = (issuer_id IS NOT NULL)`; `answered_at`,
`answered_by_account_id` (C4), both NULL iff `state = 'open'`; `version`; `created_at`.

There is no column or FK from `issuers` to a request: the request text has no path into the
registry or a submission (AC 11; D 2.1). Indexes: the admin queue, partial `(market_id, created_at,
id) WHERE state = 'open'`; the seller's `draft-issuer-not-listed` code (D 3.3), partial `(market_id,
seller_id, type_id) WHERE state = 'open'`.

`issuer_request_documents`: PK `(market_id, issuer_request_id, document_id)`; FKs to both parents,
RESTRICT; `position smallint`. Insert-only.

### 3.9 `uploaded_documents` and `document_previews` (slice 4)

`uploaded_documents` (root of one uploaded file):

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `owner_seller_id` | `uuid` | yes | The seller for seller files; NULL for admin-recorded manufacturer files. CHECK `(owner_seller_id IS NULL) = (purpose = 'product-certificate')` |
| `purpose` | `text` | no | CHECK `seller-certificate`, `issuer-request`, `product-certificate` |
| `type_id` | `uuid` | yes | The type the upload was made for (the HMAC input of 3.17). FK `(market_id, type_id)` → `certification_types` |
| `state` | `text` | no | CHECK `received`, `scanning`, `clean`, `refused` (D 3.8) |
| `refusal_code` | `text` | yes | CHECK the closed `file.*` list of D 3.8; CHECK `(state = 'refused') = (refusal_code IS NOT NULL)` |
| `media_type` | `text` | yes | Found by inspection, never the client's: CHECK `image/jpeg`, `image/png`, `image/heic`, `image/heif`, `application/pdf`. CHECK `state <> 'clean' OR media_type IS NOT NULL` |
| `byte_size` | `bigint` | no | Plaintext size. CHECK `> 0` |
| `page_count` | `smallint` | yes | CHECK `>= 1` |
| `data_key_envelope` | `text` | no | The per-file data key wrapped under the owner's subject key (T6 A; P-1): the seller's for seller files, the Market's platform subject (3.22) for manufacturer files with `owner_seller_id` NULL (Hassan L-d); **for draft files as well** (ruling M7; D 16.1 item 6). Destroying the subject key makes the bytes unreadable in both buckets. CHECK length bound until P-1 fixes the format |
| `draft_object_key` | `text` | yes | Random key in the draft bucket; NULL after promotion or purge |
| `clean_sha256` | `bytea` | yes | SHA-256 of the stored (encrypted) draft bytes recorded when the file became `clean` (M7); `promote` checks it. CHECK `octet_length = 32`; CHECK `(state = 'clean') = (clean_sha256 IS NOT NULL)` |
| `evidence_key` | `text` | yes | Content address in the evidence bucket (D 9.1), set once at promotion. CHECK `evidence_key IS NULL OR state = 'clean'`; CHECK `evidence_key IS NOT NULL OR draft_object_key IS NOT NULL OR state = 'refused'` |
| `retain_until` | `timestamptz(6)` | yes | The Object Lock period set on the object at promotion from the Market's retention configuration (ruling: per file, no bucket default). CHECK `(evidence_key IS NULL) = (retain_until IS NULL)` |
| `promoted_at` | `timestamptz(6)` | yes | Same nullability as `evidence_key` |
| `version`, `created_at` | | no | CE1 |

- **Set-once guard** (6.1): a trigger refuses any change of `evidence_key`, `retain_until`,
  `clean_sha256`, `owner_seller_id`, `purpose`, `type_id`, `data_key_envelope` once set, and any
  `DELETE` of a row whose `evidence_key` is set, for every role. A promoted document is also
  referenced by a submission or revision link (RESTRICT), so deletion fails twice.
- The client's file name is never stored (brief s9).
- Indexes: draft purge and quota recount, partial `(market_id, owner_seller_id, created_at) WHERE
  evidence_key IS NULL`; scan handler by PK.

`document_previews`: PK `(market_id, document_id, page_no)`; FK to `uploaded_documents`, RESTRICT;
`page_no smallint` CHECK 1 to the page limit backstop 50; `evidence_key text NOT NULL` (derived from
the document key, same lock, D 9.1); `byte_size integer`; `created_at`. Insert-only; written once the
document is `clean` and promoted (previews of a draft file are rendered and kept in the draft area
under `draft_object_key` plus page suffix, never in this table: Q-C6).

### 3.10 `submission_review_checks` and `submission_scope_readings` (slice 7; V4)

`submission_review_checks`: `id` PK; `submission_id`, FK `(market_id, submission_id)` →
submissions; `check_code text` (S8 pattern, Market `reviewChecks`); `result` CHECK `done`, `problem`,
`not-applicable`; `recorded_by_account_id uuid NOT NULL` (C4); `recorded_at`. **A re-recording is a
new row; the latest per (submission, check code) wins** (ruling; D 16.1 item 2). Index `(market_id,
submission_id, check_code, recorded_at DESC)`: the approval guard reads the latest row per code with
`DISTINCT ON (check_code)` over that index (or Prisma `distinct` with the same order). "Only on the
pending submission" is the aggregate's (6).

`submission_scope_readings` (D 3.2 rule 5): `id` PK; `submission_id` FK; `location_ciphertext` and
`scope_ciphertext text NOT NULL`, **Personal**, Enc; `recorded_by_account_id`; `recorded_at`. Latest
per submission wins; index `(market_id, submission_id, recorded_at DESC)`.

Both insert-only (CE3).

### 3.11 `seller_certification_draft_documents` and `seller_submission_documents` (slice 5)

`seller_certification_draft_documents`: PK `(market_id, seller_certification_id, document_id)`; FKs
to the root and to `uploaded_documents`, RESTRICT; `position smallint`. Mutable (`SELECT, INSERT,
DELETE`): the seller adds and removes draft files.

`seller_submission_documents`: PK `(market_id, submission_id, document_id)`; FKs RESTRICT;
`position smallint` CHECK `>= 1`, unique `(market_id, submission_id, position)`. Insert-only (CE3).
A resubmission that keeps a file links the same document row (no copy). The count limit (10) is
request validation.

### 3.12 `seller_draft_quotas` and `rate_counters` (slice 4; D 7.5, 16.1 item 7)

`seller_draft_quotas`: PK `(market_id, seller_id)`; `draft_bytes bigint NOT NULL` CHECK `>= 0`;
`updated_at`. The 200 MiB limit of 5.1 is Market configuration, so it is not a CHECK: the upload
unit reserves with one guarded statement, `UPDATE … SET draft_bytes = draft_bytes + $n WHERE market_id
= $1 AND seller_id = $2 AND draft_bytes + $n <= $limit` (an `upsert` creates the row first), so two
concurrent uploads cannot both pass; promotion, removal and purge subtract in their units. Repair
path: the purge job recomputes the sum from the index of 3.9.

`rate_counters`: the shape of SL-data 3.11 (PK `(market_id, kind, key_hash)`, keyed HMAC under this
module's rate-counter key, fixed window, `count >= 0`). Kinds (closed list; numbers are Hassan's, D
7.5): `upload.seller.day`, `upload.unapproved-seller.day`, `submit.certificate.day`,
`issuer-request.seller.day`, `save.account.minute`, `save.account.day`, `reviewer-mail.market.hour`
(the coalesced reviewer mail of D 12), and `ai-fill.seller.day` (added by slice 16's migration).
Reserve before the work, fail closed with `access.unavailable` (SL-data 3.11). Purged hourly.

### 3.13 `seller_certification_history` (slice 5; V4, CERT-17)

`id` PK; `seller_certification_id`, FK to the root, RESTRICT; `from_status` (nullable, the CHECK list
of 3.4) and `to_status`; `submission_id uuid` nullable, FK `(market_id, seller_certification_id,
submission_id)` → submissions (same certificate); `actor_kind` CHECK `seller`, `admin`, `system`;
`actor_account_id` (C4, NULL iff `system`); `reason_code` (S8); `note_ciphertext`, **Personal**, Enc;
`occurred_at`. Index `(market_id, seller_certification_id, occurred_at)` for the history read (VER-14,
audited per read). Insert-only by grant and trigger (CE3). The first row is written at the first
submission (`draft` → `in-review`); creating a draft writes none, so a never-submitted record has no
history and can be deleted (3.4). Q-C1.

### 3.14 `claim_basis_policies`, `claim_policy_revisions`, `claim_policy_rows`, `retired_category_flags` (slice 13)

`claim_basis_policies`: `id` PK; `type_id`, FK, **unique `(market_id, type_id)`** (one per Market and
type); `published_revision_id`, FK `(market_id, id, published_revision_id)` → revisions of this
policy; `version`; `created_at`.

`claim_policy_revisions`: `id` PK; `policy_id` FK; `revision_no` unique per policy; `change_reason`
(as 3.2, D 3.7); `author_account_id`; `created_at`. Unique `(market_id, policy_id, id)`. Insert-only.

`claim_policy_rows`:

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `revision_id` | `uuid` | no | FK `(market_id, revision_id)` → `claim_policy_revisions` |
| `selector_kind` | `text` | no | CHECK `platform-category`, `handling` |
| `category_id` | `uuid` | yes | A `catalog` platform category id (C4: no FK) |
| `handling` | `text` | yes | CHECK `SEALED_ORIGINAL`, `REPACKED`, `PREPARED`, `FRESH` |
| `basis` | `text` | no | CHECK `SELLER_REQUIRED`, `SELLER_OR_MANUFACTURER`, `NOT_APPLICABLE` |

- CHECK `claim_policy_rows_selector_check`: `(selector_kind = 'platform-category') = (category_id IS
  NOT NULL) AND (selector_kind = 'handling') = (handling IS NOT NULL)`.
- **CHECK `claim_policy_rows_manufacturer_basis_check`: `basis <> 'SELLER_OR_MANUFACTURER' OR
  selector_kind = 'platform-category'`** (ruling M1; D 16.1 item 8; measured: refused on a handling
  row).
- Unique `(market_id, revision_id, category_id)` and `(market_id, revision_id, handling)`: at most
  one row per selector in a revision (D 2.1); NULLs do not collide, so each unique covers its own
  kind.
- Partial `(market_id, category_id) WHERE category_id IS NOT NULL`: `assertCategoriesRetirable`
  (ruling B2; D 3.7), "is this category id named by a published or pending revision" (A12).
- Insert-only (CE3). "The strictest matching row wins; the type default applies only when no row
  matches" (D 16.1, Mohammad's correction) is the domain rule (`ClaimRule`), fed by statement S2
  (7.3).

`retired_category_flags` (the backstop of D 3.7): PK `(market_id, category_id)`; `reported_at`;
`cleared_at`, `cleared_by_account_id` nullable together. Written by `platformCategoriesRetired`
(insert ignoring a repeat); the policy page joins published rows to it. Grants `SELECT, INSERT, UPDATE
(cleared_at, cleared_by_account_id)`.

### 3.15 Manufacturer certificate: root and draft (slice 14)

The domain's draft is a working copy on the root and revision N is created at submission (D 3.4).
Because revisions are insert-only (CE3), the draft's lists (coverage, documents, editors) live in
draft tables and are copied into the revision tables in the submitting unit.

`product_certifications`: `id` PK; `type_id` FK; `status` CHECK `draft`, `in-review`, `approved`,
`rejected`, `suspended`, `revoked`, `expired`; `pending_revision_id`, `approved_revision_id` (same-
certificate FKs, as 3.4); `approved_boundary_at` (denormalised as 3.4, Market zone); draft columns
`draft_manufacturer_name text` (clear, a manufacturer; CHECK 1 to 200, S7), `draft_issuer_id` (FK
with type, CE4), `draft_certificate_number_ciphertext` (Enc, platform key), `draft_issue_date`,
`draft_expiry_date`; `author_account_id` (C4, the creator); `status_changed_at`, `last_changed_at`,
`version`, `created_at`. Unique `(market_id, id)`, `(market_id, id, type_id)`.

`product_certification_draft_coverage`: `id` PK; `product_certification_id` FK; `product_id`,
`product_revision_id` (the covered product revision, ruling M3; D 16.1 item 1), `variant_id`
(nullable). Partial uniques: `(market_id, product_certification_id, product_id) WHERE variant_id IS
NULL` and `(market_id, product_certification_id, product_id, variant_id) WHERE variant_id IS NOT
NULL`. Mutable (`SELECT, INSERT, UPDATE, DELETE`).

`product_certification_draft_documents`: as 3.11's draft link. `product_certification_draft_editors`:
PK `(market_id, product_certification_id, account_id)`; `first_edited_at`. Every admin who edits the
record, a file or the coverage is inserted (ignore on repeat) in the editing unit (D 3.4 input).

### 3.16 Manufacturer certificate: revisions and their children (slice 14; V1 and V4)

`product_certification_revisions`: `id` PK; `product_certification_id`, FK `(market_id,
product_certification_id, type_id)` → root (CE4); `type_id`; `revision_no` unique per certificate;
`issuer_id`, FK `(market_id, issuer_id, type_id)` → `issuers`; `manufacturer_name`;
`certificate_number_ciphertext text NOT NULL` (Enc, platform key; ruling: confidential);
`issue_date`, `expiry_date`; `author_account_id uuid NOT NULL` (the record's creator); `content_hash`
(over ciphertext or an HMAC under the platform key, ADR-0009 decision 6); `submitted_by_account_id`;
`submitted_at`. Unique `(market_id, id)`, `(market_id, product_certification_id, id)` (pointer
target), `(market_id, id, type_id)`, `(market_id, id, issuer_id)`, `(market_id, id,
author_account_id)`. Insert-only (CE3).

`product_revision_coverage` (insert-only, copied from the draft at submission):

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `revision_id`, `type_id` | `uuid` | no | FK `(market_id, revision_id, type_id)` → `product_certification_revisions (market_id, id, type_id)`: the copy of the type is bound (CE4) |
| `product_id` | `uuid` | no | `catalog` id (C4) |
| `product_revision_id` | `uuid` | no | The covered product revision (M3). `evaluateClaims` matches it to `ClaimQuery.productRevisionId`; a mismatch is `not-covered` |
| `variant_id` | `uuid` | yes | NULL = the whole product; a value narrows to that variant (CERT-41) |

- Partial unique `(market_id, revision_id, product_id) WHERE variant_id IS NULL` and `(market_id,
  revision_id, product_id, variant_id) WHERE variant_id IS NOT NULL`: a whole-product entry and a
  variant-narrowed entry are distinct rows (ruling L1; measured: a second whole entry is refused, a
  variant entry beside it is accepted). Whether both may coexist for one product is the aggregate's
  (Q-C7).
- **Lookup index `(market_id, product_id, type_id, product_revision_id) INCLUDE (variant_id,
  revision_id)`** (A3): statement S3 is an index-only scan on it (measured, 12).
- Never empty for a revision ("brand alone is not coverage"): cross-row, the aggregate's (6).

`product_revision_documents`: as `seller_submission_documents`. `product_revision_editors`: PK
`(market_id, revision_id, account_id)`, copied from the draft editors at submission; insert-only.

`product_revision_decisions` (one per revision, PK `(market_id, revision_id)`): `outcome` CHECK
`approved`, `rejected`, `withdrawn`; `expiry_boundary_at`, `boundary_zone` (the Market zone at
approval, ADR-0028 d8; both NULL unless approved with an expiry date); `reason_code` (required for
`rejected`); `author_account_id` with FK `(market_id, revision_id, author_account_id)` →
`product_certification_revisions (market_id, id, author_account_id)`, so it is the revision's real
author; `decided_by_account_id` (NULL only for a system withdrawal); **CHECK
`decided_by_account_id IS NULL OR decided_by_account_id <> author_account_id`** (measured) and CHECK
`(decided_by_account_id IS NULL) = (outcome = 'withdrawn')` (Hassan M-a): an approval or rejection
always names a person. This is
the database half of "another person" (AC 20): the full rule (not any editor of the revision) needs
the editor set and stays in the aggregate (6). Suspension, reinstatement, revocation and expiry are
root transitions and history rows (3.4 of D), not decisions of a revision.

`product_revision_review_checks`, `product_issuer_confirmations` (`reference_ciphertext` under the
platform key) and `product_certification_history`: the shapes of 3.10, 3.16a and 3.13 with
`revision_id` in place of `submission_id`. All insert-only (CE3).

### 3.16a `seller_issuer_confirmations` (slice 7)

PK `(market_id, submission_id)` (0..1 per submission); `issuer_id`, `channel_id`; FK `(market_id,
submission_id, issuer_id)` → `seller_certification_submissions (market_id, id, issuer_id)` and FK
`(market_id, issuer_id, channel_id)` → `issuer_contact_channels (market_id, issuer_id, id)`: the
channel is a **registered** channel **of the submission's issuer**, never typed in (D 3.2 rule 7);
`confirmed_on date`; `reference_ciphertext text NOT NULL`, **Personal**, Enc; `confirms_number`,
`confirms_holder boolean NOT NULL` with CHECK both true (a row exists only for a full confirmation,
so `verifiedWithIssuer` = "a row exists"); `recorded_by_account_id`; `recorded_at`. Insert-only (CE3);
a second confirmation of one submission fails on the PK. A correction path is not in D (Q-C5).

### 3.17 `certificate_number_index` and `document_index` (slice 7; D 10.2)

`certificate_number_index`: PK `(market_id, submission_id)`; `seller_id uuid NOT NULL`; FK
`(market_id, submission_id, seller_id)` → `seller_certification_submissions (market_id, id,
seller_id)` (Hassan L-c; a new unique key on submissions), so a row cannot name another seller than
its submission's and the erasure delete by seller cannot miss one; `index_hmac bytea NOT NULL` (C6), HMAC-SHA-256 under this module's stack secret over Market,
type and the normalised number. Index `(market_id, index_hmac)` for the reviewer's duplicate hint.

`document_index`: PK `(market_id, document_id)`; `seller_id uuid NOT NULL`; FK `(market_id,
document_id, seller_id)` → `uploaded_documents (market_id, id, owner_seller_id)` (Hassan L-c; a new
unique key there; manufacturer files, whose owner is NULL, never get a row);
`index_hmac bytea NOT NULL` over Market, type and the plaintext bytes. Index `(market_id,
index_hmac)`.

**Pseudonymous personal data** (SL-data S5): a stack-secret HMAC survives the destruction of the
seller's key. They are in their own tables, not columns of the insert-only submissions, so the
erasure handler can delete the seller's rows: `DELETE … WHERE market_id = $1 AND seller_id = $2`
(ruling L4; D 16.1 item 5), served by an index `(market_id, seller_id)` on each. The only `DELETE`
grant on these tables; also used for draft-area documents removed before submission.

### 3.18 `expiry_warnings` (slice 9)

PK `(market_id, version_kind, version_id, threshold_days)`; `version_kind` CHECK `submission`,
`product-revision`; `version_id uuid` (C4: one table for two parents, no FK; the job writes it in the
root's unit together with the event); `threshold_days smallint` CHECK `>= 1`; `created_at`. The
marker makes a re-run create nothing (D 8.6, AC 9): an insert that hits the PK means "already sent".
A renewal is a new submission, so its warnings start afresh. Insert-only.

### 3.19 `outbox` and `inbox` (slice 1)

Exactly ID-data 3.1 and 3.8 with the module name: `outbox_type_check`
`^certification\.[a-z0-9-]+\.v[1-9][0-9]*$`; `inbox_handler_check` `^certification\.[a-z0-9-]+$`;
unique `(market_id, aggregate_id, aggregate_version)`; claim index `(market_id, event_id) WHERE
published_at IS NULL`. Aggregate types: `certification-type`, `issuer`, `issuer-request`,
`seller-certification`, `product-certification`, `claim-policy`, `uploaded-document`. Payloads ids,
codes and enums only (D 8.3). Added to the "every outbox has the same columns" test.

`platform.audit_log` and `platform.event_delivery` are unchanged: the actions of D 11 fit
`audit_log_action_check`, and `certification.<handler>` fits the `subscriber` CHECK. The change
reason of a policy or type revision is the one free-text value in a `certification` audit row (D
3.7): admin-written, at most 500 characters, plain text.

### 3.20 `relaxation_proposals` (slice 2; subjects added in 12 and 13; D 7.6, 16.1 items 3 and 11)

| Column | Type | Null | Notes |
|---|---|---|---|
| `id` | `uuid` | no | PK |
| `subject_kind` | `text` | no | CHECK `type-revision`, `claim-policy-revision`, `issuer-reactivation`, `type-reactivation`. All four in the CHECK from slice 2 (as SL-data 3.11 did), so later slices do not alter it |
| `subject_id` | `uuid` | no | The type, policy or issuer id (C4: three possible parents, no FK) |
| `based_on_revision_id` | `uuid` | yes | The published revision it was made from |
| `proposed_revision_id` | `uuid` | yes | The saved, unpublished revision; NULL for a reactivation. CHECK `(subject_kind IN ('type-revision', 'claim-policy-revision')) = (proposed_revision_id IS NOT NULL)` |
| `proposed_expert_reference_ciphertext` | `text` | yes | For `issuer-reactivation` only: the new expert reference (platform key). CHECK `(subject_kind = 'issuer-reactivation') = (… IS NOT NULL)` |
| `state` | `text` | no | CHECK `pending`, `approved`, `rejected`, `withdrawn`, `superseded` |
| `proposer_account_id` | `uuid` | no | C4 |
| `proposed_at` | `timestamptz(6)` | no | |
| `decided_by_account_id` | `uuid` | yes | C4. **CHECK `decided_by_account_id IS NULL OR decided_by_account_id <> proposer_account_id`**: a second admin (H1). CHECK `(state IN ('approved', 'rejected')) = (decided_by_account_id IS NOT NULL)` |
| `decided_at` | `timestamptz(6)` | yes | CHECK `(state = 'pending') = (decided_at IS NULL)` |
| `change_reason` | `text` | yes | As 3.2 (≤ 500 characters) |
| `version`, `created_at` | | no | |

- **Partial unique `(market_id, subject_kind, subject_id) WHERE state = 'pending'`**: one pending
  proposal per subject (D 7.6); a second save is refused (`review.proposal-pending`) by the insert's
  `P2002`, never read-then-insert.
- Grants `SELECT, INSERT, UPDATE (state, decided_by_account_id, decided_at, version)`: the proposal
  content never changes. The diff the read shape shows (D 7.6) is computed from the two revisions,
  not stored.
- **The proposer is the author of the proposed revision** (Hassan L-b). No foreign key can say it,
  because `proposed_revision_id` points at a type revision or a policy revision. Enforced by an
  application assertion in the proposal aggregate (the save that writes the revision writes the
  proposal with the same account id), with one `test:db` case per subject kind that reads both rows
  after a save and compares `proposer_account_id` with the revision's `author_account_id`.
- The published pointer of the type or policy moves, and the issuer becomes `active`, only in the
  approving unit (the aggregate, 6). The revision row itself exists from the save and is
  insert-only; an unapproved revision is simply never pointed at.

### 3.21 AI outputs (slices 16 and 17; outline only)

Designed with slice 16, after `platform/ai` part 1 fixes the output schema. Shape agreed now so
nothing earlier blocks it: `ai_field_suggestions` (document id, the document's `clean_sha256` as the
binding, owner seller id, `suggestion_ciphertext` under the seller key, `created_at`; deleted when the
draft or the document goes; D 13 "discarded when the document changes") and `ai_reading_results`
(submission id, document id, the same binding, `result_ciphertext`, `created_at`; insert-only). The
human-versus-AI record of brief s5 (R12) is the submission's `field_provenance` plus these rows.

### 3.22 `platform_subjects` (slice 2; Ali on Q-C3, Hassan M-b)

| Column | Type | Null | Notes |
|---|---|---|---|
| `market_id` | `varchar(8)` | no | PK `(market_id)`: one row per Market |
| `subject_id` | `uuid` | no | A random UUIDv7 minted by `IdGenerator`, never derived from the Market code. Unique `(subject_id)` |
| `created_at` | `timestamptz(6)` | no | |

- Created by the certification Market-activation seed (D 5.2), as the system actor, inside an open
  unit: insert the row and call `SubjectKeyService.createKey(market, subjectId)` in the same unit,
  so neither exists without the other. Idempotent: an existing row means nothing to do.
- Grants `SELECT, INSERT`; no `UPDATE`, no `DELETE`. The subject id never changes.
- `SubjectKeyService.destroyKey` refuses a platform subject, and the erasure path refuses this id
  (`identity`'s erasure and this module's erasure handler), each with a test. Only admin use cases
  decrypt under it (manufacturer certificate pages, issuer expert references, relaxation proposals
  of issuer reactivation), and each such read writes an audit row.
- Not personal: an opaque id.
- **Risk:** rotation of a platform subject's data key is deferred (Ali). One data key protects
  every manufacturer number, manufacturer document and expert reference of a Market for its
  lifetime; a compromise of that one wrapped key exposes all of them, and re-encryption needs a
  batch job not designed yet. Listed in 14 (O7).

## 4. Encryption at rest and keyed indexes

### 4.1 What is clear and what is encrypted (D 10.1)

| Data | Where | Form |
|---|---|---|
| Type, issuer, policy and coverage data; issuer display names and accreditation numbers; manufacturer names; status codes, check codes, reason codes, dates, zones, flags, ids | Everywhere | Clear |
| Certificate number, self-declaration note, reason and note texts, location and scope as read, issuer-confirmation reference, issuer-request typed name, AI suggestions | Seller certificate tables | Enc, seller's subject key |
| Document and preview bytes, draft files included | Object storage | Encrypted per file; the data key wrapped under the seller's key in `data_key_envelope` (T6 A, M7) |
| Manufacturer certificate number and documents (the files' data keys wrapped under the platform subject, Hassan L-d); issuer expert reference | Manufacturer tables, issuers, `uploaded_documents.data_key_envelope` | Enc, the Market's platform subject (CE7, 3.22) |
| Certificate-number and document HMAC indexes | 3.17 | Keyed HMAC under the stack secret; deleted on erasure |
| Content hashes | Submissions, revisions | `SubjectKeyService.hmac` (seller) or platform key (manufacturer) |

### 4.2 Labels (PF 4 row 3)

`certification.seller-certification.draft-certificate-number`, `.draft-self-declaration-note`;
`certification.submission.certificate-number`, `.self-declaration-note`;
`certification.submission-decision.reason-text`; `certification.scope-reading.location`, `.scope`;
`certification.issuer-confirmation.reference`; `certification.history.note`;
`certification.issuer-request.typed-name`; `certification.document.data-key`;
`certification.product-revision.certificate-number`, `certification.product-certification.draft-certificate-number`,
`certification.product-issuer-confirmation.reference`; `certification.issuer.expert-reference`,
`certification.relaxation-proposal.expert-reference`. Hash purposes:
`certification.submission.content`, `certification.product-revision.content`.

### 4.3 Decryption cost by read

| Read | Unwraps | Why |
|---|---|---|
| `evaluateClaims`, badge data, `matchClaimTerms`, `certificationTypes`, `ClaimGuard`, the job's selection, queues and lists | **0** | Every column they read is clear (7.3) |
| Seller's own certificate page | 1 | One seller |
| Review page (`review-read`) | 1 (+1 per document streamed) | Audited per read (D 7.2) |
| Manufacturer certificate page | 1 (platform key) | Admin only |

## 5. What is never stored

| Never | Instead |
|---|---|
| A `ClaimDecision`, a tag, an "allowed" flag or a cached validity | Computed per request (ADR-0028 d2, d3); no table holds one |
| The `expired` status as an input to validity | The root's status is a record for people and events (D 2.4 rule 4); `evaluateClaims` reads boundaries |
| A "derecognised" flag per certificate | The issuer's state, joined per evaluation (ADR-0028 d11) |
| A plaintext or unkeyed hash of a certificate number or document | Keyed HMAC rows (3.17); content addresses over ciphertext |
| The client's file name, EXIF or location from a file | Nothing (brief s9) |
| The seller's zone as a live copy | Read per request from `sellers` (S-1); only the zones at submission and approval, as history |
| Issuer-request text in an issuer or submission | Ciphertext in `issuer_requests` only (AC 11) |
| Personal data in `outbox`, `inbox`, `event_delivery`, `audit_log`, logs | Ids, codes, enums (D 10.3) |
| A regular expression from an admin | Phrases only (3.3) |

## 6. Invariants the database does not carry

| Invariant | Why not a constraint | Enforced by |
|---|---|---|
| Which status follows which (D 3) | Transitions | Aggregates under the root version |
| The root's `status` agrees with its pointers and the decision rows (for example `approved` ⇒ `approved_submission_id` names an `approved` decision) | Cross-table | The transition unit writes both; same-certificate FKs narrow it |
| A submission is created only from a complete draft; its documents are `clean`; the issuer is `active`; the boundary is after now | Cross-table, configuration, `Clock` | Submit guard (D 3.2 row 1) |
| Review checks and scope readings only while pending; required checks recorded before approval | Depends on pointer and configuration | Aggregate; approval guard |
| Approver is not any editor of the manufacturer revision (beyond the author CHECK) | Set membership | `ProductCertification.approve` |
| One pending proposal's revision is the one published on approval; a superseded proposal | Cross-table | Proposal aggregate |
| A relaxation is detected (which revisions need a second admin) | Compares two revisions with the default (D 3.7) | Domain |
| Coverage list non-empty; whole-product and variant entries not mixed | Cross-row | Aggregate |
| `approved_boundary_at` equals the approved decision's boundary | Denormalised (3.4) | The pointer-moving unit; not read by `evaluateClaims` |
| Draft quota ≤ the Market limit | Configuration | Guarded reservation statement (3.12) |
| Locales of texts are the Market's `supportedLocales` | Configuration | Aggregate |
| `seller_id`, account, product, variant and category ids exist | Other schemas | Facades, `CatalogReferences` |
| No personal data in payloads, audit values, logs | Not expressible | `defineEvent`, audit allow-lists |

### 6.1 Triggers

```sql
-- One function for every insert-only table of CE3 (trigger function: no grant, platform.md 10.2).
CREATE FUNCTION "certification"."reject_mutation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'certification.%: append-only, % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END; $$;
-- Per insert-only table <t>, in the migration that creates it:
CREATE TRIGGER "<t>_no_update_delete" BEFORE UPDATE OR DELETE ON "certification"."<t>"
  FOR EACH ROW EXECUTE FUNCTION "certification"."reject_mutation"();
CREATE TRIGGER "<t>_no_truncate" BEFORE TRUNCATE ON "certification"."<t>"
  FOR EACH STATEMENT EXECUTE FUNCTION "certification"."reject_mutation"();
```

Tables: `certification_type_revisions`, `type_revision_texts`, `claim_terms`,
`seller_certification_submissions`, `seller_submission_decisions`, `seller_submission_documents`,
`seller_certification_history`, `submission_review_checks`, `submission_scope_readings`,
`seller_issuer_confirmations`, `issuer_request_documents`, `document_previews`, `expiry_warnings`,
`claim_policy_revisions`, `claim_policy_rows`, `product_certification_revisions`,
`product_revision_coverage`, `product_revision_documents`, `product_revision_editors`,
`product_revision_decisions`, `product_revision_review_checks`, `product_issuer_confirmations`,
`product_certification_history`, `ai_reading_results`. The `TRUNCATE` trigger is needed: measured,
the owner truncated a table that had only the row trigger (12).

The set-once guard of `uploaded_documents` (3.9) is a second trigger function,
`certification.uploaded_documents_guard()`, in the pattern of `platform.subject_keys_guard_update`
(ID-data 3.2): `BEFORE UPDATE` refuses a change of a set-once column; `BEFORE DELETE` refuses a row with
`evidence_key` set.

A legal-retention deletion of submitted evidence (after counsel, 10.4) will need its own migration
that changes these triggers for that one job and role; it is not designed before the period exists.

## 7. Access paths

Volume assumption: one Market, first year 10³ sellers; planning ceiling 2×10⁴ sellers, 5×10⁴
certificate records, 10⁵ submissions, 4,000 manufacturer certificates with 5×10⁵ coverage rows,
300 category rows per policy revision. Measured at that ceiling (12).

### 7.1 Named queries

| # | Query (D) | Shape | Index |
|---|---|---|---|
| A1 | `evaluateClaims` seller basis (D 4.2 step 2) | S1 (7.3) | Partial unique of 3.4; PKs |
| A2 | Type and policy (step 3) | S2 | `(market_id, code)`; PKs; unique `(market_id, revision_id, category_id)` |
| A3 | Manufacturer basis (step 6) | S3 | Coverage lookup index (3.16); PKs |
| A4 | Seller's own certificates; `sellerCertificateOverview(sellerIds)` | `seller_certifications WHERE market_id AND seller_id IN (…)` | `(market_id, seller_id, created_at)` |
| A5 | Reviewer queue: pending submissions, renewals first, oldest first, keyset (D 7.2) | Roots with `pending_submission_id IS NOT NULL` joined to the submission; two segments: `kind = 'renewal'` then others, each ordered `(submitted_at, id)` | Partial `(market_id, status_changed_at, id) WHERE pending_submission_id IS NOT NULL` on the root; submission by PK. Queue sizes are tens to hundreds; the kind split is done on the joined rows (Q-C8 if it grows) |
| A6 | Matcher, `ClaimGuard`, `certificationTypes` | 3.3 | PKs; `(market_id, code)` |
| A7 | Admin lists by status, "expiring" | `seller_certifications WHERE market_id AND status = $s ORDER BY status_changed_at, id` | `(market_id, status, status_changed_at, id)` |
| A8 | Issuer fan-out: approved certificates of an issuer (derecognition mail, the count before it) | Roots `status IN ('approved','expired')` whose approved submission names the issuer | `(market_id, issuer_id)` on submissions, then roots by `approved_submission_id`: partial unique `(market_id, approved_submission_id) WHERE approved_submission_id IS NOT NULL` on the root; manufacturer the same on revisions |
| A9 | Expiry and warning job (D 8.6) | `seller_certifications WHERE market_id = $1 AND status = 'approved' AND approved_boundary_at < $now + interval '26 hours' + $maxWarning` | **Partial `(market_id, approved_boundary_at) WHERE status = 'approved'`**: holds only live approved records. The 26-hour margin covers the largest offset gap between the zone at approval and any current zone (UTC−12 to UTC+14); the exact boundary per record is computed in code with the current zone (D 2.4). Same on `product_certifications` |
| A10 | Duplicate hint | `certificate_number_index`, `document_index` by `(market_id, index_hmac)` | 3.17 |
| A11 | Approval guard: latest checks; latest scope reading | 3.10 | 3.10 |
| A12 | `assertCategoriesRetirable(categoryIds)` (B2) | Rows with `category_id = ANY($ids)` whose revision is published (`claim_basis_policies.published_revision_id`) or proposed (`relaxation_proposals.proposed_revision_id` pending) | Partial `(market_id, category_id)` of 3.14; policies by `(market_id, type_id)`; proposals' partial unique |
| A13 | History read (VER-14) | 3.13 | `(market_id, seller_certification_id, occurred_at)` |
| A14 | Draft purge; quota recount | 3.9, 10.1 | Partial `(market_id, owner_seller_id, created_at) WHERE evidence_key IS NULL`; root `(market_id, last_changed_at, id) WHERE status = 'draft'` |
| A15 | Erasure of the HMAC rows | 3.17 | `(market_id, seller_id)` on both |
| A16 | Outbox claim; inbox | PM1, PM4 | ID-data 3.1, 3.8 |

**Not added, on purpose:** any index on a `*_ciphertext` column; a GIN index on claim phrases (the
matcher loads a Market's vocabulary, tens to hundreds of rows); an index on
`seller_certification_submissions (market_id, seller_id)` (no query reads submissions by seller
without the root); a status index on submissions (no status column, CE3); trigram search on issuer
names (the registry is tens of rows per type).

### 7.2 How the three statements reach the database

D 4.2 rule 2 requires each basis to be decided from **one statement** (one snapshot under READ
COMMITTED; read-only units open no transaction, ADR-0025). Prisma's `include` sends one query per
relation level unless `relationLoadStrategy: 'join'` is used, so "one statement" is not guaranteed
by the ORM's default.

| Option | For | Against |
|---|---|---|
| **A (decided by Ali, 2026-10-07).** The raw read helper of P 4.2: three named statements (S1 to S3) on a checked-in list, the Market bound by the helper as `$1`, unnamed (platform.md 10.9), each proven by a two-Market `test:db` case and by a query-count assertion | One statement by construction, whatever Prisma version; the partial-index predicates are SQL literals, so any plan uses them; the plans below are the plans that run | First raw helper of the codebase: needs Ali's and Hassan's approval (P 4.2), and the read-only unit's "raw SQL refused" rule gets one named exception for these three statements. Review cost per statement change |
| B. Prisma `findMany` with nested `select` and `relationLoadStrategy: 'join'` | No raw SQL | Whether Prisma 7.10 emits one statement for these shapes (unnest of pairs, `ANY` on two columns, the coverage OR) is unmeasured; a version change can silently split it into several snapshots; the guard sees model calls only |

**Decided: option A** (Ali, O1). The terms that bind the helper:

| # | Rule |
|---|---|
| 1 | A separate platform port, not a method of `MarketTransaction`, which stays model delegates only |
| 2 | It takes only a statement id from the checked-in list (S1, S2, S3). Each SQL text is a static compile-time constant, `SELECT` only; no `Unsafe` form, no string building, no identifier or fragment from input |
| 3 | `$1` is bound by the helper from the open unit's `MarketContext`, never by the caller. Array parameters are length-capped (100 queries; the category-id array at a cap set with S2's caller) and refused above it |
| 4 | Results are parsed by a schema per statement; a row that fails validation fails the whole batch closed (`unavailable`, D 4.2 rule 1) |
| 5 | Per statement: a two-Market `test:db` case (AU rows never answer a ZZ call and the reverse) and an assertion that one call issues exactly one SQL statement |
| 6 | Only the helper file and the callers of S1 to S3 in `modules/certification/infrastructure/` pass the lint and boundaries rules for it. A change to the list needs my sign-off and Hassan's (CODEOWNERS) |
| 7 | **ADR-0030** records it and amends ADR-0025 1(b) (read-only units refuse raw SQL); Mohammad drafts it, accepted before slice 1 merges |

Option B is not built.

### 7.3 The statements (A1 to A3; parameters bound, `$1` is the Market)

```sql
-- S1: seller basis. Inputs: arrays of (seller id, type code), one element per query.
SELECT q.ord, t.id AS type_id, c.id AS certification_id, c.status,
       s.id AS submission_id, s.issuer_id, s.expiry_date, s.type_revision_id,
       d.expiry_boundary_at, d.approved_zone, tr.requires_expiry, t.verification_mode,
       i.state AS issuer_state, i.display_name AS issuer_name,
       (ic.submission_id IS NOT NULL) AS verified_with_issuer
  FROM unnest($2::uuid[], $3::text[]) WITH ORDINALITY AS q(seller_id, type_code, ord)
  JOIN "certification"."certification_types" t ON t.market_id = $1 AND t.code = q.type_code
  JOIN "certification"."seller_certifications" c
    ON c.market_id = $1 AND c.seller_id = q.seller_id AND c.type_id = t.id
   AND c.status NOT IN ('declined', 'revoked')
  LEFT JOIN "certification"."seller_certification_submissions" s ON s.market_id = $1 AND s.id = c.approved_submission_id
  LEFT JOIN "certification"."seller_submission_decisions" d ON d.market_id = $1 AND d.submission_id = s.id
  LEFT JOIN "certification"."certification_type_revisions" tr ON tr.market_id = $1 AND tr.id = s.type_revision_id
  LEFT JOIN "certification"."issuers" i ON i.market_id = $1 AND i.id = s.issuer_id
  LEFT JOIN "certification"."seller_issuer_confirmations" ic ON ic.market_id = $1 AND ic.submission_id = s.id;

-- S2: type and policy. Inputs: distinct type codes; every category id of every path; the handlings.
SELECT t.id AS type_id, t.code, t.status, t.verification_mode, tr.id AS type_revision_id, tr.default_basis,
       p.published_revision_id AS policy_revision_id, r.category_id, r.handling, r.basis
  FROM "certification"."certification_types" t
  LEFT JOIN "certification"."certification_type_revisions" tr ON tr.market_id = $1 AND tr.id = t.published_revision_id
  LEFT JOIN "certification"."claim_basis_policies" p ON p.market_id = $1 AND p.type_id = t.id
  LEFT JOIN "certification"."claim_policy_rows" r ON r.market_id = $1 AND r.revision_id = p.published_revision_id
       AND (r.category_id = ANY ($3::uuid[]) OR r.handling = ANY ($4::text[]))
 WHERE t.market_id = $1 AND t.code = ANY ($2::text[]);

-- S3: manufacturer basis, only for queries still undecided under SELLER_OR_MANUFACTURER.
SELECT q.ord, pc.id AS product_certification_id, rv.id AS revision_id, rv.issuer_id, rv.expiry_date,
       dd.expiry_boundary_at, i.state AS issuer_state, i.display_name AS issuer_name,
       (pic.revision_id IS NOT NULL) AS verified_with_issuer
  FROM unnest($2::uuid[], $3::uuid[], $4::uuid[], $5::text[])
       WITH ORDINALITY AS q(product_id, product_revision_id, variant_id, type_code, ord)
  JOIN "certification"."certification_types" t ON t.market_id = $1 AND t.code = q.type_code
  JOIN "certification"."product_revision_coverage" cv
    ON cv.market_id = $1 AND cv.product_id = q.product_id AND cv.type_id = t.id
   AND cv.product_revision_id = q.product_revision_id
   AND (cv.variant_id IS NULL OR cv.variant_id = q.variant_id)
  JOIN "certification"."product_certification_revisions" rv ON rv.market_id = $1 AND rv.id = cv.revision_id
  JOIN "certification"."product_certifications" pc
    ON pc.market_id = $1 AND pc.id = rv.product_certification_id
   AND pc.approved_revision_id = rv.id AND pc.status = 'approved'
  JOIN "certification"."product_revision_decisions" dd ON dd.market_id = $1 AND dd.revision_id = rv.id
  JOIN "certification"."issuers" i ON i.market_id = $1 AND i.id = rv.issuer_id
  LEFT JOIN "certification"."product_issuer_confirmations" pic ON pic.market_id = $1 AND pic.revision_id = rv.id;
```

Notes:
- A variant-narrowed entry never matches `variant_id = NULL` (`NULL = NULL` is not true), as L1
  requires; a whole-product entry matches every variant.
- S1 returns no row for a (seller, type) without a non-terminal certificate: "no valid seller
  certificate". A status of `expired`, `changes-needed` or `in-review` still returns the approved
  submission, because validity is the boundary, not the status (D 2.4 rule 4).
- Seller zones come from the fixed `sellers` read of S-1 (D 16.1 item 9), before S1, outside it;
  nothing of `sellers` is joined.
- S2 reads the 300 rows of a published revision through `(market_id, revision_id, …)` and filters
  the OR in memory (measured 0.2 ms per type). If a revision grows past about 10³ rows, split the OR
  into two probes of the two uniques (`UNION ALL`); not needed at the assumed size.
- The first S3 draft joined the root by its pointer and read all 4,000 roots sequentially; joining
  through the revision's FK makes it index-only (12).

## 8. Grants

Under platform.md 10.2: hand-written in the `migration.sql` that creates the table, in the block
`-- Grants (database-designer): docs/design/data/certification.md section 8`, to `mondapac_app`
only, mirrored in `down.sql` (every `REVOKE` before any `DROP`), nothing from the "Never" row, and
the expected map of the privilege test changed in the same PR. `GRANT USAGE ON SCHEMA
"certification"` in migration 1. No sequence; the two trigger functions get no grant.

| Table | Privileges of `mondapac_app` | `DELETE` from | Reason |
|---|---|---|---|
| `outbox` | `SELECT, INSERT`, `UPDATE (published_at)` | Never | PM2 |
| `inbox` | `SELECT, INSERT` | Prune job | PM4 |
| `certification_types` | `SELECT, INSERT`, `UPDATE (status, published_revision_id, version)` | Never | `code` and `verification_mode` immutable (H1) |
| `issuers` | `SELECT, INSERT`, `UPDATE (display_name, display_name_key, accreditation_number, state, expert_reference_ciphertext, state_changed_at, state_changed_by_kind, state_changed_by_account_id, version)` | Never | `type_id` immutable; never deleted (CERT-04) |
| `issuer_contact_channels` | `SELECT, INSERT`, `UPDATE (retired_at)` | Never | 3.7 |
| `seller_certifications` | `SELECT, INSERT, UPDATE` | 5 (never-submitted records; the FK refuses others) | Root and draft |
| `seller_certification_draft_documents`, `product_certification_draft_documents`, `product_certification_draft_coverage` | `SELECT, INSERT, DELETE`; draft coverage also `UPDATE` | 5; 14 | Draft lists |
| `product_certification_draft_editors` | `SELECT, INSERT` | 14 (removed at submission) | |
| `product_certifications` | `SELECT, INSERT, UPDATE` | Never (a draft is rejected, not deleted: Q-C2) | |
| `uploaded_documents` | `SELECT, INSERT, UPDATE` | 4 (draft area only; the guard trigger refuses promoted rows) | |
| `issuer_requests` | `SELECT, INSERT`, `UPDATE (state, answer_reason_code, issuer_id, answered_at, answered_by_account_id, version)` | Never | Typed name immutable |
| `relaxation_proposals` | `SELECT, INSERT`, `UPDATE (state, decided_by_account_id, decided_at, version)` | Never | 3.20 |
| `claim_basis_policies` | `SELECT, INSERT`, `UPDATE (published_revision_id, version)` | Never | |
| `platform_subjects` | `SELECT, INSERT` | Never | 3.22; the id never changes or goes |
| `retired_category_flags` | `SELECT, INSERT`, `UPDATE (cleared_at, cleared_by_account_id)` | Never | |
| `certificate_number_index`, `document_index` | `SELECT, INSERT, DELETE` | 7 (erasure handler; draft documents removed) | L4 |
| `seller_draft_quotas`, `rate_counters` | `SELECT, INSERT, UPDATE, DELETE` | 4 | Counters |
| Every table of the 6.1 list | `SELECT, INSERT` | Never | CE3; the trigger refuses `UPDATE`, `DELETE` and `TRUNCATE` for the owner too |

**`test:db` assertions (ruling M6):** for each table of the 6.1 list, on the application connection,
`UPDATE … WHERE false`, `DELETE … WHERE false` and `TRUNCATE` fail with `42501` (measured on one
table, 12); on the owner connection `UPDATE` and `DELETE` run **against a real row** inserted by the
test (Hassan L-a: `WHERE false` would never fire a row trigger) and fail with `23001`, the row is
unchanged afterwards, and `TRUNCATE` fails with `23001`. Driven by a list
in the expected map, so a new insert-only table without the trigger fails the test. Column-level
`UPDATE` tables join the 10.4 column test (every other column refuses).

## 9. Migration plan

### 9.1 Order (one PR with a migration open at a time)

| # | Slice | Migration | Contains |
|---|---|---|---|
| 1 | 1 | `certification_claims_core` | `CREATE SCHEMA "certification"`; `reject_mutation()`; `outbox`, `inbox`; `certification_types`; `certification_type_revisions`; `seller_certifications` (slice-1 columns, T1 partial unique, A9 partial index); `seller_certification_submissions`; `seller_submission_decisions`; `issuers` minimal (S1 joins it; registry fields in 2) — or S1 without the issuer join in slice 1: Hossein's choice at the slice, I sign off either; triggers; grants |
| 2 | 2 | `certification_types_registry` | `type_revision_texts`, `claim_terms`, `change_reason`; the rest of `issuers`, `issuer_contact_channels`; `relaxation_proposals`; `platform_subjects` (the seed creates the row and key) |
| 3 | 4 | `certification_documents` | `uploaded_documents` with its guard trigger and function; `document_previews`; `seller_draft_quotas`; `rate_counters` |
| 4 | 5 | `certification_drafts_submissions` | Draft columns of `seller_certifications` and their CHECKs and FKs; `seller_certification_draft_documents`; `seller_submission_documents`; `seller_certification_history`; `DELETE` on the root; root lists indexes (A4, A7, A14) |
| 5 | 6 | `certification_issuer_requests` | `issuer_requests`, `issuer_request_documents` |
| 6 | 7 | `certification_review` | `submission_review_checks`, `submission_scope_readings`, `seller_issuer_confirmations`, `certificate_number_index`, `document_index`; queue and fan-out indexes (A5, A8) |
| 7 | 9 | `certification_expiry_warnings` | `expiry_warnings` |
| 8 | 13 | `certification_claim_policies` | The four tables of 3.14 |
| 9 | 14 | `certification_product_certifications` | Every table of 3.15 and 3.16 |
| 10 | 16 | `certification_ai_fill` | `draft_field_provenance`, `field_provenance`; `ai_field_suggestions`; `ai-fill.seller.day` in the counter CHECK (`DROP` and `ADD … NOT VALID`, then `VALIDATE`) |
| 11 | 17 | `certification_ai_reading` | `ai_reading_results` |

No migration: slices 3, 8, 10, 11, 12, 15. This matches D 14.1 (1, 2, 4, 5, 6, 7, 9, 13, 14) plus
16 and 17. The status-history table moves from slice 7 to slice 5, so the first submission already
writes its history row; no deployed environment exists in between.

### 9.2 Safety on live tables

As SL-data 9.3: every migration starts with `SET lock_timeout = '5s'`. New nullable columns are
catalog-only changes. A CHECK or FK added to an existing table is `ADD … NOT VALID` followed by
`VALIDATE CONSTRAINT` in the same file (the draft columns of migration 4 and the AI columns of 10 on
`seller_certifications`). An index on a table that holds rows in a deployed environment is `CREATE
INDEX CONCURRENTLY`, alone in its file (SL-data spike S3); before the first deployed environment,
plain `CREATE INDEX`. Changing a closed CHECK list (migration 10) is `DROP CONSTRAINT` plus `ADD …
NOT VALID` and `VALIDATE` in one file. Adding a trigger to an existing table takes a `SHARE ROW
EXCLUSIVE` lock briefly; none is planned. Backfills: none planned; if needed, a worker job in
batches, never in a migration.

### 9.3 `down.sql` and reversibility

- Reverse order: `REVOKE` first; triggers (`DROP TRIGGER`) before their tables; FKs between tables of
  the same migration before the tables (the pointer FKs of `seller_certifications`,
  `certification_types`, `claim_basis_policies` and `product_certifications` first, then children,
  then parents); columns added to existing tables last; trigger functions after every table that
  uses them (`reject_mutation()` in down of 1, `uploaded_documents_guard()` in down of 3). No `IF
  EXISTS`. Down of 1 leaves the empty schema and revokes its `USAGE` (platform.md 10.5 guard 2).
- The append-only triggers do not fire on `DROP TABLE`, so `pnpm db:check-reversible` (up, down, up)
  works with them; test setup never truncates these tables (platform.md 8 item 8).
- A down drops data: development and CI only.
- My sign-off per migration: platform.md 8, the five review points of 10.2, the hand-written block
  equal to this document, the partial-index and trigger list of 9.4.

### 9.4 Prisma specifics

- Prisma expresses the tables, types, keys, plain indexes and the composite FKs, including the
  pointer FKs whose fields overlap other keys (SL-data spike S2 covers the same shape).
- Hand-written blocks: every CHECK; `COLLATE "C"` on `display_name_key`; the triggers and their
  functions; the grants; the `INCLUDE` coverage index; and the partial indexes, invisible to Prisma,
  listed for the catalog test: `seller_certifications_market_id_seller_id_type_id_open_key`,
  `seller_certifications_market_id_approved_boundary_at_idx`,
  `seller_certifications_market_id_pending_idx`,
  `seller_certifications_market_id_approved_submission_id_key`,
  `seller_certifications_market_id_last_changed_at_draft_idx`,
  `product_certifications_market_id_approved_boundary_at_idx`,
  `product_certifications_market_id_approved_revision_id_key`,
  `issuers_market_id_type_id_accreditation_number_key`,
  `issuer_requests_market_id_created_at_open_idx`, `issuer_requests_market_id_seller_id_type_id_open_idx`,
  `uploaded_documents_market_id_owner_seller_id_draft_idx`,
  `claim_policy_rows_market_id_category_id_idx`, `relaxation_proposals_market_id_subject_pending_key`,
  the four coverage partial uniques (revision and draft), `outbox_market_id_event_id_unpublished_idx`.
- The three statements of 7.3 are not Prisma (7.2 option A); they live in
  `modules/certification/infrastructure/` on the helper's checked-in list.

## 10. Retention, purge and erasure

### 10.1 Draft purge (`certification.purge-drafts`, daily; D 8.6)

Selects never-submitted records (`status = 'draft'`, no submission: `pending_submission_id IS NULL
AND approved_submission_id IS NULL` and no submission row) with `last_changed_at < now − retention`,
and draft-area documents (`evidence_key IS NULL`) older than the retention, refused files included.
One record per unit: the draft links, the documents (and their objects, outside the unit, after
commit: an object without a row is harmless, a row without an object is not), the HMAC rows of those
documents, the quota decrement, the root. The retention values wait for counsel (D 19.1 item 2); the
job does nothing until the Market has a value, and absence is never zero.

### 10.2 Erasure of a seller (key destruction, ADR-0009 decision 6)

Triggered by `identity`'s erasure (CUS-03, later) through this module's handler: delete the seller's
rows of `certificate_number_index` and `document_index` (L4), delete never-submitted drafts as in
10.1, and nothing else: every remaining personal value is ciphertext under the destroyed key, and
the document bytes are unreadable because their data keys are wrapped under it. Submitted evidence
stays under legal retention first. Columns not made unreadable by key destruction: none personal
(issuer, dates, codes are not about the person); the store name on the badge belongs to `sellers`.

### 10.3 Other retention

| Rows | Rule |
|---|---|
| `rate_counters` | Hourly `certification.purge-expired`: windows older than 48 h |
| `expiry_warnings` | Kept (3 per approved version) |
| Submissions, decisions, history, checks, confirmations, revisions | Kept; legal retention (counsel) |
| Evidence objects | Object Lock until `retain_until`; deletion after that is a later design (6.1) |

## 11. Volume and jobs

| Table | First year (one Market) | Planning ceiling (measured) | Growth control |
|---|---|---|---|
| `seller_certifications` | 10³ | 5×10⁴ | Draft purge |
| Submissions, decisions | 1 to 5 per certificate per year | 9×10⁴ | None needed |
| Checks, scope readings, history | ~10 per submission | 10⁶ | Revisit partitioning at 10⁷ |
| Product coverage | 10⁴ | 5×10⁵ | One row per covered product per revision |
| Uploaded documents | 3 to 10 per submission | 5×10⁵ | Draft purge |
| Outbox | ~10 events per certificate per year | — | As identity's |

| Job | Every | Lock key (PM8) | Work |
|---|---|---|---|
| `certification.expiry-and-warnings` | 15 min (proposal) | `3131801444743177164` | A9, batches of 100, one unit per record |
| `certification.purge-drafts` | Daily | `8052976510567502285` | 10.1 |
| `certification.purge-expired` | Hourly | `3403428811734510887` | Counters |

None equals Prisma Migrate's `72707369`.

## 12. Evidence

Measured on 2026-10-07 on PostgreSQL 16.15 in a throwaway cluster (C.UTF-8), with the core tables of
this design (types, revisions, issuers, channels, seller certificates, submissions, decisions,
confirmations, policies with revisions and rows, manufacturer certificates, revisions, coverage,
decisions), seeded for AU at the planning ceiling and ZZ at a quarter: 49,887 certificate records,
87,502 submissions, 9,090 policy rows, 12,000 manufacturer revisions, 509,964 coverage rows. The
cluster was deleted afterwards.

| Statement (batch of 100 queries, custom plan, warm session) | Plan | Planning | Execution |
|---|---|---|---|
| S1 seller basis | Index scan on the T1 partial unique per query, then PK probes; no sequential scan of a large table | 3.3 ms | 1.0 ms (2.2 ms cold) |
| S2 type and policy, 400 category ids | Bitmap scan of 303 rows per published revision through the `(market_id, revision_id, handling)` unique | 1.5 ms | 1.2 ms |
| S3 manufacturer, first draft (root joined by pointer) | Sequential scan of 4,000 roots | 3.5 ms | 3.2 ms |
| S3 rewritten as 7.3 | Index-only scan of the coverage lookup index, then PKs | 3.0 ms | 1.7 ms |

All three together: about 12 ms of database time for 100 queries, inside D 4.2 rule 5's proposal
(P95 under 30 ms for 10). Planning dominates; a generic plan would remove it but is forbidden for
partial indexes under Prisma (platform.md 10.9) and is not needed.

Constraint behaviour, each observed: append-only trigger refuses `UPDATE` on a submission and
`DELETE` on a decision (`23001`); the owner's `TRUNCATE` **succeeded** on a table with only the row
trigger (hence the statement trigger of 6.1); the application role gets `42501` on `UPDATE`,
`DELETE` and `TRUNCATE` with `SELECT, INSERT`; `SELLER_OR_MANUFACTURER` on a handling row refused;
a second non-terminal certificate for one (seller, type) refused; deleting a root with submissions
refused (`23503`); a decision row in another Market than its submission refused (PM6); an issuer of
another type on a submission refused; a manufacturer decision by the revision's author refused; a
second whole-product coverage entry refused.

Not measured: anything through Prisma (option B of 7.2, overlapping pointer FKs, drift with
`COLLATE "C"` and `INCLUDE`); PostgreSQL 17; the job and queue queries; plans with real data
distributions.

## 13. Questions to Mohammad

| # | Point | My proposal |
|---|---|---|
| Q-C1 | Status history starts at the first submission (no row for the draft's creation), so a never-submitted record can be deleted (3.4, 3.13) | Confirm; **Answered by Mohammad:** confirmed (D 11) |
| Q-C2 | Manufacturer draft never deleted (no `delete-draft` in D for it); a draft is left or rejected | Confirm, or add a use case; **Answered by Mohammad:** confirmed, no delete use case; never-submitted draft files go through `purge-drafts` after retention (D 16.1) |
| Q-C3 | Closed by Ali (2026-10-07): one platform subject per Market (3.22) | — |
| Q-C4 | Issuer contact channels are clear (an organisation's contacts). If a channel can be a person's phone, encrypt under the platform key | Clear |
| Q-C5 | An issuer confirmation cannot be corrected (PK, insert-only). A wrong one needs revoke-style handling | Out of scope until asked; **Answered by Mohammad:** confirmed, out of scope; recommendation if asked in D 19.2 item 14 |
| Q-C6 | Previews of draft files: rendered into the draft area and copied at promotion, or rendered again after promotion | Copy at promotion, same lock; **Answered by Mohammad:** confirmed; draft previews encrypted like the draft (D 16.1) |
| Q-C7 | May a revision's coverage hold a whole-product entry and variant entries for the same product? | No (aggregate refuses); the database allows both rows; **Answered by Mohammad:** confirmed (D 2.1) |
| Q-C8 | Queue "renewals first" (A5): split in two keyset segments by kind | Confirm the ordering rule; **Answered by Mohammad:** renewals first, then FIFO by submission instant in each group (D 7.2) |
| Q-C9 | `change_reason` on type revisions and issuer reactivations as well as policy revisions (the coordinator's wording "on revisions") | Yes on all three; D 3.7 names only policies; **Answered by Mohammad:** yes on all three (D 3.7) |
| Q-C10 | Type-revision relaxation: the revision row is written at the save and published on approval (3.20). D 3.6 still says a save is published in the same unit | Confirm the pending path for types (D 16.1 item 3 says so); **Answered by Mohammad:** confirmed; D 3.6 fixed |

## 14. Open

| # | Point | Who |
|---|---|---|
| O1 | Closed: option A decided (7.2). Remaining: ADR-0030 drafted and accepted before slice 1 merges | Mohammad; Ali, Hassan |
| O2 | Spike 3 of D 14.3: re-run 12 through the chosen access path (helper or Prisma join) with the `sellers` call, at 10 and 100 queries | Hossein, with me |
| O3 | `data_key_envelope` format and size (P-1) | Kazem, Hassan |
| O4 | Retention periods: drafts, refused files, evidence `retain_until` (counsel) | Owner via Hadi |
| O5 | The stack secret of the HMAC indexes and the rate-counter key (HKDF split as SL-data 4.4) | Kazem; Hassan |
| O6 | Ciphertext bounds (SL-data O2) | Kazem, Hassan |
| O7 | Rotation of the platform subject's data key (3.22 risk); deferred by Ali | Kazem, Hassan; before the first deployed environment holds manufacturer data |

## 15. Follow-up changes

| File | Change | When |
|---|---|---|
| `prisma/schema/base.prisma`, `certification.prisma`; migrations of 9.1 with `down.sql` | As specified | Per slice; Hossein; my sign-off |
| Privilege map and catalog tests of `pnpm test:db` | Section 8 lists, the insert-only list of 6.1 with its `42501` and `23001` cases, the partial indexes of 9.4, `certification.outbox` in the outbox test | With each migration |
| `docs/adr/0030-…` (amends ADR-0025 1(b)); `docs/design/domain/platform-persistence-and-events.md` 4.2 | The raw read helper port and its three statements (7.2) | Mohammad, before slice 1 merges |
| `SubjectKeyService` (PF 4) | `destroyKey` refuses a platform subject (3.22) | With slice 2 |
| `.env.example` | The HMAC index secret | Slice 7; shared-file PR |

## 16. Rulings and hand-offs applied

| Source | Where |
|---|---|
| Ali and Hassan: no `UPDATE` or `DELETE` on submissions, decisions, history, confirmations, review checks (latest row wins); grant and trigger, `test:db` | CE3, 3.5, 3.6, 3.10, 3.13, 3.16a, 6.1, 8 |
| Drafts encrypted, clean hash checked at promotion, draft bucket without old versions | 3.9 (`data_key_envelope`, `clean_sha256`); bucket policy is ADR-0029's |
| Draft quota 200 MiB; file limits | 3.12; limits are request validation and configuration |
| Coverage carries the product revision; index (product, product revision, variant) | 3.15, 3.16, A3, S3 |
| The strictest matching row wins; the type default applies only when no row matches (Mohammad's correction); `SELLER_OR_MANUFACTURER` on category only (CHECK) | S2; 3.14 CHECK |
| `verificationMode` immutable per type; relaxations need a second admin | 3.1, 3.2 FK; 3.20 |
| Non-provisional zone, caller-independent (S-1) | 7.3 notes |
| Category retirement refused while referenced; indexed | 3.14, A12 |
| HMAC index rows deleted on erasure | 3.17, 10.2 |
| Object Lock period per file at promotion | 3.9 `retain_until` |
| Manufacturer number confidential under a platform key | 3.15, 3.16, CE7, Q-C3 |
| D 16.1 item 10: delete a never-submitted record | 3.4, 8, 10.1 |
| D 16.1 item 11: relaxation proposals; change reason | 3.20, 3.2, 3.14 |

## 17. G2 review record (2026-10-07)

| Reviewer | Result | Date |
|---|---|---|
| Ali (cto) | Approved for G2. O1: option A with the terms of 7.2 and ADR-0030; Q-C3: one platform subject per Market, rotation deferred as a risk | 2026-10-07 |
| Hassan (security-tester) | Accept with conditions, applied: M-a (3.16 CHECK), M-b (3.22), L-a (8), L-b (3.20), L-c (3.17), L-d (CE7, 3.9, 4.1) | 2026-10-07 |
| Mohammad (software-architect) | Correction applied: the type default applies only when no policy row matches (3.14, 16). Questions Q-C1, Q-C2 and Q-C5 to Q-C10 answered (13); Q-C4 answered by this design (clear) | 2026-10-07 |
