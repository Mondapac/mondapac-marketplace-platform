# certification: flows and screens (G2 UX specification)

| | |
|---|---|
| Author | Reza (ui-ux-designer), 2026-10-07 |
| Status | **G2 approved 2026-10-07** (review record in section 9). Open points in section 7 that need counsel or a spike are not G2 blockers and are tracked there |
| Module | `certification`, tier A, Phase 3. G1 approved by the owner on 2026-10-03 |
| Reviewers | Jafar (product-designer), Ali (cto), Hassan (security-tester). Mohammad's domain design (`docs/design/domain/certification.md`, "CD") sections 3, 4, 7, 9, 12 and 16.2 are cited here |
| Used for | Brief section 12 (filled in section 4 here), the Figma work (ADR-0017) and slice 18 (panel screens; one frontend PR per row of 8.2) |

**Ground truth.** `docs/modules/certification/brief.md` (sections 4, 5, 7, 10, 12); CD 2 to 4, 7, 9, 12, 13, 16;
`docs/features/08-certifications.md` (CERT-*); ADR-0012 and the Proposed ADR-0028; ADR-0017;
`docs/modules/sellers/ux.md` (approved; cited as "SL-UX": its shells, `DataRow`, `FormActionBar`,
`SettingRow`, `CheckboxRow` changes, copy rules and acting-as rule are reused) and `docs/modules/identity/ux.md`
("ID-UX": limited shell, dialogs, toasts, B5).

**Not verified.** The Figma file was not opened. The library inventory comes from `docs/design/figma/README.md`,
and SL-UX 4. SL-UX releases 1.3.0 and 1.4.0 (and ID-UX 1.1.0, 1.2.0) are **planned, not built**; this document
assumes them and adds 1.5.0 and 1.6.0 on top (section 4). `CertChip`, `ExtractedField`, `DeadlineBadge` and
`QueueCard` are named in the README; their properties were not inspected, so every "change" in section 4 is
a proposal to confirm in the file. No research with real sellers or reviewers exists. Step order and grouping
are provisional ("For Jafar"). ADR-0028 is Proposed; where it changes, section 3.8 changes with it.

**IDs.** CS = seller-panel screen, CA = admin-panel screen, CB = buyer-facing element, DG = dialog, EM = email,
FL = flow. (SL-UX uses S, P, C, D, E, F; this module uses its own prefixes so no ID collides.) "AC n" is
acceptance criterion n of the brief section 10 as cited in CD. Codes are the API codes of CD 3.3, 3.8 and 16.2;
the UI maps each to a translation key and never shows server text (INTL-11).

## 1. Scope and inventory

Phase 3 UI for `certification`: **seven seller-panel screens, nine admin-panel screens, three buyer-facing
elements, nine dialogs, ten emails.** The buyer-facing elements are specified here because the badge is
trust-critical and must be designed once (CERT-24); they are **built** in the Phase 6 storefront. Until then
the same `CertChip` and `CertDetail` components appear inside the seller and admin panels (3.8).

### 1.1 Screens
| ID | Name | Panel | Slice | AC | Priority | Note |
|---|---|---|---|---|---|---|
| CS1 | Certificates | Seller | 5 | 10, 13 | P0 | List per type, two separate statuses, "what you can't offer yet" |
| CS2 | Add a certificate | Seller | 5 | 10, 11 | P0 | Choose a type among the Market's active types |
| CS3 | Certificate details (form) | Seller | 5, 8 | 10, 11, 21 | P0 | Type-driven fields, upload, draft, correction, renewal. Four steps |
| CS4 | Review before you submit | Seller | 5 | 10, 11 | P0 | Summary of every value and file; submit |
| CS5 | Certificate status page | Seller | 5, 7, 9 | 13, 14, 15, 16 | P0 | One page for every status of CD 3.3, including "awaiting review" |
| CS6 | My issuer isn't listed | Seller | 6 | 11 | P0 (team proposal) | Request with files; typed name is request text only |
| CS7 | AI help in the form (AIS-02) | Seller | 16 | 26 to 28 | Optional | Not a page: states inside CS3 (3.1) |
| CA1 | Certificate queue | Admin | 7 | 13, 17 | P0 | Renewals first; certificates and issuer requests are two tabs |
| CA2 | Review a certificate | Admin | 7 | 13, 14, 21 to 23 | P0 | Document, checks, decision; the decision is a person's (R2) |
| CA3 | Certificate record (history) | Admin | 11 | 16, 22 | P0 launch | Status history, revoke; same page as CA2 once decided |
| CA4 | Certificate types | Admin | 12 | 3, 4 | P0 | List and form with versions |
| CA5 | Issuer registry | Admin | 12 | 11, 19 | P0 | List, form, the two deactivation forms |
| CA6 | Issuer requests | Admin | 6 | 11 | P0 (team proposal) | Answer without copying the typed name |
| CA7 | Manufacturer certificates | Admin | 14, 15 | 6, 20 | P0 build, off in AU | List, form with coverage, another-person rule |
| CA8 | Claim basis policy | Admin | 13 | 4, 5 | P0 build, off in AU | Rows per type, versions |
| CA9 | Expiry and warnings (read-only panel inside CA1, CA7) | Admin | 9 | 8, 9 | P0 | Filter "Expiring" and "Expired" |
| CB1 | Certificate badge (`CertChip`) | Buyer, seller, admin | 10 | 23 | P0 | Built only from badge data |
| CB2 | Badge detail (`CertDetail`) | Buyer, seller, admin | 10 | 23 | P0 | Popover on wide screens, sheet below 480 px |
| CB3 | Certificate filter (CERT-23) | Buyer | Phase 6 | n/a | P0 | Options from the Market's types |

Offer-level views (the "Certificate badges" card on an Offer, the per-Offer attestation line) belong to
`catalog`'s screens; 3.9 specifies the certification parts they must reuse.

Dialogs: **DG1** Leave without saving (reuses ID-UX B3; listed for completeness); **DG2** Save and withdraw
your submission; **DG3** Withdraw submission; **DG4** Approve; **DG5** Request changes; **DG6** Decline;
**DG7** Revoke; **DG8** Deactivate issuer (two forms); **DG9** Suspend manufacturer certificate.
Type save confirmation (with the product count) is a `Dialog` frame inside CA4 (DG10, section 3.5).

### 1.2 Emails
Text templates outside Figma; prefix `certification.mail.`; sent to the Seller Owner's **sign-in** address
through `identity`'s contact point (CD 12). Layout and rules as ID-UX 3.4. **No email carries a certificate
number, a holder name, an issuer's contact, a file or a review time**; reasons are the prepared reason's text
(plus optional text) as the seller reads it on CS5.

| ID | Email | Trigger (CD 8.3) |
|---|---|---|
| EM1 | Your certificate was approved | `seller-certification-approved` (kind initial, resubmission, renewal change the second sentence) |
| EM2 | Your certificate needs changes (reason, next step) | `-changes-requested` |
| EM3 | Your certificate wasn't accepted (reason) | `-declined` |
| EM4 | Your certificate expires in {n} days (30, 14, 1; consequence and "submit by" date) | `-expiry-warning-due` |
| EM5 | Your certificate has expired | `-expired` |
| EM6 | Your certificate was revoked (reason) | `-revoked` |
| EM7 | {issuerName} is no longer recognised (why, what to do), one per affected seller | `issuer-deactivated` with `derecognised` |
| EM8 | Answer to your issuer request | `issuer-request-answered` |
| EM9 | To reviewers: a certificate is waiting (no seller name, no values; coalesced to one per Market per hour) | `-submitted` |
| EM10 | To Offer owners: a manufacturer certificate covering your product expires in {n} days | `product-certification-expiry-warning-due` through `catalog` (request C-6; the template is `catalog`'s, listed so the words match) |

Submitting a certificate sends **no** email to the seller; CS5 is the confirmation (same rule as SL-UX F13 step 7).

### 1.3 Not designed, and why
- **Admin creating, editing or submitting a seller's certificate.** Forbidden (brief s5; CD 3.1). In an acting-as
  session CS1 to CS6 are read-only with the banner of 3.0 rule 9.
- **A consent screen for AI.** The owner chose option C of Q4: AI is off for a new seller until an admin switches it
  on. There is no seller consent flow and no notice screen; the sellers module owns the switch (SL-UX C1).
- **Review-time promise, queue position, "reviewed by {name}".** None (7.1).
- **Scope enforcement UI.** The system does not enforce scope (Q5). The reviewer records location and scope as
  read; nothing on an Offer or badge shows them.
- **Public certificate number, holder name or file.** Never public (CD 4.5).
- **Kosher and Vegan seller screens.** Types are data. They are inactive in AU at launch (Q1); no screen is
  special-cased. The `SELF_DECLARATION` form variant is designed (3.1) because the ZZ fixture and the model need it.
- **Product-level certificate by a seller (CERT-47).** P1, not in this module's slices.
- **Mobile navigation (D16).** Still undesigned; admin pages and the seller certificate pages wait for it on phones (6).
- **Notification centre.** Mail is the only channel until `notifications` (Phase 6).

### 1.4 Changes this spec makes to approved documents
Recorded so Jafar and the owners can accept or refuse them.
1. **SL-UX S1 slot.** The certificate slot on S1 gains real rows: "Certificates (not needed to submit)" opens CS1.
   Each type row shows the certificate's own status word from 3.3, never the seller badge.
2. **`Admin · Certificate review` template.** The existing template (README) is **revised**, not reused: the
   brief s12 list applies (checks are the Market's named list; no automatic checks except deterministic ones;
   no score or "all clear" text; a "not checked" list; the full page works without the AI section).
3. **`Admin · Sellers` column.** The "Certificate type" column of SL-UX P1 is composed by the panel from
   `sellerCertificateOverview`; it shows `CertChip`-style text chips of **status only** (not a badge): "Halal:
   valid" or "Halal: awaiting review". It never uses the buyer badge, because a status is not a claim.

## 2. Flows

### FL1. Add a certificate and submit (Seller Owner or Staff with `own-certificate.manage`; brief 4-A; CD 3.1, 3.2)
| # | Step | Failure or branch: code and what the user sees |
|---|---|---|
| 1 | CS1 "Add a certificate" opens CS2. Entry points: the S1 step (limited shell, seller not yet approved), the Certificates menu item (approved sellers), "Add a {type} certificate" in the "can't offer yet" card | A type with a non-terminal certificate is not offered; its row says "You already have a {type} certificate. Open it." (`certificate.exists-for-type`). A `declined` or `revoked` certificate does not block a new one |
| 2 | CS2: one choice among active types of the Market (`certificationTypes`). The type description is the admin-written text of the published revision. "Next" | `type.inactive` (race): "{type} certificates can't be added now." and the list refreshes. No active type: "No certificate types are open for new certificates." |
| 3 | CS3 step 1 "Certificate details": fields come from the type revision's form settings: issuer (searchable list of **active** issuers of the type), certificate number, issue date, expiry date (when `requiresExpiry`). `SELF_DECLARATION` types show the tick and an optional note instead (3.1). "Save draft" is explicit | `issuer.not-active`; `certificate.already-expired` ("This certificate has already expired. Add a current one."); `seller.zone-missing` (blocks submit only; the reason links to SL-UX S3). A listed issuer missing: link "My issuer isn't listed" to FL2. **No active issuer for the type (the AU state at launch until the owner supplies the expert list):** the issuer field is replaced by `form.issuer.empty` ("No issuers are available yet. We'll email you when you can add this certificate."), the draft can be saved, submit is blocked, and no review time is named |
| 4 | Step 2 "Documents": upload (3.1 upload spec). A submission can hold several pages or photos | Each file shows its own state and refusal code (`file.*`); submit stays blocked while any file is not Ready |
| 5 | Step 3 (only when AI is on for the seller): "Fill from document" (3.1 CS7); skipped silently otherwise. The step list shows 3 steps then, not 4 | AI states never block (3.1) |
| 6 | Step "Review": CS4 summary; "Submit for review" | `file.*` not clean; `issuer.not-active`; `certificate.already-expired`; `seller.zone-missing`; `request.throttled` or the daily limit ("You've reached today's limit for submissions of this certificate. Try again later.", 5 per 24 hours, proposal); `access.acting-as-refused` in acting-as (every seller certificate action returns it; the panel shows the acting-as banner, `error.access.acting-as-refused`: "This can't be done while you're signed in as the seller.") |
| 7 | Done: CS5 "Awaiting review" and "Submitted on {dateTime}" in the seller's work time zone, named. No email. Reviewers are told (EM9) | Status unreadable: inline error with "Try again" |

Rules: one explicit save per step; a failed save keeps the typed text; leaving with unsaved changes asks first
(DG1). The draft **is** saved on the server (it is a record), but the form's unsaved text lives **in memory only**: nothing is written to
localStorage, sessionStorage, IndexedDB or a service-worker cache, and every response that carries decrypted
certificate data is `Cache-Control: no-store` (CD 10.3). Uploaded files are held server-side from the moment they
arrive; the page shows them again after a reload. No wording about how long a draft or file is kept (7.2).

### FL2. Issuer isn't listed (brief 4-A step 3; CD 2.1 `IssuerRequest`)
| # | Step | Branch |
|---|---|---|
| 1 | CS6 from the issuer field: typed issuer name (plain text), one or more files, a note field. "Send request" | `request.throttled` (3 per 24 hours); `file.*` per file; no `issuer.*` code can arise from the typed name |
| 2 | The certificate stays `draft-issuer-not-listed`: CS5 says "We're checking your issuer. We'll email you with the answer." and the submit step is blocked, with no review time named | Seller can send a second request only after the first is answered |
| 3 | Answer arrives (EM8). Added: the issuer appears in the list and the draft is usable; the seller **chooses** it from the list (it is never filled in for them). Not accepted: the reason text and "Choose a certificate from a different issuer" | |

### FL3. Awaiting review, edit, withdraw (brief 4-A step 7 and the status table; CD 3.2 row 2)
| # | Step | Branch |
|---|---|---|
| 1 | CS5 in `awaiting-review` shows the submitted values read-only and what happens next (3.2). The primary action is none. Secondary: "Edit certificate" and "Withdraw submission" | Not allowed without `.manage`: both disabled with "You can view certificates but not change them. Ask your shop owner." (`view-only.ask-owner`; the same text on every seller control that needs `.manage`) |
| 2 | "Edit certificate" opens CS3 with a top `InfoBanner` (Attention): editing a field the submission holds withdraws it. "Save and continue" on a **changed** value opens DG2 ("Save and withdraw your submission?"). An unchanged step saves nothing and shows no dialog | Cancel keeps the typed text |
| 3 | After DG2 the certificate goes to `draft` (when never approved), or stays `approved` with the renewal withdrawn (the valid certificate is untouched) | The reviewer who has the page open sees "This was replaced while you reviewed" (CA2) |
| 4 | "Withdraw submission" opens DG3 | `conflict.stale`: the page refreshes and says what changed |

### FL4. Warning, expiry, renewal (brief 4-C; CERT-14, CERT-15; CD 2.4, 3.3)
| # | Step | Branch |
|---|---|---|
| 1 | At 30, 14 and 1 days the seller gets EM4 and sees the matching banner on CS1 and CS5 (3.2: `approved-expiring`). The banner gives the consequence and the `submitBy` date | No warning for a type without expiry |
| 2 | "Renew" opens CS3 prefilled from the approved submission (nothing already given is asked again, WCAG 3.3.7); the seller changes dates, number and files. The submission is `renewal`; the approved one stays valid | `certificate.already-expired` for a renewal that is itself expired |
| 3 | After the boundary (00:00 the day after the expiry date in the seller's zone) the page shows `expired` **whether or not the job has run**: the status is computed from validity, never from the stored `expired` value (CD 2.4 rule 4, AC 8). Per CERT-15 the whole Offer goes off sale (not deleted): it stays in the seller's own list, marked off sale, until a renewal is approved. The page says "Offers with this badge are off sale until a renewal is approved." What customers see is left to `catalog`'s G2 and the storefront; this spec promises nothing about buyer visibility | A pending renewal: `expired-renewal-pending` |
| 4 | Renewal approved: status back to `approved`; EM1 | Renewal needs changes: `approved-renewal-changes-needed`; a correction submission is made the same way |
| 5 | No grace period is offered anywhere, and no screen suggests one | |

### FL5. Reviewer queue and one decision (brief 4-B; CD 3.2)
| # | Step | Branch |
|---|---|---|
| 1 | CA1 opens on "Awaiting review". Order is fixed: renewals first, then oldest first. The sort is not a control. Rows belong to sellers in any seller state (CERT-12); the row shows the seller state separately | View-only (`.view` only): row actions disabled with the reason, clear fields only |
| 2 | "Review" opens CA2 for the pending submission | Withdrawn meanwhile: CA2 shows "This submission was withdrawn" and a link back; no actions |
| 3 | The reviewer reads the document (viewer, audited), the seller's business details beside it, the seller's entered values, the issuer and its state, history. Records each named check (Done, Problem, Not applicable), records location and scope **as read**, and optionally records an issuer confirmation | Lost network on a check: the row returns to its old value and shows the error |
| 4 | Decision: **Approve** (DG4), **Request changes** (DG5) or **Decline** (DG6). Enabled only per the API's allowed-actions; a disabled button names the missing item as text beside it | `review.checks-missing`; `review.issuer-not-accepting`; `review.not-current-submission`; `seller.zone-missing`; `certificate.already-expired` (the boundary passed while the page was open); documents not clean; `conflict.stale` |
| 5 | Toast ("Certificate approved. We've emailed the seller.") and back to CA1 on the same tab and page | Failure: error banner on CA2, nothing recorded |

No screen, label or order in CA1 or CA2 is driven by AI output (R2). The decision buttons never sit inside or next to the
AI section and are never pre-selected.

### FL6. Revoke (CERT-16; CD 3.1)
CA3 (or CA2 in its decided state) shows "Revoke certificate" for an `approved` or `expired` record to a holder of
`seller-certificate.revoke`. DG7 requires a prepared reason and shows the consequence. A pending submission is withdrawn
in the same action and DG7 says so. After: status `revoked` (terminal), EM6, toast.

### FL7. Types, issuers, issuer requests (brief 4-D; CD 3.5, 3.6)
| # | Step | Branch |
|---|---|---|
| 1 | CA4: edit a type; "Save" opens DG10 stating "This creates revision {n}. Certificates already approved keep the rules they were approved under." and, when claim terms changed, the number of published products whose text would match (`catalog` endpoint, request C-7). Confirm publishes | The count cannot be loaded: "We couldn't count the affected products. You can still save." with Attention tone, never a silent zero |
| 2 | CA5: add an issuer (state `proposed`); "Activate" needs the expert-approval reference (who confirmed, when, a reference). Two deactivation forms through DG8 | `issuer.expert-reference-required`; derecognise names the number of approved certificates affected |
| 3 | CA6: open a request, read the typed text and files, then answer: "Issuer added" (choose an **existing** registry issuer; the request text is never copied into the issuer form) or "Not accepted" (prepared reason). EM8 | An unlisted selection is impossible by construction |

### FL8. Manufacturer certificate and policy (brief 4-E; CD 3.4, 3.7)
| # | Step | Branch |
|---|---|---|
| 1 | CA7: an admin records the certificate: manufacturer, type, issuer, number, dates, files, **explicit coverage list** (never "brand") | `product.not-found` per id from `CatalogReferences` |
| 2 | Submit for review. Another person approves: the page for the person who created or edited any part of it shows Approve disabled with "You worked on this record. Another person has to approve it." (`review.not-another-person`) | Until such a person exists the record stays "Awaiting review" and the page says this basis isn't active |
| 3 | An edit of an approved certificate (coverage, dates, files) creates a **pending revision**; the approved revision and its coverage stay live; the page shows both. "Suspend" stops it at once (DG9) | `file.change-pending`: "A change is already waiting. Decide it first." |
| 4 | CA8: per type, rows `{category or handling} -> basis`; Save creates a new revision published at once | Orphaned rows (category retired) are flagged "This category was retired. Check this rule." and never rewritten automatically |

## 3. Screen specifications

### 3.0 Rules for every screen
1. **Shells.** Seller pages use the seller shell; before approval they sit in the **limited shell** of ID-UX F5
   (these are among the pages the limited sign-in allows, I-1). Admin pages use the admin shell. `Sidebar` and
   `Topbar` stay instances.
2. **Two statuses, never merged (CERT-12).** Wherever a certificate and its seller both appear, the seller's
   access state is a `StatusBadge` with the words of SL-UX 3.3 (the seller's own "Approved" reads "Seller
   approved" beside a certificate) and the certificate uses the words of 3.2 below. A certificate status is never
   styled as a seller state and the reverse.
3. **Step pages** follow SL-UX 3.0 rule 2: back link, H1, "Step {n} of {total}" as words, cards, `FormActionBar`
   (sticky below 760 px), form column at most `size/form-max`.
4. **Validation, loading, errors** follow ID-UX 3.0 rules 3 and 4 and SL-UX 3.0 rule 3: error summary takes focus,
   field errors are icon plus text, the primary button shows `State=Loading` at the same width, lists load as 8
   skeleton rows, no page spinner.
5. **Market-driven content.** Type names, descriptions, claim terms, issuer names, form settings, review checks,
   prepared reasons, file limits, warning thresholds and the `submitBy` offset all arrive from the API as data or
   translation keys the Market owns. The frontend has no type list, no issuer, no `halal`, no `AU`, no country
   name. Examples show AU values only because AU is the launch Market.
6. **Never, on any screen:** the word "verified" in any form about a certificate, issuer or seller (legal approval
   is pending, brief s12); a religious ruling of any kind (R13): no "permissible", "approved as halal",
   "guaranteed", "compliant", "authentic" and no sentence about whether a product is acceptable; a certificate
   number, holder name, file or reviewer name on a buyer-facing surface; a server message string; model output as
   a status, badge word, reason or decision input (R1, R2); a review-time promise.
7. **Permissions in the UI** follow ID-UX 3.0 rule 6 and SL-UX 3.0 rule 6: no View, no menu item, B5 on the URL; View
   without the action, the control is disabled and states its reason as text. The panel renders the **allowed-actions
   list and denial codes the API supplies** and never infers a permission.
8. **Dates and times.** An expiry or issue date is a **date without a time** (`PlainDate`): format it with
   `Intl` in the page locale and **never convert it through a time zone**. Where the end of validity matters the
   sentence names the zone: "Valid until the end of {date}, {zoneName} time". Times that belong to a seller
   (submitted, decided, warning) use the seller's work time zone, named, for the seller and for admins alike
   (SL-UX 3.0 rule 8). A manufacturer certificate is measured in the **Market's** zone, named. Zone names use
   `Intl` in the page locale. No raw `Date` arithmetic in the frontend for deadlines; "{n} days left" comes from
   the API (`daysLeft`) or is shown only as the date.
9. **Acting-as.** In a "Login as Seller" session **every** seller certificate action is refused (create, save draft,
   upload, remove, submit, withdraw, renew, issuer request, AI). CS1 to CS6 render read-only with an Attention banner
   "You're signed in as this seller. Certificates are added by the shop owner or staff." and a link "Back to admin" (`acting-as.back`, to the seller's admin page), and no AI; acting buttons are absent, not disabled.
13. **Two-person changes (Ali, Hassan).** On CA4 and CA8 a change that **relaxes** a type setting or a policy row, and **reactivating a
    type**, is not applied on save: it becomes a **proposal** in state "Waiting for a second admin" showing who proposed it and when,
    with a diff against the live revision. A **different** admin sees "Approve change" and "Reject change"; the proposer sees both
    disabled with "Another admin has to decide this." Tightening changes apply at once. The API says which kind a save is
    (`change.kind`); the panel never decides. `verificationMode` cannot be changed on an existing type code (read-only with "To change
    this, add a new type."). `product-certificate.approve` is a **protected action**: CA7 Approve, Reject and Reinstate may ask "Confirm it's
    you" (SL-UX D9) first.
10. **Money.** None on these screens.
11. **Plain text.** Every free-text field shows what was typed, with the line "Plain text only." and
    `dir="auto"`. Reasons, notes, typed issuer names and scope text are rendered inert (no links, no HTML).
12. **Disabled controls stay focusable when they give a reason** (SL-UX 6).

### 3.1 Seller panel
| Screen and purpose | Content, top to bottom | Fields, validation, actions | States | Never shown |
|---|---|---|---|---|
| **CS1 Certificates.** What the seller holds and what is missing | H1 "Certificates". A line "Your seller account: {StatusBadge}" with link to S1 (the other status, separate). Card "Your certificates": one row per record: type name, certificate `StatusBadge` (3.2), issuer name, "Valid until {date}" or "Submit by {submitBy}" (`DeadlineBadge` for the thresholds), primary row action by status ("Continue", "Renew", "Open"). Card "What you can't offer yet" (approved sellers only): per **active** type without a valid certificate: "You can't add the {type} badge to offers until a {type} certificate is approved." with "Add a {type} certificate". `InfoBanner` Info under the H1 for `approved-expiring`, Attention at 14 days, Critical at 1 day or `expired` | "Add a certificate" (primary, top right). Row actions come from the API's allowed-actions. Rows sort: needs attention first (expired, expiring, changes needed), then the rest | Skeleton rows; empty ("You haven't added a certificate yet. Add one to use certificate badges on your offers. You don't need one to submit your seller application."); load error with "Try again"; acting-as; view-only; no view: B5; one row for each of the 13 statuses (3.2) | Other sellers' data; the seller's access state as a certificate status; a review time; inactive types (no row, no "add") |
| **CS2 Add a certificate** | Back link; H1 "Add a certificate"; step counter "Step 1 of {total}"; a `RadioGroup` of cards: type name, one-line description, "{documents needed}" summary built from the form settings (issuer, number, dates, document) | One required choice. "Next" | Default; one type only (preselected, still confirmed); no active type; type deactivated meanwhile (`type.inactive`); load error | Inactive types; a type the seller can't claim for any reason is still listed (the form explains) |
| **CS3 Certificate details (form).** Four steps, three when AI is off or on never | Step 1 "Certificate details": **Issuer** (`Select` Searchable, active issuers of the type; help "Choose the body named on your certificate."; link "My issuer isn't listed"), **Certificate number** (`dir="ltr"`, `autocomplete="off"`), **Issue date**, **Expiry date** (`DateField`; help "The last day the certificate is valid."), the line "We'll measure the expiry in your work time zone: {zoneName}." For `SELF_DECLARATION`: one `Checkbox` with the type's declaration text (admin-written, from the revision) and an optional note, and a `InfoBanner` Info "This will show as a seller's claim, not a certificate." Step 2 "Documents": **upload** (below). Step 3 "Fill from document" (only when AI is on). Last step "Review" is CS4 | Required fields from the form settings. Dates: expiry after issue; expiry not already past in the seller's zone (`certificate.already-expired`). Draft: "Save draft" on every step, explicit; status text "Draft saved" / "Unsaved changes". **Correction** (after `changes-needed`): a `ReasonQuote` card at the top with the reason text and next step, fields prefilled with the submitted values. **Renewal**: prefilled; banner "Your current certificate stays valid until {date}. A renewal doesn't extend it until it's approved." | Default; dirty; saving; saved; field errors; error summary; `issuer.not-active`; load error; withdraw-warning banner (FL3); acting-as; view-only; session ended (typed text lost, saved draft kept) | The type chosen by anyone but the seller; an AI-chosen type, tick or attestation (R14); the issuer prefilled from typed text |
| **Upload (inside CS3 step 2)** | Heading "Documents"; help from the Market's limits: "JPEG, PNG, HEIC or PDF. Up to {maxSize} per file, {maxFiles} files, {maxPages} pages per PDF." (all values from the API). Launch values (Market data, shown from the API, never hardcoded): 10 MiB per file, 10 files, 20 pages per PDF, 40 megapixels per image, 200 MiB of drafts per seller; a "Used {used} of {quota}" line appears at 80% of the draft quota. A drop area plus a "Choose files" button (works with the phone camera and gallery; `accept` lists the four types; no forced `capture`). A list of `UploadItem`s | Multiple files; each file shows its name **chosen by the seller on screen only** (never stored; the server-made label is "Page {n}"), size, a thumbnail when Ready and "Remove". "Replace" on a refused file. Reorder with keyboard-operable "Move up" and "Move down". Preview opens `DocumentViewer`. Quota: 30 files per 24 hours, 10 for a not-yet-approved seller (proposal): `request.throttled` or the daily text | Per file: **Uploading** (progress as text and `<progress>`), **Checking** ("Checking this file…", `role="status"`), **Ready** (thumbnail), **Refused** (Critical, code text, "Replace"), **Removed**. Whole area: empty; at the file-count limit (the button is disabled with the reason); offline. **A file refused as malware or unsafe (`file.malware`, `file.active-content`) has no thumbnail, no preview and no viewer link, ever.** HEIC may be refused with `file.heic-unsupported` ("Convert it to JPEG"; Hadi's copy, depends on the HEIC spike, 7). Previews are server-made PNG only; the UI never renders user bytes inline and an original is only an attachment download. Quota full: `file.draft-quota` . Refusal texts: `file.type-not-allowed`, `file.encrypted-pdf`, `file.active-content`, `file.malware`, `file.scan-failed`, `file.too-large`, `file.too-many-pages` (section 5) | The original bytes inline (previews are server-made PNG only); EXIF or location; file names from the client |
| **CS7 AI help (AIS-02)** inside CS3 | Only when the capability is on for this seller and Market. Button "Fill from document" under the upload list. After it runs, each field shows a `SuggestionField` (`ExtractedField` Mode=Suggestion): the suggested value as plain text, a text-and-icon mark "AI suggestion", and three actions: "Use", "Edit", "Not this". No "accept all" | Suggested issuer only from the registry list, or "No listed issuer found in the document". Dates as dates. The type, the declaration tick and attestations are never suggested. Uncertainty is one word from a fixed list (for example "Unsure"). Each field keeps its provenance (manual, AI suggestion accepted, AI suggestion edited), shown to the reviewer | **Reading** ("Reading your document…", status, form stays usable); **Could not read** ("We couldn't read this document. Fill in the form yourself."); **Partly read** ("We could only read some fields. Check each one."); **Limit reached** ("AI help has reached its limit for today. Fill in the form yourself."); **Off** (no button; if a call returns off: "AI help isn't available. Fill in the form yourself."). None of them blocks upload, save or submit | A model sentence outside a field; any claim about validity, authenticity or "looks fine"; AI before approval unless an admin switched it on (it is off by default for new sellers); a per-seller consent screen |
| **CS4 Review before you submit** | H1 "Review your certificate"; `InfoBanner` Info "MondaPac reviews this certificate before you can use it on offers. You'll get an email when there's a decision."; `DataRow`s (Layout=Single): type, issuer, number, issue and expiry dates (with zone line), each document as a thumbnail row, each with an "Edit" link; **Missing** and **Blocked** states as in SL-UX S6; for AI-filled fields an "AI suggestion, used" or "AI suggestion, edited" text | "Submit for review" (renewal: "Submit renewal"; correction: "Submit again"). Disabled with reason text "Finish {n} items first" linking to the first | Default; submitting; each refusal code of FL1 step 6; success moves to CS5 | Reviewer information; internal checks |
| **CS5 Certificate status page.** The one page for every status | H1 "{typeName} certificate"; `StatusBadge` (3.2). A status card with the title and body for the status (3.2). `ReasonQuote` for `changes-needed`, `declined`, `revoked`. Submitted values as `DataRow`s (read-only). `TimelineItem` list "History" (minimal: status, reason, date; full history is admin-only). A "Before the badge works" `InfoBanner` Info for `awaiting-review`: no promise (below). **Seller state** line "Your seller account: {StatusBadge}" separate | Actions by status from the allowed-actions: Continue, Edit, Withdraw, Renew, Correct and resubmit, Add a replacement. **`awaiting-review` text (final wording, no time):** title "We're reviewing your certificate"; body "We'll email you when there's a decision. Until then you can't use this certificate on offers. If you change anything you submitted, your submission is withdrawn and you'll need to submit again." No countdown, no "usually", no "within". The seller never sees queue position or reviewer | Skeleton; load error; each of 13 statuses; **seller not approved yet** (a note "This certificate can be reviewed now. It has no effect until your seller application is approved."); acting-as; view-only | A review time; a position; reviewer or check detail; the certificate number of another seller; a file of an expired submission as a download (previews of own documents only) |
| **CS6 My issuer isn't listed** | H1; `InfoBanner` Info "Tell us who issued your certificate and add the document. We'll check the issuer and email you. We can't promise when."; **Issuer name** (plain text, "As written on your certificate"); **Documents** (same upload); **Note** (optional); the line "This doesn't change your certificate form. You'll choose the issuer from the list once it's added." | "Send request". Typed name is request text only | Default; sending; sent (the certificate row says "Checking your issuer"); `request.throttled`; one request open per certificate; load error | A suggestion to use the typed name; any "we'll add it" promise |

### 3.2 Seller-facing certificate statuses (CD 3.3 mapped to words)
English is panel text; Persian terms are the brief's status table where it has one; legal reads the final wording (L).
Badge = icon + word, never colour alone. Certificate statuses use `StatusBadge` with the icons below; none of
them reuses a seller-state word on its own ("Approved" is always "Certificate approved" in text outside the badge).

| Code | Badge (en-AU) | Persian (brief s4) | Tone, icon | CS5 title; body; actions |
|---|---|---|---|---|
| `draft` | Draft | پیش‌نویس | Neutral, `pencil` | "Finish your certificate"; "Add the details and documents, then submit it for review."; Continue |
| `draft-issuer-not-listed` | Checking your issuer | پیش‌نویس، صادرکننده در فهرست نیست | Info, `clock` | "We're checking your issuer"; "We'll email you with the answer. You can't submit this certificate until then."; View request |
| `awaiting-review` | Awaiting review | در انتظار بازبینی | Info, `clock` | See CS5 above; Edit, Withdraw |
| `changes-needed` | Changes needed | نیاز به اصلاح | Attention, `alert-circle` | "Your certificate needs changes"; reason and next step; Correct and submit again |
| `declined` | Not accepted | رد نهایی | Critical, `x` | "We couldn't accept this certificate"; reason; "You can't send this certificate again. You can add a different one."; Add a certificate |
| `approved` | Certificate approved | تأییدشده | Success, `check` | "Your certificate is approved"; "You can add the {type} badge to your offers."; Renew |
| `approved-expiring` | Expires soon | تأییدشده، رو به انقضا | Attention (Critical at 1 day), `clock` | "Your certificate expires on {date}"; "After the end of {date}, {zone} time, offers with this badge can't be bought until a renewal is approved. Submit your renewal by {submitBy}."; Renew |
| `approved-renewal-pending` | Renewal awaiting review | تأییدشده، تمدید در انتظار بازبینی | Info, `clock` | "Your renewal is being reviewed"; "Your current certificate stays valid until {date}. We'll email you when there's a decision."; View both |
| `approved-renewal-changes-needed` | Renewal needs changes | تأییدشده، تمدید نیاز به اصلاح دارد | Attention, `alert-circle` | Reason; "Your current certificate stays valid until {date} only."; Correct and submit again |
| `expired` | Expired | منقضی | Critical, `ban` | "Your certificate has expired"; "Offers with this badge can't be bought until a renewal is approved."; Renew |
| `expired-renewal-pending` | Expired, renewal awaiting review | منقضی، تمدید در انتظار بازبینی | Critical, `clock` | "Your renewal is being reviewed"; "Offers with this badge can't be bought until it's approved."; View |
| `revoked` | Revoked | لغوشده | Critical, `ban` | "MondaPac revoked this certificate"; reason; "Offers with this badge can't be bought. You can add a new certificate."; Add a certificate |
| `issuer-not-recognised` | Issuer not recognised | (not in the brief; Q6) | Critical, `alert-circle` | "{issuer} is no longer recognised by MondaPac"; "This certificate no longer counts, so offers with this badge can't be bought. Submit a certificate from a recognised issuer."; Submit a replacement (a renewal-kind submission) |
| (none) "type deactivated" | not a status | (not a status, CERT-03) | n/a | An existing certificate stays as is; "Add" is hidden for the type. A **renewal** of an existing certificate of a deactivated type stays possible (CD 19.2 item 4) |

The seller sees the **certificate** words above next to the seller state, in two separate badges. `expired` is
computed (CD 2.4), so a certificate past its boundary shows Expired even if the job has not run.

### 3.3 Admin panel
| Screen and purpose | Content, top to bottom | Fields, validation, actions | States | Never shown |
|---|---|---|---|---|
| **CA1 Certificate queue** (template `Admin · Certificate queue`, from `Admin · Sellers`) | Title "Certificates" with count and Market name. Tabs with counts: **Awaiting review** (default), **Changes needed**, **Approved**, **Expiring**, **Expired**, **Declined or revoked**, **Manufacturer** (CA7 link), **Issuer requests** (CA6 link), **All**. `FilterChip`s: Type, Kind (New, Resubmission, Renewal). Columns: Seller (the **public store name, or "Not yet approved" with the seller id**, read per page through `sellerSummaries`; the seller state `StatusBadge` beneath), Type, Kind, Issuer, Expires (`DeadlineBadge`, with the seller-zone date), Waiting since (**admin-only: queue time never appears on any seller screen or email; add a test that CS1 to CS6 and every seller email carry no queue time or position**), Actions. No score, no AI column | Row action "Review" (needs `.review`; `.view` alone sees clear fields only) or "Open". Order fixed: renewals, then oldest first. Search is a POST body, never in the URL | Skeleton rows; empty per tab ("No certificates are waiting. You're up to date."); load error with "Try again"; view-only; a row whose decision is under way shows "Decision being recorded" | Certificate number, holder name, files, reasons in a row |
| **CA2 Review a certificate** (template `Admin · Certificate review`, revised) | **Summary bar:** store name, type, kind `Badge`, "Submission {n}", submitted date and time (seller's zone), time in the queue, two separate badges "Certificate: Awaiting review" and "Seller: {state}". Actions **Approve**, **Request changes**, **Decline** (each disabled with a reason text when the API says so; none preselected). **Main column:** (1) `DocumentViewer` with the pages, "Viewing documents is recorded." line, "Download original" for `document.view` holders only; (2) **Seller's business details** (`DataRow`s from `reviewerBusinessDetails`: legal name, trading name, operating address, registered address when given), headed "From the seller's application"; (3) **Submitted values** (`DataRow` Single: issuer, number, issue and expiry dates with the zone line "{date}, {zoneName} time", provenance marks for AI-filled fields); (4) **Issuer** (name, `Badge` of its state, accreditation reference; `closed-to-new` shows an Attention banner "This issuer isn't taking new certificates. Request changes or decline." and `derecognised` shows Critical); (5) **Checks** (below); (6) **Location and scope as read**; (7) **Issuer confirmation**; (8) **Possible duplicates**; (9) **Read from document** (AIA-01, only when on); (10) **History** (`TimelineItem`). **Side column:** statuses, seller zone, kind, for a renewal the **current approved expiry**, seller approved or not | **Checks** (`CheckboxRow Mode=Result`): the Market's named list with a "Required" `Badge`; each has Done, Problem, Not applicable (a `SegmentedControl`), recorded by and when; saving one check is immediate (`State=Saving`); re-recording replaces and is shown as "Changed from {old} by {name}"; each check shows the **latest result** with an expandable "Earlier results" list (result, who, when). **Location and scope:** two required text areas for `THIRD_PARTY_DOCUMENT` types, "Write them as they appear on the certificate. Plain text only."; **Issuer confirmation:** `Select` of the issuer's **registered** channels only (email domain, phone, web page; no free typing of a channel), date, an encrypted reference field ("Where the confirmation is kept"), and two required ticks "Confirms this certificate number" and "Confirms this holder"; a line "Only record a confirmation the issuer sent you through one of its registered contacts. Don't use a contact the seller gave you."; result: "Confirmed with the issuer" `Badge`, recorded on a pending or an approved submission (on an approved one it takes effect from then and is audited). **Possible duplicates:** "The same certificate number appears on another seller's certificate in this Market." and "The same document file appears on another seller's certificate." listed **one row per match** with its kind (same number, same file), the other seller's **public store name or "Not yet approved"**, and an access-checked link to that certificate; opening a link is recorded ("Opening this is recorded."); "This is a hint. It doesn't stop a decision." **The hint never appears on any seller screen, not even as a count** **Read from document:** per field one state from a fixed list (Same, Different, Not found, Unreadable) with the read value as a quotation, **no sentence, no score, no "all clear"**, a fixed list "Not checked by this reading: authenticity, seal, issuer enquiry", a mark "Filled by AI, used as it was" for fields the seller accepted unchanged (in which case Same is not shown); when AI is off for this seller, the whole section is replaced by one line "AI reading isn't on for this seller. The review is the same." | Default; document loading; document refused or not clean (Approve disabled); load error; **replaced while you reviewed** (`review.not-current-submission`: "This was replaced while you reviewed. Open the current submission." with a link; all actions disabled); **withdrawn**; **decision under way**; view-only (`.view`: the page is not available, B5, because it decrypts); review without approve (`.review` only: checks recordable, decision buttons disabled with "Your role can't decide certificates."); `conflict.stale` | Raw document metadata or EXIF; AI recommendation, ranking, colour, or any text that reads as approval; a reviewer name to the seller; a permission inferred client-side |
| **Approve disabled reasons (CA2)** | Text next to Approve, from the API's denial code: `review.checks-missing` ("Record {n} required checks first."), `review.issuer-not-accepting` ("This issuer isn't taking new certificates. Request changes or decline."), `review.not-current-submission`, `seller.zone-missing` ("The seller's time zone isn't set yet. Ask the seller to finish their address."), `certificate.already-expired` ("This certificate has expired. Request changes or decline."), `file.*` ("A document isn't ready."), location and scope missing ("Record the location and scope as read first.") | The reason is text, not a tooltip | | |
| **CA3 Certificate record** | The CA2 layout in decided state: values, checks as recorded, decision with reason and date; "Revoke certificate" for `approved` or `expired` (needs `.revoke`); full status history (`TimelineItem`, needs `document.view`; each read is recorded, "Viewing this is recorded." and a "Show history" step as SL-UX P2-H); a read of an earlier submission's reason | Revoke opens DG7 | Locked; loading; empty history ("No history yet."); no permission: tab hidden | Values without the "Show" step for history |
| **CA4 Certificate types** (list and form; template `Shared · Settings` form variant) | List: name, code, mode, status, published revision, issuers count. Form: **Code** (read-only after creation, `^[a-z][a-z0-9-]{1,31}$`), **Mode** (`THIRD_PARTY_DOCUMENT`, `SELF_DECLARATION`; chosen at creation, **read-only afterwards**), the four form switches (`SettingRow`s): needs issuer from the registry, needs a document, needs an expiry date, default basis (options "Seller certificate required" and "No badge allowed" only; the manufacturer option is **not offered** here); for `SELF_DECLARATION`: "Approve without a person" switch with the warning "These claims show as a seller's claim. No one reviews them." Per locale of the Market (`Tab`): **Name**, **Description for customers**, **Claim terms** (one phrase per row, plain text, "Words people use for this claim in product text. People write these. MondaPac doesn't generate them."), **Icon** (a picker over the design-system icon set; no uploads, no SVG). "Revisions" list with the revision number, date and author | Save opens DG10; a **relaxing** save (3.0 rule 13) says "This change needs a second admin. It isn't live yet." and creates a pending proposal card at the top of the page (proposer, date, diff, "Approve change" and "Reject change" for another admin, "Withdraw proposal" for the proposer). **Reactivating** a type is also a proposal. Activate and Deactivate each open a `Dialog` with consequences ("No new {type} certificates can be added. Existing certificates and badges stay."). Locales only from the Market's list. Plain text only | Loading; saving; saved Toast "Revision {n} published."; stale; inactive type badge; view-only; no view: B5 | A "delete"; an editable past revision; a manufacturer default |
| **CA5 Issuer registry** | List: issuer name, type, state `Badge` (Proposed, Active, Closed to new, Not recognised), accreditation reference, expert-approval reference present (yes or no), approved certificates count. Form: name (public, appears on badges: help "Customers see this name on badges."), accreditation number, **registered contact channels** (rows of channel kind and value; help "Reviewers use only these to confirm certificates."), **Expert approval** (confirmed by, date, reference; required to activate: "Add the expert's approval before activating this issuer.") | Actions by state: Activate (proposed, or re-open a closed-to-new issuer with a new reference; **reactivation is a pending proposal that another admin approves**, 3.0 rule 13, `review.second-admin-required`), "Stop new certificates" and "Stop recognising" through DG8. No delete | Loading; saving; stale; view-only; **seed issuers are `proposed` until the expert reference arrives** (banner: "No real certificate can be approved until an issuer is active.") | A delete; free-typed channels in a confirmation |
| **CA6 Issuer requests** | Tabs Open, Answered. List: seller (store name), type, date, file count. Detail: the typed issuer name as plain text under "Typed by the seller", the seller's note, document previews (`DocumentViewer`), the answer card | **Issuer added**: a required `Select` over the **existing** registry issuers of the type ("Choose the issuer you added to the registry. Add it in the registry first."), link to CA5; the typed name is **not** copied anywhere. **Not accepted**: required prepared reason. "Answer request" opens a `Dialog`. EM8 goes to the seller | Empty; loading; answered (read-only); `conflict.stale`; view-only | A button "Create issuer from this request"; the typed name inside the issuer form |
| **CA7 Manufacturer certificates** | List (status, manufacturer, type, issuer, expiry in the Market's zone named, covered products count, "Waiting for another person" mark). Page: values, `DocumentViewer`, **Coverage** (a `PickerList`: search products, chosen list with variant narrowing per product; never "all products of a brand"), checks as CA2, history; each covered product shows the **product revision it covers** and, when its material content changed after approval, a Critical mark "The product changed after this certificate was approved. Review the certificate again." (the certificate is suspended; Reinstate is a re-review); **Pending revision** card beside the approved revision when one exists | Approve (another person only: for any admin who created or edited the record, a file or the coverage the button is disabled with "You worked on this record. Another person has to approve it."), Reject (reason), "Suspend" (DG9), "Revoke" (DG7 variant), Reinstate (re-review by another person). Edits create a new pending revision. Banner by policy: "No category rule allows the manufacturer basis in {market} yet, so this certificate doesn't give any badge." when the policy has no `SELLER_OR_MANUFACTURER` row | Loading; saving; **no second person exists** ("This certificate is waiting for a reviewer who didn't work on it."); pending revision; suspended; expired; view-only | A claim of validity before approval; coverage by brand |
| **CA8 Claim basis policy** | Per type: the default row and a table of rows "{Category or handling} -> {basis}" with `Badge`s ("Seller certificate required", "Seller or manufacturer certificate", "No badge allowed"); revision list; a side note "If several rows apply, the strictest one counts." | Add row (category picker over platform categories, or handling `Select`: Sealed original, Repacked, Prepared, Fresh), change basis, remove row; "Save" shows a diff and creates a revision published at once (confirmation `Dialog`). Adding a `SELLER_OR_MANUFACTURER` row shows an Attention `InfoBanner` "Check that the halal authority and legal have approved the manufacturer basis before saving." (non-blocking; 7.5) | Orphaned category rows (Attention, "This category was retired. Check this rule."); **pending proposal** (a relaxing row change (3.0 rule 13) waits for a second admin; the live rows stay in force and are shown beside the proposal); stale; view-only. **Category in use:** each row has "Move to another category" (a policy edit, itself a proposal when it relaxes). Catalog refuses a category merge, archive or move while a policy row references it and shows `policy.category-blocked` with a link to this page filtered to those rows | A default of `SELLER_OR_MANUFACTURER` |

**Check list texts (Market data, AU; final wording is the Market's configuration, drafted here, L).**
| Check key | Text | Required |
|---|---|---|
| `holder` | The name on the certificate matches the seller's legal or trading name. | Yes |
| `location-scope` | The location and scope on the certificate fit this seller's business. | Yes |
| `issuer` | The issuer on the document is the issuer the seller chose. | Yes |
| `dates` | The dates on the document match the dates entered. | Yes |
| `tampering` | The document shows no signs of being altered. | Yes |
| `legibility` | The document is readable and in a language the reviewer can read. | Yes |
| `issuer-enquiry` | You asked the issuer about this certificate (record it under Issuer confirmation). | No |

The `tampering` text states what the reviewer looked for, not a finding about the seller. A `Problem` result is never shown to
the seller; the reason code is.

### 3.4 Dialogs
ID-UX 3.3 rules apply (title names action and object; destructive confirm opens with focus on Cancel; sheet
layout below 480 px; focus trap and return; no outside-click close while text is typed).
- **DG2 Save and withdraw your submission** (title, body and action keys in section 5; cancel keeps typed text).
- **DG3 Withdraw submission.** "It leaves MondaPac's review queue. Your details stay saved."
- **DG4 Approve.** Title "Approve submission {n}?"; body "{storeName} can add the {type} badge to offers. Offers waiting for this certificate are checked again."
  For a renewal: "This replaces the current certificate, which is valid until {date}." States the **named** submission and
  sends its version. No reason field. Failure: `review.not-current-submission` and the page-level message of CA2.
- **DG5 Request changes.** Required `Select` "Prepared reason" (Market list; each names the failed check and a next step), optional
  `Textarea` "Add to the reason" (counter; "The seller will read this. Don't include personal details from the document."). The
  next-step text of the chosen reason is shown read-only. An empty reason is a field error and nothing is sent.
- **DG6 Decline.** Same fields; the body adds "The seller can't send this certificate again. They can add a different one." Focus opens on Cancel.
- **DG7 Revoke.** Required prepared reason; body "Offers with this badge can't be bought until the seller has a valid certificate. The seller is emailed." If a submission is pending: "A pending submission is withdrawn too." Focus opens on Cancel.
- **DG8 Deactivate issuer.** Two radio options with consequences. "Stop new certificates": "No one can submit or approve a certificate from {issuer}. Approved certificates stay valid until they expire." "Stop recognising": "{n} approved certificates from {issuer} stop counting now. Offers with those badges can't be bought. Each seller is emailed." (n from the API); a required checkbox "I understand this takes effect now" for the second; Cancel is focused. Terminal.
- **DG9 Suspend manufacturer certificate.** "{n} products lose the badge at once. Offers on them can't be bought until another person reinstates it."
- **DG10 Save type revision.** As FL7 step 1.

### 3.5 Empty, loading, error and locked, in one place
| Surface | Empty | Loading | Error | Locked or read-only |
|---|---|---|---|---|
| CS1 | "You haven't added a certificate yet." (3.1) | 4 skeleton rows | "We couldn't load your certificates. Try again." | Acting-as; view-only |
| CS3 and upload | A new draft shows empty fields and an empty upload area | Skeleton fields; per-file Checking | Field and per-file errors (section 5) | Withdrawn banner; view-only |
| CS5 | n/a | Skeleton cards | "We couldn't load this certificate. Try again." | View-only |
| CA1 | Per tab (3.3) | 8 skeleton rows | Card error with "Try again" | View-only |
| CA2 | "None found." for duplicates; "No earlier submissions." for history | Skeleton cards; viewer placeholder | "We couldn't load this submission." | Withdrawn, replaced, decided, or decision under way: read-only |
| CA4 to CA8 | "No {things} yet." with the primary action | 8 skeleton rows | Card error | View-only; locked rows with the reason |

### 3.6 Fail-closed states (CD 4.2 rule 1, brief s5, AC 4)
The UI treats "unknown" as "not allowed" and never invents a badge:
| Situation | What the surface does |
|---|---|
| `ClaimDecision.allowed` is false, absent, malformed, or the call failed (`unavailable`) | **No badge is rendered anywhere, and the buyer side shows nothing at all on failure: no badge, no error text, no "couldn't check" notice, no layout gap** (only the seller and admin panels explain, below). No placeholder, no grey chip, no "pending" chip on a buyer surface |
| A decision names an unknown `typeCode`, unknown basis, or a missing `issuer` for a non-claim | `CertChip` renders nothing and the component logs a code (no values) |
| Seller panel, Offer badge card, when the answer is `unavailable` | Attention `InfoBanner`: "We couldn't check this certificate right now. The badge isn't shown until we can. Try again in a moment." with "Try again" |
| The panel holds an older decision | The panel **never stores a decision** (no cache, no localStorage, no store); it re-asks for every view and every save. A decision is valid only in the request that asked (CD 4.3) |
| Admin page cannot load a permission or an allowed-action list | Decision buttons are absent, with "We couldn't check what you can do. Try again." |
| A refusal with an unknown code | `identity.error.unknown` text; the action stays disabled |

### 3.7 Reason-to-words (seller-facing, the closed `ClaimReason` enum; CD 4.2)
Used by `catalog`'s Offer screens and by CS1. The reason is a code, never free text; the next step is a key.
| Reason | Text for the seller | Next step |
|---|---|---|
| `allowed` | You can use the {type} badge on this offer. | none |
| `no-valid-seller-certificate` | You don't have a valid {type} certificate. | Add or renew a certificate |
| `seller-zone-missing` | We can't work out your time zone yet. | Finish your address (link to S3) |
| `policy-not-applicable` | The {type} badge isn't available for this category. | none |
| `handling-requires-seller` | For this kind of offer, you need your own {type} certificate. | Add a certificate |
| `attestation-missing` | Confirm this offer is sold in its original sealed packaging to use a manufacturer's certificate. | Open the offer's confirmation |
| `not-covered` | The manufacturer's certificate doesn't cover this product. | Choose another basis or contact us |
| `type-unknown`, `input-invalid` | We couldn't check this badge. | Try again; contact us if it continues |
| `unavailable` | We couldn't check this right now. | Try again in a moment |

### 3.8 Buyer-facing badge (CB1, CB2) and its data (CERT-24, CERT-44; AC 23)
**One component, built from structured badge data only (R1).** `CertChip` takes `BadgeData` (CD 4.5) as its single
content prop. It has **no `label`, `children` or `text` prop**; a lint rule bans a string where `BadgeData` is expected;
the words below come from translation keys selected by `basis`, `sellerClaim` and `verifiedWithIssuer`; the type name and
the issuer's display name are data (written by people, R10, or the registry), rendered as plain text. Model output cannot
reach it. If any field the variant needs is missing, nothing renders (3.6).

**Three variants, distinguishable without colour or hover (the trust-critical decision).**
| Variant | Meaning | Chip words (key) | Shape and icon | What it must never look like |
|---|---|---|---|---|
| **Seller's certificate** (`basis=SELLER`, `sellerClaim=false`) | A third-party issuer certified this seller; MondaPac reviewed the document | "{typeName} · Seller's certificate" | Solid container with a 2 px solid border, type icon plus `file-check` | A claim chip |
| **Manufacturer's certificate** (`basis=MANUFACTURER`) | The product's manufacturer holds the certificate; this seller does not, and sells it sealed | "{typeName} · Manufacturer's certificate" | Outlined container with a 2 px solid border and an offset second line (a double-line shape), type icon plus `package` | The seller's chip (it must not read as the stronger one, CERT-44) |
| **Seller's claim** (`sellerClaim=true`) | The seller says so; no third-party check | "{typeName} · Seller's claim" | Container with a **dashed** border, neutral surface, type icon plus `user`, **no check mark of any kind** | Any chip with a check or a shield |

Three icons, three border treatments and three different phrases: any one of them alone distinguishes the variant (works in
grayscale, in `forced-colors`, and for a screen reader). Type identity comes from the type name text and the type's
icon key; two types never differ only by colour. If both bases hold, the decision returns `SELLER` and the chip is the seller's.

**The "Confirmed with the issuer" level** (`verifiedWithIssuer=true`; never on a claim). The chip gets a trailing `check-check` mark and
the detail gets one more line. Without it the detail says only "MondaPac reviewed the certificate document." The word "verified"
is not used on any surface until legal approves it (7.3).

**CB2 `CertDetail`** (popover on the chip's click, tap or Enter, a bottom sheet below 480 px; it is not a hover tooltip):
| Line | Seller's certificate | Manufacturer's certificate | Seller's claim |
|---|---|---|---|
| Heading | "{typeName}: seller's certificate" | "{typeName}: manufacturer's certificate" | "{typeName}: seller's claim" |
| Who | "{storeName} holds a {typeName} certificate issued by {issuer}." | "This product has a {typeName} certificate issued by {issuer} to its manufacturer. {storeName} doesn't hold its own {typeName} certificate." | "{storeName} states this offer is {typeName}. This is the seller's own statement." |
| Packaging | none | "Sold in its original sealed packaging." | none |
| Valid | "Valid until the end of {date}, {zoneName} time." (omitted when `validUntil` is null) | the same, in the **Market's** zone, named | none |
| What MondaPac did | "MondaPac reviewed the certificate document." or "MondaPac reviewed the document and confirmed it with the issuer." | the same two lines | "MondaPac hasn't checked this against a certificate." |
| Footer | "MondaPac doesn't certify products. A certificate shows who checked." (L) | same | same |

`{storeName}` is the public store name from `sellers`, joined by the storefront and not by this module. The detail never shows the
certificate number, holder name, file, reviewer, scope or location. No sentence about whether a product is acceptable, permitted or
correct under any belief (R13); the chip states a fact about a document or a statement.

**Where the badge appears in Phase 3:** seller Offer pages (a preview of what customers will see), the admin seller and product
views, and `catalog`'s tag list. The Phase 6 storefront reuses the same two components with no new variants. If a design asks for
an inline badge sentence, a card or a banner, it uses `CertChip` and `CertDetail`, not a new component.

### 3.9 Per-Offer attestation display (brief s5, OFR-08; CD 4.1)
The attestation itself (what the seller confirms, and the wording) is `catalog`'s (OFR-08). This module specifies only the display that
depends on it.
- **Seller panel, Offer certificate card (reused from `catalog`):** one row per active type: the type name, `CertChip` when allowed or the reason
  text of 3.7, and for the manufacturer basis the line "Your confirmation is recorded: sold in original sealed packaging." (or "Not recorded") read-only,
  with a link to the attestation control in `catalog`'s form. The attestation is never ticked, defaulted or suggested for the seller (R14).
- **Buyer detail:** the "Sold in its original sealed packaging." line of 3.8 appears **only** for the manufacturer variant, and only because the
  attestation was recorded when the decision was made.
- **Handling other than sealed original:** the row says "For this kind of offer, you need your own {type} certificate." (`handling-requires-seller`).

### 3.10 CERT-23 filter (CB3; storefront in Phase 6, data from `catalog`/`search`)
| Part | Spec |
|---|---|
| Placement | A `FilterGroup` "Certificates" in the catalog filter panel (a bottom-sheet filter on phones). One row per **active** type of the Market (from `certificationTypes`), with a count from the search facet |
| Options | Checkbox per type, name from the type revision. "Halal" can expand to two sub-options **"Seller holds a certificate"** and **"Manufacturer's certificate"** (CERT-46, P1; hidden until built). A **self-declaration type is its own labelled group "Seller's claims"** so a buyer cannot mix claims with certificates |
| Meaning, spelled out | Helper line under the group: "Shows offers that carry the badge." The filter applies to Offers, and the product page lists only matching Offers (CERT-23) |
| Selection of several types | **Resolved (Hadi):** AND across types (an offer must carry every selected type's badge); inside the Halal type the sub-options "Seller holds a certificate" and "Manufacturer's certificate" are OR. Sentence under the group: "Offers with all of these." |
| State | Default; selected (count in the group header and in a removable `FilterChip` above the results); loading; **zero results** ("No offers match these badges. Remove a filter to see more." with "Clear certificate filters"); filter unavailable (the group hides; results unfiltered with no claim); facet count failed (counts hidden, options still work) |
| Query | A text search with certification words becomes this filter (R1; ADR-0019); the chip shows it, so a buyer sees what was applied. Never the other way: the filter never builds from model output |
| Never | A filter option for a type with no active certificates and no offers is not hidden silently: it shows "(0)" and is disabled; the badge is never inferred from product text |

## 4. Design-system impact (fills brief section 12)

"Existing" is `docs/design/figma/README.md` section 5, `icons.json`, the ID-UX components planned for 1.1.0 and 1.2.0
and the SL-UX components planned for 1.3.0 and 1.4.0. All changes are additive: two MINOR releases. **1.5.0 "Certificates
and badge"** (badge, seller screens, upload, viewer) and **1.6.0 "Certification admin"** (review, registry, manufacturer,
policy). Both need SL-UX 1.3.0 and 1.4.0 first. (The README was not opened for property lists; confirm every row in the file.)

| Screen element | Existing library component or template | Change needed in Figma first | Release |
|---|---|---|---|
| Badge on offers and detail (CB1) | `CertChip` | Properties **Basis** (SellerCertificate, ManufacturerCertificate, SellerClaim), BOOLEAN **Confirmed** (not available with SellerClaim), TEXT slots **Type name** and **Issuer** (no free-text label slot), **Size** (Compact for lists, Regular), **State** (Default, Focus, Pressed). Border treatment per Basis (solid, double-line, dashed) as in 3.8; light, dark and forced-colors | MINOR 1.5.0 |
| Badge detail (CB2) | None | New component `CertDetail`: three variants, popover and bottom-sheet layouts, fixed line slots (Heading, Who, Packaging, Valid, What MondaPac did, Footer) | MINOR 1.5.0 |
| Certificate status words (3.2) | `StatusBadge` | Add 13 status values with icon, tone and word (the table of 3.2); no property changes | MINOR 1.5.0 |
| Expiry thresholds, submit-by date | `DeadlineBadge` | Add Kind=Expiry with Tone by threshold (30 Info, 14 Attention, 1 Critical) and Expired; text carries the number or date | MINOR 1.5.0 |
| Document upload (3.1) | None | New components `UploadArea` (States Default, Drag over, Disabled at limit, Offline) and `UploadItem` (States Uploading, Checking, Ready, Refused, Removed; thumbnail slot, size, Remove, Replace, Move up and down) | MINOR 1.5.0 |
| Document viewer (CA2, CA6, CA7, CS3 preview) | None | New component `DocumentViewer`: Page strip, zoom, rotate, fit width, next and previous, full screen; Modes Seller and Admin (Admin adds the "Download original" slot and the "Viewing is recorded." line); keyboard keys documented; States Loading, Ready, Failed, Not available | MINOR 1.6.0 |
| Searchable issuer list, product picker | `Select` (ID 1.2.0) | New property **Searchable** (with filtered list and empty "No match"); a new component `PickerList` (search plus chosen list with Remove and a nested narrowing row) for coverage | MINOR 1.5.0 (`Select`), 1.6.0 (`PickerList`) |
| Date entry | `Input` | New component `DateField` (Day, Month, Year in the locale's order, one label, one error line, Gregorian in AU) | MINOR 1.5.0 |
| AI suggestion beside a field (CS7) | `ExtractedField` | New Mode **Suggestion**: value, "AI suggestion" mark (icon plus text), Uncertainty word, actions Use, Edit, Not this; States Reading, Could not read, Partly read, Limit reached, Off | MINOR 1.5.0 |
| Reviewer reading of a document (AIA-01) | `ExtractedField` | Mode **Reading**: State Same, Different, Not found, Unreadable, with the read value as a quotation; no score | MINOR 1.6.0 |
| Pending second-admin change (CA4, CA8) | `SettingRow` (SL-UX 1.4.0), `InfoBanner` | `SettingRow` new State **Pending** (proposer, date, diff slot, Approve and Reject actions, disabled-with-reason for the proposer); no new component | MINOR 1.6.0 |
| Reviewer checks (CA2) | `CheckboxRow` (SL-UX 1.4.0: Saving, Undo) | New Mode **Result** (Not recorded, Done, Problem, Not applicable) via an embedded `SegmentedControl`; "Changed from" line | MINOR 1.6.0 |
| Summary and read-only values | `DataRow` (SL-UX 1.3.0) | None; add a provenance mark slot (AI suggestion used, edited) | MINOR 1.5.0 |
| Form save bar, setting rows | `FormActionBar`, `SettingRow` (SL-UX) | None | n/a |
| Reasons | `ReasonQuote` (ID 1.1.0) | None | n/a |
| History | `TimelineItem` | None | n/a |
| Warnings, withdraw, fail-closed banners | `InfoBanner` | None | n/a |
| Prepared-reason pickers, dialogs DG2 to DG10 | `Select`, `Textarea`, `Dialog`, `Toast` (ID 1.2.0) | None to the components; frames for each use (8.1) | n/a |
| Queue and lists | `Tab`, `FilterChip`, `TableCell`, `Pagination`, `QueueCard` | None | n/a |
| Seller sees separate states | `StatusBadge`, `Badge` | None; rule in 3.0 rule 2 | n/a |
| CERT-23 filter | `Checkbox`, `FilterChip` | New component `FilterGroup` (Checkbox rows with a count, an expandable sub-option row, a group helper line); built by Phase 6 but defined here so the word and count rules are fixed | MINOR 1.5.0 |
| Icons | Library icons | Add 8: `file-check`, `package`, `user`, `check-check`, `upload`, `camera`, `rotate-cw`, `zoom-in`. Reused if present in `icons.json`: `pencil`, `clock`, `alert-circle`, `x`, `check`, `ban`, `external-link`, `info` | MINOR 1.5.0 |
| Templates | Seller `Home`; Admin `Home`, `Sellers`, `Certificate review`; SL-UX `Seller · Setup step`, `Shared · Settings` | New: `Seller · Certificates` (list), `Seller · Certificate status`, `Admin · Certificate queue`. **Revised:** `Admin · Certificate review` (3.3 CA2). Reused: `Seller · Setup step` for CS2 to CS4 and CS6; `Shared · Settings` for CA4 to CA5 and CA8; `Admin · Certificate review` shell for CA7 | 1.5.0 (seller) and 1.6.0 (admin) |
| Mobile navigation | None (D16) | Not part of this module; blocks seller certificate pages and all admin pages on phones | Open |

- **Brief s12's "components not in README" list** is covered as follows: file upload with preview and "retry" (`UploadArea`, `UploadItem`);
  document viewer in both panels (`DocumentViewer`); searchable registry list (`Select` Searchable); date input (`DateField`); AI suggestion field
  (`ExtractedField` Mode=Suggestion; the brief's question "is `ExtractedField` enough for the seller form" is answered: with the new Mode, yes); Dialog (ID 1.2.0);
  states "file being checked", "upload failed", "no permission", "AI is off" and its four sub-states, and "replaced while you reviewed" (3.1, 3.3 CA2, 3.5);
  mobile shell (D16, open).
- **Brief s12's two "(در G2)" blanks** (new templates; design-system version): three new templates and one revised (this table); version **1.6.0**.
- **New components (8):** `CertDetail`, `UploadArea`, `UploadItem`, `DocumentViewer`, `PickerList`, `DateField`, `FilterGroup`, plus `ExtractedField` modes
  counted as changes. **Changed components (6):** `CertChip`, `StatusBadge` (values), `DeadlineBadge`, `Select` (Searchable), `ExtractedField` (two modes), `CheckboxRow`
  (Mode). **New tokens:** none (all values reuse existing color, type, spacing and `size/form-max`). **New icons:** 8.
- **Design-system version after this module:** 1.6.0, on top of SL-UX's 1.4.0. Nothing is renamed or removed, so no MAJOR. Light and dark both; the Audit
  plugin file must be clean (ADR-0017). Border treatments for `CertChip` use existing border-width and border-style tokens; if `dashed` is not a
  token yet, the design track adds `border/style-dashed` (a new token, the reason being the third variant of 3.8) in 1.5.0.

## 5. Copy

Keys are `certification.<surface>.<element>[.<variant>]`, kebab-case, ICU MessageFormat, en-AU spelling. Errors are
`certification.error.<code>`; unknown codes use `identity.error.unknown`. The design:ux-copy approach: plain words, one idea per
sentence, say what happened, what it means for the user and what to do next; no jargon, no blame, no promise we can't keep; no
religious or health claim (R13); legal reads every line marked (L). Type names, issuer names, claim terms, check names and prepared reasons
are keys or data the **Market** owns; the values below are the AU drafts.

**Words used everywhere:** certificate; issuer; submit, submit again, renew; awaiting review; changes needed; not accepted; badge; seller's
certificate; manufacturer's certificate; seller's claim; confirmed with the issuer; work time zone. **Words never used:** verified, certified
(about a product), approved as halal, guaranteed, compliant, authentic, permissible, "usually", "within {time}".

| Key (prefix `certification.`) | en-AU text |
|---|---|
| `seller.title · action.add · seller-state.line` | Certificates · Add a certificate · Your seller account: {status} |
| `seller.empty · empty.hint` | You haven't added a certificate yet. · Add one to use certificate badges on your offers. You don't need one to submit your seller application. |
| `seller.cant-offer.title · row · action` | What you can't offer yet · You can't add the {type} badge to offers until a {type} certificate is approved. · Add a {type} certificate |
| `add.title · step · choose.help · exists · none` | Add a certificate · Step {current} of {total} · Choose the type of certificate you hold. · You already have a {type} certificate. Open it. · No certificate types are open for new certificates. |
| `form.title · save-draft · saved · dirty` | Certificate details · Save draft · Draft saved · Unsaved changes |
| `form.issuer.label · help · not-listed · empty` | Issuer · Choose the body named on your certificate. · My issuer isn't listed · No issuers are available yet. We'll email you when you can add this certificate. |
| `view-only.ask-owner` | You can view certificates but not change them. Ask your shop owner. |
| `acting-as.back` | Back to admin |
| `change.pending.notify · no-second-admin` | Another admin has been emailed to decide this change. · No other admin can decide this yet. The change stays waiting, and you can't approve it yourself. |
| `form.number.label · issue-date.label · expiry-date.label · expiry-date.help · zone-line` | Certificate number · Issue date · Expiry date · The last day the certificate is valid. · We'll measure the expiry in your work time zone: {zoneName}. |
| `form.claim.banner · declaration.note` | This will show as a seller's claim, not a certificate. · Note (optional) |
| `form.correct.banner · renewal.banner` | Changes were requested. Your earlier answers are filled in. · Your current certificate stays valid until {date}. A renewal doesn't extend it until it's approved. |
| `upload.title · help · choose · limit` | Documents · JPEG, PNG, HEIC or PDF. Up to {maxSize} per file, {maxFiles} files, {maxPages} pages per PDF. · Choose files · You've added the most files allowed. |
| `upload.status.uploading · checking · ready · refused · removed` | Uploading… · Checking this file… · Ready · Not accepted · Removed |
| `upload.action.replace · remove · up · down · preview` | Replace · Remove · Move up · Move down · View |
| `error.file.type-not-allowed` | We can't accept this type of file. Use a JPEG, PNG, HEIC or PDF. |
| `error.file.encrypted-pdf · active-content` | This PDF is locked with a password. Save an unlocked copy, or take a photo. · This PDF has features we don't accept, such as scripts or attachments. Save a plain copy, or take a photo. |
| `error.file.heic-not-supported · draft-quota · polyglot` (HEIC copy: Hadi; shown only if spike 2 fails) | We can't read this photo format. Convert it to JPEG and upload it again. · You've used all your space for drafts. Remove a file to add another. · We can't accept this file. Save it again as a plain PDF or take a new photo. |
| `error.category.referenced-by-policy · move-first · action.move` (shown by `catalog`'s category pages) | Certificate rules for {types} use this category, so it can't be merged, archived or moved yet. · Move or remove those policy rows first. · Move to another category |
| `error.review.second-admin-required` | Another admin has to approve this change. It isn't live yet. |
| `change.product-changed · coverage.revision` | The product changed after this certificate was approved. Review the certificate again. · Covers product revision {revision} |
| `review.check.history · latest` | Earlier results · Latest result |
| `change.pending.title · body · by · approve · reject · withdraw · own` | Waiting for a second admin · This change isn't live yet. The current settings stay in force. · Proposed by {name} on {date} · Approve change · Reject change · Withdraw proposal · Another admin has to decide this. |
| `change.relaxing.notice · types.mode.locked` | This change needs a second admin. It isn't live yet. · To change this, add a new type. |
| `error.file.malware · scan-failed` | We didn't accept this file because it may be unsafe. Try a different file. · We couldn't check this file. Try uploading it again. |
| `error.file.too-large · too-many-pages` | This file is larger than {maxSize}. Try a smaller file or a lower-quality photo. · This PDF has more than {maxPages} pages. Split it into smaller files. |
| `error.issuer.not-active` | That issuer isn't available. Choose another from the list. |
| `error.certificate.already-expired` | This certificate has already expired. Add a current one. |
| `error.seller.zone-missing` | We can't work out your time zone yet. Finish your address, then try again. |
| `error.type.inactive · certificate.exists-for-type` | {type} certificates can't be added now. · You already have a {type} certificate. Open it. |
| `error.request.throttled · limit.daily · file.unavailable` | Too many requests. Wait a moment. · You've reached today's limit for this. Try again later. · We couldn't check this file now. Try again. |
| `review.title · banner · action.submit · action.renew · action.again` | Review your certificate · MondaPac reviews this certificate before you can use it on offers. You'll get an email when there's a decision. · Submit for review · Submit renewal · Submit again |
| `review.help.blocked · row.missing · row.blocked` | Finish {count, plural, one {# item} other {# items}} first. · Missing · Blocked |
| `status.draft · draft-issuer-not-listed · awaiting-review · changes-needed · declined` | Draft · Checking your issuer · Awaiting review · Changes needed · Not accepted |
| `status.approved · approved-expiring · approved-renewal-pending · approved-renewal-changes-needed` | Certificate approved · Expires soon · Renewal awaiting review · Renewal needs changes |
| `status.expired · expired-renewal-pending · revoked · issuer-not-recognised` | Expired · Expired, renewal awaiting review · Revoked · Issuer not recognised |
| `status.submitted-on · decided-on · valid-until` | Submitted on {dateTime} · Decided on {dateTime} · Valid until the end of {date}, {zoneName} time |
| `awaiting.title · body (L)` | We're reviewing your certificate · We'll email you when there's a decision. Until then you can't use this certificate on offers. If you change anything you submitted, your submission is withdrawn and you'll need to submit again. |
| `awaiting.seller-pending` | This certificate can be reviewed now. It has no effect until your seller application is approved. |
| `checking-issuer.title · body` | We're checking your issuer · We'll email you with the answer. You can't submit this certificate until then. |
| `changes.title · body · action` | Your certificate needs changes · Read the reason, update your certificate and submit again. · Correct and submit again |
| `declined.title · body · action` | We couldn't accept this certificate · You can't send this certificate again. You can add a different one. · Add a certificate |
| `approved.title · body` | Your certificate is approved · You can add the {type} badge to your offers. |
| `expiring.title · body · action` | Your certificate expires on {date} · After the end of {date}, {zoneName} time, offers with this badge can't be bought until a renewal is approved. Submit your renewal by {submitBy}. · Renew |
| `renewal-pending.title · body` | Your renewal is being reviewed · Your current certificate stays valid until {date}. We'll email you when there's a decision. |
| `expired.title · body` | Your certificate has expired · Offers with this badge can't be bought until a renewal is approved. |
| `revoked.title · body · action` | MondaPac revoked this certificate · Offers with this badge can't be bought. You can add a new certificate. · Add a certificate |
| `issuer-not-recognised.title · body · action` | {issuer} is no longer recognised by MondaPac · This certificate no longer counts, so offers with this badge can't be bought. Submit a certificate from a recognised issuer. · Submit a replacement |
| `edit-warning.banner · dialog.title · dialog.body · dialog.action` | Your certificate is waiting for review. If you change anything you submitted, your submission is withdrawn and you'll need to submit again. · Save and withdraw your submission? · Your changes will be saved and your submission withdrawn. Submit again when you're ready. · Save and withdraw |
| `withdraw.title · body · action` | Withdraw your submission? · It leaves MondaPac's review queue. Your details stay saved. · Withdraw submission |
| `issuer-request.title · help · name.label · note.label · action.send` | My issuer isn't listed · Tell us who issued your certificate and add the document. We'll check the issuer and email you. We can't promise when. · Issuer name (as written on your certificate) · Note (optional) · Send request |
| `issuer-request.status.open · added · not-accepted` | We're checking your issuer. · Your issuer was added. Choose it from the list. · We couldn't add your issuer. Choose a certificate from a different issuer. |
| `ai.action.fill · mark · use · edit · reject` | Fill from document · AI suggestion · Use · Edit · Not this |
| `ai.status.reading · unreadable · partial · limit · off · none-listed` | Reading your document… · We couldn't read this document. Fill in the form yourself. · We could only read some fields. Check each one. · AI help has reached its limit for today. Fill in the form yourself. · AI help isn't available. Fill in the form yourself. · No listed issuer found in the document. |
| `ai.uncertain` | Unsure |
| `ai.provenance.used · edited` | AI suggestion, used · AI suggestion, edited |
| `acting-as.banner` | You're signed in as this seller. Certificates are added by the shop owner or staff. |
| `view-only · view-only.banner` | You can view certificates but not change them. · You can view this page but not change it. |
| `admin.title · tab.awaiting · changes · approved · expiring · expired · closed · manufacturer · requests · all` | Certificates · Awaiting review · Changes needed · Approved · Expiring · Expired · Declined or revoked · Manufacturer · Issuer requests · All |
| `admin.kind.initial · resubmission · renewal` | New · Resubmission · Renewal |
| `admin.empty.awaiting · other` | No certificates are waiting. You're up to date. · No certificates here. |
| `admin.row.deciding` | Decision being recorded |
| `review.page.title · meta.submission · meta.certificate · meta.seller` | Review {typeName} certificate · Submission {number} · Certificate: {status} · Seller: {status} |
| `review.section.document · business · values · issuer · checks · scope · confirmation · duplicates · reading · history` | Document · From the seller's application · Submitted values · Issuer · Checks · Location and scope as read · Issuer confirmation · Possible duplicates · Read from document · History |
| `review.doc.recorded · download` | Viewing documents is recorded. · Download original |
| `review.issuer.closed · derecognised` | This issuer isn't taking new certificates. Request changes or decline. · This issuer is no longer recognised. |
| `review.check.result.done · problem · na · unset` | Done · Problem · Not applicable · Not recorded |
| `review.check.required · recorded · changed` | Required · Recorded by {name} on {dateTime} · Changed from {old} by {name} |
| `review.check.holder` · `location-scope` · `issuer` · `dates` · `tampering` · `legibility` · `issuer-enquiry` | The name on the certificate matches the seller's legal or trading name. · The location and scope on the certificate fit this seller's business. · The issuer on the document is the issuer the seller chose. · The dates on the document match the dates entered. · The document shows no signs of being altered. · The document is readable and in a language the reviewer can read. · You asked the issuer about this certificate (record it under Issuer confirmation). |
| `review.scope.label · help` | Location and scope as read · Write them as they appear on the certificate. Plain text only. |
| `review.confirm.channel · date · reference · tick-number · tick-holder · help · result` | Contact used · Date · Where the confirmation is kept · Confirms this certificate number · Confirms this holder · Only record a confirmation the issuer sent you through one of its registered contacts. Don't use a contact the seller gave you. · Confirmed with the issuer |
| `review.duplicate.number · file · hint · not-approved · open-recorded` | Same certificate number as {storeName}'s certificate. · Same document file as {storeName}'s certificate. · This is a hint. It doesn't stop a decision. · Not yet approved · Opening this is recorded. |
| `policy.reason.label · help` | Reason for change (optional) · Up to {max} characters. Plain text. Kept in the audit record. |
| `change.pending.rejected · withdrawn · exists` | The change was rejected. · The proposal was withdrawn. · A change is already waiting for this item. Decide it first. |
| `draft.delete.action · title · body` | Delete draft · Delete this draft? · The draft and its files are removed. This can't be undone. |
| `queue.store.unapproved` | Not yet approved |
| `review.reading.same · different · not-found · unreadable · not-checked · ai-filled · off` | Same · Different · Not found · Unreadable · Not checked by this reading: authenticity, seal, issuer enquiry. · Filled by AI, used as it was · AI reading isn't on for this seller. The review is the same. |
| `error.review.checks-missing · issuer-not-accepting · not-current-submission · not-another-person` | Record {count, plural, one {# required check} other {# required checks}} first. · This issuer isn't taking new certificates. Request changes or decline. · This was replaced while you reviewed. Open the current submission. · You worked on this record. Another person has to approve it. |
| `error.review.scope-missing · decision-unavailable · no-permission` | Record the location and scope as read first. · We couldn't check what you can do. Try again. · Your role can't decide certificates. |
| `review.withdrawn · busy` | This submission was withdrawn. · A decision is being recorded. |
| `approve.title · body · body-renewal · action` | Approve submission {number}? · {storeName} can add the {type} badge to offers. Offers waiting for this certificate are checked again. · This replaces the current certificate, which is valid until {date}. · Approve |
| `changes.dialog.title · action · help` | Request changes? · Request changes · The seller will read this. Don't include personal details from the document. |
| `decline.dialog.title · body · action` | Decline this certificate? · The seller can't send this certificate again. They can add a different one. · Decline |
| `revoke.title · body · body-pending · action` | Revoke this certificate? · Offers with this badge can't be bought until the seller has a valid certificate. The seller is emailed. · A pending submission is withdrawn too. · Revoke |
| `reason.label.prepared · label.extra · next-step` | Prepared reason · Add to the reason (optional) · What the seller should do next |
| `reason.holder-mismatch (L)` | The name on the certificate doesn't match your business name. Upload a certificate in your business's name, or correct your business details. |
| `reason.unreadable · dates-differ · issuer-differs · scope-mismatch` | We couldn't read the document. Upload a clearer copy of every page. · The dates on the document don't match the dates you entered. Correct the dates, or upload the right document. · The issuer on the document isn't the issuer you chose. Choose the correct issuer or upload the right document. · The location or scope on the certificate doesn't fit your business. Add a certificate that does. |
| `reason.issuer-not-accepting · cannot-accept (L)` | This issuer isn't taking new certificates. Choose a certificate from a different issuer. · We can't accept this certificate. You can add a different one. |
| `types.title · revision · code · mode · basis` | Certificate types · Revision {number} · Code · Verification · Default badge rule |
| `types.mode.document · self` | Document from a third party · Seller's own statement |
| `types.basis.seller · none` | Seller certificate required · No badge allowed |
| `types.auto-approve.warning` | These claims show as a seller's claim. No one reviews them. |
| `types.terms.help · plain` | Words people use for this claim in product text. People write these. MondaPac doesn't generate them. · Plain text only. |
| `types.save.title · body · count · count-failed · action` | Save this type? · This creates revision {number}. Certificates already approved keep the rules they were approved under. · {count, plural, one {# published product has} other {# published products have}} text that matches these terms. · We couldn't count the affected products. You can still save. · Save revision |
| `types.saved · deactivate.body · activate.body` | Revision {number} published. · No new {type} certificates can be added. Existing certificates and badges stay. · {type} certificates can be added again. |
| `issuer.title · state.proposed · active · closed · derecognised` | Issuer registry · Proposed · Active · Closed to new · Not recognised |
| `issuer.name.help · channels.help · expert.help · expert.required` | Customers see this name on badges. · Reviewers use only these contacts to confirm certificates. · Add the expert's approval before activating this issuer. · Add the expert's approval to activate this issuer. |
| `issuer.seed.banner` | No real certificate can be approved until an issuer is active. |
| `issuer.deactivate.title · closed · derecognised · confirm · action` | Stop recognising or closing {issuer}? · Stop new certificates. No one can submit or approve a certificate from {issuer}. Approved certificates stay valid until they expire. · Stop recognising. {count, plural, one {# approved certificate from {issuer} stops} other {# approved certificates from {issuer} stop}} counting now. Offers with those badges can't be bought. Each seller is emailed. · I understand this takes effect now. · Confirm |
| `issuer-requests.typed · answer.added · not-accepted · choose.help` | Typed by the seller · Issuer added · Not accepted · Choose the issuer you added to the registry. Add it in the registry first. |
| `manufacturer.title · coverage.label · coverage.help · coverage.none` | Manufacturer certificates · Covered products · Add the products this certificate covers. A brand alone doesn't count. · Add at least one product. |
| `manufacturer.waiting-other · off-market` | You worked on this record. Another person has to approve it. · No category rule allows the manufacturer basis in {market} yet, so this certificate doesn't give any badge. |
| `manufacturer.pending-revision · change-pending` | A change is waiting for another person. The approved version stays live until then. · A change is already waiting. Decide it first. |
| `manufacturer.suspend.title · body · action` | Suspend this certificate? · {count, plural, one {# product loses} other {# products lose}} the badge at once. Offers on them can't be bought until another person reinstates it. · Suspend |
| `policy.title · row.label · strictest · add · orphaned · save.title` | Claim basis policy · {selector} · If several rows apply, the strictest one counts. · Add a rule · This category was retired. Check this rule. · Save this policy? |
| `policy.basis.seller · seller-or-manufacturer · none` | Seller certificate required · Seller or manufacturer certificate · No badge allowed |
| `policy.warn.manufacturer (L)` | Check that the halal authority and legal have approved the manufacturer basis before saving. |
| `badge.basis.seller · manufacturer · claim` | {typeName} · Seller's certificate · {typeName} · Manufacturer's certificate · {typeName} · Seller's claim |
| `badge.sr.seller · manufacturer · claim` | {typeName}, seller's certificate. Press for details. · {typeName}, manufacturer's certificate. Press for details. · {typeName}, seller's claim. Press for details. |
| `badge.detail.who.seller (L)` | {storeName} holds a {typeName} certificate issued by {issuer}. |
| `badge.detail.who.manufacturer (L)` | This product has a {typeName} certificate issued by {issuer} to its manufacturer. {storeName} doesn't hold its own {typeName} certificate. |
| `badge.detail.who.claim (L)` | {storeName} states this offer is {typeName}. This is the seller's own statement. |
| `badge.detail.sealed · valid · reviewed · confirmed · unchecked · footer (L)` | Sold in its original sealed packaging. · Valid until the end of {date}, {zoneName} time. · MondaPac reviewed the certificate document. · MondaPac reviewed the document and confirmed it with the issuer. · MondaPac hasn't checked this against a certificate. · MondaPac doesn't certify products. A certificate shows who checked. |
| `offer.unavailable · retry` | We couldn't check this certificate right now. The badge isn't shown until we can. Try again in a moment. · Try again |
| `offer.attestation.recorded · missing` | Your confirmation is recorded: sold in original sealed packaging. · Not recorded |
| `reason.allowed · no-valid-seller-certificate · seller-zone-missing · policy-not-applicable` | You can use the {type} badge on this offer. · You don't have a valid {type} certificate. · We can't work out your time zone yet. · The {type} badge isn't available for this category. |
| `reason.handling-requires-seller · attestation-missing · not-covered · unknown · unavailable` | For this kind of offer, you need your own {type} certificate. · Confirm this offer is sold in its original sealed packaging to use a manufacturer's certificate. · The manufacturer's certificate doesn't cover this product. · We couldn't check this badge. · We couldn't check this right now. |
| `filter.title · helper · all-of · sub.seller · sub.manufacturer · claims-group` | Certificates · Shows offers that carry the badge. · Offers with all of these. · Seller holds a certificate · Manufacturer's certificate · Seller's claims |
| `filter.empty · clear · chip` | No offers match these badges. Remove a filter to see more. · Clear certificate filters · {typeName} |

Emails (prefix `certification.mail.`; each has `.subject`, `.heading`, `.body`, `.action`; account-type and ignore lines from `identity.mail.common`):
| Template | Subject (en-AU) | Button |
|---|---|---|
| `approved` | Your MondaPac {type} certificate was approved | Open your certificates |
| `changes-needed` (L) | Your MondaPac {type} certificate needs changes | Read the reason |
| `declined` (L) | Your MondaPac {type} certificate wasn't accepted | Read the reason |
| `expiry-warning` (n = 30, 14, 1) | Your {type} certificate expires in {n, plural, one {# day} other {# days}} | Renew your certificate |
| `expired` | Your {type} certificate has expired | Renew your certificate |
| `revoked` (L) | MondaPac revoked your {type} certificate | Read the reason |
| `issuer-not-recognised` (L) | {issuer} is no longer recognised by MondaPac | Submit a replacement |
| `issuer-request-answered` | Answer to your issuer request | Open your certificates |
| `reviewer-new` (reviewers) | A certificate is waiting for review | Open the queue |

Email bodies state the consequence and the `submitBy` date for the warning, and say nothing about review time. The expiry email says "after the end of {date}, {zoneName} time".

## 6. Accessibility, responsiveness, RTL and locale

Gate: WCAG 2.2 AA (ID-UX 6).
- **Forms.** Real `<form>` with Enter to save a step; visible labels; optional fields say "(optional)"; the certificate number has
  `autocomplete="off"`; `DateField` is one `fieldset` with one legend, three labelled inputs and a single error line that names the field. 3.3.7:
  correction and renewal forms are prefilled, nothing already given is asked again. Multi-step forms: back, next and save are keyboard
  operable; the step counter is text; focus moves to the new step's H1.
- **Status messages.** Upload state changes, "Draft saved", "Recorded", AI states and the decision toast use `role="status"` and announce once per
  result; each file announces its own result once. Error summaries are `role="alert"` and take focus.
- **Focus order.** Steps: back link, H1, fields, `FormActionBar`. CA2: summary bar, document viewer, business details, values, checks, decision
  buttons last in the DOM and in a sticky bar; after a decision focus moves to the next page's H1.
- **Document viewer.** Focusable region with a visible label "Document, page {n} of {total}"; keys: Left and Right (pages), Plus and Minus (zoom), R
  (rotate), 0 (fit width), Escape (leave full screen); every key also has a labelled button. Page images have alt "Page {n} of {total} of the uploaded
  certificate" (the server never describes the content). No timed content.
- **Badge.** The chip is a `button` with an accessible name from `badge.sr.*` (3.8); the icon is `aria-hidden`; the variant is distinguishable by
  text, shape and border and survives `forced-colors` and grayscale; contrast of text and the 2 px border is 3:1 or better against the
  surface, and text is 4.5:1 (light and dark). The popover is dismissible with Escape, returns focus to the chip, and is not hover-only. Hover and
  focus show the same state.
- **Checks.** A check row is a `radiogroup` named by its text, with the three results as radios; "Required" is text; the saved state is announced.
- **Disabled controls** stay focusable when they give a reason (Approve, Submit, row actions); the reason is text beside the control.
- **Dialogs.** As ID-UX; DG5 to DG7 keep typed text on an outside click.
- **Motion.** Upload progress and "Reading" are a static icon plus text under `prefers-reduced-motion`.
- **Targets.** 48 px on seller pages (Touch density, as on Auth); 32 px on admin screens, with a 24 px hit area for checkboxes. Toasts last at least
  6 seconds and never carry the only copy of a reason.
- **Widths.** Smallest width 320 px for CS1 to CS6 and every dialog; design frames 360 and 1280. Sellers photograph certificates on phones, so
  CS3 to CS6 are phone-first: one column, sticky `FormActionBar`, full-width primary button, the upload list as stacked cards, thumbnails 64 px. CA1
  shows a full table from 760 px and stacked cards below. CA2 is two columns from 1024 px (document left); below that the document is on top
  with a "Full screen" action and the side column drops below the main column; the decision buttons repeat in a sticky bottom bar below 760 px.
  CA2 on phones needs D16. `CertDetail` is a popover from 480 px and a bottom sheet below.
- **RTL.** Logical properties only; the certificate number, issuer reference, emails, URLs and dates entered as numbers stay left-to-right (`dir="ltr"`) inside an RTL page;
  free text (reasons, notes, typed issuer names, scope) uses `dir="auto"`; icons that point (back, chevron, Move up and down are vertical and do not mirror)
  mirror correctly; the `CertChip` icon sits on the logical start side. The chip's dashed or double-line border does not depend on direction. Text may grow 40%:
  chips and buttons wrap, never truncate. No text in images; the document pages are images by nature and have alt text as above.
- **Persian terms.** Status words in 3.2 take the brief's Persian terms. The Persian badge and detail strings are separate keys written by a person with legal review, not translated by
  machine; until they exist the Market's default locale is used and the panel says nothing in a half-translated sentence.
- **Calendar and numerals.** Phase 3 enters and shows Gregorian dates for the AU Market; numerals follow the page locale for display and the field accepts both Latin and Persian digits. A Market with another calendar changes
  `DateField`'s configuration, not its code.
- **Locale and Market.** Nothing is hardcoded to AU (3.0 rule 5). A second Market (ZZ) with different type set (one with `SELF_DECLARATION`
  and auto-approval), issuers, checks, file limits and locale must render with no code change: a Storybook or Playwright case per Market fixture for CS3,
  CA2 and `CertChip` (ADR-0003 decision 9).
- **Claims.** The only words that make a statement about certification are on `CertChip`, `CertDetail` and the status pages, and they come from keys and
  badge data. Seller approval is never styled as a certificate; a certificate never uses a seller-state word on its own.

## 7. Open points

**Still open**
1. **Review time (owner question 19.1-1, brief s7). RESOLVED by the owner: no review-time promise.** The spec already does this: **no time promised** on CS5, in emails EM1 to EM3
   and in the queue; renewals are reviewed first and the seller is **not** told this (no queue position either). If the owner answers otherwise,
   only `certification.awaiting.body`, `.renewal-pending.body`, `.issuer-request.help` and the matching email keys change. Who reviews at launch is the owner's call; the seller UI shows
   nobody's name.
2. **Retention wording (owner question 19.1-2).** No screen says how long a draft, a document or a refused file is kept. If counsel allows a short line,
   it goes under the upload area (`upload.help`). Until then the screens say nothing about retention.
3. **Legal wording.** The three badge variants' words, "Confirmed with the issuer", "MondaPac doesn't certify products. A certificate shows who checked.",
   the claim-chip text, `awaiting.body`, the prepared reasons, EM3, EM6, EM7. The words "verified", "certified" and any phrase that reads as a ruling are
   excluded in the meantime (R13). The brief says the word "verified" is held until legal approves.
4. **CERT-23 multi-select meaning. RESOLVED (Hadi):** AND across types; inside the Halal type the seller and manufacturer bases are OR (CERT-46). Still open: whether a deactivated type with live badges still appears in the filter (I propose yes while any live Offer carries it).
5. **Queue identification. RESOLVED (Mohammad):** rows show the public store name read per page through `sellerSummaries`, or "Not yet approved", plus the seller id. (Earlier text kept for the record:) I assumed `seller-certificates.queue` returns the
   store name or I compose it from `sellers` (API needs 1).
6. **Duplicates. RESOLVED:** never on a seller screen (not even a count); the reviewer sees kind, the other store's public name or "Not yet approved", and an access-checked, recorded link (API need 7: kind, other certificate id, store name).
7. **Seed issuers.** AU issuers are `proposed` until the halal expert list arrives (brief s11, owner action). CA5 shows the banner of 3.3, and the
   seller form shows `form.issuer.empty` (FL1 step 3, section 5). This is the AU state at launch until the owner acts.
8. **Manufacturer basis banner (CA8). RESOLVED (Hadi):** warning only, no blocking acknowledgement. The save dialog gains an optional "Reason for change" text field (`policy.reason.label`: "Reason for change (optional)"; plain text), stored in the audit row.
9. **Wording that depends on `catalog`.** The attestation text and its control (OFR-08) are `catalog`'s; the lines of 3.9 must follow them.
10. **Mobile navigation (D16).** Still undesigned; CS pages work in the limited shell on phones, the full seller shell and the admin pages wait.
11. **`SELF_DECLARATION` without a person.** The ZZ type with auto-approval is shown with the warning of CA4; no AU screen uses it. Q1 chose Halal only, so no legal wording
    for "Seller's claim" is needed before launch beyond what is above.
13. **HEIC.** Whether HEIC is accepted or refused with "convert to JPEG" depends on the intake spike (CD 14.3 spike 2); both copies are in section 5.
14. **Second-admin pending state** (Ali, Hassan) is designed in 3.0 rule 13; the exact list of what counts as "relaxing" is the API's (API need 13), and a `PendingChange` frame is needed in Figma (section 4, `SettingRow` State=Pending).
12. **Time-in-queue and "daysLeft".** If the API does not return `daysLeft` and `submitBy` the panel shows only the date; no client date arithmetic (3.0 rule 8).

### For Jafar
- **Provisional:** the four-step form, one page per step (phone first), upload on its own step, "Review" as the last step (the brief fixes the review
  step; the rest is my reading). Research should test: phones with a camera upload of multi-page certificates; whether sellers understand "Seller's certificate" versus
  "Manufacturer's certificate" on the detail; whether reviewers want the document beside or above the checks.
- **Please confirm:** the order "renewals first, then oldest" is a fixed sort, not a control; the seller is not told about it.
- **Changes to approved documents** (1.4) need your acceptance.

### API needs (for Mohammad)
1. **Queue row:** store name (or `sellerId` plus a name from `sellers` under `.view`); seller state; `daysLeft` or the boundary instant and zone; kind; whether a decision is
   under way.
2. **Allowed-actions and denial codes** per certificate, submission and manufacturer revision (the ID 8.6 pattern), including the codes of CD 16.2 plus
   `review.scope-missing`, `certificate.already-expired` as a denial for Approve, and `file.not-ready`.
3. **Seller list:** status codes of CD 3.3 plus `submitBy`, `daysLeft`, `validUntilLocalDate` and `validUntilZone`; `statusReason` (prepared reason key, optional text, next-step key).
4. **Draft: closed.** `own-certificate.delete-draft` exists (never-submitted drafts only; refused in acting-as).
5. **Upload read:** per file a server-made label ("Page {n}"), state, refusal code, thumbnail and preview URL path (API-streamed PNG), page count, size; reordering support.
6. **Form settings:** the type revision's fields as data (issuer required, document required, expiry required, declaration text and the Market's file limits), so the form is built from data.
7. **Review read:** the Market's check list with keys, required flags and recorded results; the registered contact channels of the issuer; duplicate hints (counts and ids); prior submissions; AI provenance per field; the AIA-01 per-field states (CD 13).
8. **Issuer registry read for the seller form:** active issuers of the type, and an explicit "none available" state.
9. **Product picker for coverage:** a `catalog` admin search endpoint that lists products and variants (CD 8.2's `CatalogReferences` validates ids but does not search); a request to `catalog` is needed (C-7 is the count only).
10. **Policy page:** the list of retired categories (CD 3.7) and a flag whether any row allows `SELLER_OR_MANUFACTURER` in the Market.
11. **Badge data on every read the panel uses**, including the `reason` of the decision, never cached by the panel.
13. **Proposals:** a read of pending type and policy changes (proposer id and name, date, diff, `change.kind` tightening or relaxing), and `review.second-admin-required` as the refusal when the proposer tries to approve it (`review.not-another-person` stays for manufacturer certificates). **Closed:** the read is `RelaxationProposalView` (domain 7.6: subject, proposer, reason, diff with `relaxes`, state, actions approve, reject, withdraw).
14. **RESOLVED:** (a) queue rows show the public store name or "Not yet approved" plus seller id; (b) "Delete draft" is kept: `own-certificate.delete-draft`, a never-submitted draft only (dialog "Delete this draft?" with Cancel focused; absent after any submission; refused in acting-as). **Pending proposals** use `RelaxationProposalView`: one pending per subject; a second save is refused with `review.proposal-pending` ("A change is already waiting for this item. Decide it first."); actions Approve, Reject and, for the proposer, Withdraw. The change reason is optional, plain text, **max 500 characters**. **Notification and no-second-admin rule (Jafar S6):** when a proposal is raised, the other admins holding the approving permission are emailed (template added to domain section 12 by Mohammad; no values, no reason text in the mail), and the proposer sees `change.pending.notify`. If no other admin holds the permission the proposal stays pending, the proposer cannot approve it, and the page says `change.pending.no-second-admin`.
12. **Daily-limit codes:** confirm `request.throttled` with `retryAfterSeconds` for minute windows and a distinct code for 24-hour windows, so `limit.daily` can replace the minutes text.

## 8. Hand-off notes

### 8.1 Design track: what to build in Figma, in order
Follow `docs/design/figma/update-procedure.md` (Sandbox, review, publish, Export tokens). Both releases need SL-UX 1.3.0 and 1.4.0 first.
1. **1.5.0 "Certificates and badge":** icons; `CertChip` (all variants, light, dark, forced-colors preview, compact and regular); `CertDetail` (three variants, popover and
   sheet); `StatusBadge` values; `DeadlineBadge` Expiry; `Select` Searchable; `DateField`; `UploadArea`, `UploadItem` (all states); `ExtractedField` Suggestion;
   `FilterGroup`; `DataRow` provenance slot. Templates `Seller · Certificates` (empty, one of each of the 13 statuses, expiring at 30, 14, 1 days, cannot-offer card, seller not approved,
   acting-as, view-only), `Seller · Certificate status` (each status page, including `awaiting-review` with no time text and renewal states), and `Seller · Setup step` frames
   for CS2, CS3 (each step; type with and without expiry; `SELF_DECLARATION`; correction; renewal; withdraw warning; AI states), CS4 and CS6. Badge detail frames in the seller Offer card.
2. **1.6.0 "Certification admin":** `DocumentViewer`; `PickerList`; `CheckboxRow` Mode=Result; `ExtractedField` Reading. Templates `Admin · Certificate queue` (all tabs, empty),
   the revised `Admin · Certificate review` (every state of CA2: default, checks all recorded, each Approve-disabled reason, issuer closed, issuer not recognised, replaced while you reviewed, withdrawn, decision under
   way, view-only, review-only, AI section on and off, duplicate hint on and off, renewal side note), CA3 (decided, revoke), CA4 and CA5 and CA8 on `Shared · Settings` form variants, CA6, CA7 (waiting for another person, pending revision, suspended).
   Dialog frames: DG2 to DG10.
3. Each release: README section 8 checklist, both themes, Audit with zero warnings, token export, changelog, README counts, `claude/design-status.md`. Owner review: a short Persian summary with screenshots of
   the three badge variants and CS5 `awaiting-review`.

### 8.2 Frontend track: which screens wait for which backend slice
Every screen also waits for ID-UX D1 and D2 ADRs and slice F0 (ADR-0017).

| Screens | Backend slice | Library release |
|---|---|---|
| `CertChip`, `CertDetail` (seller and admin previews) | 10 | 1.5.0 |
| CS1, CS2, CS3 (without upload), CS4, CS5 | 5 | 1.5.0 |
| Upload (`UploadArea`, `UploadItem`) and viewer preview in CS3 | 4 and 5 | 1.5.0 (viewer 1.6.0) |
| CS6 and CA6 | 6 | 1.5.0 and 1.6.0 |
| CA1, CA2 (checks, scope, issuer confirmation, document), DG4 to DG6 | 7 | 1.6.0 |
| Withdraw, resubmission, renewal (FL3, FL4) | 8 | 1.5.0 |
| Expiry banners, `DeadlineBadge`, EM4, EM5 | 9 | 1.5.0 |
| CA3 (revoke, full history), DG7 | 11 | 1.6.0 |
| CA4, CA5, DG8, DG10 | 12 | 1.6.0 |
| CA8 | 13 | 1.6.0 |
| CA7, DG9 | 14 and 15 | 1.6.0 |
| CS7, CA2 AI sections | 16 and 17 | 1.5.0 and 1.6.0 |
| CB3 filter | Phase 6 (`search`) | 1.5.0 |

- Build the row menus, Approve and the status page actions from the allowed-actions list the API supplies; never infer a permission and never store a decision.
- Frontend telemetry never records a certificate number, document or reason. The panel server sends `x-market-id`. Labels, fields, checks, reasons and file limits come from the API.
- `CertChip` accepts only `BadgeData`; add a lint rule and a test that fails if a string label is passed or if a missing field renders anything.
- Mail templates are built by the backend from the `certification.mail.*` keys of section 5.
- Slice 18 is one frontend PR per row of the table above.

## 9. Review record

| Reviewer | Result | What was applied |
|---|---|---|
| Jafar (product-designer) | **Accept with changes, applied** (2026-10-07) | B1 section 4 copied into brief s12; B2 status count 13; B3 queue store name and draft deletion resolved; S1 "Waiting since" admin-only with a test; S2 `form.issuer.empty` in FL1 and section 5; S3 "Back to admin" in the acting-as banner; S4 "Ask your shop owner"; S5 expired Offers stay in the catalogue but cannot be bought; S6 proposal email and no-second-admin rule; S7 buyer side shows nothing on failure |
| Reza (ui-ux-designer, author) | **Signed** (2026-10-07) | Spec written; review rulings of Ali, Hassan, Jafar, Hadi and Mohammad's 16.2 hand-offs applied |
| Ali (cto) | **Accept** (2026-10-07, G2 yes) | Rulings relayed and applied (second admin for relaxations, acting-as refusal, category retire refusal, upload limits) |
| Hassan (security-tester) | **Accept with conditions, applied** (2026-10-07) | C3 duplicate hint reviewer-only with recorded link; T5-A preview server-made PNG only; malware-refused files never previewed. Checked in particular: the badge's no-string rule, "viewing is recorded", the no-prefill rule from the typed issuer name, no browser storage, duplicates hint, admin-only download |
| Mohammad (CD 16.2) | **Answered** (2026-10-07) | API needs (7): queue store name, `own-certificate.delete-draft`, `RelaxationProposalView` (CD 7.6), proposal email (CD 12) |
| Hadi (product-owner) | **Ruled** (2026-10-07) | CERT-23: several types = AND, bases inside one type = OR; claim-policy warning only warns, optional change reason |
| Owner | Review time **decided 2026-10-07: no promise**; retention wording (7, 2) waits for counsel (not a G2 blocker) | |
