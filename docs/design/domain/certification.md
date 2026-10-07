# Certification — G2 domain design

**Author:** Mohammad (software-architect) — 2026-10-07
**Status:** G2 approved 2026-10-07. Ali (cto) signed; Hassan (security-tester) accepted with
conditions C1–C3, applied; Mojtaba's data design and Reza's `ux.md` complete; Jafar accepted with
changes, applied; ADR-0028 Accepted by the owner 2026-10-07. Reviews recorded in 19.3 and 19.4. The owner gets a Persian summary with the questions of
19.1 only.
**Ground truth:** `docs/modules/certification/brief.md` (G1 approved 2026-10-03; sections, rules,
owner answers and acceptance criteria are cited as "brief s5", "Q6", "AC 14"); ADR-0001, ADR-0003,
ADR-0004, ADR-0005, ADR-0006, ADR-0008, ADR-0009, ADR-0010, ADR-0012, ADR-0013, ADR-0015,
ADR-0016, ADR-0017, ADR-0018 (decisions 4 and 7), ADR-0019 (R1 to R4, R8, R9, decisions 5 to 10
and 12), ADR-0020, ADR-0022, ADR-0023, ADR-0024 (decision 6), ADR-0025; the amending ADR drafted
with this design, `docs/adr/0028-certification-claim-contract-amendments.md` (cited as
"ADR-0028 d3"); `docs/design/domain/platform-foundations.md` ("PF 6.2"),
`docs/design/domain/platform-persistence-and-events.md` ("PP 3.1"),
`docs/design/domain/identity.md` ("ID 8.1") and `docs/design/domain/sellers.md` ("SL 7.1"), whose
interfaces this design does not change (requests in 18); `docs/features/08-certifications.md`
(CERT-*), `10-versioning.md` (VER-07, VER-13, VER-14), `09-internationalization.md` (INTL-10,
-11, -12, -50); the `catalog` brief s5, s6, s10 and s11 where they touch this module; board
requests 13 (items 1 to 6) and 15 item 1 (`claude/tracks.md`). The code on `main` at `3f574b4`:
`modules/certification/` is an empty shell.

## 1. Scope

A design, not an implementation: a signature appears only where it is the contract.

- **Decided here:** the domain model (2), state machines (3), the single decision point
  `evaluateClaim` and the claim-text matcher (4), Market configuration and seeds (5), contexts
  (6), authorisation and the answer to board 13 item 2 (7), the boundary (8), documents and
  storage (9), personal data (10), audit and history (11), mail (12), the AI uses (13), slices
  (14), dependencies (15).
- **Not changed here:** the ports, facades and events of `identity` (ID 8) and `sellers`
  (SL 7). What this design needs from them, from `catalog` and from `platform/ai` is a request
  in 18.
- **In ADR-0028 (drafted with this design, Proposed):** the contract between `certification`,
  `catalog` and `ordering` that board 13 item 1 and board 15 item 1 ask for. This design applies
  it; where the two differ, the ADR wins once accepted.
- **In Mojtaba's data design** (`docs/design/data/certification.md`, written from this model):
  tables, columns, constraints, indexes, the single-statement reads of 4.2, retention jobs; his
  inputs are in 16.1.
- **In Reza's `docs/modules/certification/ux.md`:** screens, states and copy, and the table of
  brief s12; what the API gives the panels is in 16.2.
- **Left open, with the reason:** the questions of 19.1 need the owner; retention periods wait
  for counsel; the real AU
  issuer list and the manufacturer basis wait for the halal authority and legal (brief s11).

### 1.1 Brief slices and where they are covered
| Slice (brief s11) | Covered in |
|---|---|
| 1 Minimal type and seller certificate, one validity measure, `evaluateClaim` with seller basis and fail-closed default | 2.1, 2.4, 4.1 to 4.4, 7.4 |
| 2 Type seed with form settings, default basis and claim terms; issuer registry with expert reference; "which types" through `evaluateClaim` | 2.1, 3.5, 3.6, 4.6, 5.2 |
| 3 File storage client; drafts apart from locked storage | 9.1, 9.2, 14.2 |
| 4 File checks, server-made preview, authorised and audited download | 3.8, 9.3, 9.4 |
| 5 Add a certificate: draft, multi-page upload, review step, submit; in limited sign-in | 3.1, 3.2, 7.2 |
| 6 "My issuer is not listed" request and its queue | 2.1, 3.5, 7.2 |
| 7 Review queue and page with `sellers` data and named checks; approve the named submission, changes needed, decline; issuer confirmation; audit; minimal history; events | 3.2, 7.2, 8.5, 11 |
| 8 Withdraw by edit; resubmit; renew | 3.1, 3.2 |
| 9 Warning and expiry job in local time, with the expiry event | 3.1, 8.6 |
| 10 Structured badge data with "verified with issuer" | 4.5 |
| 11 Revoke with event; full history | 3.1, 11 |
| 12 Type and registry admin pages; the two issuer deactivation forms | 3.5, 3.6, 7.2 |
| 13 Versioned claim basis policy; manufacturer basis in `evaluateClaim` | 3.7, 4.2 |
| 14 Manufacturer certificate and coverage; review by another person | 2.1, 3.4 |
| 15 Expiry, revoke and suspend of a manufacturer certificate; warnings to Offer owners | 3.4, 8.3, 8.6 |
| 16 AIS-02 with `platform/ai` and the claim guard adapter | 13 |
| 17 AIA-01 | 13 |
| 18 Panel screens | 16.2; Reza's document |

### 1.2 Inputs from other documents
| Input | Answered in |
|---|---|
| Board 13 item 1, board 15 item 1: the amending ADR | ADR-0028; applied in 4 and 8 |
| Board 13 item 2: the access rule of `evaluateClaim`, badge data and the claim guard port, before slice 1 | 7.4 (no ADR change needed: the pair pattern of ID 8.1 and SL 7.1, and one named exception of the kind ADR-0019 decision 7 already admits) |
| Board 13 item 3 (done in SL 7.1): `reviewerBusinessDetails`; AI off for a new seller | 8.5, 13 |
| Board 13 item 4: the limited sign-in allow-list | 7.2 (column N); request I-1 in 18 |
| Board 13 item 5: the claim guard port in `platform/ai` part 1 | 4.6; request A-1 |
| Board 13 item 6: local storage review with the Object Lock criterion before slice 3; new dependencies with Ali | 9, 15, 17 |
| Brief s7 "left to G2" (state machine, two same-type certificates, resubmission cap, duplicate flag, file limits, parser sandbox, upload checks apart from the AI file pipeline, storage keys against ADR-0009 decision 6, quotas, retention, check texts, expiry cadence, zone read per query or stored, port names, `applies_to` and `PLATFORM_AUDIT`, claim-term shape, seeds, encryption key, who sees reasons, alert channel, permission keys, VER-14, events, issuer confirmation, AI details) | 3.1 and 2.3 T1; 7.5; 9; 3.1; 2.4; 4.1; 2.3 T4; 4.6; 5.2; 10; 7.1; 12; 8.3; 3.2; 13 |
| `Revision<T>`, `ContentHash`, `EffectivePeriod` (designed in SL 2.4) | Used as designed; nothing new (2.1) |
| SL 3.5 and 16.2 item 6: the claim-word data file of `sellers` "later supplied by the port that `certification` implements" | 4.6; request S-2 |
| `catalog` brief s6: "product and category data for coverage and policy through `catalog`'s events or a port decided at G2 with the amending ADR" | 8.2 (`CatalogReferences` port); ADR-0028 d9 |

## 2. Domain model

### 2.1 Aggregates
Every aggregate root carries `marketId` and `tenantId` (ADR-0003 decision 3, ADR-0001) and a
`version` (PP 10). References to other modules are ids: seller id (minted by `identity`), product,
variant and platform category ids (minted by `catalog`). Nothing is shared between Markets: a
type, an issuer, a policy and a certificate each exist in exactly one Market (brief s5, CERT-04,
INTL-50 as corrected).

```
CertificationType (code unique per Market)
  |-- TypeRevision (V1, 0..n; immutable)        settings, texts per locale, claim terms per locale
  |-- publishedRevisionId, status (active | inactive)
Issuer (one Market, one type)
  |-- name, accreditation reference, registered contact channels, expert-approval reference
  |-- state (proposed | active | closed-to-new | derecognised)
IssuerRequest ("my issuer is not listed"; one seller, one type)  --> sellerId, file refs
SellerCertification (one seller, one type)
  |-- Draft (editable working copy; file refs to draft objects)
  |-- Submission (V1, 0..n; immutable content)  --> ReviewCheck (0..n), IssuerConfirmation (0..1)
  |-- approvedSubmissionId, status, decisionHistory (V4, append-only)
ProductCertification (manufacturer certificate; admin-recorded)
  |-- ProductCertificationRevision (V1, 0..n; immutable: certificate fields, files, coverage)
  |-- approvedRevisionId, status, history (V4)
ClaimBasisPolicy (one per Market and type)
  |-- PolicyRevision (V1, 0..n; immutable row set), publishedRevisionId
UploadedDocument (one uploaded file; draft area until submitted)
```

| Aggregate | Holds | Invariants it owns |
|---|---|---|
| `CertificationType` | `code` (immutable, `^[a-z][a-z0-9-]{1,31}$`), `status`, the published revision. A revision holds: `verificationMode` (`THIRD_PARTY_DOCUMENT`, `SELF_DECLARATION`), `requiresIssuerRegistry`, `requiresDocument`, `requiresExpiry`, `defaultBasis` (`SELLER_REQUIRED`, `NOT_APPLICABLE`), `autoApproveSelfDeclaration` (only for `SELF_DECLARATION`), per locale of the Market: name, customer description, claim terms (4.6); a badge icon key from the design system's icon set (ADR-0017) | A revision is never edited; a save creates revision N+1 and publishes it in the same unit (brief s4 d 1), unless it relaxes a setting: then it waits `pending` until a second admin approves it (3.6; H1). `verificationMode` is fixed for a type code: no revision changes it; another mode is another type (H1). `defaultBasis` is never `SELLER_OR_MANUFACTURER` (brief s5, AC 4). `autoApproveSelfDeclaration` is false unless the mode is `SELF_DECLARATION` (CERT-11). Locales only from the Market's `supportedLocales` (INTL-10). Plain text; no uploaded SVG (brief s5). A type is never deleted; `inactive` refuses new certificates only (CERT-03) |
| `Issuer` | Type id, display name (public: it appears on the badge), optional official accreditation number, registered contact channels (email domain, phone, web page; 3.2 rule 7), expert-approval reference (who confirmed, when, a document or note reference), state, per state change the instant and admin account id | Never deleted (CERT-04). `active` only with an expert-approval reference (brief s5, AC 19). Back from `closed-to-new` to `active` only with a new reference and a second admin (3.5; H1). Belongs to one type and one Market; a certificate's issuer must be of the same type and Market (AC 11) |
| `IssuerRequest` | Seller id, type id, the typed issuer name (request text only; brief s4 a 3), file refs, state (`open`, `issuer-added`, `not-accepted`), the answer's reason code, the issuer id if one was added | The typed name never becomes an issuer field of a certificate (AC 11): there is no path from the request text to `Issuer` or to a submission; an admin creates the issuer separately |
| `SellerCertification` | Seller id, type id, status (3.1), the draft, the submissions, `approvedSubmissionId`, the open decision attempt (3.2 rule 4), the status history | At most one pending submission; a submission is created only from a complete draft (3.2); the approved submission is replaced only by approving another; `declined` and `revoked` are terminal for this certificate (brief s7); at most one non-terminal certificate per (seller, type) (T1); no seller-side request sets `marketId`, the seller id, a status, an issuer confirmation or a review check |
| `Submission` (entity of `SellerCertification`) | Submission number, kind (`initial`, `resubmission`, `renewal`), immutable content (issuer id, certificate number, issue date, expiry date as local dates, self-declaration tick and note for `SELF_DECLARATION`, document refs, per-field provenance for AIS-02, 13), `contentHash` (`Revision<T>`, SL 2.4), the type revision id it was made under, the seller's zone at submission, status (3.2), review checks, location and scope as read (Q5), issuer confirmation, the decision (reason code, optional text, reviewer, instant) | Content never changes; approval names the submission the reviewer saw (brief s5, AC 14) |
| `ProductCertification` | Status (3.4), revisions, `approvedRevisionId`, history. A revision holds: manufacturer name, type id, issuer id, certificate number, issue and expiry dates (local dates), document refs, coverage (product ids, each with the product revision id it was checked against (M3) and optionally narrowed to variant ids; CERT-41), the author and every admin who edited it, review checks, issuer confirmation, the decision | Coverage is part of the revision, so it never changes on an approved revision (ADR-0028 d7). The approver is not any admin who created or edited the record, a file or the coverage of the revision under review (Q3, AC 20). Brand alone is not coverage: the coverage list is explicit ids, never empty. For one product a revision holds either one whole-product entry or variant entries, never both (Q-C7). A coverage entry narrowed to variants matches only those (product, variant) pairs, never a query without a variant (L1); an entry matches only the product revision it records (M3) |
| `ClaimBasisPolicy` | Type id, the published revision. A revision is a set of rows `{ selector, basis }` where `selector` is a platform category id or a handling value (`SEALED_ORIGINAL`, `REPACKED`, `PREPARED`, `FRESH`) and `basis` is `SELLER_REQUIRED`, `SELLER_OR_MANUFACTURER` or `NOT_APPLICABLE` | Each change is a new revision (CERT-42, ADR-0012 d2), published at once when it only tightens and after a second admin's approval when it relaxes (3.7; H1); at most one row per selector in a revision; `SELLER_OR_MANUFACTURER` only on a platform-category selector, never on a handling value (M1); no row is needed for a default; a revision is never edited |
| `UploadedDocument` | Owner (seller id for seller files; none for admin-recorded manufacturer files), purpose (`seller-certificate`, `issuer-request`, `product-certificate`), media type found by inspection (never the client's), byte size, page count, the object keys (draft and, once submitted, locked), the keyed duplicate index (10.2), scan state (3.8), the hash of the stored bytes recorded when it became `clean` (M7), preview renditions | Usable (preview, submission, model) only in state `clean` (brief s5, AC 21); used only by its owner and for its purpose (L2). Its draft object is encrypted under the subject key like a locked one (M7) and is never in locked storage; its locked object is never overwritten (VER-07). The client's file name is not stored (brief s9) |

### 2.2 What is deliberately not an aggregate of `certification`
| Thing | Why |
|---|---|
| The certification tag on an Offer, its status and copies | `catalog` (ADR-0010 d2 and d3). `catalog` stores a copy of the decision for display and for selecting tags to ask again (ADR-0028 d3) |
| The Offer's handling and attestation | `catalog` (OFR-08). `evaluateClaim` takes "attestation recorded" as input (ADR-0028 d1) |
| Product, variant, platform category tree | `catalog`. Read through the `CatalogReferences` port (8.2) to validate coverage and policy rows |
| Seller access state, may-sell | `identity`, `sellers` (ADR-0022). `evaluateClaim` says nothing about selling (CERT-12) |
| The seller's time zone, legal and trading names, business address, the AI switch | `sellers` (SL 7.1, 7.6) |
| The order snapshot of a claim | `ordering` (VER-06, Phase 5) |
| Audit log | Platform (ADR-0004 decision 7); certification writes rows through the audit writer |
| The badge as shown, the store name on it | Storefront (Phase 6), from badge data (4.5) and `sellers`' published profile |

### 2.3 Modelling choices that need a reason
| Choice | Reason | Cost |
|---|---|---|
| A seller certificate is one record with V1 submissions; resubmission and renewal are new submissions of the same record | Brief s4 c 3 ("renewal: a new submission on the same certificate") and ADR-0009 decision 2 (approved one stays live while the next is reviewed); "approval names what was reviewed" becomes "approve submission N" | `withdrawn` and `changes-requested` are submission statuses beside V1's four (as SL 2.4 rule 1 allows) |
| Validity is computed at the instant of the question, never read from the stored `expired` status | Brief s5: `evaluateClaim` never waits for the job; one measure for `evaluateClaim`, badge data and the job (2.4) | The job's `expired` status is a record for people and events, not an input |
| Issuer derecognition is a state of the issuer, not a status written into every certificate | One write takes effect at once for every certificate of that issuer (Q6, AC 19) and is part of the validity measure; no fan-out has to finish first | Every evaluation reads the issuer's state (it is in the same statement, 4.2) |
| The manufacturer certificate is revisioned like the seller certificate, coverage inside the revision | Answers "coverage changed event, or coverage immutable per approved revision" (brief s6): both. An edit is a new pending revision reviewed by another person while the approved one stays live (ADR-0028 d7, T3) | Two revision-holding aggregates with the same shape |
| The policy is one aggregate per (Market, type) with immutable row sets | `ClaimDecision` names one policy revision; "strictest row wins" is evaluated over one row set (ADR-0012 d2) | A one-row change writes a whole revision (small: tens of rows) |

**Toss-up T1: two certificates of one type for one seller at the same time** (brief s7).

| Option | For | Against |
|---|---|---|
| **A (recommended).** At most one non-terminal certificate per (seller, type); renewal and correction are submissions of it; a new certificate is possible only after `declined` or `revoked` | One validity answer per (seller, type); the seller panel and the reviewer see one line per type; a partial unique index enforces it (Mojtaba) | A seller holding two valid certificates of one type from two issuers (two premises) can register only one. With Q5 (no scope enforced) one valid certificate already gives the badge on every Offer, so nothing is lost for selling |
| B. Several concurrent certificates per type | Mirrors multi-premises sellers | Two answers to pick from; reviewer and panel complexity; no benefit for the claim while scope is not enforced |

**Toss-up T2: which zone measures a seller certificate's expiry** (brief s7: "read per query or
stored at approval, with the constraint that a zone change never extends or revives").

| Option | For | Against |
|---|---|---|
| **A (recommended).** Both: the boundary in the seller's zone at approval is stored on the submission; each evaluation also reads the seller's current **non-provisional** zone through one fixed `sellers` read whose answer does not depend on the caller (request S-1; B1) and uses the earlier of the two boundaries. No zone now means "not allowed" | Exact, and a zone change can only bring the boundary forward (never extends, never revives); "no seller zone means not allowed" (brief s5, AC 4) holds literally; no event from `sellers` is needed | One `sellers` facade call per `evaluateClaims` batch (at most 100 seller ids, one read-only unit there) |
| B. Store at approval only; re-compute from a `sellers` zone event | No call in the hot path | `sellers` publishes no zone event today (SL 7.4; an admin correction is audited only); a window exists between a change and its delivery; "no zone" is not observable |

**Ruling (Ali B1 = Hassan M4, 2026-10-07):** A, with the zone source of the claim path independent of
the caller: only the non-provisional zone, through one fixed read (S-1), never `sellerSummaries`
under the caller's context (whose answer differs by actor). The submit and approve guards (3.2) and
the job (8.6) may keep the provisional zone through `sellerSummaries`. ADR-0028 d8 records it.

**Toss-up T3: an edit of the coverage of an approved manufacturer certificate** (brief s5: "an edit
of coverage after approval returns to review").

| Option | For | Against |
|---|---|---|
| **A (recommended).** The edit is a new pending revision; the approved revision with its coverage stays live until another person approves the new one; then `product-certification-coverage-changed.v1`. To stop coverage at once, an admin suspends the certificate | Same V1 shape as product content (ADR-0009 d3); widening coverage never takes effect without the second person; `ClaimDecision` always names an approved revision | Narrowing coverage is not immediate unless the admin also suspends |
| B. Any coverage edit moves the whole certificate back to `in-review` (no manufacturer basis until re-approved) | Strict and simple | Every Offer on every covered product loses the badge for a correction of one product id |

**Toss-up T4: `applies_to` and `PLATFORM_AUDIT`** (brief s3, s8 item 15). **Recommended:** neither is
modelled. ADR-0012 replaced the product-level certificate that `applies_to=PRODUCT` stood for with
the claim basis and the policy; `PLATFORM_AUDIT` has no behaviour in the documents. The
`verificationMode` enum has two values; adding one is a code change with its own review, and the
mode of a type code never changes (H1). Alternative: keep both as inert fields, which invites code
to branch on them. Feature file 08 s2 is corrected in a product-track PR (20). **Ruling
(2026-10-07):** accepted; verification mode stays two values.

### 2.4 The one validity measure (brief s5; used by `evaluateClaim`, badge data and the job)
```ts
// domain/validity.ts — pure; time comes in as an argument from Clock (ADR-0005 decision 5)
function sellerCertificateValidAt(
  cert: SellerCertificationView, // status, approved submission, its type revision, issuer state
  sellerZoneNow: TimeZoneId | null, // non-provisional, from sellers' fixed read in this request (T2, B1)
  at: Temporal.Instant,
): Validity; // { valid: true, submissionId, expiresAt? } | { valid: false, reason }
function productCertificateValidAt(cert: ProductCertificationView, marketZone: TimeZoneId, at: Temporal.Instant): Validity;
```
| # | Rule |
|---|---|
| 1 | Valid only if: status is `approved` (not `revoked`, `suspended`, `declined`); an approved submission or revision exists; its issuer is not `derecognised` (Q6); and, when the submission's type revision has `requiresExpiry`, `at` is before the expiry boundary |
| 2 | Seller boundary: the start of the day after the expiry date (00:00 local, DST-safe with Temporal's start of day) in the seller's zone (ADR-0005 decision 3, CERT-15); the earlier of the zone stored at approval and the current non-provisional zone, read the same way for every caller (T2, B1). No current zone: `{ valid: false, reason: 'seller-zone-missing' }` |
| 3 | Manufacturer boundary: the same rule in the Market's `defaultTimezone` (ADR-0028 d8), one instant for every Offer. The boundary computed at approval is stored; evaluation takes the earlier of it and the boundary in the current configured zone |
| 4 | Status `expired`, written by the job (3.1), is never read by this function: past the boundary it is invalid whether or not the job ran (AC 8) |
| 5 | A type that later drops `requiresExpiry` does not remove the expiry of a certificate approved under a revision that required it: the submission's own type revision decides (brief s5: easing a type never upgrades what was approved) |
| 6 | An issuer `closed-to-new` does not affect validity (Q6) |
| 7 | Inactive type (CERT-03): no effect on validity |

## 3. State machines

Every transition is one use case with one read-write unit (PP 3.1), time from `Clock`, one
version step and at most one event (PP 10). A transition not listed is forbidden; the tempting
ones are named.

### 3.1 Seller certificate (record status)
`draft` → `in-review` → `approved` | `changes-needed` | `declined`; `approved` → `expired` |
`revoked`; `expired` → `approved` (renewal approved); `changes-needed` → `in-review`.

| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| (none) → `draft` | `own-certificate.create` by the Seller Owner or Staff with the key; type is `active` in the actor's Market (CERT-03); no non-terminal certificate of this type for this seller (T1) | Record created with an empty draft | CERT-10, AC 10 |
| `draft` → (removed) | `own-certificate.delete-draft` (7.2): only a record that never had a submission. The record, its draft and its draft documents are removed and the draft objects deleted (draft bytes are encrypted and the draft bucket keeps no old versions, M7); frees the (seller, type) place of T1. No event, no audit row (nothing was ever submitted; SL 9) | — | ux.md API need 4 |
| `draft` → `in-review` | Submit (3.2 row 1) | — | CERT-10 |
| `in-review` → `approved` | Approve (3.2 row 3) | `approvedSubmissionId` = N; event `seller-certification-approved.v1` | CERT-11, AC 13 |
| `in-review` → `changes-needed` | Request changes (3.2 row 4) | Event | CERT-11, AC 13 |
| `in-review` → `declined` | Decline (3.2 row 5) | Terminal; event | CERT-11, AC 13 |
| `in-review` → `draft` | The only pending submission is withdrawn (3.2 row 2) and none was ever approved | — | AC 14 |
| `changes-needed` → `in-review` | Resubmission | — | AC 15 |
| `approved` → `approved` | A renewal or a correction (resubmission) is approved: the pointer moves, the old submission is `superseded` | Event `seller-certification-approved.v1` with `kind` | Brief s4 c 3, AC 15 |
| `approved` → `expired` | Job (8.6): the boundary of 2.4 rule 2 has passed and no later submission is approved. System actor | Event `seller-certification-expired.v1`; audit row with the system actor (AC 9). A pending renewal stays pending | CERT-15, AC 9 |
| `expired` → `approved` | A renewal is approved (it is not itself already expired; 3.2 row 3 guard) | Event | Brief s4 table |
| `approved` or `expired` → `revoked` | `seller-certificate.revoke` with a reason (CERT-16); a pending submission is withdrawn in the same unit (cause `revoked`) | Terminal; event `seller-certification-revoked.v1`; mail; audit | CERT-16, AC 16 |

Forbidden: approval of anything but the named pending submission (AC 14); a transition out of
`declined` or `revoked` (brief s7: add a new certificate instead); an admin use case that creates,
edits or submits a seller's draft (brief s5); a change by the seller's approval or suspension
(CERT-12, AC 12); a status from the request body (AC 17). A type's later `inactive` status changes
nothing here except creation (CERT-03; renewal of an existing certificate stays possible, 19.2
item 4).

### 3.2 Submission: `pending` → `approved` | `changes-requested` | `declined` | `withdrawn` | `superseded`
| # | From → to | Trigger and guard | Effects |
|---|---|---|---|
| 1 | (draft) → `pending` | `own-certificate.submit` (Seller Owner or Staff with the key; refused in acting-as, 7.2). Guards: no pending submission; the draft is complete for the type revision in force (issuer from the registry when required, number, dates, at least one document when required, the tick for `SELF_DECLARATION`); every document `clean` (3.8), owned by this seller and of purpose `seller-certificate` (L2; `save-draft` checks the same); the issuer is `active` and of the same type and Market; the expiry date's boundary in the seller's current zone is after now (no already-expired certificate; brief s7, AC 11); the seller has a zone (provisional allowed here, 8.5); at most the submissions of 7.5. Kind: `initial`, `resubmission` (after `changes-requested`) or `renewal` (the record is `approved` or `expired`) | Content copied immutable, documents promoted to locked storage (9.2), `contentHash`; event `seller-certification-submitted.v1`; for `SELF_DECLARATION` with `autoApproveSelfDeclaration`, the handler of 8.4 approves as the system actor (none active at launch, Q1) |
| 2 | `pending` → `withdrawn` | The seller edits a field the pending submission holds (after a warning; brief s4 table), or cancels it; or a revoke (3.1) | Leaves the queue (AC 14); cause (`edited`, `cancelled`, `revoked`) and instant kept; a reviewer with the page open gets `review.not-current-submission` ("replaced while you reviewed", brief s4 b 6); event `seller-certification-withdrawn.v1` |
| 3 | `pending` → `approved` | `seller-certificate.approve`; the request names submission N and the record version. Re-checked in the same unit (brief s5, AC 14): N is the pending one; required review checks recorded (5.1); every document `clean`; the issuer is `active` (neither `closed-to-new` nor `derecognised`); the boundary is after now in the seller's current zone (read before the unit through `sellerSummaries`, provisional allowed, 8.5); the record is not `revoked`. The seller's zone at approval is stored (T2) | Record transition of 3.1; the previous approved submission `superseded`; history row; audit |
| 4 | `pending` → `changes-requested` | Same key; a reason code from the Market list (5.1) is required, with optional text (brief s4 b 5) | Seller sees the reason and next step (AC 13) |
| 5 | `pending` → `declined` | Same key; reason required | Record `declined` (terminal) |
| 6 | `approved` → `superseded` | Another submission of the record is approved | — |

Rules:
1. **Resubmission cap** (brief s7): no absolute cap; the rate limit of 7.5 applies.
2. **Renewal while approved** keeps the approved submission valid until its own boundary (brief
   s4 c 3; AC 15); there is no grace period (brief s7).
3. **Review checks** (`ReviewCheck`): code from the Market list (5.1), result `done`,
   `problem` or `not-applicable`, reviewer, instant; recorded only on the pending submission;
   re-recording adds a new row and the latest row per check code counts (M6); each row audited. The
   approval guard needs the latest row of every required check `done` or `not-applicable`.
4. **Decision attempt.** The approval reads the seller's zone through `sellers` outside the unit
   (PP 3.1 row 5), then opens one unit that re-reads the record by version. No facade call is
   inside the unit; no two-step write is needed (unlike SL 7.3).
5. **Location and scope as read** (Q5): two encrypted text fields on the submission, written by
   the reviewer, required for approval of a `THIRD_PARTY_DOCUMENT` type. Not enforced on Offers.
6. **Duplicate hint** (brief s7; Hassan C3): the review page flags when the same certificate number
   or the same document bytes appear on another seller's certificate in the same Market (keyed
   index, 10.2). A hint for the reviewer only; never a refusal. The seller never sees it, not even a
   count. A reviewer with `seller-certificate.review` in that Market sees per match the kind
   (number or file), the other seller's public store name (`sellerSummaries`) and a link to that
   certificate's review page; the link is checked against the reviewer's own access when opened, and
   opening it is recorded like a document view (audit `certification.review-page.viewed` with the
   reason `duplicate-hint`). No legal name or business details appear unless the reviewer opens that
   page. The hint is never an input of AIS-02 or AIA-01 (13).
7. **Issuer confirmation** (Q7; brief s7 with Hassan's G1 conditions). Recorded only by a reviewer
   with `seller-certificate.review`, on one submission, pending or approved: the channel used,
   chosen from the issuer's **registered** contact channels (never typed in, never one the seller
   gave), the date, the reviewer, an encrypted reference to the confirmation itself, and two
   required ticks: "confirms this certificate number" and "confirms this holder". Both ticks make
   the submission `verifiedWithIssuer`. A confirmation recorded after approval sets the flag from
   then on (event `seller-certification-issuer-confirmed.v1` so `catalog` refreshes its display
   copy). A renewal or new submission starts without the flag. No seller-side use case and no AI
   output can write it; it never changes "allowed" (AC 23). Audited (AC 22).
8. **Append-only** (M6): submissions, decisions, status history, review checks and issuer
   confirmations are never updated or deleted; a database grant and a trigger refuse `UPDATE` and
   `DELETE` on them (Mojtaba, 16.1). A submission's status is therefore its latest decision row; the
   record root, updated under its version, holds the pointers (`approvedSubmissionId`, the pending
   submission).

### 3.3 What the seller sees (computed; brief s4 table)
Record status × pending submission × validity (2.4) × issuer state. Codes are API codes; words are
Reza's with ux-copy.

| Code | When |
|---|---|
| `draft` | Record `draft`, no pending submission |
| `draft-issuer-not-listed` | `draft` with an open `IssuerRequest` for this type |
| `awaiting-review` | Pending `initial` or `resubmission` |
| `changes-needed` | Record `changes-needed` |
| `declined` | Record `declined` |
| `approved` | Valid, no pending submission, not within 30 days of the boundary |
| `approved-expiring` | Valid, within the first warning threshold; carries `submitBy` (5.1) |
| `approved-renewal-pending` / `approved-renewal-changes-needed` | Valid with a pending or changes-requested renewal |
| `expired` / `expired-renewal-pending` | Invalid past the boundary (whether or not the job ran), without or with a pending renewal |
| `revoked` | Record `revoked` |
| `issuer-not-recognised` | Approved but the issuer is `derecognised` (Q6: tell the seller why and what to do) |

Next to it the seller's own access state from `identity` (two separate statuses, CERT-12), and
after approval the list of active types without a valid certificate (brief s4 a 7). "Type
deactivated" is not a status (brief s4).

### 3.4 Manufacturer certificate (ADR-0012 d3, as amended by ADR-0028 d7)
Record: `draft` → `in-review` → `approved` | `rejected`; `approved` → `suspended` | `revoked` |
`expired`; `suspended` → `approved` (re-review); `expired` → `approved` (renewal).
Revision: `pending` → `approved` | `rejected` | `withdrawn` | `superseded`.

| From → to | Trigger and guard | Effects |
|---|---|---|
| (none) → `draft`, draft edits | `product-certificate.edit` (admin; brief s4 e 1). Coverage ids validated through `CatalogReferences` (8.2): every product and variant exists in the Market; each covered product is recorded with its current published revision id (M3). Each editing admin is recorded on the draft | — |
| `draft` → `in-review` | Same key; completeness as for a seller submission; documents `clean`; issuer `active` | Revision N `pending` |
| `in-review` → `approved` (and revision `pending` → `approved`) | `product-certificate.approve`, naming revision N; the actor is not the author nor any admin who edited the record, a file or the coverage of N (Q3, AC 20); issuer `active`; boundary in the Market zone after now; documents `clean` | Boundary stored; event `product-certification-approved.v1` |
| `in-review` → `rejected` | Same key, reason required | Terminal |
| `approved` → `approved` (coverage or renewal revision approved) | As above for revision N+1 (T3) | Old revision `superseded`; event `product-certification-coverage-changed.v1` when coverage differs, otherwise `-approved.v1` (renewal) |
| `approved` → `suspended` | `product-certificate.revoke` (admin, reason), or the system actor through `productMaterialContentChanged` (8.1; ADR-0012 d3, CERT-45). CERT-31's report threshold does not exist before Phase 7 (brief s3) | Event `product-certification-suspended.v1` |
| `suspended` → `approved` | Re-review: `product-certificate.approve` by a person who neither created nor edited the current revision | Event `-approved.v1` |
| `approved` or `suspended` → `revoked` | `product-certificate.revoke`, reason | Terminal; event |
| `approved` → `expired` | Job: boundary passed (2.4 rule 3) | Event `-expired.v1` |

A covered product that later gets a new published revision is no longer covered by this revision (4.2
step 6 answers `not-covered`) until an admin records a coverage revision for the new product
revision and another person approves it (M3).

Until the halal authority and legal approve (ADR-0012 status; Q2) no policy row allows
`SELLER_OR_MANUFACTURER` in AU, so an approved manufacturer certificate gives no claim there (brief
s4 e 5). Until the second person exists, no AU manufacturer certificate can be approved (Q3).

### 3.5 Issuer: `proposed` → `active` → `closed-to-new` | `derecognised`
| From → to | Trigger and guard | Effects |
|---|---|---|
| (none) → `proposed` | `issuer.edit`, or seed | Not selectable |
| `proposed` → `active` | `issuer.edit` with an expert-approval reference (brief s5) | Selectable in forms of its type and Market |
| `active` → `closed-to-new` | `issuer.edit` (Q6 form 1) | No new submission or approval names it; approved certificates stay valid until their own boundary (AC 19). Pending submissions naming it cannot be approved; the reviewer requests changes or declines (19.2 item 3). Event `issuer-deactivated.v1` (`form: closed-to-new`) |
| `active` or `closed-to-new` → `derecognised` | `issuer.edit`, a confirmation that names the number of affected approved certificates (brief s12) | Every certificate of this issuer, seller and manufacturer, is invalid from that instant (2.4 rule 1); event `issuer-deactivated.v1` (`form: derecognised`); the own handler mails each affected seller (12). Terminal |
| `closed-to-new` → `active` | `issuer.edit` with a new expert reference, then approved by a second admin with `issuer.edit` who is not the requester (19.2 item 2; H1); until then the issuer stays `closed-to-new` | Audit rows `certification.issuer.reactivation-requested` and `.reactivation-approved` |

Forbidden: delete; any change from another Market; an issuer of another type on a certificate.

### 3.6 Certification type
`active` ⇄ `inactive` by `type.edit` (CERT-03; events `certification-type-deactivated.v1`,
`-activated.v1`). A content save is a new revision. A revision that does not relax is published in
the same unit; a relaxing revision is written `pending` at the save and published only on the second
admin's approval (below; Q-C10). The event is written when the revision is published
(`certification-type-revised.v1` carrying
`claimTermsChanged: boolean`, so `catalog` re-scans product text when the vocabulary grows; catalog
Q6). Activation of a type for sellers (Kosher, Vegan; Q1) is this transition, not a deploy.

`verificationMode` never changes for a type code (H1). A revision that relaxes a type setting
(`autoApproveSelfDeclaration` to true; `requiresDocument`, `requiresIssuerRegistry` or
`requiresExpiry` to false; `defaultBasis` from `NOT_APPLICABLE` to `SELLER_REQUIRED`), or that removes
a claim term in any locale or drops a locale (Hassan C2: a smaller vocabulary lets claim text through
4.6), is saved `pending` and published only when a second admin with `type.edit`, not its author, approves it
(the rule of Q3 and AC 20); audit rows `certification.type.relaxation-requested` and
`.relaxation-approved`. A revision that only tightens, adds terms or changes other texts is published
at once. Reactivation of an `inactive` type (`inactive` → `active`) needs the same second admin (H1).
`requiresExpiry` and `defaultBasis` count as relaxations by 19.2 item 11 (closed): they cannot ease
an approved certificate (2.4 rule 5) but they ease new ones.

### 3.7 Claim basis policy
A save by `claim-policy.edit` creates revision N+1. A revision that only tightens is published in the
same unit; event `claim-policy-changed.v1` (ADR-0012 d6). A revision that relaxes (any row whose
basis becomes less strict, for example to `SELLER_OR_MANUFACTURER`; any removed row that is not
`SELLER_OR_MANUFACTURER`; and any **added** row whose basis is less strict than the type's default,
for example a new `SELLER_OR_MANUFACTURER` row (Hassan C1; tests on AU and ZZ)) is saved `pending` and published, with the event, only when a second admin
with `claim-policy.edit`, not its author, approves it (H1; the rule of Q3 and AC 20); audit rows
`certification.claim-policy.relaxation-requested` and `.relaxation-approved`. Rows on a platform
category are validated through `CatalogReferences`; `SELLER_OR_MANUFACTURER` is refused on a
handling selector (M1). The save dialog's warning about affected Offers (ux.md CA8) only warns; no
acknowledgement blocks the save (Hadi, 2026-10-07). The admin may give an optional change reason:
plain text, at most 500 characters, stored on the revision and in the audit row (Hadi's ruling; the
same optional reason applies to type revisions and to issuer and type reactivations, Q-C9; the
one free-text field in a `certification` audit row, so the reason is admin-written and holds no
seller data; rendered inert).

**Retired categories** (B2; ADR-0028 d5 and d9). `catalog`'s move, merge and archive of a platform
category first call `assertCategoriesRetirable` (8.1). It refuses (`category.referenced-by-policy`,
with the type codes) while a row of the published or a pending revision names one of the ids with
basis `NOT_APPLICABLE` or `SELLER_REQUIRED`, because such a row stops matching once the category is
gone and its lapse could relax the result. An admin moves or removes those rows first (a policy
revision, relaxation rule included). A `SELLER_OR_MANUFACTURER` row only gets stricter on lapse
(the next result is a stricter row or the default); it does not block and stays flagged on the
policy page. The module never rewrites a row by itself. Backstop for the race between the check and
`catalog`'s commit: `catalog`'s handler of its own retirement event calls `platformCategoriesRetired`
(8.1), which flags any row on a retired id and alerts the admins when a flagged row is not
`SELLER_OR_MANUFACTURER`.

### 3.8 Uploaded document: `received` → `scanning` → `clean` | `refused`
| From → to | Trigger | Effects |
|---|---|---|
| (none) → `received` | Upload through the API (9.3 limits); bytes to the draft area | Event `document-received.v1` (internal) |
| `received` → `scanning` → `clean` or `refused` | Own handler (system actor): type inspection, malware scan, PDF and image checks in the sandbox, previews rendered (9.3) | `refused` carries a code (`file.type-not-allowed`, `file.encrypted-pdf`, `file.active-content`, `file.malware`, `file.scan-failed`, `file.too-large`, `file.too-many-pages`); a scanner failure is `refused` (brief s5) |
| `clean` → (promoted) | Submission (3.2 row 1): copied to locked storage under its content key | Draft object deleted |

## 4. `evaluateClaim`, `ClaimDecision`, badge data and claim text

### 4.1 The contract (ADR-0012 d5 as amended by ADR-0028 d1 and d2)
```ts
// contracts/certification.facade.ts
interface ClaimQuery {
  readonly sellerId: Id<'Seller'>;            // the Offer's owner, from the stored Offer (never the actor)
  readonly productId: Id<'Product'>;
  readonly productRevisionId: Id<'ProductRevision'>; // the published product revision the Offer sells (M3)
  readonly variantId: Id<'Variant'> | null;   // catalog asks once per variant on sale
  readonly typeCode: CertificationTypeCode;
  readonly handling: 'SEALED_ORIGINAL' | 'REPACKED' | 'PREPARED' | 'FRESH';
  readonly attestationRecorded: boolean;       // OFR-08 attestation on this Offer
  readonly platformCategoryPaths: readonly (readonly Id<'Category'>[])[]; // every path, root first, of every
                                               // platform category of the published revision; never a seller shelf
}
interface ClaimDecision {
  readonly allowed: boolean;
  readonly basis: 'SELLER' | 'MANUFACTURER' | null;
  readonly reason: ClaimReason;               // closed enum (4.2); 'allowed' when allowed
  readonly certificate: {                      // null when not allowed
    readonly kind: 'seller' | 'manufacturer';
    readonly certificateId: Id;               // SellerCertification or ProductCertification
    readonly versionId: Id;                   // submission or revision id: the "version" of ADR-0012 d8
    readonly issuerId: Id | null;
    readonly typeRevisionId: Id;
    readonly validUntil: Temporal.Instant | null;
  } | null;
  readonly policyRevisionId: Id | null;       // null = the type's default applied
  readonly badge: BadgeData | null;           // 4.5; present only when allowed
  readonly inputs: ClaimQuery;                // echoed, normalised (ADR-0028 d2)
  readonly evaluatedAt: Temporal.Instant;
}
evaluateClaims(ctx: CallContext, queries: readonly ClaimQuery[]): Promise<readonly ClaimDecision[]>; // 1..100
```
One facade method, one use-case pair (7.4), one domain function `ClaimRule.decide` in `domain/`.
"Which types can this seller claim for this Offer" (CERT-20) is `evaluateClaims` with one query per
type of the Market (`certificationTypes`, 8.1), not a second implementation. Nothing else in any
module computes CERT-21.

### 4.2 Algorithm (domain service `ClaimRule.decide`, pure)
The application layer loads, then calls the pure rule with `Clock.now()`:

| Step | Load (outside any write; one read-only unit, ADR-0025) | Rule |
|---|---|---|
| 0 | Validate the batch shape (1 to 100; ids parse; enum values); `marketId` from the context only | Any malformed query is `{ allowed: false, reason: 'input-invalid' }`; the other queries still answer |
| 1 | Seller zones: the fixed, caller-independent read of non-provisional zones (`sellers`, request S-1), distinct seller ids (T2, B1). Never `sellerSummaries` under the caller's context | Missing seller or zone: `seller-zone-missing` for the seller basis |
| 2 | **One statement** for the seller basis: per (seller, type) the non-terminal certificate, its approved submission, the submission's type revision, the issuer's state | — |
| 3 | **One statement** for the type and policy: the type's published revision (default basis, mode), the published policy rows matching any category id in the paths or the handling | Unknown type: `type-unknown`. Resolve the basis requirement: the strictest of **all** matching rows, every category id of every path and the handling row together (M1); the type's default when none match. Strictness: `NOT_APPLICABLE` > `SELLER_REQUIRED` > `SELLER_OR_MANUFACTURER`. A handling row is never `SELLER_OR_MANUFACTURER` (2.1), so handling can only tighten. See 19.2 item 12 on the type default |
| 4 | — | `NOT_APPLICABLE`: deny both bases (`policy-not-applicable`; AC 4) |
| 5 | — | Seller basis: valid by 2.4 → allow, basis `SELLER`. Both bases holding returns `SELLER` (ADR-0012 d7; AC 6) |
| 6 | **One statement**, only for queries still undecided and when step 3 resolved `SELLER_OR_MANUFACTURER`: approved, unsuspended manufacturer certificates of the type whose approved revision covers the query: an entry for the product with the same `productRevisionId` (M3), either for the whole product or narrowed to variants including `variantId`; a narrowed entry never matches `variantId = null` (L1); and their issuers | Manufacturer basis only if: mode is not `SELF_DECLARATION` (CERT-40); handling is `SEALED_ORIGINAL` (else `handling-requires-seller`); attestation recorded (else `attestation-missing`); a covering certificate valid by 2.4 rule 3 (else `not-covered`; a product revision mismatch is `not-covered` too, M3). Several covering: the one with the latest boundary |
| 7 | — | Otherwise `no-valid-seller-certificate` |

Rules:
1. **Fail closed.** Any exception, timeout or unreadable row turns every query of the batch into
   `{ allowed: false, reason: 'unavailable' }`; nothing is cached (brief s5, AC 4). The use case
   never throws to the caller for a domain reason.
2. **One snapshot per basis.** Under READ COMMITTED each statement has its own snapshot (ADR-0025
   context), so each basis is decided from one statement and no security decision combines facts
   read by two statements (PP 3.1 row 9). Mojtaba writes the three statements (16.1).
3. **No model** on this path (ADR-0019 decision 10; AC 25). The files of this path are not on the
   `platform/ai` allow-list.
4. **No actor input.** The actor never contributes a seller, a Market or a status; the use case
   ignores the actor entirely (7.4).
5. **Performance.** Three statements plus one `sellers` call per batch; no per-query round trip.
   Proposal: P95 under 30 ms for a batch of 10 on the staging data set, measured with Mojtaba
   (brief s9; the request budget of technical-spec s3.2 is 200 ms).

### 4.3 How `ClaimDecision` may be used (ADR-0028 d2 to d4)
| Rule | Where it is enforced |
|---|---|
| Valid only in the request that asked; never stored as an authorisation, re-presented, or accepted from a client or an Import file | `certification` has no use case that takes a decision, basis, certificate id or tag status as input (AC 24); `catalog` and `ordering` the same (their briefs) |
| The Offer accepts a decision only if `inputs` equal the state being saved, in its write unit, under the Offer's version | `catalog`'s Offer aggregate (ADR-0028 d2); a lost race asks again |
| The stored tag and every copy only restrict | `catalog` (ADR-0028 d3) |
| Purchase asks again in the same request | `ordering` (ADR-0028 d4) |

### 4.4 The three moments (brief s4 f, s5)
At write (`catalog` asks in its use case, outside its unit), continuously (each event of 8.3 is a
trigger; `catalog` asks again in idempotent batches, and runs the daily reconciliation; ADR-0028 d6
and d10), at purchase (`ordering` asks in the same request). Every entry path of ADR-0028 d5 reaches
`evaluateClaims`; Hassan reviews each one.

**CERT-23 filter** (Hadi, 2026-10-07): selecting several types means AND across types; inside one
type the seller and manufacturer bases are OR (CERT-46). The filter is `catalog`'s and search's,
built from tag copies that `evaluateClaims` produced; nothing in this module changes.

**After a certificate expires** (CERT-15; for Reza's FL4 step 3). From the boundary instant
`evaluateClaims` answers "not allowed" for that basis, whether or not the job ran (2.4 rule 4).
`ordering` asks again at purchase, so the Offer cannot be bought with the claim from that instant
(ADR-0028 d4). On `seller-certification-expired.v1` (or the daily reconciliation) `catalog` asks
again; a tag with no other valid basis (for example a manufacturer basis, ADR-0012) is **suspended,
not deleted**, and the Offer goes **off sale, not deleted**: it stays in the seller's list with its
tag shown as suspended and cannot be bought until a valid basis exists again (CERT-15; catalog brief
s1). When a renewal is approved (`seller-certification-approved.v1`, kind `renewal`), `catalog` asks
again and the tag and the Offer come back without seller action. Whether an off-sale Offer remains
visible to customers is the storefront's (Phase 6) and `catalog`'s G2, not this module's.

### 4.5 Badge data (CERT-24, CERT-44; AC 23)
Built inside the same use case from the decision it just made; there is no method that builds badge
data from a decision passed in.

```ts
interface BadgeData {
  readonly typeCode: CertificationTypeCode;
  readonly typeRevisionId: Id;            // the revision the certificate was approved under: its texts
  readonly basis: 'SELLER' | 'MANUFACTURER';
  readonly sellerClaim: boolean;          // true for SELF_DECLARATION ("seller claim")
  readonly issuer: { id: Id; displayName: string } | null; // public registry name
  readonly validUntilLocalDate: Temporal.PlainDate | null; // the expiry date as written, with
  readonly validUntilZone: TimeZoneId | null;              // the zone it is measured in (ADR-0005)
  readonly verifiedWithIssuer: boolean;   // from the submission or revision the decision names; never for sellerClaim
  readonly reviewedByPlatform: true;      // "the platform reviewed the document" (Q7)
}
```
Never in it: the certificate number, the holder's name, the document, the reviewer, the scope text.
The store name on the badge is the public store name from `sellers` (brief s5), joined by the
storefront, not here. Badge texts come from the type revision named, so easing a type never
upgrades an approved badge. For the manufacturer basis the same flag rule applies to the revision.

### 4.6 Claim terms, the matcher and the claim guard port (ADR-0019 R1, decision 12; CERT-01)
- **Shape.** Per type revision and locale: a list of terms written by people (R10), each a phrase of
  one or more tokens, in the script of the locale. No regular expressions from admins.
- **One matcher** (`domain/claim-text-matcher.ts`, pure): normalise (Unicode NFKC, case fold,
  strip default-ignorable and bidi characters, UTS #39 confusable skeleton) then match phrases
  token by token (tokens split on whitespace and punctuation, as SL 3.5). A **second pass** (M8)
  runs over the normalised text with separators (whitespace, punctuation, joiners) removed and a
  fixed digit-to-letter map applied (for example `0`→`o`, `1`→`l`, `3`→`e`, `4`→`a`, `5`→`s`;
  the map is Hassan's, in the test corpus), so "h-a-l-a-l" and "ha1al" match. The vocabulary is
  every type of the Market, active or inactive (brief s7 team proposal, Q1), from published
  revisions, with the terms of **every** locale of the Market applied to every text whatever its
  declared locale (M8). Hassan sets the normalisation and the corpus; the separator, digit and
  cross-locale cases are slice 2 tests.
- **Three consumers, one implementation:**

| Consumer | Through | Rule |
|---|---|---|
| `platform/ai` claim guard (R1, defence in depth) | Port `ClaimGuard` **declared in `platform/ai`** (part 1), implemented in `certification/infrastructure`, bound in the composition root | Named exception (7.4): `check(market, texts)` with a `MarketContext` only; reads published type revisions in a read-only unit; an error is "claim found" (fail closed) |
| `catalog`'s server-side refusal of claim text (the control, catalog brief s5) | Facade `matchClaimTerms(ctx, texts)` | Anonymous and system pair (7.4); returns per text the matched type codes and token spans; no other data. If the call fails, `catalog` refuses the save (fail closed, M8; request C-1) |
| `sellers`' slug and store-name check (SL 3.5) | The same `ClaimGuard` port, read by `sellers` (request S-2) | Until then `sellers`' checked-in data file stays |

## 5. Market-specific behaviour, behind configuration

No type code, issuer, Market code or country name appears in core code (ADR-0001 decision 5,
ADR-0008 decision 6); types and issuers are data and are named only in seeds and tests (brief s5).

### 5.1 The `certification` section of `config/markets/<code>.json`
| Field | AU (launch) | ZZ (test fixture) | Used by |
|---|---|---|---|
| `reviewChecks` | Codes and keys: holder name against business names, location and scope, issuer, dates, signs of tampering, legibility and language, issuer enquiry (optional); which are required (brief s4 b 3). Final texts: Reza with ux-copy; reviewer procedure document (`operations:process-doc`) | A shorter list | 3.2 rule 3 |
| `reasons` | Codes, each naming its check and next-step key (brief s7) | Its own | 3.2 rows 4 and 5, revoke |
| `warningThresholdsDays` | `[30, 14, 1]` (CERT-14) | Same | 8.6 |
| `renewalSubmitByDays` | Proposal 7 days before the expiry date (brief s4 c 2 "date by which to submit"); Hadi sets | 2 | 3.3, mails |
| `fileLimits` | Set at G2 (2026-10-07): 10 MiB per file, 10 files per submission, 20 pages per PDF, 40 megapixels per image, 200 MiB of draft files per seller | Small | 9.3 |
| `retention` | Waits for counsel (owner question 2): submitted documents (legal retention), never-submitted drafts and their files, refused files including files refused as malware. Also the evidence lock period, applied at promotion (T6 ruling) | Short | 9.1, 9.5 |
| `defaultTimezone` | Exists (Market); used only for manufacturer expiry (ADR-0028 d8) | Another zone | 2.4 rule 3 |

### 5.2 Seeds (CERT-02, CERT-04)
A versioned seed file per Market in `modules/certification/infrastructure/seed/` (exempt from the
literal check by exact path, as SL 4), applied by a `system` use case at deploy per hosted Market
(the identity role-seed pattern, ID 5.6): it creates missing types and issuers and never edits a
type revision or an issuer an admin changed. AU: Halal active (THIRD_PARTY_DOCUMENT, registry,
document, expiry, default `SELLER_REQUIRED`), Kosher and Vegan inactive (Q1); claim terms per type
from the human-written list (R10; the AU list waits for the halal authority, brief s11). AU issuers
are seeded `proposed` (no expert reference) until the owner's action of brief s11 gives one: no
real certificate can be approved before that. ZZ: a different type set (one with document and
expiry, one active `SELF_DECLARATION` with `autoApproveSelfDeclaration`, brief s6) and its own
issuers, active, so tests prove the model generic (AC 3).

## 6. `ActorContext` and `MarketContext`

| Caller | Context | Where the seller id comes from |
|---|---|---|
| Seller Owner or Staff over HTTP | Authenticated actor, population `seller` | `ActorContext.sellerId` only (ID 4 rule 2; AC 17) |
| Admin over HTTP | Authenticated actor, population `admin` | The path, read with the request's Market; another Market's id is "not found", byte-identical (AC 18) |
| `catalog`, `ordering`, storefront through the facade | The caller's `CallContext` unchanged | The query (`sellerId` is the Offer's owner, guaranteed by the caller from its stored record; ADR-0028 d1) |
| Event handler, job | Envelope Market or one run per hosted Market; system actor | Payload or selected rows |
| `platform/ai` through `ClaimGuard` | `MarketContext` only | None |
| `catalog` through `CatalogReferences` (8.2) | `MarketContext` only | None |

Repositories take the `MarketContext` (PP 4). Time from `Clock`. Tests run every domain and
integration case on AU and ZZ, with the Brisbane, Sydney, Adelaide and Perth fixtures and the DST
days (ADR-0005 decision 8; AC 8).

## 7. Authorisation

### 7.1 Permission catalogue of `certification`
Declared in `modules/certification/contracts/permissions.ts`. P = protected (R11 of the identity
brief). Protected status of `type.edit` and `seller-certificate.revoke` (Hadi's proposal, brief s6)
and of `product-certificate.approve` was accepted at G2 (19.2 item 7). Default roles are a proposal for the owner's approved roles
(ID 5.6), including one new admin role (Q3).

| Key | Scope | P | Allows | Proposed default roles |
|---|---|---|---|---|
| `certification.seller-certificate.view` | platform | no | Queue and lists with clear fields only: type, status codes, dates, issuer, seller id, kind; no number, no document, no decrypted text | Onboarding and Compliance; Certification Reviewer; Viewer |
| `certification.seller-certificate.review` | platform | no | The review page (decrypts number, reason, scope; previews of documents, audited per read as VER-14), record checks, location and scope, issuer confirmation | Onboarding and Compliance; Certification Reviewer |
| `certification.seller-certificate.approve` | platform | yes | Approve, request changes, decline (brief s5 protected list) | Onboarding and Compliance; Certification Reviewer |
| `certification.seller-certificate.revoke` | platform | yes | Revoke (CERT-16) | Platform Administrator only |
| `certification.document.view` | platform | yes | Download an original document, read the full status history (VER-14); each read audited | Platform Administrator; Certification Reviewer |
| `certification.type.view` / `.edit` | platform | no / yes | Types, revisions, claim terms, activation (CERT-01, CERT-03); a relaxing revision and a reactivation need a second holder (3.6) | View: every admin role; edit: Platform Administrator |
| `certification.issuer.view` / `.edit` | platform | no / yes | Registry, the two deactivation forms, answers to issuer requests (CERT-04); reactivation needs a second holder (3.5) | View: Onboarding and Compliance, Certification Reviewer; edit: Platform Administrator |
| `certification.product-certificate.view` | platform | no | Manufacturer certificates, coverage | Catalogue Moderator; Certification Reviewer |
| `certification.product-certificate.edit` | platform | yes | Record and edit a manufacturer certificate, files and coverage; suspend and revoke use `.revoke` | Platform Administrator |
| `certification.product-certificate.approve` | platform | yes | Approve, reject, reinstate, by another person (Q3) | Certification Reviewer |
| `certification.product-certificate.revoke` | platform | yes | Suspend and revoke | Platform Administrator |
| `certification.claim-policy.view` / `.edit` | platform | no / yes | Policy rows and revisions (CERT-42); a relaxing revision needs a second holder (3.7) | View: Catalogue Moderator; edit: Platform Administrator |
| `certification.own-certificate.view` | seller | no | The seller's own certificates, statuses, reasons, previews of its own documents | Store Manager; Catalogue and Stock |
| `certification.own-certificate.manage` | seller | no | Create, edit, upload, submit, withdraw, renew, issuer request, "fill from file" (AIS-02) | Store Manager |

Non-default verbs: `review`, `approve`, `revoke`, `manage`. The new admin role **Certification
Reviewer** is the account the owner's trusted second person holds (Q3: "an account that only has
certificate review permission"); its seed row goes into `identity`'s role seed (request I-3). Who in
a seller's team sees reasons (brief s7): every holder of `own-certificate.view` (reasons are about
the certificate, written for the seller).

### 7.2 Use cases and their access rules
`N` = `whenSellerNotApproved` (ID 5.2). Every use case is a `UseCase` subclass in
`modules/certification/application/use-cases/`; the CI check covers them. "Acting-as" refused: the
use case refuses when the context carries `actingAs` (SEL-08, when it exists), because an admin
never creates or submits a seller's certificate (brief s5). From slice 5, every
`own-certificate.manage` use case and `own-issuer-request.create` refuse in acting-as, and refuse
when the context cannot say whether it is acting-as (M5).

| Use case | Rule | N | Notes |
|---|---|---|---|
| `own-certificates.read`, `own-certificate.read`, `own-document.preview` | `permissions [own-certificate.view]` | allow | Own seller only; 3.3 codes; "types you cannot claim yet" |
| `own-certificate.create`, `.save-draft`, `.upload`, `.remove-upload`, `.submit`, `.withdraw` | `permissions [own-certificate.manage]` | allow | Brief s5 and AC 10: add, edit, upload, submit, view. `withdraw` is part of editing. All refused in acting-as (M5). `save-draft` and `submit` check each document's owner, purpose and `clean` state (L2) |
| `own-issuer-request.create` | same | allow | Part of "add" (brief s4 a 3); carries the files; refused in acting-as (M5) |
| `own-certificate.delete-draft` | same | allow | Only a record never submitted (3.1); refused in acting-as and when unsure (M5); deletes the draft objects (M7); counts against the draft-save limit of 7.5 |
| `own-certificate.fill-from-document` (AIS-02) | same | deny | Not in the limited allow-list (AC 10); AI is off for a new seller anyway (Q4) |
| `certification-types.read-for-seller` | `permissions [own-certificate.view]` | allow | Active types of the Market and their form settings |
| `seller-certificates.list`, `.queue` | `permissions [seller-certificate.view]` | — | Renewals first (brief s4 b 1): all pending renewals, then all other pending submissions, each oldest submission first (FIFO within the group; a proposal Hadi may change, Q-C8); filters by status and "expiring". Each row carries the store name: the use case calls `sellers.sellerSummaries` once per page (at most 100 seller ids, page size ≤ 100) at read time and returns the public store name; a seller not yet approved has none, and the row shows "not yet approved" with the seller id (the legal or trading name is only on the review page, through `reviewerBusinessDetails`). Nothing is stored here |
| `seller-certificate.review-read` | `permissions [seller-certificate.review]` | — | Decrypts; calls `sellers.reviewerBusinessDetails` (8.5); audited; `Cache-Control: no-store` |
| `seller-certificate.record-check`, `.record-scope`, `.record-issuer-confirmation` | `permissions [seller-certificate.review]` | — | Pending submission (checks, scope); confirmation also on the approved one (3.2 rule 7) |
| `seller-certificate.approve`, `.request-changes`, `.decline` | `permissions [seller-certificate.approve]` | — | Named submission and version (3.2) |
| `seller-certificate.revoke` | `permissions [seller-certificate.revoke]` | — | Reason required (AC 16) |
| `document.download`, `seller-certificate.history-read` | `permissions [document.view]` | — | Attachment only; audited per read (VER-14, AC 22) |
| `types.*` (list, read, save revision, activate, deactivate) | view / edit keys | — | Save shows the number of products whose text would become claim-bearing via `catalog` (16.2) |
| `type.approve-relaxation`, `type.approve-reactivation` | `permissions [type.edit]` | — | Actor is not the author (`review.second-admin-required`); 3.6 (H1) |
| `issuers.*`, `issuer-requests.list`, `.answer` | view / edit keys | — | 3.5 |
| `issuer.approve-reactivation` | `permissions [issuer.edit]` | — | Actor is not the requester; 3.5 (H1) |
| `product-certificates.*` | view / edit / approve / revoke keys | — | 3.4 |
| `claim-policy.*` | view / edit keys | — | 3.7 |
| `claim-policy.approve-relaxation` | `permissions [claim-policy.edit]` | — | Actor is not the author; 3.7 (H1) |
| `relaxation-proposals.read` (per subject), `.reject`, `.withdraw` | view key of the subject to read; edit key to reject (not the proposer) or withdraw (the proposer only) | — | Shape in 7.6 |
| `evaluate-claims`, `match-claim-terms`, `certification-types.read`, `assert-categories-retirable` (facade) | `anonymous` and `system` pairs | — | 7.4; never exposed over HTTP (L3) |
| `product-material-content-changed`, `platform-categories-retired` (facade, called by `catalog`'s handlers) | `system` | — | 8.1 |
| Handlers and jobs | `system` | — | 8.4, 8.6 |

The allow-list entries (N = allow) join the checked-in list of PF 6.2 row 5 in their slices; that
is the identity mini-review of board 13 item 4 (request I-1), and Hassan reviews each entry.

### 7.3 Where the hard rules of brief s5 are enforced
| Rule | Enforcement point | Test |
|---|---|---|
| CERT-21, one entry point, every type | `ClaimRule.decide` in `domain/`; no other module computes it (catalog, ordering call `evaluateClaims`); literal check finds no type code in core | AC 1 to 3 |
| Fail-closed default; `NOT_APPLICABLE`; strictest row | Step 3 and 4 of 4.2; `CertificationType` invariant on `defaultBasis` | AC 4, AC 5 |
| Manufacturer basis conditions | Step 6 of 4.2 | AC 6 |
| One validity measure; no waiting for the job | `domain/validity.ts` (2.4), used by `ClaimRule`, badge data and the job | AC 7, AC 8 |
| Decision only in the request; nothing accepted from outside | No use-case input type has a decision, basis, certificate or status field; `inputs` echoed for `catalog`'s equality check | AC 24 |
| Approval bound to the reviewed submission | 3.2 row 3 guard in the same unit, under version | AC 14 |
| Negative decisions and revoke need a reason | Value objects of the commands | AC 13, AC 16 |
| Another person for manufacturer certificates | `ProductCertification.approve` invariant over the author and editor set of the revision | AC 20 |
| Issuer never deleted; active only with reference; registry choice only | `Issuer` invariants; no delete path; submission guard | AC 11, AC 19 |
| Ownership and Market from contexts | Seller-side repositories take the seller id from the actor as a required argument; PP 4 guard | AC 17, AC 18 |
| Files unusable until clean; locked once submitted | `UploadedDocument` state guard; storage port (9.2) | AC 21 |
| No personal data outside | `defineEvent` vocabulary; audit allow-lists (11); log fields ids and codes | AC 22 |
| Verified-with-issuer only by a reviewer | Only `record-issuer-confirmation` writes it | AC 23 |
| No model on deterministic paths | `platform/ai` allow-list excludes `domain/` and the decision use cases | AC 25 |

### 7.4 The access rule of `evaluateClaim`, badge data and the guard port (board 13 item 2)
Brief s5 and s8 item 22 noted that these are called under seller, admin, system and customer
actors with a seller id as input, which looked incompatible with "exactly one rule from the closed
set" (ADR-0018 decision 4). **Answer: no named exception and no ADR change is needed for the facade;
one named exception is needed for the port.**

| Surface | Rule | Why it is enough |
|---|---|---|
| `evaluateClaims` (badge data is inside its result), `matchClaimTerms`, `certificationTypes` | Two use cases behind one facade method: `anonymous` for request actors (admits anonymous and authenticated, never system; the gate passes the anonymous actor to `handle`) and `system` for handlers and jobs. Not exposed over HTTP | The approved pattern of `identity.sellerAccessOf` (ID 8.1) and `sellers.sellingEligibility` (SL 7.1). The answers are not personal (badge data is public by design, 4.5); ownership of the seller id is the caller's guarantee from its stored record (ADR-0028 d1), and the use case never reads the actor |
| `ClaimGuard` port | Not a use case: takes a `MarketContext` and texts, no actor; recorded in the checked-in list of non-permission declarations (PF 6.2 row 5) | The kind ADR-0019 decision 7 already admits for the AI switch reader (SL 7.6): under the user's `CallContext` a guard failure would silently drop AI output or, worse, depend on the user's keys. Confirmed by Ali 2026-10-07 (19.2 item 6) |
| `CatalogReferences` port (8.2) | Same named-exception kind, declared here, implemented by `catalog` | Product and category existence are not personal and needed under admin actors only |

Ruling (19.2 item 6): no ADR-0018 amendment. `ClaimGuard` and `CatalogReferences` go on the
checked-in exceptions list with Hassan's review, and a CI check enforces the list of their callers
(the composition root binding and the named consumers of 4.6 and 3.4, 3.7). A boundary check fails
the build if a use case of the anonymous and system pairs is reachable from a controller (L3,
slice 1).

### 7.5 Rate limits (set by Hassan at G2, 2026-10-07, as proposed)
| Item | Limit |
|---|---|
| Uploads | 30 files per seller per 24 h; 10 for a seller not yet approved (brief s9: unapproved sellers upload too) |
| Submissions (submit, resubmit, renew) | 5 per certificate per 24 h |
| Issuer requests | 3 per seller per 24 h |
| Draft saves | 60 per minute, 1,000 per 24 h per account (SL 6.5) |
| AIS-02 calls | Per `platform/ai` budget; additionally 10 per seller per 24 h |
| Facade batches | 100 queries or texts per call |
| Draft storage | 200 MiB of draft files per seller (5.1) |

Per-account counters fail closed (`access.unavailable`), as SL 6.5.

### 7.6 Read shape of a pending relaxation (types, policies, issuer reactivation; H1)
```ts
interface RelaxationProposalView {
  readonly id: Id;
  readonly subject: 'type-revision' | 'claim-policy-revision' | 'issuer-reactivation' | 'type-reactivation';
  readonly subjectId: Id;                     // type, policy or issuer id
  readonly basedOnRevisionId: Id | null;      // the published revision it was made from
  readonly proposedRevisionId: Id | null;     // null for a reactivation
  readonly proposer: { accountId: Id; displayName: string }; // display name via identity R-11
  readonly proposedAt: Temporal.Instant;
  readonly reason: string | null;             // the optional change reason (3.7)
  readonly diff: readonly {
    readonly path: string;                    // field key, `terms.<locale>`, or `row:<selector>`
    readonly before: string | boolean | null; // codes and values, never free text of a seller
    readonly after: string | boolean | null;
    readonly relaxes: boolean;                // why the second admin is needed
  }[];
  readonly state: 'pending' | 'approved' | 'rejected' | 'withdrawn' | 'superseded';
  readonly decidedBy: { accountId: Id; displayName: string } | null;
  readonly decidedAt: Temporal.Instant | null;
  readonly actions: { approve: Allowed; reject: Allowed; withdraw: Allowed }; // allowed + denial code (ID 8.6)
}
```
At most one pending proposal per subject; a new save while one is pending is refused
(`review.proposal-pending`) until it is approved, rejected or withdrawn. `superseded` marks a pending
proposal whose base was replaced by a tightening revision published meanwhile; it must be made again.
The approve denial for the proposer is `review.second-admin-required`.

## 8. Boundary

`certification` imports `sellers`' `index.ts` (facade) and, for the contact point and display
names of 12 and 7.2, `identity`'s `index.ts`. It imports neither `catalog` nor
`ordering`: they import `certification` (ADR-0028 d9). A cycle would fail the `no-circular` rule.
From `platform/` it needs: Market context, `Clock`, `IdGenerator`, UnitOfWork and outbox, inbox and
`runOnce`, scheduler, audit writer, `SubjectKeyService`, permission registry, `platform/mail/`,
Market configuration, the object storage port (9.2; the S3 client `@aws-sdk/client-s3` is imported only
in `platform/storage`, enforced by a boundary rule), and from `platform/ai` (slice 16) the model
entry point, switch evaluation, file pipeline and the `ClaimGuard` declaration.

### 8.1 Public facade (`contracts/certification.facade.ts`)
| Method | Returns | Access rule | Slice |
|---|---|---|---|
| `evaluateClaims(ctx, queries)` | `ClaimDecision[]` (4.1), badge data inside | `anonymous` and `system` pair | 1; badge 10; manufacturer 13 |
| `certificationTypes(ctx, { status? })` | Per type: code, status, published revision id, name and description keys per locale, icon key, mode, form settings | `anonymous` and `system` pair | 2 |
| `matchClaimTerms(ctx, texts: { locale, text }[])` | Per text: matched type codes and token spans | `anonymous` and `system` pair | 2 |
| `sellerCertificateOverview(ctx, sellerIds)` | Per seller: type codes with a valid certificate and with one awaiting review (for the sellers admin list column, brief s12; composed by the panel) | `permissions [seller-certificate.view]` | 7 |
| `productMaterialContentChanged(ctx, productId, productRevisionId)` | Suspends every approved manufacturer certificate covering the product (3.4) | `system` | 15 |
| `assertCategoriesRetirable(ctx, categoryIds)` | `ok`, or a refusal `category.referenced-by-policy` with the type codes whose `NOT_APPLICABLE` or `SELLER_REQUIRED` rows name the ids (3.7; B2). `catalog` calls it before a move, merge or archive and refuses its own use case on a refusal or an error | `anonymous` and `system` pair | 13 |
| `platformCategoriesRetired(ctx, categoryIds)` | Backstop after `catalog`'s commit: flags rows on those ids, alerts on a non-`SELLER_OR_MANUFACTURER` row (3.7) | `system` | 13 |

### 8.2 Ports
| Port | Declared in | Implemented by | Notes |
|---|---|---|---|
| `ClaimGuard` | `platform/ai` (part 1) | `certification/infrastructure` | 4.6, 7.4. Until part 1 exists, the matcher is reached only through `matchClaimTerms` |
| `CatalogReferences` | `certification/application/ports` (exported from `contracts/`) | `catalog/infrastructure`, bound in the composition root; unbound fails boot once slice 13 is merged | `publishedProductRevisions(market, ids)` (existence and the current published revision id, M3), `variantsOf(market, productId)`, `platformCategoriesExist(market, ids)`. Named exception (7.4). The answer to "event or port" (catalog brief s6; ADR-0028 d9) |
| `ObjectStore` | `platform/storage` (designed with slice 3; 9.2) | Platform adapter | First consumer |
| `MalwareScanner`, `DocumentInspector` | `certification/application/ports` | Infrastructure adapters (9.3) | Move to `platform/` when `catalog`'s photo pipeline needs them (catalog slice 12) |
| `AI switch reader` | `platform/ai` | `sellers` (SL 7.6) | Read by `platform/ai`, not by this module |

### 8.3 Events published
`certification.<subject>-<past participle>.v1`; payloads from the closed vocabulary (PP 5.3), ids
and enums only; no actor. Every event comes in the slice that changes the state (brief s11).

| Type | Payload | Consumers |
|---|---|---|
| `seller-certification-submitted.v1` | `sellerCertificationId`, `sellerId`, `submissionId`, `kind` | Own: auto-approval for self-declaration, AIA-01 (slice 17) |
| `seller-certification-withdrawn.v1` | ids, `cause` | — |
| `seller-certification-approved.v1` | ids, `typeId`, `kind` (`initial`, `resubmission`, `renewal`: the brief's "renewed") | `catalog` (tags come back: brief s4 c 5); own mail |
| `seller-certification-changes-requested.v1`, `-declined.v1` | ids | Own mail |
| `seller-certification-expired.v1`, `-revoked.v1` | ids, `typeId` | `catalog` (re-evaluate); own mail |
| `seller-certification-issuer-confirmed.v1` | ids | `catalog` (display copy) |
| `seller-certification-expiry-warning-due.v1` | ids, `thresholdDays` (enum of the configured values) | Own mail |
| `product-certification-approved.v1`, `-expired.v1`, `-revoked.v1`, `-suspended.v1` (ADR-0012 d6) | `productCertificationId`, `revisionId`, `typeId` | `catalog` |
| `product-certification-coverage-changed.v1` | `productCertificationId`, `revisionId`, `previousRevisionId` | `catalog` (ADR-0028 d6) |
| `product-certification-expiry-warning-due.v1` | ids, `thresholdDays` | `catalog` warns Offer owners (CERT-45; request C-6) |
| `claim-policy-changed.v1` | `policyId`, `revisionId`, `typeId` | `catalog` |
| `certification-type-revised.v1` | `typeId`, `revisionId`, `claimTermsChanged` | `catalog` (re-scan text, catalog Q6) |
| `certification-type-activated.v1`, `-deactivated.v1` | `typeId` | Storefront later (filters) |
| `issuer-deactivated.v1` | `issuerId`, `form` (`closed-to-new`, `derecognised`) | `catalog` (for `derecognised`: tags whose copy names this issuer, ADR-0028 d11); own mail |
| `issuer-request-answered.v1` | `issuerRequestId`, `sellerId`, `outcome` | Own mail |
| `relaxation-proposed.v1` | `proposalId`, `subject` | Own mail to the other admins (12) |
| `document-received.v1` | `documentId` | Own scan handler |

### 8.4 Events consumed (`presentation/subscribers/`, system actor, `runOnce`)
Only its own events: mail (12), the scan handler (3.8), self-declaration auto-approval (a rule-based
automation; no model, R2), and in slice 17 AIA-01 (13). No other module's event: `catalog` reaches
this module through facade calls from its own handlers (ADR-0028 d9).

### 8.5 Calls to `sellers`
| Call | Where | Notes |
|---|---|---|
| The fixed zone read of request S-1 (name is `sellers`' to choose) | `evaluateClaims` (T2, B1) | Non-provisional zone only, the same answer for every caller; an unapproved seller has none, which is "no zone" and so "not allowed": correct, since such a seller cannot sell |
| `sellerSummaries(ctx, ids)` | Submit and approve guards, the job | Zone, provisional allowed here (B1 ruling): these decide a review step or a status record, not the claim |
| `reviewerBusinessDetails(ctx, sellerId)` | Review page | Personal data; returned only to the reviewer, never logged, audited by `sellers` (SL 7.1) |
| `sellingEligibility` | Never | CERT-12: the claim and may-sell are separate questions; `catalog` asks both |

### 8.6 Jobs (`presentation/jobs/`, worker, per hosted Market)
| Job | Every | Work |
|---|---|---|
| `certification.expiry-and-warnings` | 15 minutes (set at G2; brief s7 "cadence and latency target") | Seller certificates whose boundary in the seller's current zone has passed: `approved` → `expired`, one event and one audit row each (AC 9). Warnings whose local day has started: one stored marker per (submission, threshold), so a re-run creates nothing (AC 9). Manufacturer certificates in the Market zone, same. Bounded batches of 100. Target: status and event within 30 minutes of the boundary (evaluation is already "no" at the boundary). Alert when a run fails twice in a row (brief s9) |
| `certification.purge-drafts` | Daily | Drafts never submitted and refused files older than the retention value (5.1); waits for counsel; deletes draft objects |

The job reads zones through `sellers.sellerSummaries` in batches of 100 (system actor gets provisional
zones; allowed by the B1 ruling). Concurrency per PP 7: safe to run twice.

## 9. Documents and storage

### 9.1 What is stored where (ADR-0009 decision 5, VER-07, brief s5)
| Object | Area | Key | Lock |
|---|---|---|---|
| Uploaded file before submission | Draft bucket: no versioning, or a lifecycle rule that expires non-current versions (M7; period with Kazem and Hassan in ADR-0029); bytes encrypted under the seller's subject key like evidence (M7) | Random id | None; deleted on submit, removal or purge |
| Document of a submission or manufacturer revision | Evidence bucket with Object Lock, retention mode; the period is set per object at promotion from the Market's retention configuration; no bucket default before counsel answers (T6 ruling) | Content address: SHA-256 of the stored bytes (ciphertext, 9.4) | Never overwritten; a replacement is a new object |
| Preview renditions (server-made PNG pages, metadata stripped) | Evidence bucket beside the document | Derived from the document key | Same lock |

### 9.2 `ObjectStore` port (platform; first consumer; ADR-0015 trigger "object-storage client")
Contract only; Hossein and Ali design the adapter with the ADR-0016 review (slice 3): `putDraft`,
`deleteDraft`, `promote(draftKey, expectedHash, retainUntil) → evidenceKey` (copy, verify that the
hash equals the one recorded when the document became `clean`, M7; set the lock period; delete the
draft), `get(key)` as a
stream, `head(key)`; every call takes the `MarketContext` and the bucket names come from the Region
Stack configuration. No public URL and no presigned URL in Phase 3: bytes reach a browser only
through the API (9.4). The local server must support versioning and Object Lock in retention mode
(the criterion board 13 item 6 adds to ADR-0016's table). Fallback if no maintained candidate does
(Ali S5): the lock exists in production only, proven by a staging smoke test before the first
production upload, and the gap is recorded in ADR-0029; the adapter never fakes a lock. The S3 client
is `@aws-sdk/client-s3`, imported only in `platform/storage` (boundary rule; 15).

### 9.3 Intake checks (brief s5, s9; AC 21)
1. Size and count limits (5.1) checked while streaming; over the limit stops reading.
2. Type by content inspection only; allowed: JPEG, PNG, PDF, and HEIC/HEIF (phone cameras) only if
   spike 2 shows a decoder that meets 15; otherwise HEIC is refused with a "convert to JPEG" message
   (copy by Hadi). Refused always: SVG, HTML, Office formats, archives, encrypted PDF, PDF with
   JavaScript, actions, embedded files, forms or XFA (brief s5), and polyglots (a file that also
   parses as another type; L5).
3. Malware scan through `MalwareScanner`; a timeout or error is `refused` (`file.scan-failed`).
4. Parsing and rasterising run in a separate sandboxed process with CPU, memory and time limits
   and no network (`DocumentInspector`; brief s7 "parser sandbox"): rasterising at most 150 DPI,
   at most 512 MiB decompressed size and process memory (L5). Images are decoded and
   re-encoded; EXIF and other metadata (location) never reach a preview, a customer or a model
   (brief s9).
5. These checks are this module's (and later a shared platform intake), **separate from**
   `platform/ai`'s file pipeline (brief s7): the AI pipeline only ever receives `clean` documents
   (ADR-0019 decision 9).
6. A file refused as malware (`file.malware`) is never served, previewed or sent to a model; its
   retention is part of owner question 2 and waits for counsel (19.1).
7. When a document becomes `clean`, the hash of its stored bytes is recorded; promotion checks it
   (M7, 9.2).

### 9.4 Serving and encryption
| Topic | Design |
|---|---|
| Preview | Streamed by the API through `own-document.preview` or `seller-certificate.review-read`, PNG only, `Content-Type` fixed, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, `Cache-Control: no-store`, `Content-Disposition: inline` |
| Original | `document.download` only: `Content-Disposition: attachment` with a server-made file name, `application/octet-stream`, audited per read (AC 21) |
| Separate origin (brief s8 risk, board 13 item 6) | **Toss-up T5. A (recommended for Phase 3):** no separate origin; only re-encoded PNG previews are ever shown inline, originals are attachments. **B:** a cookieless origin with short-lived signed URLs, the infrastructure `catalog` needs for public photos (board 15 item 6). **Ruling (2026-10-07):** A for `certification` only, on conditions: inline content is only server-made PNG; every download sends `nosniff` and `Content-Security-Policy: sandbox`; no presigned URLs. The cookieless origin B is required before `catalog`'s public photos and is decided in ADR-0029 |
| Encryption of the bytes | **Toss-up T6. A (recommended):** each document is encrypted under the seller's subject key before it is stored (envelope: a random data key per file, wrapped with the subject key), so erasure is key destruction even under Object Lock (ADR-0009 decision 6) and the content address is over ciphertext (no plain hash of personal data). Needs a byte-oriented operation on `SubjectKeyService` (request P-1). Manufacturer documents (no seller) use a platform key. **B:** governance-mode lock, erased by a privileged delete; weaker evidence guarantee and a privileged role to protect. **Ruling (2026-10-07):** A, with the lock period set at promotion from Market configuration and no bucket default before counsel. Draft bytes are encrypted the same way (M7) |

### 9.5 Retention
Submitted documents follow the Market's legal retention first (ADR-0009 decisions 6 and 7);
never-submitted drafts and refused files are purged (8.6). All periods wait for counsel (brief s11).

## 10. Personal data

### 10.1 Fields and keys
All seller certificate data is personal (brief s5). Subject: the seller id (key created by
`identity` with the `SellerAccess`, as in SL 8.1). Labels `certification.<record>.<field>`.

| Field | Live | In submissions and history |
|---|---|---|
| Certificate number, location and scope as read, reason and note texts, issuer-confirmation reference, self-declaration note, AI suggestions (13) | Encrypted | Encrypted |
| Documents and previews, draft files included | Encrypted bytes (T6, M7) | Same |
| Type, issuer id, dates, status codes, check codes, flags | Clear | Clear |
| Manufacturer certificate fields | Clear except the number and documents, confidential under a platform key (ruling 19.2 item 9) | Same |
| Issuer request typed name | Encrypted (a seller's text) | — |

### 10.2 Keyed indexes and hashes
`CertificateNumberIndex` and `DocumentIndex`: HMAC-SHA-256 under a stack secret, with the Market and
type in the input, over the normalised number and over the plaintext bytes; used only for the
reviewer's duplicate hint (3.2 rule 6). The secret differs from `sellers`' `IdentifierIndex` secret
(boot check), is never logged, is backed up like the KEK (SL 7.6). Submission `contentHash` uses
`SubjectKeyService.hmac` (SL 2.4 rule 2). On the seller's erasure (key destruction, ADR-0009
decision 6) the seller's rows of both indexes are deleted, because a stack-secret HMAC survives the
subject key (L4; slice 7, with the erasure handler; the only `DELETE` grant on these tables).

### 10.3 Never outside the module
No personal field in an event, the outbox, an audit `before` or `after`, a log line, an error or a
URL (AC 22; VER-13). Searches are POST bodies; request bodies are not logged; responses with
decrypted data carry `Cache-Control: no-store`; panels keep unsaved drafts in memory only (SL 8.3).

## 11. Audit and history

**Audit** (`platform.audit_log`, in the transaction of the change; `before` and `after` hold ids,
codes and booleans only; each decision row carries the submission or revision id, a keyed hash and
the type revision id, AC 22): `certification.seller-certification.approved`, `.changes-requested`,
`.declined`, `.revoked`, `.expired` (system actor), `.renewal-approved`;
`certification.type.relaxation-requested`, `.relaxation-approved`, `.reactivation-approved`;
`certification.claim-policy.relaxation-requested`, `.relaxation-approved`;
`certification.issuer.reactivation-requested`, `.reactivation-approved` (H1: each its own row);
`certification.review-check.recorded` (one per new row, M6), `certification.issuer-confirmation.recorded`;
`certification.document.downloaded`, `certification.history.viewed`,
`certification.review-page.viewed`; `certification.type.revised`, `.activated`, `.deactivated`;
`certification.issuer.created`, `.activated`, `.closed-to-new`, `.derecognised`;
`certification.issuer-request.answered`; `certification.product-certification.recorded`, `.edited`,
`.approved`, `.rejected`, `.suspended`, `.reinstated`, `.revoked`, `.expired`;
`certification.claim-policy.revised` (its `after` may hold the optional change reason, the one
free-text exception, 3.7). A seller's own submit or withdraw is not an audit row (it is
history), as SL 9.

**Status history** (CERT-17, V4, append-only and never updated (M6, 3.2 rule 8), owned here; brief s8 item 7): one row per transition of
3.1 and 3.4: from, to, instant, actor kind and account id, reason code, the encrypted note. The
first row is written at the first submission: creating or editing a draft writes none, so a
never-submitted record holds no history and can be deleted (3.1; Q-C1). The table comes with slice 5
(first submission); the minimal read (current status, reason, who and when) with slice 7; the full read with slice 11
under `document.view`.

## 12. Mail

Sent through `platform/mail/` from handlers of own events, in the worker, system actor; read,
render and send outside any unit, then `runOnce` (ID 9). Templates
`certification.mail.<template>`; locale the Market's default; values escaped. Recipient: the Seller
Owner's sign-in address and locale through `identity`'s contact point (SL request R-4, accepted).
Until `notifications` (Phase 6) mail is the only channel (brief s8 item 11).

| Template | Trigger |
|---|---|
| Approved; changes needed (reason, next step); declined (reason) | 8.3 events |
| Expiry warning 30, 14, 1 days: consequence and "submit by" date (brief s4 c 2) | `-expiry-warning-due` |
| Expired; revoked (reason) | 8.3 events |
| Issuer no longer recognised: why and what to do (Q6) | `issuer-deactivated` with `derecognised`, one per affected seller |
| Issuer request answered | `issuer-request-answered` |
| To admins: a relaxation proposal is waiting (7.6) | Proposal raised (own event `relaxation-proposed.v1`, internal: ids only). Sent to every other admin of that Market holding the approving key (`type.edit`, `claim-policy.edit` or `issuer.edit`), never the proposer; no values in the mail, only the subject kind and a link to the proposal. If no such admin exists, nobody is mailed and the proposal stays `pending`: the proposer can never approve it (H1) |
| To reviewers: new submission in the queue | `-submitted`, coalesced to at most one per Market per hour (proposal) |

## 13. AI uses (ADR-0019; slices 16 and 17, optional for launch)

Designed only as far as this module's side; the rest waits for `platform/ai` part 1, which declares
the switch evaluation, budget, file pipeline and `ClaimGuard` (brief s3; ADR-0019 decision 6).

| Topic | AIS-02 (fill from document) | AIA-01 (read for the reviewer) |
|---|---|---|
| Capability scope | Seller-scoped; off unless the Market and the per-seller switch are on (Q4: off for a new seller until an admin switches it on) | Seller-scoped; the same switch stops it for that seller's files (ADR-0019 decision 7) |
| Trigger | The seller presses "fill from document" (`own-certificate.fill-from-document`), synchronous, outside any unit; refused in acting-as (R3) | Asynchronous: own handler of `-submitted` (system actor, no tools); Market from the envelope, seller from the record, switch evaluated again (R3) |
| Input allow-list (R5) | One `clean` document's pages through the file pipeline; the Market's issuer names of the selected type; the type's field list. Never another seller's data, the business details, the number index | The same document's flattened rendition the reviewer sees; the submitted form values; the issuer's registry name and state |
| Output (closed schema, R9) | Per field: suggested value or `not-found`; issuer only as an id from the registry or `no-listed-issuer-found` (never a nearest guess); dates as dates; uncertainty as a word from a fixed list. Type, ticks and attestations are never suggested (R14) | Per field: one state from a fixed list (`read-same`, `read-different`, `not-found`, `unreadable`) plus the read value as a quotation; no sentence, no score, no "all clear" (R6); a fixed list of what was not checked (authenticity, seal, issuer enquiry). For a field AI filled and the seller accepted unchanged, `read-same` is not shown |
| Effect | A draft: each field accepted, edited or rejected by the seller; no "accept all"; the record changes only through `save-draft` and `submit` (R4). Per field provenance `manual`, `ai-accepted`, `ai-edited` stored in the submission and shown to the reviewer | Shown on the review page only; never orders the queue, ticks a check, makes a notification, or counts as a second person (R2) |
| Storage (R12) | Suggestion records bound to the document's content address, encrypted under the seller's key; discarded when the document changes; retention with the draft | Result bound to the document address; a new document drops it |
| No-AI path | Upload and manual form never wait; states "reading", "could not read", "partly read", "limit reached", "AI is off" never block (brief s4 a 5) | The same page without the section, with a plain reason (brief s4 b 4) |
| Done (ADR-0019 decision 9) | Synthetic versioned evaluation set, claim leakage 0, allow-list respected, canaries across sellers and Markets, injection samples one in a file, inert rendering, non-AI path walked, both Markets, `pnpm verify` offline | Same |

## 14. Slices

### 14.1 Order, size and security gates
Every slice is one branch and one PR (rule 13), tested on AU and ZZ and the four zone fixtures,
with Hassan's review (tier A; every slice touches the CERT enforcement path, a file surface or an
AI surface). Sizes as ID 12.1.

| # | Slice | Size | Needs first | Hassan checks |
|---|---|---|---|---|
| 0 | ADR-0028 accepted (7.4 confirmed by Ali 2026-10-07) | — | This G2 | — |
| 1 | `CertificationType` (minimal), `SellerCertification` with a test-only path to an approved submission, `validity.ts`, `ClaimRule`, `evaluateClaims` (seller basis, default, `NOT_APPLICABLE`), outbox and inbox | M | `sellers` slices 1 and 2; the fixed zone read of S-1 (its `sellers` mini-review); identity 8a (registry); ADR-0030 accepted (raw read helper, data design 7.2) | Fail-closed matrix; AC 1 to 4, 8; no actor read; same answer under every caller (B1); CI check that the anonymous and system pairs are not reachable over HTTP (L3) |
| 2 | Type revisions with form settings, default basis, claim terms; seeds (AU, ZZ); `Issuer` with expert reference; `certificationTypes`; `matchClaimTerms` | M | 1 | Matcher normalisation and corpus, incl. separator-removed, digit-to-letter and cross-locale cases (M8); seed path exemption; type relaxation pending a second admin, `verificationMode` immutable (H1) |
| 3 | `ObjectStore` port and adapter; local server in compose; draft and evidence buckets | M | ADR-0029 accepted (storage parts); spike 1; the dependency approvals of 15 | Bucket policy; no public access; draft bucket lifecycle (M7); promote checks the clean hash (M7); no fake lock (S5) |
| 4 | Intake: inspection, scanner, sandbox, previews, preview and download use cases, `document.view` | L | 3; ADR-0029 intake parts; spike 2; P-1 | The whole of 9.3 and 9.4 incl. the sandbox caps and polyglot refusal (L5) and draft encryption (M7); joins the penetration-test scope (ADR-0018 decision 7) |
| 5 | Add a certificate: draft, upload, review step, submit, withdraw by edit; limited sign-in entries | L | 4; I-1 | Status history table (first row at submission, 11); AC 10, 11, 17, 21; acting-as refused, and refused when unsure (M5); document owner, purpose and state at save-draft and submit (L2) |
| 6 | Issuer request and queue | S | 5 | Typed name never reaches an issuer |
| 7 | Queue and review page, checks, scope, issuer confirmation, approve, changes needed, decline, minimal history, mail, `sellerCertificateOverview` | L | 5; `sellers` slice 9 (`reviewerBusinessDetails`); R-4 and R-11 of `identity` | AC 13, 14, 22, 23; append-only grants and trigger (M6); index rows deleted on erasure (L4) |
| 8 | Resubmission and renewal | M | 7 | AC 15 |
| 9 | Expiry and warnings job, events, mail | M | 7 | AC 8, 9; idempotence |
| 10 | Badge data in `ClaimDecision` | S | 7 | AC 23; nothing personal |
| 11 | Revoke; full history read | S | 7 | AC 16, 22 |
| 12 | Type and registry admin pages' use cases; the two deactivation forms; derecognition mail; issuer and type reactivation by a second admin | M | 9 | AC 19; H1 |
| 13 | `ClaimBasisPolicy` with relaxation by a second admin; manufacturer basis in `ClaimRule`; `CatalogReferences`; `assertCategoriesRetirable` and the `platformCategoriesRetired` backstop | M | 12; `catalog` implements the port (C-3) and calls the check (C-4) | AC 4 to 6; policy change audit; strictest of all matching rows, `SELLER_OR_MANUFACTURER` never on handling (M1); category retirement refused (B2); H1 |
| 14 | `ProductCertification` and coverage with product revision ids; another person | L | 13 | AC 20; coverage revision; product revision mismatch is `not-covered` (M3); a variant-narrowed entry never matches `variantId = null` (L1) |
| 15 | Manufacturer expiry, suspend, revoke, material change, warnings event | M | 14; `catalog` C-2 | AC 7 |
| 16 | AIS-02 with `platform/ai` part 1, `ClaimGuard` adapter | L | `platform/ai` part 1; ADR 3 (provider); `sellers` slice 16 | R15 review; AC 26 to 28, 30, 31 |
| 17 | AIA-01 | M | 16 | AC 29, 30 |
| 18 | Panel screens (frontend; one PR per row of `ux.md`) | XL in all | Figma and F0 (ADR-0017); each after its backend slice | Frontend track |

On the path to the first sale: 0 to 11, and `catalog`'s tag slices after 1, 2 and 10 (catalog
brief s11). Launch-required, not first sale: 12 (derecognition is the safety valve of Q6). Built in
Phase 3 and off in AU until the two preconditions: 13 to 15 (Q2). Optional: 16, 17. Slices with a
migration: 1, 2, 4, 5, 6, 7, 9, 13, 14 (Mojtaba places them). About 17 backend PRs; no date until
Javad has the pace of `identity` and `sellers`.

### 14.2 Platform triggers (ADR-0015 decision 3) pulled by `certification`
| Trigger | Slice |
|---|---|
| Object-storage client and the local server (ADR-0016 decision 3) | 3 |
| First file intake (scanner, sandbox, preview) | 4 |
| First zone-aware job per party ("daily at the seller's local midnight", ADR-0005 decision 6) | 9 |
| `platform/ai` and the CI rules of R2 and R7 | 16 |
| Byte encryption on `SubjectKeyService` (T6 A accepted) | 4 |
| Not pulled: the extension-point registry and `AttributeSchema` (fixed form; brief s11), Redis, Market configuration in the database | — |

### 14.3 Spikes (run, not merged)
| # | Spike |
|---|---|
| 1 | Local S3-compatible servers against the Object Lock and versioning criterion: maintained, pinned by digest, not MinIO (Hossein; Ali reviews; feeds ADR-0029) |
| 2 | Scanner and sandbox: throughput, memory, the caps of 9.3 and HEIC support on the minimum Node version (Hossein; Kazem for the daemon; feeds ADR-0029) |
| 3 | The three statements of 4.2 at 100 queries on a seeded volume, with Mojtaba |

## 15. Dependencies (rulings of Ali, 2026-10-07; for the owner's bundled list)
| Need | Standard library? | Ruling |
|---|---|---|
| S3-compatible client | No | `@aws-sdk/client-s3`, imported only in `platform/storage`; a boundary rule fails the build elsewhere |
| Local S3 server with Object Lock | No | Chosen by spike 1: maintained, pinned by digest, not MinIO; recorded in ADR-0029 |
| Malware scanner | No | A self-hosted scanner daemon only (no external scanning service), as a compose service and a production service per Region Stack, behind `MalwareScanner`; Kazem owns signature updates and memory |
| PDF inspection and rasterising; image decode and re-encode | No | A PDF renderer and an image library, each run as a separate process with no network; permissive or LGPL licences, never AGPL. The image library is shared with `catalog`'s photo pipeline (board 15 item 6) |
| HEIC/HEIF decoding | No | Only if spike 2 finds a decoder that meets the row above (licences incl. HEVC); otherwise HEIC is refused with "convert to JPEG" (Hadi's copy) |
| File type detection | Partly | Magic-byte checks in our code; a package only if the spike shows a need |
| Separate cookieless origin | Infrastructure | Not for `certification` (T5 ruling); required before `catalog`'s public photos, decided in ADR-0029 |
| Envelope encryption of bytes | Yes (`node:crypto`) | No package; `SubjectKeyService` extension (P-1) |

## 16. Hand-offs

### 16.1 For Mojtaba (`docs/design/data/certification.md`)
Schema `certification`. Tables per aggregate root of 2.1 and their children; `outbox`, `inbox`;
warning markers; upload quota counters. Decisions that are his: submissions and revisions as rows
with encrypted content (V1 columns of ADR-0009 decision 2); the partial unique index for T1
(one non-terminal certificate per Market, seller, type); unique (Market, type, code) for types and
the issuer uniqueness rule; the three single statements of 4.2 and their indexes (seller and type;
policy rows by selector; coverage by product and variant); the job's selection index (boundary
instant); the immutable-history trigger pattern; grants (no `DELETE` except drafts, documents in
the draft area and quota rows). Every root has `version`; children's foreign keys include
`market_id` (PM6). Inputs: the stored boundary instants (T2), the editor set of a manufacturer
revision (3.4).

**Changes from the 2026-10-07 review that `data/certification.md` must carry** (he is writing it
now; not edited by this document):
1. Coverage rows carry the covered `product_revision_id` (M3); the coverage index serves (product,
   product revision, variant), and a variant-narrowed entry is distinct from a whole-product one
   (L1).
2. No `UPDATE` and no `DELETE` on submissions, decision rows, status history, review checks and
   issuer confirmations, by grant and by trigger (M6); a submission's status is its latest
   decision row; review checks are rows, latest per (submission, check code) wins.
3. Type revisions, policy revisions and issuer reactivations have a `pending` state with author
   and approver columns and a check that they differ (H1); the published pointer moves only on
   approval.
4. `verificationMode` immutable per type: a trigger or a column on the type root, not the revision
   (H1).
5. A `DELETE` grant on the two HMAC index tables for the erasure handler only (L4).
6. The document row stores the hash recorded at `clean` (M7) and draft objects are encrypted:
   the wrapped data key is stored for draft documents too.
7. A per-seller draft storage quota of 200 MiB (5.1) beside the upload counters.
8. The policy row selector check: `SELLER_OR_MANUFACTURER` only with a category selector (M1).
9. The fixed zone read of S-1 replaces `sellerSummaries` in the seller-basis statement inputs.
10. `DELETE` of a never-submitted certificate record with its draft and draft documents
    (`own-certificate.delete-draft`, 3.1); refused by a check when any submission exists.
Answers to data design section 13 (2026-10-07): Q-C1 confirmed (11). Q-C2: no delete use case for
a manufacturer draft; the record stays as admin data and its never-submitted draft files are removed
by `purge-drafts` (8.6) after the retention value, like seller drafts. Q-C5: out of scope (19.2 item
14). Q-C6: previews rendered into the draft area (encrypted like the draft, M7) and copied at
promotion under the same lock as their document. Q-C7: confirmed, the aggregate refuses mixing
(2.1). Q-C8: renewals first, then FIFO by submission instant (7.2). Q-C9: yes on all three (3.7).
Q-C10: fixed in 3.6. Correction for data design section 16: the rule is the strictest of all
matching rows, the type default **only when no row matches** (4.2 step 3, 19.2 item 12), not "rows
and the default".
11. Relaxation proposals (7.6): one pending per subject (partial unique index), proposer and
    decider columns, state; the optional change reason (≤ 500 characters) on policy revisions and
    the audit row (3.7).

### 16.2 For Reza (`docs/modules/certification/ux.md`)
The screens of brief s12. From the API: the status codes of 3.3; refusal codes (`file.*` of 3.8,
`issuer.not-active`, `certificate.already-expired`, `review.not-current-submission`,
`review.checks-missing`, `review.issuer-not-accepting`, `review.not-another-person`,
`seller.zone-missing`, `type.inactive`, `certificate.exists-for-type`); per action `allowed` and a
denial code (the pattern of ID 8.6 row 6); the warning before an edit withdraws a submission;
`submitBy` dates; the zone named next to every seller time (SL 14.3 Reza 11); badge data (4.5);
reviewer page parts of brief s4 b; AI states of 13. The "Certificate type" column of the sellers
list is composed by the panel from `sellerCertificateOverview` (the `sellers` module cannot import
this one). The "products affected by new claim terms" count before a type save comes from a
`catalog` admin endpoint the panel calls (request C-7).

**Changes from the 2026-10-07 review that `ux.md` must carry** (Reza is writing it now; not edited by
this document):
1. New refusal codes: `category.referenced-by-policy` (catalog's category pages show the types to
   fix first, B2), `review.second-admin-required` (relaxing type or policy revisions, type and issuer
   reactivation, H1), `access.acting-as-refused` on every seller certificate action (M5),
   `file.polyglot` and, unless spike 2 succeeds, `file.heic-not-supported` with Hadi's "convert to
   JPEG" copy.
2. Admin screens for a `pending` relaxation: who asked, what relaxes, approve by another admin;
   the type form shows `verificationMode` read-only after creation.
3. The policy page shows flagged rows on retired categories.
4. Upload limits shown to the seller: 10 MiB per file, 10 files, 20 pages, 40 megapixels, 200 MiB of
   drafts per seller (5.1).
5. Review checks show the latest result per check, with earlier results as history (M6).
6. Manufacturer coverage shows the product revision each entry covers and a "product changed since
   approval" state (M3).
7. Duplicate hint (Hassan C3; ux.md open point 6 and the `review.duplicate.*` keys): per match the
   kind, the other seller's public store name (or "not yet approved") and a link to that certificate,
   not a count only; a note that opening it is recorded (like `review.doc.recorded`); the hint never
   appears on any seller screen. API need 7 "duplicate hints (counts and ids)" becomes per match:
   kind, other certificate id, public store name.
8. API needs answered: queue store name (7.2; open point 5), delete a never-submitted draft (3.1,
   7.2; API need 4: keep "Delete draft"), relaxation proposals (7.6) with `review.proposal-pending`.

## 17. ADRs needed
| ADR | Status | Order |
|---|---|---|
| ADR-0028 "Certification claim contract amendments" | Drafted with this design, Proposed | Accepted before `catalog`'s G2 (board 13 item 1) |
| No ADR for the access rule of 7.4 | Confirmed by Ali 2026-10-07 | Before slice 1 |
| ADR-0029 "Object storage and file intake" (local server, Object Lock and its fallback, draft lifecycle, lock period at promotion, scanner, sandbox and caps, HEIC, T5 conditions, the cookieless origin for `catalog`, T6) | To be written by Ali; spikes 1 and 2 by Hossein; Kazem for operations; Hassan reviews. It amends ADR-0016 | Accepted before slice 3; its intake parts before slice 4 |
| ADR 3 of ADR-0019 (provider) | Existing plan | Before slice 16 |
| ADR-0026 (admin-editable Market settings) | Accepted by the owner 2026-10-07 (its decision 9: types, issuers, policies and the Market `defaultTimezone` are never settings; ADR-0028 relates to it) | Before any AI capability is switched on |

## 18. Requests to other modules
No port, facade or event of another module is changed by this document.

| # | To | Request | By slice |
|---|---|---|---|
| I-1 | `identity` (mini-review, board 13 item 4) | Allow-list entries of 7.2 (N = allow) for a seller not yet approved or rejected | 5 |
| I-2 | `identity` | Reuse R-4 (contact point) and R-11 (admin display names) accepted for `sellers` | 7 |
| I-3 | `identity` | Seed the default admin role "Certification Reviewer" and map the keys of 7.1 to default roles (R10) | 7 |
| S-1 | `sellers` | **New (B1):** one fixed read of sellers' non-provisional zones by id, whose answer does not depend on the caller (an `anonymous` and `system` pair returning only the zone of the approved revision, or nothing), for `evaluateClaims`. `sellerSummaries` (provisional to system and authenticated callers) stays for the guards and the job; `reviewerBusinessDetails` as approved | 1, 7 |
| S-1 note | `sellers` | S-1 changes `sellers`' facade, so it needs its own `sellers` mini-review: Mohammad drafts, Ali and Hassan review, a row in the `sellers` brief change log; approved before `certification` slice 1 merges. Not a blocker of this G2 (Ali, 2026-10-07) | Before 1 merges |
| S-2 | `sellers` | Replace the claim group of the slug data file by the `ClaimGuard` port once `platform/ai` part 1 declares it (SL 3.5 "later supplied by the port") | After 16 |
| C-1 | `catalog` | Apply ADR-0028: query from the storable Offer state with the product revision id (M3), every platform path, attestation flag; ask on every entry path of d5 incl. Offer reactivated or unsuspended, variant added, tag re-enabled (M9); refuse the save when `matchClaimTerms` fails (M8); accept a decision only with equal `inputs` under the Offer version; copies restrict only; tag copy keeps certificate, version and issuer ids | Its tag slice |
| C-2 | `catalog` | Publish `catalog.product-material-content-changed.v1`; its own handler calls `productMaterialContentChanged` (ADR-0028 d6, d9) | Before 15 |
| C-3 | `catalog` | Implement `CatalogReferences` (8.2), incl. `publishedProductRevisions` | Before 13 |
| C-4 | `catalog` | **Changed (B2):** its move, merge and archive of a platform category call `assertCategoriesRetirable` first and are refused on a refusal or an error (`category.referenced-by-policy`); after the commit its handler calls `platformCategoriesRetired` (backstop) and re-asks the affected tags | Before 13 |
| C-5 | `catalog` | Consume 8.3 events; derecognition by issuer id from the tag copy; the daily reconciliation run over both bases and suspended tags (ADR-0028 d10) | Its re-evaluation slice |
| C-6 | `catalog` | Warn Offer owners on `product-certification-expiry-warning-due` (CERT-45) | Before 15 |
| C-7 | `catalog` | An admin endpoint: number of published products whose text a proposed term list would match (catalog Q6) | Before 12 |
| C-8 | `catalog` (information for its G2; Hassan) | Moving a category under a parent named by a `SELLER_OR_MANUFACTURER` row eases the rule for its products: `catalog` treats the move as an entry path (ADR-0028 d5), re-asks the affected tags and audits the move | Its G2 |
| A-1 | `platform/ai` part 1 | Declare `ClaimGuard` (named exception, `MarketContext` only, error = claim); keep upload checks out of the AI file pipeline; field allow-lists of 13 | Before 16 |
| P-1 | Platform (`SubjectKeyService`) | A byte-oriented envelope operation (data key per object, wrapped by the subject key), if T6 A is accepted | Before 4 |
| O-1 | `ordering` (Phase 5 G1) | ADR-0028 d4 and d12: fresh `evaluateClaims` at purchase in the same request; snapshot copies decision and badge data | Its G1 |

## 19. Review record and open points

### 19.1 For the owner (Persian summary, through Hadi)
| # | Question, in plain words | Team recommendation | State |
|---|---|---|---|
| 1 | Does the "waiting for review" page of a certificate promise a review time? (brief s7, asked with the page text) | No promised time at launch; renewals first in the queue | **Decided by the owner 2026-10-07: no promise** |
| 2 | How long do we keep certificate files, unsent drafts and refused files, including files refused as malware? | Counsel decides; nothing is purged before the answer, and documents follow the legal retention first. Until counsel answers, a file refused as malware is never served, previewed or sent to AI (9.3) | Pending counsel |

Told, not asked: one certificate per type per seller at a time (T1); the manufacturer certificate is
suspended as a whole when a covered product's material content changes (ADR-0012 d3 as written; this
can take many Offers off the badge); renewals and corrections are reviewed the same way; a coverage
correction waits for the second person while the old coverage stays live (T3); AU issuers stay
"proposed" until the halal expert's list arrives, so no real certificate can be approved before it;
a platform category that a claim rule names cannot be moved, merged or archived until an admin moves
the rule (B2); easing a type or a claim rule needs a second admin (H1).

### 19.2 Team decisions at G2 and their rulings (Ali, Hassan; 2026-10-07)
| # | Point | Proposal | Ruling |
|---|---|---|---|
| 1 | T1 to T6 | The recommended options | Accepted. T2 subject to B1 (2.3). T4 with verification mode at two values and immutable per type (2.3, 3.6). T5 A for `certification` only, with the conditions of 9.4; origin B required before `catalog`'s public photos, in ADR-0029. T6 A with the lock period set at promotion from Market configuration, no bucket default before counsel (9.1, 9.4) |
| 2 | Re-activation of a `closed-to-new` issuer (not in the documents) | Allowed with a new expert reference; `derecognised` stays terminal | Accepted with a second admin (H1; 3.5) |
| 3 | Pending submissions naming an issuer that becomes `closed-to-new` (AC 19 left to G2) | Not approvable; the reviewer requests changes; renewals naming it refused at submit | Accepted |
| 4 | Renewal of an existing certificate of a type made inactive | Allowed (CERT-03 closes only new certificates) | Accepted |
| 5 | Policy rows on retired platform categories | (was: flagged through `platformCategoriesRetired`) | **Replaced (B2):** move, merge and archive refused while a `NOT_APPLICABLE` or `SELLER_REQUIRED` row names the category, until an admin moves the rows; `SELLER_OR_MANUFACTURER` rows only get stricter on lapse and stay flagged; backstop flagging kept (3.7, 8.1, C-4, ADR-0028 d5, d9) |
| 6 | 7.4 reading of ADR-0018 decision 4 | No ADR; `ClaimGuard` and `CatalogReferences` as named exceptions in the checked-in list | Accepted: no ADR-0018 amendment; both on the checked-in exceptions list with Hassan's review and a CI-enforced caller list (7.4) |
| 7 | Protected status of `type.edit`, `seller-certificate.revoke` | Protected | Accepted; `product-certificate.approve` protected too (7.1) |
| 8 | Numbers of 5.1 and 7.5; job cadence 15 minutes | Hassan sets | Set: 10 MiB per file, 10 files, 20 pages, 40 MP, plus 200 MiB of drafts per seller; 7.5 as proposed; job every 15 minutes |
| 9 | Manufacturer number and documents: confidential under a platform key | Hassan | Confidential under a platform key (10.1) |
| 10 | Snapshot keeps "verified with issuer" (ADR-0028 d12) | Yes | Accepted |
| 11 | New: are `requiresExpiry` to false and `defaultBasis` from `NOT_APPLICABLE` to `SELLER_REQUIRED` relaxations under H1? | Yes; this design treats them so (3.6) | Closed: both are relaxations (Ali; confirmed by Hassan) |
| 12 | New: the type default in M1 | Hassan's M1 reads "the strictest of all matching rows and the type default". Taken literally, `SELLER_OR_MANUFACTURER` could never result, since `defaultBasis` is never `SELLER_OR_MANUFACTURER` (brief s5, AC 4), and the manufacturer basis of ADR-0012 would be dead. Applied here: strictest of all matching rows (every path and handling together), the default when none match (4.2 step 3). Alternative: a `NOT_APPLICABLE` default always wins over rows | Closed: M1 as applied (Ali; confirmed by Hassan); ADR-0028 d1 restates the rule |
| 14 | Q-C5 (data design): correcting a wrong issuer confirmation | Out of scope until asked. Recommendation if asked: a new confirmation row with result `retracted` (latest wins, M6), by a reviewer, audited, with the issuer-confirmed event so `catalog` drops the flag; Hassan reviews | Open, deferred |
| 13 | Hadi's rulings (product owner) | — | CERT-23 several types: AND across types, OR across bases inside one type (CERT-46; 4.4). The claim-policy warning only warns, no blocking acknowledgement; the audit row may store an optional change reason (3.7) |

### 19.3 Reviews
| Reviewer | Result | Date |
|---|---|---|
| Ali (cto) | Accept with changes (B1, B2, S1, S2, S4, S5); changes applied (19.4). Re-review: **G2 yes**, conditional on Mojtaba's data design, Reza's `ux.md` and Hassan confirming items 11 and 12 (now confirmed); items 11 and 12 closed (both relaxations; M1 as applied). S-1 needs a separate `sellers` mini-review before slice 1 merges, not a G2 blocker | 2026-10-07 |
| Hassan (security-tester) | Accept with changes (H1, M1 to M9, L1 to L5); changes applied (19.4). Re-review: **accept with conditions C1 to C3, applied**; items 11 and 12 confirmed | 2026-10-07 |
| Hadi (product-owner) | Rulings of 19.2 item 13 | 2026-10-07 |
| Jafar (product-designer) | Accept with changes | 2026-10-07 |
| Mojtaba (database-designer) | Pending (data design; changes listed in 16.1) | |
| Reza (ui-ux-designer) | Pending (`ux.md`, brief s12; changes listed in 16.2) | |

### 19.4 Review record: where each change was applied
| Item | Change | Applied in |
|---|---|---|
| Ali B1 = Hassan M4 | Claim path zone: non-provisional only, one fixed caller-independent read; guards and job may keep provisional | 2.3 T2 ruling, 2.4, 3.2 rows 1 and 3, 4.2 step 1, 8.5, 8.6, 14.1 slice 1, S-1; ADR-0028 d8 |
| Ali B2 = Hassan M2 | Category move, merge, archive call `assertCategoriesRetirable`; refused while a row could relax on lapse; `SELLER_OR_MANUFACTURER` rows flagged | 3.7, 7.2, 8.1, 14.1 slice 13, C-4, 19.2 item 5; ADR-0028 d5, d9 |
| Hassan H1 | `verificationMode` immutable; relaxing type and policy revisions, type and issuer reactivation by a second admin with own audit rows | 2.1, 2.3 T4, 3.5, 3.6, 3.7, 7.1, 7.2, 11, slices 2, 12, 13; ADR-0028 Consequences |
| M1 | Strictest of all matching rows; `SELLER_OR_MANUFACTURER` only on a category selector | 2.1, 3.7, 4.2 step 3, slice 13; see 19.2 item 12 |
| M3 | Coverage records the product revision; `productRevisionId` in `ClaimQuery`; mismatch `not-covered` | 2.1, 3.4, 4.1, 4.2 step 6, 8.2, slice 14, C-1, C-3; ADR-0028 d1, d7 |
| M5 | Acting-as refused for every manage use case and issuer request, and when unsure | 7.2, slice 5 |
| M6 | No `UPDATE` on submissions, decisions, history, checks, confirmations; checks as rows | 3.2 rules 3 and 8, 11, slice 7, 16.1 |
| M7 | Draft bucket lifecycle; draft bytes encrypted; promote checks the clean hash | 2.1, 9.1, 9.2, 9.3, 10.1, slices 3 and 4 |
| M8 | Second matcher pass; every locale; slice 2 tests; catalog refuses on failure | 4.6, slice 2, C-1 |
| M9 | More entry paths | ADR-0028 d5; C-1 |
| L1 | Variant-narrowed coverage never matches `variantId = null` | 2.1, 4.2 step 6, slice 14 |
| L2 | Document owner, purpose and state at save-draft and submit | 2.1, 3.2 row 1, 7.2, slice 5 |
| L3 | CI check: anonymous pairs never over HTTP | 7.2, 7.4, slice 1 |
| L4 | HMAC index rows deleted on erasure | 10.2, slice 7, 16.1 |
| L5 | 150 DPI, 512 MiB, polyglots refused | 9.3, slice 4 |
| Ali S1 | "Relates to" ADR-0026 d9 | ADR-0028 header; 17 |
| Ali S2 | "Confirmed by cto 2026-10-07" | ADR-0028 Consequences; 7.4; 17 |
| Ali S4 | ADR-0026 status corrected (now Accepted by the owner, 2026-10-07) | 17 |
| Ali S5 | Object Lock fallback: production-only lock proven in staging, gap recorded, no fake lock | 9.2, slice 3 |
| Rulings | T1 to T6, items 2 to 10, numbers, dependencies, ADR-0029, owner question 2 | 19.2, 5.1, 7.5, 8.6, 9.4, 15, 17, 19.1 |
| ux.md API needs | Store name in queue rows; delete a never-submitted draft; relaxation proposal read shape | 7.2, 3.1, 7.6 |
| Ali re-review | ADR-0028 d1 restates the evaluation rule; ADR-0012 d2 amendment rephrased; items 11, 12 closed; S-1 mini-review | ADR-0028; 3.6; 19.2; 18 |
| Hassan C1 | An added row less strict than the type default is a relaxation | 3.7 |
| Hassan C2 | Removing claim terms or a locale is a relaxation | 3.6 |
| Hassan C3 | Duplicate hint: reviewer only, store name and checked link, recorded view, never to AI | 3.2 rule 6 |
| Hassan info | Category move under a `SELLER_OR_MANUFACTURER` parent is an entry path | C-8 |
| Hadi | CERT-23 meaning; warning only; optional change reason | 4.4, 3.7, 19.2 item 13 |
| Data design Q-C1 to Q-C10 | Answered | 3.6, 11, 14.1 slice 5, 2.1, 7.2, 3.7, 16.1, 19.2 item 14 |
| Coordinator additions | Relaxation-proposal mail; what happens to the Offer and tag after expiry; ADR-0026 Accepted; Jafar's result | 12, 4.4, 17, 19.3 |

## 20. Follow-up changes
| File | Change | When, by whom |
|---|---|---|
| `docs/modules/certification/brief.md` | G2 row; change-log rows: slice 0; T1 to T6 outcomes; no `applies_to`, no `PLATFORM_AUDIT`; new admin role; section 12 table from Reza | With the G2 approval; Hadi |
| `docs/features/08-certifications.md` | Model sketch: drop `applies_to` and `PLATFORM_AUDIT` (T4), the seller-certificate state machine of 3.1 | Product track; Hadi |
| `docs/adr/0028-…` | Accept after Ali's and Hassan's review | Before `catalog`'s G2 |
| `docs/design/data/certification.md` | New, from 16.1, including its list of review changes | Mojtaba |
| `docs/modules/certification/ux.md` | New, from 16.2, including its list of review changes | Reza |
| `docs/adr/0029-…` (object storage and file intake) | New (17) | Ali; spikes by Hossein; Kazem; Hassan reviews |
| `docs/design/domain/sellers.md` | Request S-1 (fixed zone read), through `sellers`' mini-review | Mohammad, before slice 1 |
| `docs/design/domain/platform-foundations.md` | P-1, if accepted | Mohammad, with slice 4 |
| `claude/adr-0019-follow-ups.md` | Note: `evaluateClaims`, approve, decline, revoke, expiry and auto-approval of self-declaration are deterministic paths of ADR-0019 decision 10 | Mohammad, with the G2 record |
| `config/markets/AU.json`, `test/fixtures/markets/ZZ.json`, schema | 5.1 (shared files: own PR, announced) | Slices 2 to 9; Hossein |
| `.env.example` | Bucket names, scanner address, the index secret | Slices 3, 4, 7; shared-file PR |
| `docs/modules/README.md`, the board | G2 status; requests of 18; ADR-0029 for object storage and file intake (Proposed 2026-10-07) | Orchestrator |
