# Sellers — G2 domain design

**Author:** Mohammad (software-architect) — 2026-10-07
**Status:** **G2 approved 2026-10-07** (Ali, cto; Hassan confirmed the H1 text the same day; M1-M4 are merge conditions on 7a-auto (M1), 8 (M2), 7a-decide (M3), 7a-read (M4), and H1's test is on slice 10). Reviews: Ali, Hassan, Jafar accept with changes, applied (16.4). Recorded in the brief and in `docs/modules/README.md`. The owner gets a Persian summary with the
questions of 16.1 only.
**Ground truth:** `docs/modules/sellers/brief.md` (G1 approved 2026-10-03; sections, rules,
owner answers and acceptance criteria are cited as "brief s5", "Q3", "AC 20"); ADR-0022 (seller
access state and the may-sell contract) and ADR-0023; ADR-0001, ADR-0003, ADR-0004, ADR-0005,
ADR-0006, ADR-0007 (decisions 6 and 7), ADR-0008, ADR-0009, ADR-0010 (decision 7), ADR-0013,
ADR-0015, ADR-0016, ADR-0017, ADR-0018, ADR-0019 (decisions 7 to 10), ADR-0020, ADR-0021,
ADR-0024; `docs/design/domain/identity.md` (cited as "ID 8.4"),
`docs/design/domain/platform-foundations.md` ("PF 6.2") and
`docs/design/domain/platform-persistence-and-events.md` ("PP 3.1"); `docs/design/data/identity.md`
and `docs/design/data/platform.md`; `docs/features/01-sellers.md` (SEL-01, -03, -06, -11, -12,
-14, -15, -24, -25, -26, -27, PNL-02), `07-improvements.md` (IMP-10), `09-internationalization.md`
(INTL-02, -03, -10, -11), `10-versioning.md` (VER-09, -13, -14); the board requests 8, 11, 13
item 3 and 15 item 4 (`claude/tracks.md`) and the `sellers` rows of `claude/adr-0019-follow-ups.md`;
section 11 of `docs/modules/certification/brief.md` and `docs/modules/catalog/brief.md` (what they
ask of `sellers`). The code on `main` at `d5bfd48`: `modules/sellers/` is an empty shell.

## 1. Scope

A design, not an implementation: a signature appears only where it is the contract.

- **Decided here:** the domain model (2), state machines (3), what is Market configuration (4),
  `ActorContext` and `MarketContext` use (5), authorisation (6), the boundary with the may-sell
  contract and the calls into `identity` (7), personal data (8), audit (9), mail (10), slices (11),
  dependencies (12).
- **Not changed here:** `identity`'s ports, facade and events (ID 8.1, 8.2). Where this design
  needs more from `identity`, it is a request in section 15, not a workaround.
- **In Mojtaba's data design** (`docs/design/data/sellers.md`, written from this model): tables,
  columns, constraints, indexes, retention jobs; his inputs are in 13.1.
- **In Reza's `docs/modules/sellers/ux.md`:** pages, states and copy, and the table of brief s12;
  what the API gives the panel is in 13.2.
- **Left open, with the reason:** the questions of 16.1 need the owner; Hassan's numbers are set
  (6.5); the editable "approval required" value waits for the ADR of 14.1;
  anything that waits on counsel or the register's agreement is named where it applies.

### 1.1 Brief slices and where they are covered
| Slice (brief s11) | Covered in |
|---|---|
| 1 Seller file after the account; seller summary facade | 2.1, 3.1, 7.1, 7.5, 11 |
| 2 Complete details: General, Address with ServiceArea, phone, slug, time zone | 2.1, 3.5, 4.2, 4.3, 6.2 |
| 3 Business identifier and tax profile from Market configuration | 2.4, 4.1, 4.2, 7.1 (`taxProfileOf`) |
| 4 Register lookup | 3.4, 7.7 |
| 5 Submit for review | 3.1, 3.3, 7.3 |
| 6 Admin seller list | 7.1, 7.8 |
| 7 Review page, approve and reject through `identity`, identifier uniqueness, re-apply (split into 7a-read, 7a-decide, 7a-auto, 7b at G2) | 3.1, 3.2, 3.6, 7.3 |
| 8 Admin edit, submit on behalf, bulk actions | 3.1, 6.2, 7.3 |
| 9 Facades for `catalog`: allowed types, may-sell | 7.1, 7.2 |
| 10 Change of business identity after approval | 3.1, 7.3, 10 |
| 11 Periodic register re-check (P2 since the owner's decision of 2026-10-07, SEL-27) | 7.7, 11 |
| 12 Public store profile | 2.1, 3.7, 7.1 |
| 13 Category-proposal permission and its revoke event | 7.1, 7.4 |
| 14 Restricting allowed product types | 7.1, 11 |
| 15 Global settings page ("approval required") | 4.1, 14.1 |
| 16 Per-seller AI switch | 6.4, 7.6 |
| 17 Panel screens | 13.2; Reza's document |
| (new) 18 Retention of abandoned and rejected files | 8.4, 14.2, 15 |
| (new at G2) 19 Business history read (P2-H, AC 26) | 6.2, 11 |

### 1.2 Inputs from other documents
| Input | Answered in |
|---|---|
| ADR-0022 decision 6: the final name and conditions of the may-sell contract | 7.2 |
| ADR-0022 consequence: only `modules/sellers/` reaches the approve and auto-approve entry; what happens when `identity` refuses or the process stops between the two transactions | 7.3, 15 (R-1) |
| ID 3.3 and 14.5 item 3: the way out of the final `rejected` state | 3.3, 15 (R-7) |
| ID 8.5: approve only with a current submission; auto-approval only after `sellers`' checks; re-confirmation before slice 10; the reviewer notice after a submission | 7.3, 15 (R-1 to R-3) |
| ID 8.5 last row: the steps card of S1 | 7.1 (`onboardingSteps`), 13.2 |
| Board 8 item 3, 11 item 4: the ADR "admin-editable Market settings" | 14.1; not written; slice 15 waits for it |
| Board 11 item 1 and the ADR-0019 follow-ups: the AI switch is `sellers`'; its port is a named exception; off also stops AIA-01 | 6.4, 7.6 |
| Board 13 item 3 (certification G1): AI off for a new seller until an admin switches it on; the switch-on notifies the seller; the reviewer gets legal name, trading name and business address | 2.1, 7.1 (`reviewerBusinessDetails`), 10 |
| Board 15 item 4 (catalog G1): allowed types default "all"; offers of a type no longer allowed leave sale with a notice; the public store name on every badge has no claim check (Hassan) | 7.1, 7.4, 16.2 item 6 |
| `Revision<T>` and `EffectivePeriod` designed by their first consumer (ADR-0020; PF 3.8, A1) | 2.4 |
| `SubjectKeyService.hmac`: designed in PF 4 row 4, built with its first consumer | 8.2 |

## 2. Domain model

### 2.1 Aggregates
Every aggregate root carries `marketId` and `tenantId` (ADR-0003 decision 3, ADR-0001) and a
version (PP 10). References between aggregates and to other modules are ids. The seller id is
minted by `identity` (ADR-0022 decision 1); `sellers` uses the same id as the id of its
`SellerFile`, `StoreProfile`, `SellerAdminSettings` and `SellerTaxProfile`.

```
SellerFile (id = sellerId)
  |-- working draft: General, Address, business identifier  (editable)
  |-- Contact: phone, contact email                          (live after approval; history V4)
  |-- RegisterCheck (0..1 per identifier value; sticky negative, 7.7)
  |-- BusinessFileRevision (0..n; V1; immutable content)  --> ReviewCheck (0..n per revision)
  |-- approvedRevisionId, publicStoreName, decisionIntent (7.3); the pending revision is derived (14.3, Q-M1)
ShopSlug (one per normalised slug per Market; held | retired)       --> sellerId
IdentifierClaim (one per identifier index per Market)               --> sellerId
SellerTaxProfile (id = sellerId) --> TaxRegistrationPeriod (V2, 0..n)
StoreProfile (id = sellerId) --> StoreProfileRevision (V1, 0..n); publishedRevisionId
SellerAdminSettings (id = sellerId): allowed product types, category proposals, AI switch
```

| Aggregate | Holds | Invariants it owns |
|---|---|---|
| `SellerFile` | Origin (`self`, `invitation`; from the event), `approvalRequiredAtRegistration` (7.5), `publicStoreName` (the approved revision's store name, copied when the pointer moves; 14.3 Q-M2), the working draft: store name, business name, contact email (optional, 14.4 Q-M19), operating address and, when it differs, a registered address (14.4 Q-M23), business identifier (scheme code, normalised value, its index), derived `operatingTimezone` and the ServiceArea code the address fell in; the live contact details; the register check of the current identifier value; the revisions; the pointers and the decision intent | One pending revision at most; an edit of a field that a pending revision holds withdraws it (3.1); the approved revision is replaced only by approving another one; a revision is created only from a complete draft (3.1); the decision intent is set only on a pending revision (7.3); the draft never sets `marketId`, the seller id or a state code |
| `BusinessFileRevision` (entity of `SellerFile`) | Kind (`onboarding`, `identity-change`), revision number, immutable content (the draft's business identity, contact details at that moment, tax registration answer), `contentHash`, author kind (`seller`, `admin`) and author account id, the register check snapshot, the review checks, status, the `identity` decision id once decided | Content never changes; status moves only as in 3.1; approval names the revision the reviewer saw (brief s5) |
| `ReviewCheck` (entity of a revision) | Check code (from Market configuration, 4.1), result (`done`, `not-applicable`), reviewer account id, instant; for `manual-register-check`, the result the reviewer read | Recorded only on a pending revision, by a reviewer (6.1); a check of another revision does not count |
| `ShopSlug` | Normalised slug, holder seller id, state, whether it was ever public | Unique per Market (SEL-01, ADR-0003); a retired slug is never held again (brief s7); held from the first submission, or when an admin sets it (2.3); only a slug that was ever public is retired, any other is released (3.5, Hassan M6) |
| `IdentifierClaim` | Identifier index (8.2), holder seller id | Unique per Market among approved and suspended sellers (brief s7, AC 21); taken in the approve step, before `identity` is called (7.3) |
| `SellerTaxProfile` | `TaxRegistrationPeriod` rows: registered for indirect tax (yes or no), effective from (a local date in the seller's zone and its instant), valid to | No two periods overlap (ADR-0009 V2); not held for review; applied from its date and audited (brief s5, Q4); the platform decides nothing about it (ADR-0007 decision 6) |
| `StoreProfile` | Revisions of Description, Policies, Meta and Social, per locale of the Market; `publishedRevisionId` | V1 (ADR-0009 decision 2): each save is a new immutable revision and is published at once (Q4: these texts apply immediately); locales only from `supportedLocales` (INTL-10); plain text only; social links https on the allow-listed hosts (brief s5) |
| `SellerAdminSettings` | Allowed product types (`all`, or a non-empty set of type codes), category proposals allowed (default no), AI switch (default off); per setting, the instant and admin account id of its last change (14.3, Reza 10) | Changed only by an admin use case (SEL-25, AC 16), each change audited in its transaction (AC 14, AC 15); defaults written at creation, so a missing row is a fault, never a default |

### 2.2 What is deliberately not an aggregate of `sellers`
| Thing | Why |
|---|---|
| Access state (`pending`, `approved`, `rejected`, `suspended`), decisions and their reasons, the re-apply count | `identity` (ADR-0022 decision 1). `sellers` stores no copy, not even a read model (decision 2) |
| Account, sign-in email, membership, roles | `identity` (R8 of its brief) |
| "Approval required" as an editable value | Market configuration until the ADR of 14.1; then the store that ADR names. Not a `sellers` table: `identity` reads it too and imports no module |
| ServiceArea definitions | `config/service-areas/` read through a platform port (4.3); `sellers` stores only the code the address fell in |
| Certificates, offers, categories, type codes' meaning | `certification`, `catalog` (ProductTypeHandler registry). `sellers` stores type codes as opaque strings |
| Commission, payout account, the "show customers" and other later SEL-15 settings | Their own modules or later slices (brief s3) |
| Uploaded documents | None in this module (Q2) |
| Lookup quota counters | Operational records with a window, outside any aggregate (7.7), like `identity`'s throttle counters |

### 2.3 Modelling choices that need a reason
| Choice | Reason | Cost |
|---|---|---|
| The business file is revisioned content (V1): a submission is a pending revision; a change of business identity after approval is another pending revision while the approved one stays live | ADR-0009 decision 2 and 3 give exactly this shape (the live revision keeps selling while an edit waits). One mechanism serves onboarding (brief s4 a, b) and Q4's re-review, and "approval names what was reviewed" (brief s5) becomes "approve revision N" | `withdrawn` is a fifth status beside V1's four (3.1) |
| Contact details (phone, contact email) are live fields with a V4 history, not part of the reviewed identity | Q4: they apply at once and keep history; they are still part of each revision's snapshot so the reviewer sees what was submitted | Two places hold a phone: the live value and the snapshots |
| `SellerTaxProfile` separate from the file | ADR-0007 decision 6: the registration has an effective date, is not reviewed (Q4) and is needed "as of" an invoice date (V2). The identifier number stays in the file, because it is business identity | `taxProfileOf` composes two aggregates (7.1) |
| `ShopSlug` and `IdentifierClaim` as small aggregates with a unique key | A uniqueness rule across sellers needs a database constraint, never read-then-insert (PP 10) | Two more tables |
| `SellerAdminSettings` separate from the file | Another writer (admin only), another permission, and catalog reads it on every command; a seller's edit must never conflict with an admin's switch | One more row per seller |
| The seller-facing status is computed, never stored (3.3) | It combines `identity`'s state, which `sellers` must not copy, with `sellers`' own file state | Each read calls `sellerAccessOf` once |

**Toss-up T1: when a slug is held.** The brief needs both "availability is shown at once" (s4 a)
and "a draft slug gives no right" (s7), and AC 2 speaks of a slug "held by a seller".

| Option | For | Against |
|---|---|---|
| A. Held from the first save | Simple; the answer "available" is a promise | Anyone can squat brand slugs with throw-away accounts until the purge (8.4) |
| **B (recommended).** Held from the first successful submission (or when an admin sets it), then until an admin changes it (the old one is retired) or the file is purged (released) | Matches "a draft gives no right" and the same anti-squatting reasoning as the identifier (brief s7); the purge rule "the slug it held is freed" (brief s5) still applies | A draft can be told "available" and lose it at submission: the submit answer names `slug.taken` and the seller picks another |

**Toss-up T2: live business data in clear or encrypted.** Brief s5 says register results are kept
"encrypted like the rest of the business data", and every immutable record must be (ADR-0009
decision 6). `identity` chose plain live columns for email (its 11.2, accepted by Hassan, H1).

| Option | For | Against |
|---|---|---|
| A. Live columns in clear, revisions and history encrypted | Search and uniqueness on plain columns; erasure overwrites live rows | Contradicts the brief's wording for the business data; a dump shows phones and addresses |
| **B (recommended).** Personal live columns encrypted under the seller's key (8.1); the store name and slug stay clear because they become public; the identifier gets a keyed index for uniqueness and exact search (8.2) | Follows brief s5 as written; one key destroys everything | One key unwrap per seller per read (PF 4 row 9); no partial search except on store name and slug |

### 2.4 Value types designed here (first consumer; PF 3.8, A1, ADR-0020)
```ts
// packages/shared-kernel (domain may import only the kernel)
interface Revision<T> {
  readonly revisionNo: number;          // 1, 2, …; unique per owner record
  readonly content: T;                  // never changes once created
  readonly contentHash: ContentHash;    // from the audit-seal design (identity slice 6)
  readonly createdAt: Temporal.Instant;
  readonly authorId: Id<'Account'> | null; // null for the system actor
}
interface EffectivePeriod {
  readonly validFrom: Temporal.Instant;        // inclusive
  readonly validTo: Temporal.Instant | null;   // exclusive; null = open
}
function contains(period: EffectivePeriod, at: Temporal.Instant): boolean;
```
| # | Rule |
|---|---|
| 1 | Status is the owner's, not the type's: V1's `Pending`, `Approved`, `Rejected`, `Superseded` are kept and each module may add its own (here `withdrawn`). A free-text change note is not part of the type: it would be personal data in an immutable row (ADR-0009 decision 6) |
| 2 | `contentHash` over personal fields is an HMAC under the subject's key, never a plain hash (ADR-0009 decision 6). `sellers` computes it with `SubjectKeyService.hmac(market, sellerId, 'sellers.business-file.content', canonical bytes)`; the canonical encoding is a sorted-key JSON of the content |
| 3 | `ContentHash` itself (the branded string) is decided in the audit-seal design (PF 3.8); `sellers` slice 5 waits for it, or for a note from that design that it can be fixed earlier |
| 4 | `EffectivePeriod` is half-open; the no-overlap rule is the database's (`EXCLUDE USING gist`, ADR-0009 V2; Mojtaba). A local date entered by a person becomes the instant of 00:00 in the owning party's zone (ADR-0005 decision 3); both are stored |

## 3. State machines

Every transition is one use case with one read-write unit (PP 3.1), taking time from `Clock`. A
transition that is not listed is forbidden; the tempting ones are named.

### 3.1 Business file revision: `pending` → `approved` | `rejected` | `withdrawn` | `superseded`
| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| (draft) → `pending`, kind `onboarding` | Submit by the Seller Owner (not in acting-as, 6.4), or by an admin with `sellers.seller.edit` (brief s4 c); at most 5 submissions per 24 h per file (6.5). Guards: no pending revision; the draft is complete (all mandatory fields; the identifier when the Market requires it, Q3); the address is in a ServiceArea with `seller_onboarding_enabled` (4.3); the register check of the current value is not a definite negative (7.7); the slug can be held (T1); `identity` state is `pending` or `rejected`; a re-application (state `rejected`) is accepted by `identity`'s re-apply (7.3) | Snapshot written; content hash; the slug held; event `sellers.business-file-submitted.v1`; its handler asks `identity` to notify reviewers (7.5) or, when approval is required neither at registration nor by the current policy, tries the automatic approval (7.3, M1) | SEL-03, AC 5, AC 6, AC 11 |
| (approved file) → `pending`, kind `identity-change` | The Seller Owner requests a change of store name, business name, identifier or address after approval, through `my-business-identity.request-change` only: the request carries the new values (draft saves are refused on an approved file with `file.change-request-required`; phone and contact email change only through `my-contact.save`; Hassan L2). Guards, inside the use case: a recent re-confirmation (`identity.hasRecentConfirmation`, 10 minutes, bound to the session, never satisfied in acting-as; R-2, 6.4); no pending revision of either kind; the same completeness and area checks; a register lookup when the identifier changed | The approved revision stays live and every facade keeps answering from it (AC 20); mail to the sign-in address (10); event; audit `sellers.identity-change.requested` | Q4, AC 20 |
| `pending` → `withdrawn` | The draft field that the revision holds is edited by the seller or an admin (after a warning; brief s4 a 7); the seller cancels a pending identity change; `identity` refuses a re-apply at the limit (7.3) | The revision leaves the queue (AC 10); the slug stays held; the cause (`edited`, `cancelled`, `reapply-refused`), who caused it (`seller`, `admin`) and the instant are kept on the revision and returned by `my-file.read` (Jafar 4); event; a cancelled identity change is audited `sellers.identity-change.cancelled` | Brief s5, AC 10 |
| `pending` → `approved` (onboarding) | Only through the decision steps of 7.3: a reviewer holding `identity.seller-access.approve` approves revision N, or the automatic approval when approval is required neither at registration nor now and every check passes (7.3, Hassan M1). Guards in the first step: revision N is the pending one; required review checks recorded; register check acceptable (3.4); identifier claim taken | `approvedRevisionId` = N; the previous approved revision (none on onboarding) `superseded`; on onboarding, `identity` records the decision with `basisId` = N | SEL-03, AC 9, AC 10, AC 21, AC 32, AC 33 |
| `pending` → `approved` (identity change) | A reviewer with `sellers.identity-change.approve` (6.1). Same guards; no `identity` call (the access state does not change) | Pointer moves; the old identifier claim released and the new one taken in the same unit; slug unchanged (only an admin changes it); mail to the sign-in address; event | Q4, AC 20 |
| `pending` → `rejected` | Onboarding: a reviewer rejects through `identity` with a reason (7.3). Identity change: a reviewer with `sellers.identity-change.approve` rejects with a reason code from the list of 4.1 (no free text in `sellers`; Hassan's rule against quoting register values in a reason, brief s5) | Onboarding: the seller sees `identity`'s reason (owner only) and may correct and submit again. Identity change: the approved revision stays; the owner sees the reason code; mail. `my-file.read` returns only the latest identity-change revision when it is `rejected` and no later revision exists: it shows until the owner starts a new request; there is no dismissal state. Older rejected requests stay as revisions, read only through `business-history.read` (Jafar 5) | Decision 9 of the identity brief, AC 11, AC 20 |
| (approved file) → `approved`, kind `identity-change`, author `admin` | An admin holding **both** `sellers.seller.edit` and `sellers.identity-change.approve` edits business identity of an approved seller: a revision is created and approved in the same unit (brief s5: applies at once). Guards, the same as a reviewer's approval in unit 1 of 7.3 (Hassan H1): no pending revision (else `file.change-pending`: the admin decides that one first); completeness; every required review check of the Market recorded on that revision, by the editing admin in the same request; the register check acceptable (3.4: not a definite negative; not-performed or older than `maxResultAge` only with a recorded `manual-register-check`); the identifier claim free for this seller; a lookup when the identifier changed, as for the seller. Refusals use the same `review.*` codes (14.3 Reza 6). Test: an edit by an admin with only `sellers.seller.edit` is refused and nothing changes | Pointer, `publicStoreName` and claim move; event `business-identity-edited`; mail to the owner (10); audit | Brief s5, SEL-06, 14.3 Q-M9 |
| `approved` → `superseded` | Another revision of the file is approved | — | V1 |

An admin's edit **before** approval changes the draft like the seller's own edit and so withdraws a pending revision (approval stays bound to what was reviewed; the admin page warns first, Jafar 4). There is no approval by `sellers` alone (removed at G2, Ali change 1): a seller that `identity` already reports `approved` but that has no approved revision (only Phase 2 test data, 14.3 Q-M4) stays not eligible to sell (7.2) and is shown to an admin (3.3, 7.8). If a real environment ever has such a seller, a mini-review designs a path with an audit row.

Forbidden: approving any revision but the pending one, or with no pending one (AC 10, AC 22);
approving through `identity` without `sellers` (removed with R-1); a revision that changes;
editing a revision's review checks after its decision; a seller-side request that names a state,
a revision status, a slug after approval, an admin-only setting, the seller id or `marketId` (the
request types do not have these fields; AC 16); a `pending` revision while another is pending.

### 3.2 Decision intent on `SellerFile` (the two-step call into `identity`; ADR-0022 consequence)
| From → to | Trigger | Effect |
|---|---|---|
| none → `approve-requested` or `reject-requested` (attempt id, revision N, since) | First unit of the approve or reject use case (7.3) | The revision is locked: an edit by the seller is refused with `file.decision-in-progress` until the intent ends |
| none → `reapply-requested` | First unit of "submit again" when `identity` says `rejected` | As above |
| any intent → none | Second unit after `identity`'s answer; or the handler of `identity`'s decision event that carries `basisId` = N (7.5); or the reconciliation job (7.3) | Revision decided, or the intent dropped and the revision back to plain `pending` |

### 3.3 What the seller sees (computed; brief s4 table)
`identity` state (from `sellerAccessOf`) × `sellers` file state × ServiceArea. Codes are API
codes; words are Reza's with ux-copy (brief s4: "Changes needed", never "Rejected", while a
re-application is possible).

| Code | When | The seller can |
|---|---|---|
| `details-incomplete` | `pending`, no pending revision, draft incomplete | Complete and save |
| `outside-service-area` | `pending` or `rejected`, the address is outside every area with onboarding on | Save; not submit. When the area is switched on, submit with no new sign-up (AC 6) |
| `ready-to-submit` | `pending` or `rejected`, draft complete, no pending revision | Submit |
| `awaiting-review` | A pending onboarding revision | Read; edit after a warning (withdraws) |
| `changes-needed` | `rejected`, re-application possible (`identity` status read says so; ID 8.6 row 2) | Read the reason (owner only), correct, submit again |
| `not-approved` | `rejected` at the re-apply limit | Nothing but the contact route; see 16.2 item 1 for the way out |
| `approved` | `approved`; an `identity-change` revision may be pending beside it | The whole panel by role; see the pending value beside the current one, cancel it |
| `suspended` | `suspended` | No session (`identity`); listed here only for the admin view |
| `file-check-needed` | `identity` `approved`, no approved revision (Phase 2 test data only; 3.1) | Nothing; not eligible to sell; an admin sees the flag in the list (7.8). No path until a mini-review designs one (Ali change 1) |

### 3.4 Register check of an identifier value
| State | Meaning | Submit | Approve |
|---|---|---|---|
| `not-performed` | Market adapter `none`, or no call yet | Allowed; the reviewer sees "lookup not performed" and the manual link (4.1) | Only after a successful re-lookup or a recorded `manual-register-check` (AC 32) |
| `active` | The register knows the value and it is active; mismatches may be flagged | Allowed | Allowed; mismatches are flagged, never blocking by themselves (brief s5) |
| `not-found`, `cancelled` | Definite negative | Refused (AC 31) | Refused |
| `unavailable` | Timeout, refused, malformed, too large, redirect, entity, quota of the Market budget | Allowed, as `not-performed` (AC 32) | As `not-performed` |

A definite negative for a value is sticky: a later `unavailable` for the same value does not clear
it (AC 31); a new value clears it. A result is bound to the value and has a maximum age (30 days,
6.5). Every approval guard (reviewer, admin edit, automatic) reads the register check of (seller,
revision N's `identifier_index`), so a re-lookup after submission counts and a negative stays
sticky; an `active` older than `maxResultAge` counts as `not-performed` for manual approval too
(then a recorded `manual-register-check` is needed) and blocks the automatic approval (AC 33).
Enforced on the server, never only in the page (Hassan L3).

### 3.5 Shop slug: (none) → `held` → `retired`; `held` → (released)
Held by T1's rule. An admin change retires the old slug for ever (brief s7) only if it was ever
public, that is held while its seller had an approved revision; an admin change on a seller that
was never approved deletes the old row, which releases it (audit `sellers.slug.released`; Hassan
M6). The purge of a file that was never approved deletes its row, which releases the slug (brief
s5). Before approval the seller may save a different slug: the old row, never public, is released
(deleted) in the same unit, after the withdraw warning if a pending revision holds it, and the new
slug is held at the next submission (T1; 14.4 Q-M21). A seller never changes a slug after approval
(brief s7, AC 16). Rules (brief s7): `a-z0-9-`
only, 3 to 50 characters, no leading, trailing or double hyphen, compared after lower-casing; a
reserved list in a checked-in data file of the module (site routes, platform names, and a claim
group), never literals in `sellers`' code (Ali change 3). The claim group (certification words such
as halal, kosher, vegan, certified, verified, official) is later supplied by the port that
`certification` implements (16.2 item 6). Claim words are matched per token (split on hyphens and
spaces): in a slug they are refused (`slug.reserved`); in a store name they are flagged to the
reviewer and block the automatic approval (7.3, Hassan M1). Reviewer hint, never a refusal: the
UTS #39 confusable skeleton, then Damerau-Levenshtein distance at most 2 (at most 1 for names under
6 characters), against approved sellers' public store names and slugs in the same Market (Hassan).

### 3.6 Identifier claim
Taken in the first unit of an onboarding approval (7.3), and released if `identity` refuses;
kept while the seller is approved or suspended; moved by an approved identity change; deleted at
erasure. Two approvals of one value: the unique key refuses the second (AC 21). The seller's
answer never depends on it (brief s7: no "already registered").

### 3.7 Store profile revision
Each save creates revision N and moves `publishedRevisionId` to it in the same unit (Q4: texts
apply at once). No review state in Phase 3. Rolling back is a new revision with old content
(ADR-0009 decision 2).

## 4. Market-specific behaviour, behind configuration

No Market code, country name or identifier scheme name appears in core logic (ADR-0001 decision
5, ADR-0003 decision 2, ADR-0007 decision 6). The literal check of ADR-0008 decision 6 must accept
the register and scheme names below as authority names, not Market codes: the exemption is by
exact path (the scheme and adapter files and the configuration), never by word (Ali, 16.2 item 9).

### 4.1 The `sellers` section of `config/markets/<code>.json`
Validated at boot with the rest of the file; added by slices 2 to 5 (11.2).

| Field | AU (launch) | ZZ (test fixture) | Used by |
|---|---|---|---|
| `businessIdentifier.scheme` | `abn` | `zz-corp-no` (another length and checksum) | 4.2 |
| `businessIdentifier.required` | `true` (Q3) | `false` | Completeness, AC 5, AC 12 |
| `businessIdentifier.labelKey` | Translation key for "ABN" | Its own | AC 3 |
| `registerLookup.adapter` | `abr` once the vendor review passes; `none` until then | `fake` in tests, `none` in a second case (AC 34) | 7.7 |
| `registerLookup.manualLinkTemplate` | The register's public search page with exactly one `{identifier}`; validated at boot (https, exact host) | A dummy https URL | Review page, admins only (7.7) |
| `registerLookup.maxResultAge`, `perAccountLimit`, `reviewerLimit`, `perOriginLimit`, `marketDailyBudget`, `recheckInterval` | 30 days; 5 new values per account per 24 h; 30 per admin per 24 h; 30 per origin per 24 h; 1,000 per Market per 24 h; 90 days (Hassan, 6.5) | Small values | 7.7 |
| `taxRegistration.questionKey` | "Registered for GST" key | Its own | Draft, `SellerTaxProfile` |
| `address.format` | Fields and their order; postcode pattern; region list | Different fields | `AddressFormat` |
| `timezones` | Region → IANA zone, with postcode exceptions (data file) | Its own | `TimezoneResolver` |
| `reviewChecks` | Codes and translation keys of the reviewer's named checks, which are required, and `manual-register-check` | A smaller list | 3.1, 7.3 |
| `rejectReasons` | Codes and translation keys of the prepared reasons (brief s7) | Its own | Bulk reject, identity change |
| `approvalRequired` | `true` (until the ADR of 14.1) | `false` | 7.3, AC 12, AC 19 |
| `fileRetention` | Waits for counsel (16.1 item 3); two values: never-submitted drafts and finally rejected files | A short duration | 8.4 |

### 4.2 Strategies, selected by configuration
| Port (`modules/sellers/application/ports/`) | Adapters | Contract |
|---|---|---|
| `BusinessIdentifierScheme` | One file per scheme in `infrastructure/identifier-schemes/` (`abn`, `zz-corp-no`) | `normalise(text)`, `validate(normalised)` → `ok` or `identifier.format` / `identifier.checksum`; `display(normalised)`. Pure; no I/O. A value valid in ZZ is refused in AU (AC 3) |
| `AddressFormat` | One per Market format | Validates the fields of `address.format`; returns the postcode and region for the next two ports |
| `TimezoneResolver` | One adapter reading `timezones` | Region and postcode → IANA zone, or `timezone.unresolved` (then the seller cannot submit and the reviewer is told). Never an offset (ADR-0005 decision 1). The seller sees the zone; only an admin corrects it, audited (16.2 item 4). AC 8 runs on the Brisbane, Sydney, Adelaide and Perth fixtures |
| `BusinessRegisterLookup` | `none`, `fake`, `abr` (named after the register, no Market code inside) | 7.7 |

These are module-internal strategies chosen by a configuration value, like `identity`'s policy
values; they are not the vertical extension-point registry of ADR-0001 decision 1, so they do not
trigger it (ADR-0015 decision 3). They stay module-internal until a second module needs identifier
validation (Ali, 16.2 item 9).

### 4.3 ServiceArea
`sellers` triggers `config/service-areas/` (ADR-0015 decision 3; brief s11): the first slice that
evaluates a ServiceArea is slice 2. A platform port `ServiceAreaDirectory` in
`platform/market-config/` reads the checked-in files at boot: `areaFor(market, postcode)` returns
`{ code, sellerOnboardingEnabled, deliveryEnabled }` or none. The check runs when the address is
saved (the seller learns at once, brief s7) and again at submission; the file stores only the code.
The port, `config/service-areas/` and the `sellers` part of the Market configuration schema come in
shared-file platform PRs before slice 2 (11.1, Ali change 5).
Effective-dated activation (VER-09) is not built: switching an area is a configuration change
(16.2 item 5). Whether an approved seller keeps selling when its area's onboarding flag is later
switched off is 16.1 item 1.

## 5. `ActorContext` and `MarketContext`

| Caller | Context | Where the seller id comes from |
|---|---|---|
| Seller Owner or Staff over HTTP | `CallContext` with an authenticated actor of population `seller` | `ActorContext.sellerId` only (ID 4 rule 2); no seller-side request carries a seller id (AC 16, AC 18) |
| Admin over HTTP | Authenticated actor of population `admin` | The path, then read with the `MarketContext` of the request, so a seller of another Market is "not found", byte-identical to an unknown id (AC 1; ID 5.2) |
| Another module through the facade | The caller's `CallContext`, unchanged (ADR-0008 decision 5) | The argument; ownership is the caller's concern for reads that are not personal (7.1) |
| Event handler (`presentation/subscribers/`) | The envelope's Market, the system actor, the envelope's correlation id (PP 6.4) | The payload |
| Job (`presentation/jobs/`) | One run per hosted Market, system actor (PP 7) | The rows it selects, always with the Market |
| `platform/ai` reading the AI switch | `MarketContext` and a seller id only; no actor (ADR-0019 decision 7) | The caller (`platform/ai`), from the actor or the host aggregate |

Repositories take the `MarketContext` and name `marketId` in every `where` (PP 4); no use case
reads the Market from anywhere else. Times come from `Clock`; a seller's local date (tax effective
date) uses the seller's `operatingTimezone`, never the Market's (ADR-0005 decisions 2 and 3).
Tests run every domain and integration case on AU and ZZ (ADR-0003 decision 9).

## 6. Authorisation

### 6.1 Permission catalogue of `sellers`
Declared in `modules/sellers/contracts/permissions.ts` (R7 of the identity brief). P = protected
(R11). Default-role mapping is a proposal for the owner's approved roles (ID 5.6, 14.4 item 1).

| Key | Scope | P | Allows | Proposed default roles |
|---|---|---|---|---|
| `sellers.seller.view` | platform | no | Seller list and seller page with clear fields only: store name, slug, state, area code, time zone, revision kinds, dates (Hassan M4) | Onboarding and Compliance; Catalogue Moderator; Operations and Support; Finance; Viewer |
| `sellers.business-details.view` | platform | no | Every read that decrypts business data: the seller page's details, the review page (`review.read`), `reviewerBusinessDetails`; each read audited (9) | Onboarding and Compliance; Platform Administrator; certification reviewers through their role mapping (Hassan M4) |
| `sellers.seller.edit` | platform | no | Edit a seller's business data, contact details and slug; submit on its behalf (SEL-06, brief s4 c) | Onboarding and Compliance |
| `sellers.seller-file.review` | platform | no | Record review checks, run a re-lookup, record a manual register check | Onboarding and Compliance |
| `sellers.identity-change.approve` | platform | no | Approve or reject a pending change of business identity; separate from edit (brief s6) | Onboarding and Compliance |
| `sellers.seller-settings.edit` | platform | no | Allowed product types, category proposals (SEL-12, SEL-26) | Onboarding and Compliance; Catalogue Moderator |
| `sellers.ai-switch.edit` | platform | yes (Hassan L8) | The per-seller AI switch (ADR-0019 decision 7: its own key) | Platform Administrator only, until the owner's cost decision |
| `sellers.business-history.view` | platform | yes | History of business data and register results (VER-14); each read audited | Platform Administrator only |
| `sellers.market-settings.view` | platform | no | The sellers settings page (SEL-15) | Onboarding and Compliance; Viewer |
| `sellers.market-settings.edit` | platform | yes | Change "approval required" (slice 15) | Platform Administrator only |
| `sellers.store-profile.view` | seller | no | Read the store profile (PNL-02) | Store Manager; Customer Service |
| `sellers.store-profile.edit` | seller | no | Edit Description, Policies, Meta, Social, phone and contact email | Store Manager |
| `sellers.business-identity.edit` | seller | yes | Complete details, submit and submit again; request a change of business identity | None: Seller Owner (system role) only |

Approve and reject of an onboarding revision use `identity`'s key `identity.seller-access.approve`
(brief s6), imported from `identity`'s `contracts/` and checked again by `identity`'s own use case.
Non-default verbs: `review`, `approve`. **"Seller Owner only"** (brief s5, s6) is the protected
seller-scope key under the Phase 2 narrowing of R11, as Ali decided for this case (ID 8.5, 14.1-3):
no custom role can hold it while protected seller keys are not grantable. Ali's G2 ruling on R-10:
the narrowing stays until permission declarations get an owner-only attribute that the registry
enforces; no work now.

### 6.2 Use cases and their access rules
`N` = `whenSellerNotApproved` (ID 5.2). Every use case is a `UseCase` subclass in
`modules/sellers/application/use-cases/` (ID 5.2); the CI check covers them.

| Use case | Rule | N | Notes |
|---|---|---|---|
| `my-file.read` (draft, statuses, steps) | `permissions [sellers.business-identity.edit]` | allow | The seller's own file only. The one status read of 14.3 (Reza 1). Also returns the latest withdrawal of an onboarding revision while no later revision exists (cause, `seller` or `admin`, instant; Jafar 4) and the latest identity-change revision when rejected (3.1, Jafar 5) |
| `my-file.validate-identifier` | same | allow | Format and checksum only; no lookup, nothing stored (Reza 4) |
| `form-descriptors.read` | `permissions [sellers.business-identity.edit]` (seller) and a twin under `sellers.seller.view` (admin) | allow | Address, phone and identifier descriptors of the actor's Market (Reza 2) |
| `my-file.save-general`, `.save-address`, `.save-identifier`, `.check-slug` | same | allow | `save-general` refuses a first save without phone (SEL-11, AC 7). Refused on an approved file (`file.change-request-required`; Hassan L2) |
| `my-file.submit` | same | allow | Covers "submit again" (3.1, 7.3). Refused in acting-as (6.4) |
| `my-file.withdraw` | same | allow | Explicit cancel of a pending revision |
| `my-business-identity.request-change`, `.cancel-change` | same | deny | The request carries the new values; re-confirmation checked inside (R-2); refused in acting-as (6.4); audited (9) |
| `my-tax-registration.record` | same | allow | V2 period; audited; refused in acting-as (6.4) |
| `my-store-profile.read` | `permissions [sellers.store-profile.view]` | deny | |
| `my-store-profile.save`, `my-contact.save` | `permissions [sellers.store-profile.edit]` | deny | `my-contact.save` after approval, with the V4 history: slice 10 (14.3 Q-M10) |
| `sellers.list`, `seller.read` (clear fields) | `permissions [sellers.seller.view]` | — | No decryption (Hassan M4) |
| `seller.read-details`, `review.read` | `permissions [sellers.business-details.view]`; holding `identity.seller-access.approve` or `sellers.identity-change.approve` implies it (Hassan M4) | — | Decrypt; audited per read (9); `Cache-Control: no-store` (8.3). `review.read`: no history beyond the current and previous revisions. If the gate of ID 5.2 cannot express "implies", the role mapping grants `business-details.view` with each approve key and a registry test checks it (slice 7a-read) |
| `business-history.read` | `permissions [sellers.business-history.view]` | — | Audited per read (VER-14, AC 26); slice 19 |
| `review.record-check`, `review.relookup`, `review.record-manual-check` | `permissions [sellers.seller-file.review]` | — | Only on the pending revision |
| `review.approve`, `review.reject` (single and bulk) | `permissions [identity.seller-access.approve]` | — | 7.3; bulk carries `[{ sellerId, revisionId }]`, at most 50, 10 bulk requests per minute per admin (Hassan M2) |
| `identity-change.approve`, `.reject` | `permissions [sellers.identity-change.approve]` | — | 3.1 |
| `seller.edit`, `seller.change-slug`, `seller.submit-on-behalf`, `seller.correct-timezone` | `permissions [sellers.seller.edit]` | — | Audited. The admin route is the only one in acting-as (6.4). On an awaiting-review seller an edit of a reviewed field withdraws the pending revision after a warning (3.1, Jafar 4) |
| `seller.edit-approved-identity` | `permissions [sellers.seller.edit, sellers.identity-change.approve]` (both) | — | Hassan H1: an edit of business identity on an approved seller; reviewer-approval guards of 3.1; applies at once and notifies the owner (brief s5); audited |
| `seller-settings.change-types`, `.change-category-proposals` | `permissions [sellers.seller-settings.edit]` | — | Audited, same unit |
| `seller-settings.change-ai-switch` | `permissions [sellers.ai-switch.edit]` | — | Audited; mail on switch-on (10) |
| `market-settings.read`, `.change-approval-required` | view / edit keys | — | Slice 15, after the ADR of 14.1 |
| Facade reads (7.1) | `anonymous` and `system` pairs, or `permissions` | — | 7.1 |
| Handlers and jobs (7.5, 11) | `system` | — | |

The allow-list entries above (`N` = allow) join the checked-in list of PF 6.2 row 5 in their
slices; that list is what `identity`'s reviewers see, and Hassan reviews each entry (R-8). Brief s5 names only "complete details"
and "submit" as allowed: `my-file.read`, `withdraw` and `my-tax-registration.record` are parts of
completing details (a seller who cannot read the form cannot complete it).

### 6.3 Where the hard rules of brief s5 are enforced
| Rule | Enforcement point | Test |
|---|---|---|
| One Market per seller; no cross-Market reach | `marketId` from the context; the guard of PP 4; admin reads by id with the Market | AC 1 |
| Slug unique per Market; retired never reused | `ShopSlug` unique key; the `held` → `retired` transition | AC 2 |
| Identifier format from the Market | `BusinessIdentifierScheme` in the draft's value object | AC 3 |
| Limited sign-in | The gate with `N`; nothing else of `sellers` is `allow` | AC 4 |
| Complete before submit, and before selling regardless of the approval setting | `SellerFile.submit` invariant; `sellingEligibility` conditions (7.2) | AC 5, AC 12 |
| Approval bound to the reviewed revision; no approval without a current submission | First unit of 7.3 (pending revision N, version check) | AC 10, AC 22 |
| One may-sell answer, fails closed | 7.2; `catalog` and `ordering` call only it (ADR-0022 decision 6) | AC 13 |
| Admin-only settings never from the seller side | No seller-side use case writes `SellerAdminSettings`; request types lack the fields | AC 16 |
| Ownership from `ActorContext` | Seller-side repositories take the seller id from the actor as a required argument | AC 18 |
| Business identity change: owner only, re-confirmed, pending until approved | Protected key; `hasRecentConfirmation`; V1 pointer (3.1) | AC 20 |
| Plain text; social links https on allow-listed hosts | Value objects of the draft and the profile: text kept as typed, length-bounded (14.3 Q-M11), control, bidi and Unicode default-ignorable characters refused, values of only whitespace or invisible characters refused (the identity rule HF13; Hassan). Social links: parsed with the URL API; https only; userinfo and a non-default port refused; exact host compare after lower-casing; at most 512 characters; the stored href is the one code builds; rendered with `rel="nofollow noopener noreferrer ugc"` (Hassan L9) | AC 24 |
| Published profile closed by default | `publishedStoreProfile` returns an allow-list type with no phone, street, contact email or identifier field, and "not found" unless the seller is eligible (7.1, Hassan M5) | AC 25 |
| No personal data in events, outbox, audit, logs | `defineEvent` vocabulary (PP 5.3); audit allow-lists (9); log fields are ids and codes | AC 27, AC 34 |
| Lookup: who, what the seller sees, what blocks | 7.7 | AC 30 to 33 |
| Acting-as and rate limits | 6.4, 6.5 | Tests per row |

### 6.4 Acting-as (SEL-08) and the AI switch
| Rule | Source |
|---|---|
| Every `sellers.business-identity.edit` use case (submit, submit again, request-change, cancel-change, tax registration) is refused in an acting-as session; the admin route (`seller.edit`, `seller.submit-on-behalf`) is the only one | Hassan L6 |
| `identity.hasRecentConfirmation` is never satisfied in acting-as | Hassan L6, R-2 |
| The AI switch reader (7.6) gets no actor, so `platform/ai` evaluates acting-as before it calls the reader (ADR-0019 R3); `sellers.ai-switch.edit` is protected (6.1) | Hassan L6, L8 |

### 6.5 Rate limits (Hassan's numbers, G2)
Per-account limits are keyed by account id; counters live in `sellers`' quota table (Mojtaba) with
a fixed window from the first reservation; a counter store that cannot answer fails closed with
`access.unavailable`, as ID 6.8 (Hassan L10).

| Item | Limit |
|---|---|
| Register lookup, seller | 5 new identifier values per account per 24 h |
| Reviewer re-lookups | 30 per admin per 24 h |
| Lookups per origin | 30 per 24 h |
| Market budget | 1,000 calls per Market per 24 h; alert at 80%; the periodic job uses at most 50% |
| Slug check | 30 per minute and 300 per 24 h per account |
| Saves (`my-file.save-*`, `validate-identifier`, profile and contact saves) | 60 per minute and 1,000 per 24 h per account |
| Submissions (submit, submit again, request-change) | 5 per 24 h per seller file; the reviewer notice coalesced to at most 1 per seller per 6 h (R-3) |
| Withdraw and cancel | 10 per 24 h per seller file (14.4 Q-M22) |
| Bulk approve or reject | 50 ids per request; 10 requests per minute per admin |
| Facade batch (`sellerSummaries`, `sellingEligibility`) | 100 ids per call |
| Re-confirmation window (R-2) | 10 minutes, session-bound |

## 7. Boundary

`sellers` imports only `identity`'s `index.ts` (its facade, its permission constants, its event
definitions). It imports neither `certification` nor `catalog` (brief s6); they import `sellers`.
From `platform/` it needs: `MarketContextFactory` through the entry adapters, `Clock`,
`IdGenerator`, UnitOfWork and outbox, the audit writer, `SubjectKeyService`, the permission
registry and gate, the scheduler, `platform/mail/`, `ServiceAreaDirectory` (4.3) and the Market
configuration reader.

### 7.1 Public facade (`contracts/sellers.facade.ts`)
Every method takes a `CallContext` and calls one use case (PF 6.4 row 2). Answers hold ids, codes
and public values; the one method that returns personal data says so, and its callers may not put
it in an event, a log or an audit row.

| Method | Returns | Access rule | Slice |
|---|---|---|---|
| `sellerSummaries(ctx, sellerIds)` | Per id: exists, `operatingTimezone` (from the approved revision, otherwise the draft's, with a `provisional` flag), slug if held, the public store name once approved. For a seller with no approved revision, the slug and provisional zone go only to `system` and authenticated callers (Hassan L4). At most 100 ids | `anonymous` for request actors and `system` for handlers (two use cases behind one method, as `identity.sellerAccessOf`); not over HTTP | 1; time zone from 2 |
| `sellingEligibility(ctx, sellerIds)` | The may-sell contract (7.2). At most 100 ids (Hassan L4) | `anonymous` and `system` pair | 9 |
| `allowedProductTypesOf(ctx, sellerId)` | `all`, or the set of type codes | `anonymous` and `system` pair | 9 (always `all`); 14 |
| `mayProposeCategories(ctx, sellerId)` | Boolean | `anonymous` and `system` pair | 13 |
| `reviewerBusinessDetails(ctx, sellerId)` | Business (legal) name, store (trading) name, business address (operating, and the registered one when captured, labelled; 14.4 Q-M23), of the approved revision. **Personal data**; audited per read | `permissions [sellers.business-details.view]` (Hassan M4) | Before `certification` slice 7 (board 13 item 3) |
| `taxProfileOf(ctx, sellerId, at)` | Scheme, identifier number, registered for indirect tax, as of the instant (ADR-0007 decisions 6 and 7). **Personal data** | `system` | Designed now; built with its first consumer in Phase 5 |
| `publishedStoreProfile(ctx, slug, locale)` | Allow-listed public fields only (AC 25). Resolves only a `held` slug, never a retired one, and answers "not found" unless `sellingEligibility` holds (at least `identity` `approved`; Hassan M5). Each anonymous read costs one key unwrap: the storefront must not expose it over HTTP without a read-model or cache design that Hassan reviews | `anonymous` | 12 |
| `onboardingSteps(ctx)` | `sellers`' steps for S1: `{ owningModule, titleKey, state, route? }` (ID 8.5) | `permissions [sellers.business-identity.edit]`, N = allow | 5 |

"Business name" is read as the legal name and "store name" as the trading name of the
certification brief; both come from SEL-24's General group (brief s8 item 13).

### 7.2 The may-sell contract: `sellingEligibility`
| # | Decision |
|---|---|
| 1 | Name: `sellingEligibility(ctx, sellerIds): Map<sellerId, { eligible: boolean }>`. One call per request for a set of ids (ADR-0022 decision 6) |
| 2 | Yes only if all hold: `identity.sellerAccessOf` says `approved`; a `SellerFile` exists in the Market; it has an approved revision (complete by construction: a revision is only created from a complete draft); when the Market's **current** configuration requires an identifier, the approved revision has one (its clear index, no decryption; brief s5 states the rule live, 14.3 Q-M18); an IANA `operatingTimezone`; its address was in an onboarding-enabled ServiceArea when it was approved (16.1 item 1) |
| 3 | Order: `sellers` reads its own rows in one read-only unit, then calls `identity` outside any unit (PP 3.1 row 5). Committed state in the request, never a copy from events (brief s5) |
| 4 | Fails closed: an unknown id, a missing record, an error or a timeout in either module is `eligible: false` for the ids it concerns; nothing is cached (ADR-0022 consequences) |
| 5 | No register call, ever (brief s5: may-sell never depends on a live call to the register) |
| 6 | No reason code leaves the facade: a customer-facing caller must not learn why. A seller's own panel learns its status from 3.3, not from this |
| 7 | `sellers`' conditions only narrow `identity`'s yes (ADR-0022 decision 6). Certification status is not a condition (CERT-12) |

### 7.3 Calls into `identity`: approve, reject, re-apply, automatic approval
`sellers` changes the access state only through `identity`'s facade (ADR-0022 decisions 2 and 4).
Each call is a two-step write around a facade call outside any unit (PP 3.1 row 5).

| Step | Approve (reviewer) | Reject (reviewer) | Submit again (owner, state `rejected`) | Automatic approval (handler) |
|---|---|---|---|---|
| Unit 1 | Revision N pending, version matches; required checks recorded; register check of (seller, N's `identifier_index`) acceptable (3.4); take the `IdentifierClaim`; set intent `approve-requested` | Revision N pending; reason code (and text, if the reviewer writes one) is not stored by `sellers`; set intent | Create revision N (`pending`); set intent `reapply-requested` | As approve, plus: approval required neither at registration (`approvalRequiredAtRegistration` false) nor by the Market's current policy (the stricter wins; AC 19); the register result is `active`, within `maxResultAge`, with no mismatch; no claim word in any token of the store name or slug (3.5); the claim is free (ADR-0022 decision 5, AC 33; Hassan M1). Any of these failing sends the file to a person |
| Call | `identity.approveSellerAccess(ctx, sellerId, basisId = N)` | `identity.rejectSellerAccess(ctx, sellerId, reason, basisId = N)` | `identity.reapplySellerAccess(ctx, sellerId)` | `identity.autoApproveSellerAccess(ctx, sellerId, basisId = N)` |
| Unit 2, success | N `approved`, intent cleared | N `rejected`, intent cleared | Intent cleared; N stays `pending`; the reviewer notice (7.5) | As approve |
| Unit 2, refusal | Claim released, intent cleared, N stays `pending`; the code is returned (`seller-access.wrong-state` and so on) | Intent cleared | N `withdrawn`; `seller-access.reapply-limit` returned (3.3) | Claim released; N stays `pending` for a person |
| Crash between | The decision event carries `basisId` = N; its handler finishes unit 2 (7.5). Job `sellers.reconcile-decisions` (every minute): for an intent older than 5 minutes it first reads `identity`'s decisions for the seller by `basisId` (R-5); a decision for N finishes unit 2 as that decision; with none, and the seller still in the old state, the intent is cleared as a refusal and only then is the claim released; one whose state changed waits for the event | same | same; a `pending` seller with no intent and a `withdrawn` N is told "submit again" | same |

Rules: the facade call has a hard deadline of 30 seconds, and `identity`'s unit runs with statement
and lock timeouts below it, well under the 5-minute threshold of the reconciliation job (Hassan M3;
the values are confirmed in the 7a-decide review). `sellers.close-decision` re-takes the claim when
it finds an approval of N whose claim was released; if another seller holds that claim, it flags
both sellers for an admin (`sellers.admin_flags`, 14.4 Q-M20) and raises an operational alert. A test interleaves the job, the event
handler and a second approval of the same identifier. A reviewer's approve or reject is refused
unless the request names revision N and N is still the pending one (AC 10). Bulk (Hassan M2): the
request carries `[{ sellerId, revisionId }]`; before any unit runs, the whole request is refused if
any id is not found in the request's Market, byte-identical to an unknown id (AC 1, AC 22); then
each item is its own pair of units with the full unit-1 guard (required checks, register state); an
item whose revision is not the pending one is skipped with `review.not-current-revision`, and items
without a pending revision are skipped and counted (AC 22); a bulk reject needs a reason code from
the list of 4.1 (brief s7); limits in 6.5. `identity` checks its own permission and guards again (double gate). `identity`'s own
approve and reject endpoints are removed in slice 7a-decide (ADR-0022 decision 4; R-1). Only
`modules/sellers/` may import the contract file that holds approve, reject, re-apply, the
automatic approval and the erasure of 14.2 (ADR-0022 consequences; R-1, R-9; Hassan M7), with
Hassan's review. `basisId` is required on approve, reject and the automatic approval in that
contract; it is optional only when reading Phase 2 events (Ali change 4). Approval when "approval
required" is off is a rule-based automation: no model output feeds it (ADR-0019 R2);
`sellingEligibility`, the automatic approval and identity-change decisions are deterministic paths
of ADR-0019 decision 10, never on the `platform/ai` allow-list (follow-up note, 17).

### 7.4 Events published
`sellers.<subject>-<past participle>.v1` (ADR-0006 decision 1); payloads are ids, enums,
booleans and instants from the closed vocabulary (PP 5.3); no actor (ADR-0018 decision 4).

| Type | Aggregate | Payload | Consumers |
|---|---|---|---|
| `sellers.seller-file-created.v1` | seller-file | `sellerId` | (later: `inventory`, SEL-10, if it prefers this to `identity`'s event) |
| `sellers.business-file-submitted.v1` | seller-file | `sellerId`, `revisionId`, `kind` (`onboarding`, `identity-change`), `authorKind` (`seller`, `admin`), `resubmission` | `sellers`' own handler (7.5) |
| `sellers.business-file-withdrawn.v1` | seller-file | `sellerId`, `revisionId`, `cause` (`edited`, `cancelled`, `reapply-refused`), `byKind` (`seller`, `admin`) | — |
| `sellers.business-identity-change-approved.v1`, `-rejected.v1` | seller-file | `sellerId`, `revisionId` | `sellers`' mail handler; later the storefront |
| `sellers.business-identity-edited.v1` | seller-file | `sellerId` (an admin edit, applied at once) | `sellers`' mail handler |
| `sellers.slug-changed.v1` | shop-slug | `sellerId` | Storefront (Phase 6) |
| `sellers.store-profile-published.v1` | store-profile | `sellerId`, `revisionId` | Storefront (Phase 6) |
| `sellers.allowed-product-types-changed.v1` | seller-admin-settings | `sellerId`, `allTypesAllowed` (boolean). Type codes are not in the payload: the vocabulary has no kind for them, and `catalog` reads the set from the facade | `catalog` (offers of a type no longer allowed leave sale; board 15 item 4) |
| `sellers.category-proposals-granted.v1`, `-revoked.v1` | seller-admin-settings | `sellerId` | `catalog` (CAT-51, AC 15) |
| `sellers.ai-switch-changed.v1` | seller-admin-settings | `sellerId`, `enabled` | `sellers`' mail handler (10) |
| `sellers.tax-registration-recorded.v1` | seller-tax-profile | `sellerId` only; `tax` reads `taxProfileOf` (Hassan L1) | Later `tax` |
| `sellers.market-settings-changed.v1` | (per the ADR of 14.1) | `setting` (enum), `enabled` | Slice 15 |
| `sellers.seller-file-purged.v1` | seller-file | `sellerId` | 8.4 |

### 7.5 Events consumed (`presentation/subscribers/`, system actor, `runOnce`)
| Event | Handler | Effect |
|---|---|---|
| `identity.seller-registered.v1` | `sellers.create-file` | Creates `SellerFile`, `SellerAdminSettings` (types `all`, proposals off, AI off), `SellerTaxProfile` and `StoreProfile` (empty) under the same id, in one unit; records `approvalRequiredAtRegistration` from the Market policy at that moment, so a later switch-off never approves sellers already waiting (AC 19). Never in `identity`'s transaction (ADR-0004 decision 5). Idempotent by the inbox and by the primary key. Until it runs, the facade answers "no file" and may-sell is no |
| `identity.seller-access-approved.v1`, `-rejected.v1` | `sellers.close-decision` | Finds the revision named by the decision's `basisId` (ADR-0022 decision 4; carried in v1 of these events, which are not merged yet, so no v2: identity owner at G2); finishes unit 2 if it was not done, re-taking the claim if needed (7.3). A decision with no `basisId` (Phase 2 data) changes nothing |
| `identity.seller-access-reapplied.v1` | `sellers.close-decision` | Clears a `reapply-requested` intent |
| `sellers.business-file-submitted.v1` (its own) | `sellers.after-submission` | Kind `onboarding`: when approval is required neither at registration nor by the current policy, the automatic approval of 7.3; otherwise, or when it is refused, `identity.notifyAccessReviewers(ctx, sellerId)` (R-3). Kind `identity-change`: mail to the sign-in address (10) |
| `identity.seller-access-suspended.v1`, `-reinstated.v1` | none | May-sell reads `identity` live; nothing to store |

### 7.6 Ports
| Port | Declared in | Implemented by | Notes |
|---|---|---|---|
| `BusinessRegisterLookup`, `BusinessIdentifierScheme`, `AddressFormat`, `TimezoneResolver` | `sellers/application/ports` | `sellers/infrastructure` | 4.2, 7.7 |
| `SellerMarketPolicy` (approval required, identifier rules, review checks, reasons, retention) | `sellers/application/ports` | Adapter reading Market configuration; after the ADR of 14.1, that ADR's store | `identity` reads "approval required" through its own `IdentityMarketPolicy` (ID 8.5); both read the same value |
| `IdentifierIndex` | `sellers/application/ports` | HMAC-SHA-256 under a 32-byte stack secret, required at boot, never logged, bound to the Market and the scheme (8.2). The secret must differ from `identity`'s throttle secret (boot check) and is backed up like the KEK; rotation is not needed before launch (Hassan) | Moves to `platform/` when a second module needs one |
| `ServiceAreaDirectory` | `platform/market-config` | Platform | 4.3 |
| AI switch reader (name in the `platform/ai` design) | `platform/ai` | `sellers` | **Named exception** (ADR-0019 decision 7): takes a `MarketContext` and a seller id, no actor; not a use case, so the gate does not run; reads `SellerAdminSettings.aiEnabled` in a read-only unit; a missing row or an error is "off" (platform/ai evaluates; R8). Off also stops the admin-side reading of that seller's files (AIA-01). Bound in the composition root; unbound, boot fails in both `APP_ROLE`s. Recorded in the checked-in list of non-permission declarations so review sees it (PF 6.2 row 5). Default off for a new seller (owner, certification G1) |

### 7.7 Register lookup
| Topic | Design |
|---|---|
| Who | A seller-side account on its own file (`save-identifier`, `submit`), a reviewer's re-lookup, the periodic job (slice 11). Never anonymous, a customer or another seller (AC 30). By identifier only; no search by name (brief s5) |
| When | Only when the value differs from the last checked value of that file, or the result is older than its maximum age; a reviewer's re-lookup always calls |
| Quota | Per account (keyed by account id), per reviewer, per origin and per Market, with a reservation unit before the call (the pattern of ID 6.8, HF1): a reached account limit refuses the save of a new value (`lookup.limit`) and never creates `not-performed` (brief s5); a reached Market budget gives `unavailable`; a counter store that cannot answer fails closed (`access.unavailable`). Numbers in 6.5 (Hassan L10) |
| Call | Outside any unit. Fixed https host from configuration, validated at boot (https, port 443, no IP literal, exact host); no redirect, 5 s timeout, 64 KiB response limit, no automatic retry inside a request; the checksummed identifier as the only variable; the access key from a secret per Region Stack (never in the repository, a log or an error), carried in the body if spike 1 shows the register supports it, and the query of that host redacted in any instrumentation (Hassan L7). JSON wrapped in a callback is unwrapped by an exact prefix and suffix match and parsed with `JSON.parse`, never evaluated; XML, if used, with DTD and external entities off (brief s7). Any other shape is `unavailable` (AC 32). The outbound URL and raw client errors are never logged |
| Result kept | Outcome, status, mismatch flags (`business-name`, `indirect-tax-registration`, `postcode`) and the instant; the compared register values only if the register's agreement allows it (vendor review, 16.2 item 3), encrypted under the seller's key. Never the raw answer |
| Comparison | Names compared after a fixed normalisation (case, punctuation, legal suffix list from configuration); postcode against the draft's address; tax registration against the seller's answer. A mismatch is a flag for the reviewer only |
| What the seller sees | "Matched with the official register" or "Not matched", one message for not found and cancelled, and the way forward (brief s5: never "verified"); `unavailable` reads "could not be checked now; a reviewer will check". No register value, ever |
| Reviewer | The current revision's result beside the seller's values, mismatches flagged, or "lookup not performed" with the manual link and the re-lookup button; the line "a match does not prove the applicant controls the business" (brief s5). The manual link is for admins only on the review page, never sellers: built on the server with the URL API from the boot-validated template (https, exact host, exactly one `{identifier}`, URL-encoded), opened `noopener noreferrer`; frontend telemetry never records outbound link URLs (Hassan, UX Open 5) |
| No cross-seller cache | Results are stored per file; a value checked for seller A is called again for seller B, so response time reveals nothing (brief s7) |
| Periodic re-check (slice 11, P2) | A job per Market: approved sellers whose result is older than the re-check interval (90 days), in bounded batches, using at most 50% of the Market budget per window (Hassan L7); it flags the seller for the admin (`sellers.admin_flags`, 14.4 Q-M20) and changes no state (AC 35) |

### 7.8 The seller list (SEL-14) without a join
The list reads `sellers`' rows (store name and slug prefix search; exact identifier through
`IdentifierIndex`; file state) and, per page, one `identity.sellerAccountSummaries` call for state,
owner name and sign-in email (ID 8.1). Tabs: "All", "Awaiting review" and "Incomplete" come from
`sellers`' rows (every seller has a file, so "All" is `sellers`' list); "Changes needed", "Not
approved", "Approved" and "Suspended" page through `identity`'s list of seller ids by state (R-6)
and are decorated from `sellers`. **Text search works on the tabs read from `sellers`' rows ("All",
"Awaiting review", "Incomplete") and is not offered on an `identity` state tab in Phase 3** (the
single rule; 14.3 Reza 9 agrees; Jafar 2). The flag `file-check-needed` (3.3) is a filter on "All". Target: 25 rows per page, 95th percentile under
200 ms (technical-spec s3.2), measured with Mojtaba.

## 8. Personal data

### 8.1 Fields and keys
All business data is personal (brief s5). **Subject:** the seller id, whose key `identity` creates
with the `SellerAccess` (ID 11.3; data design: subject keys "accounts plus sellers"); `sellers`
never calls `createKey`, and a missing key is a programming error (PF 4 row 6). Labels are
constants `sellers.<record>.<field>`.

| Field | Live | In revisions and history |
|---|---|---|
| Store name, slug | Clear (public once approved; list search) | Encrypted |
| Business name, phone, contact email, address lines, postcode | Encrypted (T2 option B) | Encrypted |
| Business identifier | Encrypted, plus `IdentifierIndex` | Encrypted |
| Register compared values | Encrypted, only if the agreement allows | Encrypted |
| Store profile texts | Encrypted | Encrypted |
| Time zone, ServiceArea code, state codes, type codes, booleans | Clear | Clear |

The published store profile is decrypted per read: one key unwrap per request (PF 4 row 9). That
is acceptable until the storefront (Phase 6), whose design decides whether a public read model is
needed (16.2 item 7).

### 8.2 Identifier index and content hashes
`IdentifierIndex.of(market, scheme, normalised)` = HMAC-SHA-256 under a stack secret, with the
Market and scheme in the input: equal values in one Market collide (uniqueness, reviewer's "other
sellers with this identifier", exact search), values in two Markets do not (AC 21). The subject
key cannot do this (PF 4 row 4). Content hashes of revisions use `SubjectKeyService.hmac`
(2.4 rule 2), which makes `sellers` the first consumer of `hmac` (PF 4 row 4).

### 8.3 Never outside the module
No personal field in an event, the outbox, an audit `before` or `after`, a log line, an error or a
URL (AC 27, AC 34). Seller-side and admin routes put no personal data in paths or query strings
(brief s7): searches are POST bodies, and request bodies of `sellers` routes are never logged.
Errors carry codes and field paths only. Every response with decrypted business data carries
`Cache-Control: no-store`; seller and admin edit pages keep unsaved business data in memory only,
never in browser storage or a service-worker cache (Hassan, UX Open 4).

### 8.4 Retention of abandoned and rejected files (brief s5; mechanism here)
A daily job per Market (`sellers.purge-abandoned-files`) finds files whose seller never got an
approved revision and whose last change is older than `fileRetention`; it skips a file with a
pending revision or a decision intent, and every seller that `identity.sellerAccessOf` reports
`approved` or `suspended` (14.3 Q-M5). It deletes the file's rows
and releases a held slug, in bounded batches, and publishes `sellers.seller-file-purged.v1`. It
does not destroy the key: the key is shared with `identity`'s reason text and is `identity`'s to
destroy. Closing the account and the `SellerAccess`, and destroying the key, need `identity`'s
side (R-9), called from `sellers`' own handler of `seller-file-purged` (at least once; 14.3 Q-M6) and a cross-module decision (14.2). The delete unit re-validates, under the root's version, that there is
no pending revision, no intent and `last_changed_at` is before the cutoff, so a concurrent "submit
again" wins; `identity`'s erasure use case sits in the sellers-only contract file and refuses unless
the state is `pending` or `rejected` and no `approved` decision ever existed (Hassan M7). The period
waits for counsel (16.1 item 3); the slice waits for both, and must merge before seller sign-up is
open in a deployed environment (Hassan L11).

## 9. Audit

One row per action below, in the transaction of the change, through the audit writer (IMP-10,
ADR-0004 decision 7). `before` and `after` hold ids, codes, booleans and type codes only (VER-13);
never a name, phone, address, identifier, reason text or register value.

| Action | When |
|---|---|
| `sellers.business-file.submitted-by-admin` | An admin submits on a seller's behalf |
| `sellers.business-data.edited-by-admin` | An admin edits business data or contact details (`after` lists the changed field groups) |
| `sellers.admin-flag.cleared` | Admin (14.4 Q-M20) |
| `sellers.slug.changed`, `sellers.slug.released`, `sellers.timezone.corrected` | Admin (`released`: an admin change on a never-approved seller, 3.5) |
| `sellers.identity-change.requested`, `.cancelled` | Seller Owner (Hassan L5) |
| `sellers.business-details.viewed` | Every decrypting read under `sellers.business-details.view` (`seller.read-details`, `review.read`, `reviewerBusinessDetails`); `after` holds the read kind (Hassan M4) |
| `sellers.review-check.recorded`, `sellers.register.manual-check-recorded`, `sellers.register.relookup-requested` | Reviewer, or the editing admin of 3.1 (H1) |
| `sellers.identity-change.approved`, `.rejected` | Reviewer |
| `sellers.allowed-product-types.changed`, `sellers.category-proposals.changed`, `sellers.ai-switch.changed` | Admin (AC 14, AC 15; "who, when, before and after") |
| `sellers.market-settings.changed` | Admin (AC 19) |
| `sellers.tax-registration.recorded` | Seller or admin (brief s5) |
| `sellers.business-history.viewed` | Every authorised read (VER-14, AC 26) |

Approve, reject and re-apply are audited by `identity` (its 10.1); its decision row carries the
`basisId`. A bulk action writes one row per seller (AC 22).

## 10. Mail
`sellers` sends through `platform/mail/` (ADR-0023 decision 4) from handlers of its own events,
in the worker, as the system actor: read, render and send outside any unit, then `runOnce` (ID 9).
Templates and translation keys `sellers.mail.<template>` live in the module; locale is the Market's
default; values are escaped. The address is the Seller Owner's **sign-in** address, never the
contact email (brief s5), read from `identity` (R-4).

| Template | Trigger |
|---|---|
| Identity change requested | `business-file-submitted` of kind `identity-change` |
| Identity change approved, not approved (with the reason code's text) | The two events of 7.4 |
| Business identity edited by an admin | `business-identity-edited` |
| AI switched on for your shop (text seen by counsel; board 13 item 3) | `ai-switch-changed` with `enabled` true. Switching off sends nothing in Phase 3 (16.2 item 8) |
| **Proposal, not decided (Jafar 7; owner or Hadi decides):** "Your area is now open", one line saying the seller can now submit | If accepted: a job per Market after a deploy that switched an area's `sellerOnboardingEnabled` on re-evaluates files in `outside-service-area` and mails each such seller once (a per-file "notified" marker, Mojtaba). Not built unless accepted; recorded in the brief change log (17) |

Notices to admins (the reviewer notice) are `identity`'s (R-3). Until the proposal above is
accepted, outside-area sellers get no automatic mail when an area opens; the admin list has a
filter for them (16.2 item 5).

## 11. Slices

### 11.1 Order, size and security gates
Every slice is one branch and one PR (rule 13), tested on AU and ZZ, with Hassan's review (tier
A). Sizes as in ID 12.1: S, M, L, XL.

| # | Slice | Size | Needs first | Hassan checks |
|---|---|---|---|---|
| P1 | Shared-file platform PRs, announced on the board (backend track): `ServiceAreaDirectory`, `config/service-areas/`, the `sellers` part of the Market configuration schema | S each | — | Boot validation |
| P2 | Platform migration: `btree_gist` in schema `extensions` (not on the app role's `search_path`; a test asserts `mondapac_app` has no USAGE); the narrow platform.md 10.5 guard-1 amendment (Ali's O1 ruling; Mojtaba writes it); spike S1 shows Prisma's drift check ignores the extension | S | — ; before slice 3's migration (ADR-0023 decision 5) | The guard amendment |
| 1 | File created from `identity.seller-registered.v1`; `sellerSummaries`; `sellers.outbox`, `sellers.inbox`; a deploy-time backfill that only creates missing files (14.3 Q-M4) | M | `identity` slices 3 (delivery side) and 5; R-6 for id paging only | Idempotence; no personal data in the event |
| 2 | Complete details: General, Address, phone, slug check, time zone, ServiceArea; encryption of live fields | L | 1; P1 | Plain text, slug rules, limits (6.5) |
| 3 | Business identifier from Market configuration; `IdentifierIndex`; tax registration (V2, `EffectivePeriod`) | M | 2; P2 | Index secret (7.6); AC 3 |
| 4a | Register lookup: port, `none` and `fake`, quotas, results, seller and reviewer view | M | 3 | Quota reservation; no leak (AC 30, 34); L10 |
| 4b | The register adapter | M | 4a; merges only after Ali's vendor review of the register's web-service agreement is recorded. Switching AU to `abr` is a separate configuration PR after the key arrives (owner queue item 11) | The outbound hardening of 7.7 (L7) |
| 5 | Submit: revisions (`Revision<T>`, content hash), completeness, withdraw on edit, `onboardingSteps`, the reviewer notice | L | 4a; `ContentHash` (2.4 rule 3); **identity mini-review 3** (R-3); allow-list entries (R-8) | AC 4, AC 5, AC 10; acting-as (6.4) |
| 6 | Admin seller list | M | 5; R-6 | AC 1, AC 17; clear fields only (M4) |
| 7a-read | Review page (`review.read`), review checks, re-lookup, manual register check; the `sellers.business-details.view` key | L | 6; R-5; R-11 | M4 split; L3; AC 32 |
| 7a-decide | Approve and reject through `identity` with `basisId`; identifier claim; decision intent; reconciliation job | L | 7a-read; **identity mini-review 1** (R-1), released with it | The contract-file rule; M3 deadline and interleaving test; AC 9, 10, 21, 22 (single) |
| 7a-auto | Automatic approval | M | 7a-decide. Off the first-sale path (AU keeps approval on); must merge before any hosted Market switches approval off | AC 33 with the M1 cases (both policy values; claim words) |
| 7b | Submit again and the re-apply limit; the final state's way out (R-7) | M | 7a-decide; R-7 | AC 11 |
| 8 | Admin edit, submit on behalf, bulk approve and reject | M | 7a-decide | AC 16, AC 22; M2 |
| 9 | `sellingEligibility`; `allowedProductTypesOf` (always `all`); `reviewerBusinessDetails` | M | 7a-decide | AC 13; L4; must merge before `catalog`'s first Offer slice and `certification` slice 7 |
| 10 | Change of business identity after approval; admin edit of an approved seller (H1); live contact edit with its history | L | 7a-decide; **identity mini-review 2** (R-2); R-4 | AC 20, AC 23; the H1 test; L2; L6; re-run the postcode-mismatch comparison (7.7) after an address-only change (Hassan, G2 confirmation, Low) |
| 11 | Periodic re-check | S | 4b; P2, after launch (SEL-27) | AC 35; budget share (L7) |
| 12 | Public store profile (V1, allow-list facade) | M | 5 | AC 24, AC 25; M5; L9 |
| 13 | Category proposals and their events | S | 1 | AC 15; just before `catalog`'s CAT-51 slices |
| 14 | Restricting allowed types | S | `catalog` G2 (type registry) | AC 14 |
| 15 | Settings page: "approval required" | M | The ADR of 14.1 | AC 19 |
| 16 | AI switch and its port implementation; switch-on mail | S | `platform/ai` part 1 (declares the port); before or with the first model-calling slice (ADR-0019 decision 8) | AC 29; R2, R8; L6, L8 |
| 17 | Panel screens: one frontend PR per row of `ux.md` 8.2 | XL in all | Figma and F0 (ADR-0017); each after its backend slice | Frontend track; UX Open 4 and 5 |
| 18 | Retention purge | M | Counsel's period; ADR 14.2; R-9 | Erasure completeness; M7 |
| 19 | `business-history.read` and page P2-H | S | 10 | AC 26 (each read audited) |

On the path to the first sale: P1, P2, 1 to 6, 7a-read, 7a-decide, 7b, 8, 9, 10 and 12 (the
storefront needs 12 in Phase 6). Slice 18 is not a sales feature but must merge before seller
sign-up is open in a deployed environment (Hassan L11). Not on the path: 7a-auto, 11, 14, 15, 16,
19. Estimate: about 23 backend PRs plus the platform PRs; slices with a migration are P2, 1, 2, 3,
4a, 5, 6, 7a-read and 7a-decide (Mojtaba places 7a's tables between them), 10, 11,
12, 14, 18 (14.4 Q-M24) (the data
design's 9.1, 14.3 Q-M16), each needing Mojtaba's sign-off and Hassan's review. No date until Javad
has the measured pace of identity's slices.

### 11.2 Platform triggers (ADR-0015 decision 3) pulled by `sellers`
| Trigger | Slice |
|---|---|
| `config/service-areas/` and `ServiceAreaDirectory` | P1, before 2 |
| `btree_gist` in schema `extensions` | P2, before 3 |
| `EffectivePeriod` (designed here, 2.4) | 3 |
| `Revision<T>` (designed here) and `ContentHash` (audit-seal design) | 5 |
| `SubjectKeyService.hmac` (PF 4 row 4) | 5 |
| First outbound HTTP call to an external service | 4b |
| The `sellers` section of the Market configuration schema; ZZ fixture values | 2 to 5 |
| Not pulled: the extension-point registry (4.2), object storage (Q2), Redis, the Market configuration in the database (waits for the ADR of 14.1) | — |

### 11.3 Spikes (run, not merged)
| # | Spike |
|---|---|
| 1 | The register's web service with a test key: response fields, error shapes, rate limits, the callback wrapper; decides whether a parser package is needed (12) |
| 2 | Cost of the list page: one page of rows plus one `identity` call and one key unwrap per row, with Mojtaba |
| 3 | The AU zone table: postcodes whose zone differs from their state's, from a source whose licence allows a checked-in file |

## 12. Dependencies (for the owner's bundled list, ADR-0018 decision 8)
| Need | Standard library? | Recommendation |
|---|---|---|
| HMAC index, content hash | Yes (`node:crypto`, `SubjectKeyService`) | No package |
| Outbound HTTPS with limits | Yes (`fetch` with `AbortSignal.timeout`, manual redirect, a streamed size limit) | No package |
| Parsing the register's answer | JSON: yes. XML: no | None if spike 1 confirms JSON; otherwise an XML parser with entities off, named after the spike |
| Phone and address validation | Patterns from Market configuration | No package; a phone-number library only if a Market needs it |
| Postcode to zone data | A data file, licence checked | Data file |

## 13. Hand-offs

### 13.1 For Mojtaba (`docs/design/data/sellers.md`)
Schema `sellers`. Tables, one per aggregate root of 2.1 and their children; `outbox` and `inbox`
(PM1, PM4); lookup quota counters. Decisions that are his: revisions as rows with encrypted
content (V1 columns of ADR-0009 decision 2) and the pointers on `seller_files`; the unique keys of
`shop_slugs (market_id, slug)` and `identifier_claims (market_id, identifier_index)`; the
no-overlap constraint on tax registration periods (raw SQL in the migration); the list indexes of
7.8 (store name prefix, slug, file state, `identifier_index`); whether `seller_admin_settings`
stores type codes as an array or rows; the purge (8.4) and its batch size; grants (application
role: no `DELETE` except on the purge's tables). Every root has `version` (PP 10); foreign keys of
children include `market_id` (PM6).

### 13.2 For Reza (`docs/modules/sellers/ux.md`)
The screens of brief s12. From the API: the status codes of 3.3; field error codes
(`identifier.format`, `identifier.checksum`, `slug.taken`, `slug.reserved`, `slug.format`,
`phone.required`, `address.outside-service-area`, `timezone.unresolved`, `lookup.limit`,
`file.incomplete` with the missing fields, `file.decision-in-progress`, `link.host-not-allowed`);
the register states of 3.4 as seen by the seller (two outcomes plus "could not be checked"); the
warning before an edit withdraws a submission; the pending identity value beside the current one;
the steps of `onboardingSteps`; the reviewer page parts of brief s4 b; bulk results as counts.

## 14. ADRs needed

### 14.1 Admin-editable Market settings (ADR-0026, reserved on the board 2026-10-07; not written)
Requested by the brief (s11), board 8 item 3, 11 item 4 and 15 item 3. **Order (Ali, G2):** not a
G2 condition. Accepted before the earliest of: `sellers` slice 15; `catalog`'s CAT-36 and OFR
runtime-setting slices; any AI capability switched on in a Market. Mohammad drafts it before
`catalog`'s G2 is recorded; Hassan reviews. The brief asked for it before this G2; the change of
order goes in the brief's change log (17): R7 of the identity brief holds, because `identity` and
`sellers` read the same value from configuration through their own policy ports. **Proposed decision:**
Market settings that an admin may change at run time (SEL-15 "approval required", CAT-36, the
OFR-01 and OFR-03 settings, and the operator's switch-off of one AI capability or all AI, ADR-0019
R8) live in a platform store keyed by Market and setting code, seeded from `config/markets/`
(which stays the source of the default and of every setting not on the editable list). Each
setting is declared by its owning module with its type, default and permission key; reads are
synchronous, see a committed change at once and fail closed to the configured value; each change
is a use case of the owning module, audited, and does not cross Markets. Effective dating and a
notice to senior admins are decided in that ADR. It amends ADR-0003 decision 5 and pulls the
"Market configuration seeded to the database" trigger of ADR-0015 decision 3. **Effect here:**
this design does not wait for it except in slice 15.

### 14.2 Retention and erasure of a seller application across `identity` and `sellers` (ADR-0027, reserved 2026-10-07)
**Order (Ali, G2):** second, before slice 18, after counsel gives the period (`identity` destroys a
subject key at another module's request; PF 4, ADR-0009 decision 6). **Proposed decision:** an application that never reached approval, or was finally not approved,
is erased after the Market's retention period: `sellers` deletes its file and releases the slug,
then calls an `identity` use case (system actor) that closes the seller's accounts and
`SellerAccess` and destroys the seller's subject key, which `identity` owns. `identity` never
consumes a `sellers` event (R7); the call goes from `sellers` to `identity`'s facade. An approved
seller's erasure is a separate request (CUS-03) designed with `ordering`, because invoices fall
under legal retention (ADR-0009 decision 6). Crosses two modules and the key life cycle of PF 4.
Hassan M7: the `identity` use case sits in the sellers-only contract file (same CI rule as R-1) and
refuses unless the state is `pending` or `rejected` and no `approved` decision ever existed;
`sellers`' delete unit re-validates under the root version (8.4). Hassan's view for counsel: 6
months for never-submitted drafts, 12 months for finally rejected files.

Not needed (Ali, G2): a new ADR for the register lookup (brief s11), for the may-sell name
(ADR-0022 left it here), for `IdentifierIndex` while it stays in `sellers`, or for `withdrawn` as a
fifth V1 status.

### 14.3 Answers to Mojtaba and Reza (2026-10-07)
Edits made to the other two documents, only on the affected lines: data design 3.3 (`not-done`), 3.9 (changed-at and changed-by per setting), 3.10 and 9.1 row 9 (slice 10); `ux.md` 3.1 row S4. Mojtaba's questions are those of `docs/design/data/sellers.md` 13; Reza's are the "API needs" of
`docs/modules/sellers/ux.md` 7 and its 1.4. "Changed" means this document changed with the answer.

| # | Answer |
|---|---|
| Q-M1 | Confirmed: no pending-revision column; the partial unique index holds "one pending at most" and the aggregate derives it. Changed: 2.1 |
| Q-M2 | Confirmed: clear `public_store_name`, copied when the approved pointer moves (approval and admin edit). Changed: 2.1 |
| Q-M3 | Confirmed: a retired slug row is kept for ever with the seller id as an opaque id; the purge deletes only a held row |
| Q-M4 | Yes, slice 1 includes a backfill that only creates missing files: a `system` use case, run per hosted Market at deploy, that pages `identity`'s seller ids (R-6, used only for id paging; it also returns `origin`), idempotent by the primary key. `approvalRequiredAtRegistration` cannot be known for them: it takes the Market's value at backfill time. Phase 2 has no deployed environment (ADR-0023 decision 2), so this concerns test data. **Changed at G2 (Ali change 1):** a seller `identity` already reports `approved` gets a file with no approved revision, stays not eligible to sell and is shown to an admin (`file-check-needed`, 3.3); there is no approval by `sellers` alone; if a real environment ever has such a seller, a mini-review designs a path with an audit row. Changed: 3.1, 3.3 |
| Q-M5 | Confirmed both: skip files with a pending revision or an intent, and every seller `identity` reports `approved` or `suspended`. Changed: 8.4 |
| Q-M6 | Confirmed: R-9 is called from `sellers`' handler of `seller-file-purged`. Changed: 8.4 |
| Q-M7 | Confirmed: a fixed 24-hour window from the first reservation. `sellers.purge-expired` (hourly) cleans quota counters; the file purge keeps the name `sellers.purge-abandoned-files` |
| Q-M8 | Confirmed: outcome, flags and instant clear (they are results, not business values); compared register values encrypted |
| Q-M9 | A revision with author `admin`, approved in the same unit, moving the pointer, `public_store_name` and the claim; refused while another revision is pending (`file.change-pending`). Before approval an admin edits the draft, which withdraws a pending revision. Changed: 3.1 |
| Q-M10 | Slice 10 brings `my-contact.save` and `contact_detail_history`. Changed: 6.2, 11.1; data design 3.10 and 9.1 row 9 edited to say slice 10 |
| Q-M11 | Proposed plaintext limits (characters after NFC; Hassan may lower): store name 1 to 100; business name 1 to 200; phone at most 32 after normalisation, pattern from the Market; contact email at most 254; each address field 1 to 120, postcode by the Market's pattern; description 5,000 per locale; each policy 10,000 per locale; meta title 120, keywords 255, meta description 320; each social URL 2,048 (lowered at G2). **G2 (Hassan):** accepted with each social URL at most 512, Unicode default-ignorable characters refused, and values of only whitespace or invisible characters refused. Changed: 6.3 |
| Q-M12 | The code format is `catalog`'s registry's (its G2). An empty set is refused (`types.empty`) until `catalog`'s G2 says whether "no type" is meaningful; stopping a seller from selling is suspension's job. Changed: 2.1 |
| Q-M13 | No correction of a started period in Phase 3: a change is a new period from its date, closing the previous one. A future period that has not started may be cancelled (`DELETE` of that row only, audited). The final rule waits for the tax adviser (brief s5); this is reversible |
| Q-M14 | Confirmed: both get `version`; `shop_slugs` gets a surrogate `id` |
| Q-M15 | Confirmed: `author_account_id` NOT NULL; no system path creates a business file revision |
| Q-M16 | Accepted: slices with a migration are 1, 2, 3, 4a, 5, 6, 7a (since G2: 7a-read and 7a-decide), 10, 11, 12, 14, 18. Changed: 11.1 |
| Q-M17 | Confirmed: no status column until a review state exists |
| Q-M18 | The approved revision's clear `identifier_index IS NOT NULL` when the Market's current configuration requires an identifier (brief s5 states the rule as a live condition); time zone from the revision's clear column; no decryption. Changed: 7.2 row 2 |
| Reza 1 | Yes: `my-file.read` returns the code of 3.3, the pending revision's kind and author kind, `reapplyPossible`, the steps `{ state, fieldsLeft, route }` and, on `file.incomplete`, `details.fields`; since G2 also the latest withdrawal (cause, by whom, date; Jafar 4) and the latest rejected identity change (Jafar 5). Changed: 6.2 |
| Reza 2 | `form-descriptors.read` returns the Market's address fields in order with label keys, patterns, the region list and the phone pattern. Saving an address answers `inside` or `outside` an onboarding area and the zone id; the panel formats the zone's display name with `Intl` in the page locale. Changed: 6.2 |
| Reza 3 | Codes `slug.available`, `slug.taken`, `slug.reserved`, `slug.format`; a slug the seller already holds reads `slug.available`. No storefront prefix until Phase 6: the read returns none |
| Reza 4 | The save of the number returns `matched`, `not-matched`, `unavailable` or none. A validate-only call exists: `my-file.validate-identifier`, format and checksum only, no lookup, same rate limit as saves. Changed: 6.2 |
| Reza 5 | Yes to both: an admin with `sellers.seller.edit` edits a suspended seller (business data is independent of access state) and an invited seller whose owner has not accepted (the file exists from the invitation, ID 8.2; brief s4 c) |
| Reza 6 | Yes, all parts. Refusal codes: `review.not-current-revision`, `review.checks-missing`, `review.register-blocks`, `review.identifier-held`; each disabled action carries one of them. A recorded check can be set back: re-recording takes a third result `not-done`, which the approval guard treats as missing (data design 3.3 edited); audited like any record |
| Reza 7 | The read gives the pending values, `canCancel` (owner, while pending), and after a rejection the reason code (its text is the translation key of 4.1's list; no free text). Another request waiting: `file.change-pending`. Without a recent confirmation the request answers `reconfirmation.required`; D9 collects the password, and the code when a factor is active, and calls `identity`'s re-confirmation (R-2). **Changed at G2 (Jafar 5):** no dismissal; the read returns only the latest rejected request, shown until the owner starts a new request (3.1) |
| Reza 8 | Yes: reads return per action `allowed` and a denial code, computed from the same guards as the commands (the pattern of ID 8.6 row 6); hints only, every command checks again |
| Reza 9 | Counts per tab: from `sellers` for its tabs and from R-6 for `identity`'s. "All" supports text search (on `sellers`' rows); identity state tabs do not (the single rule of 7.8, fixed at G2, Jafar 2); the outside-area filter exists; each queue row says `onboarding` or `identity-change`; more than 50 ids answers `bulk.too-many`; the bulk result is counts plus `[{ sellerId, code }]` |
| Reza 10 | "Last changed by and when" comes from `SellerAdminSettings` itself (instant and admin account id per setting; data design 3.9 edited), with the admin's display name from R-11, not from reading the audit log. Product types: until slice 14, the card shows "All types" and the restriction as not available yet |
| Reza 11 | **Changed at G2 (Ali change 6):** seller-owned times use the seller's `operatingTimezone`, for the seller and for admins alike, with the zone named next to the time; the Market's default zone only when the seller has no zone yet (ADR-0005 decision 2: the Market's zone is the fallback) |
| Reza 12 | Hosts: `facebook.com`, `instagram.com`, `youtube.com`, each with `www.` and `m.` (the SEL-24 Social fields), a module constant. Locales: the Market's `supportedLocales`; the profile read lists which locales have text |
| Reza 13 | Contact email is part of the onboarding draft and optional (AC 5 does not list it as required). The tax "from" date is asked at onboarding when the answer is "registered" (ADR-0007 decision 6 captures `effective_from` at onboarding); when "not registered", the period starts at the instant it is recorded. Changed: 2.1; `ux.md` 3.1 row S4 edited (a "Registered from" date when the answer is Yes) |
| Reza 14 | No mail; S1 shows "Submitted by MondaPac on (date)", from the revision's author kind. Told to the owner, not asked (16.1) |
| Reza 1.4 | No objection from the domain side: the words follow 3.3, the steps follow ID 8.5, single approve and reject on the review page follow ID 8.6 row 11, and D3 and D4 are UX. They change `identity`'s approved UX, so the identity owner and Jafar accept them (R-12) |

### 14.4 Answers to Mojtaba's G2 questions (data design 13.2, 2026-10-07)
| # | Answer |
|---|---|
| Q-M19 | The brief means the **sign-in** email, which `identity` already requires; the contact email stays optional. Reasons: SEL-22 (as corrected after G1) says "name and email are always mandatory **and in sign-up**", and the sign-up form holds only the sign-in email (the same correction moved the slug to "before submission" and left email at sign-up); brief AC 5 lists the mandatory items (name, business name, phone, address, slug, identifier) without an email. No schema change. Hadi may add a clarifying change-log row to the brief (17); not a G2 condition |
| Q-M20 | Accepted as proposed: `sellers.admin_flags` (closed `code` list: `identifier-claim-conflict` from 7a-decide, `register-recheck` added with slice 11), one open flag per (Market, seller, code), created in 7a-decide. An admin with `sellers.seller-file.review` clears a flag, audited `sellers.admin-flag.cleared`. `file-check-needed` (3.3) is computed, not stored. The list filter of 7.8 reads open flags |
| Q-M21 | Yes, before approval: the brief restricts slug changes only after approval (brief s7, AC 16), and a draft slug gives no right (T1). Saving a different slug releases (deletes) the held row in the same unit, after the withdraw warning if a pending revision holds it; the new slug is held at the next submission. No audit row (a seller-side draft change; the admin release keeps `sellers.slug.released`). So `DELETE` on `shop_slugs` arrives in slice 5. Changed: 3.5 |
| Q-M22 | Per seller file, like submissions. Changed: 6.5 |
| Q-M23 | A second address: brief s7 says the determining address is where the shop operates and "if the registered address differs it is captured separately (details: G2)", and its G2 list names "operating address vs registered address". The draft has the operating address (required) and an optional registered address (same `AddressFormat`; captured only when the seller says it differs). The operating address alone determines the ServiceArea and the time zone. Both are business identity (Q4: "address"): in every revision, reviewed, changed after approval only through `request-change` (identity change), encrypted under the seller's key like other business data (8.1). The register comparison of 7.7 uses the registered address's postcode when present, otherwise the operating one; `reviewerBusinessDetails` returns both, labelled. No migration (the address is one JSON ciphertext). Changed: 2.1, 7.1; Reza adds the field to the Address step |
| Q-M24 | Accepted: P2 joins the list; slice 8 needs no migration once the `DELETE` grant on `shop_slugs` moved to slice 5 (Q-M21; Mojtaba). Changed: 11.1 |

## 15. Requests to the identity owner (backend track)
No `identity` port, event or rule is changed by this document. Each item below needs `identity`'s
owner and, where marked, a mini-review of the identity brief (ADR-0013 decision 4).

| # | Request | Why | By slice | Status (Ali and the identity owner, G2) |
|---|---|---|---|---|
| R-1 | Mini-review 1 (ID 15.2): approve and reject enter only through `sellers`; `identity`'s endpoints are removed; AC 5 changes (initial state `pending` in both settings). Also: publish approve, reject, re-apply, auto-approve and the erasure of R-9 in a separate contract file that only `modules/sellers/` may import (CI rule, ADR-0022 consequences); `basisId` **required** on approve, reject and auto-approve in that contract; `basisId` in the payload of `identity.seller-access-approved.v1` and `-rejected.v1` (those events are not merged yet, so v1, no v2), optional only when reading Phase 2 events | 7.3, 7.5 | 7a-decide | Mini-review 1 before 7a-decide, with Hassan's review of the contract file; the identity owner plans it before sellers slice 5 |
| R-2 | Mini-review 2: `hasRecentConfirmation(ctx, within)`; window 10 minutes, bound to the session, checked inside `request-change`, never satisfied in acting-as (Hassan) | 3.1, 6.4 | 10 | Before slice 10 |
| R-3 | Mini-review 3: the reviewer notice follows a submission, coalesced to at most 1 per seller per 6 h (Hassan); `notifyAccessReviewers` built and the Phase 2 trigger switched off | 7.5 | 5 | Before slice 5 |
| R-4 | Build the "contact point of an account" named in ID 8.1: for the system actor, the Seller Owner's sign-in address and locale, by seller id | 10 | 10 (and 16) | Accepted |
| R-5 | A reviewer read of a seller's decisions: instant, state, `basisId`, and the reason text for an admin with `identity.seller-access.view` (personal data, returned only to that admin, never logged by `sellers`); also read by the reconciliation job by `basisId` (7.3) | Brief s4 b; Hassan M3 | 7a-read | Accepted |
| R-6 | A paged list of seller ids by access state, with `origin` and a count per state, under `identity.seller-access.view` (also the backfill's id paging, as the system actor) | 7.8 | 1 (id paging), 6 | Accepted |
| R-7 | The way out of the final `rejected` state: an admin use case "allow one more application" (raises the limit by one for that seller), permission `identity.seller-access.approve`, audited, with a mail | 3.3; ID 14.1-8 | 7b | Accepted (16.2 item 1); before slice 7b |
| R-8 | Allow-list entries of 6.2 (`N` = allow) added to the checked-in list in their slices | ID 5.2 | 2, 3, 5 | Accepted; Hassan reviews each entry |
| R-9 | An `identity` use case for 14.2, in the sellers-only contract file: close a never-approved seller's accounts and `SellerAccess` and destroy the seller's key; refused unless the state is `pending` or `rejected` and no `approved` decision ever existed (Hassan M7) | 8.4 | 18 | Waits for the ADR of 14.2 |
| R-10 | Keep `sellers.business-identity.edit` owner-only if the Phase 2 narrowing of R11 is ever lifted | 6.1 | — | Decided: the narrowing stays until permission declarations get an owner-only attribute that the registry enforces; a change-log row in the identity brief; no work |
| R-11 | Display names of admin accounts by id, for "last changed by" on settings and review checks (Reza 10) | 14.3 | 7a-read | Accepted (admins only) |
| R-12 | Accept the four changes `ux.md` 1.4 makes to the approved identity UX (words "Awaiting review" and "Details needed"; `sellers` steps on S1; single approve and reject move from P1 to the review page; D3 and D4 modes) | 14.3 | 5 | Jafar accepted for design with conditions (16.4.3); the identity owner's acceptance is still needed |

## 16. Review record and open points

### 16.1 For the owner (Persian summary, through Hadi)
| # | Question, in plain words | Team recommendation |
|---|---|---|
| 1 | If we stop taking new sellers in an area (for example a suburb), should sellers already approved there keep selling? | Yes. The switch is about onboarding; stopping existing shops needs its own decision (suspension exists for that). The answer is read at approval time, not every day. **Owner answered 2026-10-07: yes (keep selling; checked at approval time). G2 blocker closed** |
| 2 | Does the "waiting for review" page promise a review time, and who reviews at launch? (asked at G2 by the brief, with the page text) | No promised time at launch; name the reviewer and a back-up before the first real seller |
| 3 | How long do we keep the data of applicants who never finish or are finally not approved? | Ask counsel; Hassan's view for counsel (G2): 6 months for applications never submitted, 12 months for finally rejected ones. Nothing is purged until the answer and 14.2 exist, and the purge must exist before seller sign-up opens in a real environment |

Told, not asked: slugs are held from the first submission (T1); a submission MondaPac makes for a seller shows on the seller's page, with no mail; a seller who reached the
re-application limit can be given one more chance by an admin (R-7); the store name of an approved
seller only changes through review; sellers outside the launch area are found by an admin filter.
For the owner or Hadi to decide (not a question here; Jafar 7): a one-line "your area is now open"
mail to waiting outside-area sellers (proposal in 10).

### 16.2 For Ali, Hassan, Mojtaba (team decisions, closed at G2)
| # | Point | Proposal | Decided at G2 |
|---|---|---|---|
| 1 | The way out of the final state | R-7 | Accepted (Ali) |
| 2 | T2: encrypt live personal business data | Option B | Accepted (Hassan, Ali) |
| 3 | Lookup numbers; what the register's agreement lets us keep | 30 days; 10 new values per account per day; 1,000 per Market per day; 90 days | Hassan's numbers replace the proposal: 30 days for manual and automatic approval; 5 new values per account per 24 h; 30 re-lookups per admin and 30 per origin per 24 h; 1,000 per Market per 24 h, alert at 80%, periodic job at most 50%; 90 days (6.5). Agreement: Ali's vendor review before 4b merges |
| 4 | Time zone correction | Admin only, audited; a seller asks support | Accepted (Hassan) |
| 5 | ServiceArea activation stays configuration, not effective-dated, in Phase 3 | Accept | Accepted (Ali); run-time editing only through 14.1 if ever |
| 6 | The public store name appears on every certification badge and has no claim check | A required review check on every revision; claim words in the slug reserved list; later a `certification` port | Accepted with Ali change 3 (claim words in a checked-in data file, later supplied by the port) and Hassan M1 (per-token match: refused in a slug, flagged in a store name and blocks automatic approval) (3.5, 7.3) |
| 7 | Decrypting the published profile per read | Accept until the storefront G2 | Accepted with Hassan M5: no HTTP exposure without a read-model or cache design he reviews (7.1) |
| 8 | Mail when AI is switched off | None in Phase 3 | Unchanged (Hadi; counsel may ask for one) |
| 9 | Register and scheme names are not Market codes for the literal check; the strategies of 4.2 do not trigger the extension-point registry | Accept | Accepted with conditions (Ali): exemption by exact path, not by word; strategies stay module-internal until a second module needs identifier validation (4, 4.2) |
| 10 | Rate limits | Slug check 30 per minute; saves 60 per minute; submissions 10 per hour per account; bulk at most 50 ids | Hassan's numbers replace the proposal (6.5) |
| 11 | Submission stays an explicit step when approval is not required | Accept | Accepted (Ali) |

### 16.3 Reviews
| Reviewer | Result | Date |
|---|---|---|
| Ali (cto) | Accept with changes (applied, 16.4.1) | 2026-10-07 |
| Hassan (security-tester) | Accept with changes; H1 blocks G2 (applied, 16.4.2) | 2026-10-07 |
| Jafar (product-designer), on `ux.md` | Accept with changes; items for this document applied (16.4.3) | 2026-10-07 |
| Mojtaba (database-designer) | O9 closed; Q-M19 to Q-M24 answered (14.4) | 2026-10-07 |
| Reza (ui-ux-designer) | Author of `ux.md`; Jafar's items 1, 3, 6, 8 to 11 are his | |

### 16.4 G2 review record (2026-10-07)
How each actionable item was applied in this document. Items for the data design and `ux.md` are
listed for their authors and not applied here.

#### 16.4.1 Ali (cto): accept with changes
**G2 blockers** (G2 is recorded only when all are closed): Hassan's H1 (applied, 16.4.2);
Mojtaba's O9 (brief s5, s7, s11 read against the data design; closed by Mojtaba 2026-10-07, his new
questions answered in 14.4); the owner's answer to 16.1-1 (closed 2026-10-07: yes); Jafar accepts
brief s12 (`ux.md` 4; closed 2026-10-07, `ux.md` 9). **All blockers closed (2026-10-07).**
**G2 conditions (Ali's ruling, recorded as given):** "M1-M4 are merge conditions on 7a-auto (M1), 8
(M2), 7a-decide (M3), 7a-read (M4); H1's test on slice 10."

| Item | Applied |
|---|---|
| Change 1: no approval by `sellers` alone; the backfill only creates files | 3.1 last paragraph, 3.3 (`file-check-needed`), 7.8, 14.3 Q-M4, 11.1 slice 1 (R-6 for id paging only), 15 R-6 |
| Change 2: least privilege for decrypting reads | Through Hassan M4: 6.1, 6.2, 7.1, 9 |
| Change 3: claim words in a checked-in data file, later from the certification port | 3.5, 16.2 item 6 |
| Change 4: `basisId` required in the sellers-only contract; in v1 events, no v2 | 7.3 (call row and rules), 7.5, 15 R-1 |
| Change 5: slices 7a-read, 7a-decide, 7a-auto; slice 9 after 7a-decide; slice 19; slice 17 per `ux.md` 8.2 row; platform PRs before slice 2 | 11.1 (P1, P2, all rows and the path), 1.1, 6.2 |
| Change 6: Reza 11 time zone rule | 14.3 Reza 11 |
| Change 7 (data design) | Not applied here: Mojtaba |
| O1 ruling (`btree_gist`) | 11.1 P2, 11.2; the guard amendment is Mojtaba's (17) |
| ADR order: 14.1 not a G2 condition, accepted before the earliest of slice 15, CAT-36 and OFR runtime settings, any AI switched on; drafted before `catalog`'s G2 | 14.1; brief change-log row (17) |
| ADR order: 14.2 second, before slice 18, after counsel | 14.2 |
| No ADR for the lookup, the may-sell name, `IdentifierIndex`, `withdrawn` | 14.2 last paragraph |
| Rulings on 16.2 items 1, 5, 6, 9, 11; T1, T2-B | 16.2 last column; 4, 4.2 |
| 4b merges after the vendor review; AU switch to `abr` is a separate configuration PR | 11.1 slice 4b |
| R-1 to R-12 statuses | 15, last column |

#### 16.4.2 Hassan (security-tester): accept with changes
H1 closed: Hassan confirmed the applied text (3.1, 6.2, slice 10) in writing on 2026-10-07, including the registered address as business identity; he accepts M1-M4 as merge conditions on 7a-auto, 8, 7a-decide and 7a-read. One Low added at that check: re-run the postcode-mismatch comparison after an address-only change (slice 10).
| Item | Applied |
|---|---|
| H1 admin edit of an approved seller needs both keys and the reviewer-approval guards; test | 3.1 row, 6.2 `seller.edit-approved-identity`, 9, 11.1 slice 10 |
| M1 automatic approval: both policy values; claim-word check | 3.1, 3.5, 7.3 unit 1, 7.5, 11.1 7a-auto |
| M2 bulk with `[{sellerId, revisionId}]`, whole-request Market check, full guard, limits | 6.2, 7.3 rules, 6.5 |
| M3 hard deadline; job reads decisions by `basisId`; claim re-taken; alert; interleaving test | 7.3 crash row and rules, 7.5, 15 R-5 |
| M4 `sellers.business-details.view` | 6.1, 6.2, 7.1, 9 |
| M5 published profile only for eligible sellers, by held slug | 6.3, 7.1, 16.2 item 7 |
| M6 retire only a slug that was ever public; `released` audit | 2.1, 3.5, 9 |
| M7 erasure in the sellers-only contract; `identity` refusal; re-validation | 7.3, 8.4, 14.2, 15 R-9 |
| L1 tax event `sellerId` only | 7.4 |
| L2 approved file: no draft saves; change only through `request-change`; contacts through `my-contact.save` | 3.1, 6.2 (`file.change-request-required`) |
| L3 register check by (seller, N's index); age rule for manual approval | 3.4, 7.3 |
| L4 `sellerSummaries` visibility; 100-id cap | 7.1, 6.5 |
| L5 audit `identity-change.requested` and `.cancelled` | 3.1, 9 |
| L6 acting-as | 6.4, 6.2, 15 R-2 |
| L7 register key and host hardening; no retry; job budget share | 7.7 |
| L8 `ai-switch.edit` protected | 6.1, 6.4 |
| L9 social links | 6.3 |
| L10 per-account limits keyed by account id; fail closed | 6.5, 7.7 |
| L11 slice 18 before sign-up opens in a deployed environment; period view for counsel | 8.4, 11.1, 14.2, 16.1 item 3 |
| Numbers | 4.1, 6.5, 7.7, 16.2 items 3 and 10, 14.3 Q-M11, 15 R-2 and R-3 |
| Informational: one admin can do every step (owner-accepted at G1; audit is the control); with approval off, a copied public register name and number can be auto-approved, the backstop is payment-provider KYC before payout (Phase 5) | Recorded here; no change |
| Informational: `IdentifierIndex` secret differs from the throttle secret, backed up like the KEK; no rotation before launch | 7.6 |
| Informational: `extensions` not on the app `search_path`, no-USAGE test | 11.1 P2 |
| Informational: ADR-0019 decision 10 deterministic paths | 7.3; follow-up note (17) |
| UX Open 4 (no browser storage, `no-store`, bodies not logged) | 8.3 |
| UX Open 5 (manual register link) | 4.1, 7.7 |

#### 16.4.3 Jafar (product-designer): items for this document
| Item | Applied |
|---|---|
| 2 "All" search contradiction | 7.8 states the single rule (text search on "All", "Awaiting review", "Incomplete"; not on `identity` state tabs); 14.3 Reza 9 points to it. `ux.md` may enable search on "All" |
| 4 withdrawal cause and date; admin edit withdraws with a warning; `file.change-pending` | 3.1, 6.2 `my-file.read`, 7.4 (`byKind`), 14.3 Reza 1 |
| 5 the read keeps only the last rejected change request | Yes: only the latest identity-change revision when rejected and no later revision exists; no dismissal state (3.1, 14.3 Reza 7) |
| 7 "area opened" mail | 10, as a proposal for the owner or Hadi; brief change-log row (17) |
| 1, 3, 6, 8 to 11; 1.4 accepted for design with conditions | Reza's (`ux.md`); R-12 still needs the identity owner |

## 17. Follow-up changes
| File | Change | When, by whom |
|---|---|---|
| `docs/modules/sellers/brief.md` | G2 row; change-log rows: slice 18 added, and required before seller sign-up opens in a deployed environment (Hassan L11); slice 19 added (`business-history.read`, P2-H, AC 26); slice 4 split into 4a and 4b, 7 into 7a-read, 7a-decide, 7a-auto and 7b; slice 17 one frontend PR per `ux.md` 8.2 row; platform PRs P1 and P2 before slices 2 and 3; **the ADR of 14.1 is no longer before G2: Ali's ruling of 2026-10-07 (accepted before the earliest of slice 15, CAT-36 and OFR runtime settings, any AI capability switched on in a Market; R7 holds because `identity` and `sellers` read the same value through their own policy ports)**; ADR 14.2 before slice 18; no approval by `sellers` alone (Ali change 1); new key `sellers.business-details.view` and `sellers.ai-switch.edit` protected (Hassan M4, L8); admin edit of an approved seller needs both keys (H1); automatic approval needs both policy values and no claim word (M1); owner-only as a protected key; the AI switch default off and its notice; the store-name check and the claim-word data file (16.2 item 6); **proposal for the owner or Hadi: "area opened" mail (10; Jafar 7)**; section 12 table from Reza | With the G2 approval; Hadi |
| `docs/modules/identity/brief.md` | The three mini-reviews of R-1 to R-3 (R-1 with `basisId` in v1 events and the sellers-only contract file, incl. the erasure of R-9); R-7; the R-10 decision row (narrowing stays until an owner-only attribute enforced by the registry) | With slices 5, 7a-decide, 10; identity owner |
| `docs/design/domain/identity.md` | R-4 to R-12 where accepted | Identity owner |
| `docs/design/data/sellers.md` | New, from 13.1; G2 changes in the report's "For Mojtaba" note | Mojtaba |
| `docs/design/data/platform.md` 10.5 | Guard-1 amendment for extension member functions (O1), in PR P2 | Mojtaba; Hassan reviews |
| `claude/adr-0019-follow-ups.md` | Note: `sellingEligibility`, the automatic approval and identity-change decisions are deterministic paths of ADR-0019 decision 10, never on the `platform/ai` allow-list (Hassan) | Mohammad, with the G2 record |
| `docs/modules/sellers/ux.md` | New, from 13.2 | Reza |
| `platform/ai` design, part 1 | Declares the AI switch reader port of 7.6 | Mohammad, before slice 16 |
| `config/markets/AU.json`, `test/fixtures/markets/ZZ.json`, the configuration schema, `config/service-areas/` | 4.1, 4.3 (shared files: their own PR, announced on the board) | Slices 2 to 5; Hossein |
| `.env.example` | The `IdentifierIndex` secret (distinct from the throttle secret, boot check); the register access key (secret per Region Stack) | Slices 3 and 4b; shared-file PR |
| `docs/modules/sellers/brief.md` (optional) | Clarifying change-log row: SEL-22's "email" is the sign-in email; the contact email is optional (14.4 Q-M19) | Hadi |
| ADR of 14.1 | Draft | Mohammad, before `catalog`'s G2 is recorded; Hassan reviews |
| `docs/modules/README.md`, the board | G2 status once the blockers of 16.4.1 close; the ADRs of 14.1 and 14.2 reserved; requests R-1 to R-12 to the backend track; Kazem checks the managed provider's extension allow-list before the first deployed environment (O1) | Orchestrator |
