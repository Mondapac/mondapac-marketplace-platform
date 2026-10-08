# sellers: flows and screens (G2 UX specification)

| | |
|---|---|
| Author | Reza (ui-ux-designer), 2026-10-07 |
| Status | **G2 approved 2026-10-07** (recorded in the brief and in `docs/modules/README.md`). Revised after the G2 reviews (section 9). Open points in section 7 that need the owner are not G2 blockers (Ali's ruling) and are tracked there |
| Module | `sellers`, tier A, Phase 3. G1 approved by the owner on 2026-10-03 |
| Reviewers | Jafar (product-designer), Ali (cto), Hassan (security-tester). Mohammad's domain design (`docs/design/domain/sellers.md`, "DD") is updated with the G2 reviews and its sections 6.4, 6.5, 7.8, 14.3 and 16.4 are cited here |
| Used for | Brief section 12 (filled in section 4 here), the Figma work (ADR-0017) and slice 17 (panel screens) |

**Ground truth.** `docs/modules/sellers/brief.md` (sections 3 to 5, 7, 10, 12); DD 2, 3, 6, 7 and 13.2;
`docs/modules/identity/ux.md` (approved; its IDs, templates, components and copy keys are reused, cited
as "ID-UX"); ADR-0017; `docs/design/figma/README.md` (library 1.0.0) and `docs/design/tokens/`;
`docs/design/frontend-kickoff.md`.

**Not verified.** The Figma file was not opened; the library inventory comes from its README, the
plugin's `icons.json` and ID-UX section 4. ID-UX releases 1.1.0 and 1.2.0 are **planned, not built**;
this document assumes them and adds 1.3.0 and 1.4.0 on top (section 4). Values that live in Market
configuration appear as `{names}`; the AU values are examples only. No research with real sellers
exists (brief risk 14); step order and grouping are therefore provisional ("For Jafar").

**IDs.** Continue ID-UX: S = seller-panel screen, P = admin-panel screen, C = card, D = dialog, E = email,
F = flow. S1 and P1 exist in ID-UX and are **changed** here (3.1, 3.2). "AC n" is acceptance criterion n
of brief section 10. Codes are the API codes of DD 3.3 and 13.2; the UI maps each to a translation key
and never shows server text (INTL-11).

## 1. Scope and inventory

Phase 3 UI for `sellers`: **seven seller-panel screens, five admin-panel screens (one is a card, one a
tab), four dialogs, six emails**, plus changes to S1, P1, D3 and D4 of ID-UX. No customer-facing screen:
the public store page is Phase 6 (STO-02). Nothing in this module uploads a file (Q2): there is no
document upload screen, and none is designed. A request for "document upload" in the task is answered by
the brief: the seller gives information only; certificates are `certification`'s step.

### 1.1 Screens
| ID | Name | Panel | Slice | AC | Priority | Note |
|---|---|---|---|---|---|---|
| S1 | Your seller account (changed) | Seller | 5 | 4, 5, 11 | P0 | Gains the `sellers` steps and the states of 3.3 |
| S2 | Business details | Seller | 2 | 5, 7 | P0 | Store name, business name, phone, contact email. Owner only |
| S3 | Address and area | Seller | 2 | 6, 8 | P0 | Market address format; service-area result; time zone shown |
| S4 | Business number and tax registration | Seller | 3, 4a | 3, 5, 21, 30, 31 | P0 | Label and format from Market configuration; register result |
| S5 | Shop web address | Seller | 2 | 2, 5 | P0 | Slug with availability check |
| S6 | Review and submit | Seller | 5 | 5, 10, 11 | P0 | Summary, what is missing, submit and submit again |
| S7 | Store profile | Seller | 12, 10 | 20, 23, 24, 25 | P0 (PNL-02) | Approved sellers only; General, Address, Description, Policies, Meta, Social, tax registration |
| P1 | Sellers (changed) | Admin | 6, 8 | 1, 17, 22 | P1 (SEL-14) | Tabs, search, bulk actions; approve and reject leave the row menu |
| P2 | Seller page | Admin | 7a, 8 | 1, 16, 17 | P0 | Details, edit, submit on behalf, status, card C1, tabs |
| P3 | Review a submission | Admin | 7a | 9, 10, 21, 22, 32, 33 | P0 | Onboarding and change-request variants |
| P4 | Seller settings (Market) | Admin | 15 | 19 | P0 doc, slice late | Only "Require approval for new sellers" in Phase 3 |
| C1 | Admin-only settings (card on P2) | Admin | 13, 14, 16 | 14, 15, 16, 29 | P1 | Allowed product types, category proposals, AI switch |
| P2-H | History tab on P2 | Admin | 19 | 26 | P1 (VER-14) | Slice assigned at G2 (Ali change 5) |

Dialogs: **D7** Change shop web address; **D8** Correct time zone; **D9** Confirm it's you (step-up, for the
change request; depends on identity R-2); **D10** Bulk result. **D3** gains uses and **D4** gains modes (3.4).

### 1.2 Emails
Text templates, outside Figma; prefix `sellers.mail.`; sent to the Seller Owner's **sign-in** address, never
the contact email (brief s5). Same layout and rules as ID-UX 3.4. No email carries a business value.

| ID | Email | Trigger (DD 10) |
|---|---|---|
| E18 | You asked to change your business details | Change request submitted |
| E19 | Your change was approved | `business-identity-change-approved` |
| E20 | Your change wasn't approved, with the text of the reason code | `business-identity-change-rejected` |
| E21 | MondaPac edited your business details | `business-identity-edited` (admin edit applied at once, brief s5) |
| E22 | AI is switched on for your shop (L: counsel reads it) | `ai-switch-changed`, enabled; switching off sends nothing |
| E23 | You can submit your application again | An admin allows one more application (identity R-7, DD 15). Same pattern as E21. Whether `identity` or `sellers` owns the text is open (7, API needs 3) |

E3 (identity: "A seller is waiting for approval") **changes trigger and wording**: it now goes after a
submission, not after email confirmation (DD 7.5, R-3). It still carries no seller name or email
(Jafar's condition for accepting the change).

**Proposal, not designed, pending the owner or Hadi (DD 10, Jafar 7):** a one-line "Your area is now open"
email to sellers waiting in `outside-service-area`. It would be E24 on the same pattern. Until it is
decided, S1 is the only place such a seller learns it (they find out on their next visit), and the admin
filter on P1 is the only staff route. It is not in the counts above.

### 1.3 Not designed, and why
- **Document upload:** none (Q2).
- **Rich-text editing:** none; every text field is plain text (brief s5).
- **Public store page, logo and images:** Phase 6; SEL-24 has no image fields.
- **Seller-side AI features:** none. The only AI element a seller sees is the optional read-only line on S7
  "AI is on for your shop" (Jafar 11; 3.1).
- **Commission, allowed types for a seller, payout account:** other modules (brief s3).
- **A seller-visible history of store-profile versions:** versions are kept (ADR-0009) but no screen
  shows them in Phase 3 (Jafar, answered).
- **Mobile navigation (D16):** still undesigned; S7 and every admin screen wait for it on phones (6).

### 1.4 Changes this spec makes to the approved ID-UX
Recorded here so Jafar and the identity owner can accept or refuse them. **Jafar accepted all four for
design on 2026-10-07; the identity owner's acceptance (DD request R-12) is still needed.** His conditions
on change 3 are in 3.2 (P3) and apply when it lands: P3 keeps E4 and E5 and the same toasts as ID-UX;
view-only admins see disabled actions with the reason (identity criterion 9); a seller whose application
needs changes still cannot be approved (ID-UX F9 step 2); and ID-UX F9 steps 1 to 3 are updated at that
time.
1. **Words.** ID-UX uses "Awaiting approval" for a seller who has not been decided on. With `sellers`
   the seller-facing states split (3.3), so the badge reads **"Awaiting review"** only once a submission
   exists, and **"Details needed"** before. The P1 tab "Awaiting approval" becomes **"Awaiting review"**
   (DD 7.8 names it so). Keys `identity.sellers.tab.pending`, `identity.seller-status.status.pending`
   and `.title.pending` are superseded by `sellers.*` keys in section 5.
2. **S1 steps.** `identity` still owns "Account created", "Email confirmed", "MondaPac reviews your
   application"; `sellers` supplies the steps between (3.1), as ID-UX F5 planned.
3. **P1.** Approve and reject for one seller move to P3; they stay only as bulk actions (ID-UX F9 step 7).
4. **D4** gains modes; **D3** gains uses (3.4).

## 2. Flows

### F13. Complete details and submit (Seller Owner; brief 4-A; DD 3.1)
| # | Step | Failure or branch: code and what the user sees |
|---|---|---|
| 1 | Sign-in lands on S1 (ID-UX F5). The steps card lists the `sellers` steps from `onboardingSteps`; each opens its own page and returns to S1 | Staff cannot reach these pages (no Staff exist before approval); an approved seller who opens S2 to S6 is sent to S7 |
| 2 | S2: store name, business name, phone, contact email (optional). "Save and continue" | `validation.failed` (control, bidi or URL-like text, ID-UX 3.0); `phone.required` on the first save (AC 7) |
| 3 | S3: address fields as the Market format lists them. On save the answer says whether the postcode is in an area that takes new sellers, and gives the work time zone | `address.outside-service-area`: the address is kept, the page says "not available in your area yet" and the submit step is blocked (AC 6); `timezone.unresolved`: address kept, submit blocked, the page says so; the reviewer is told by the API |
| 4 | S4: business number; then the tax registration answer. On save the register is asked once (never while typing). Result: "Matched with the official register", "Not matched", or "Could not be checked now; a reviewer will check" | `identifier.format`, `identifier.checksum`: field error. `lookup.limit`: save refused for a new value. Definite negative (not found, cancelled: one message): submit stays blocked until the number changes (AC 31) |
| 5 | S5: shop web address with an availability check. "Save and continue" calls `my-file.save-slug` (Q-M25), which saves the slug in the draft; it is not held until submission | `slug.format`, `slug.reserved`, `slug.taken` (advisory), `request.throttled` (a save counts against both the saves and the slug-check limits, 30 a minute and 300 a day for checks, DD 6.5), `conflict.stale`. The field is prefilled by code from the store name (not AI), editable, and marked as a suggestion; Jafar tests it |
| 6 | S6: summary of everything saved, what is missing, and "Submit for review". Submit is enabled only when nothing is missing and no step is blocked | `file.incomplete` with the missing field list (each links to its step; the `slug` item links to S5); `slug.taken` (the slug was lost at submission, T1); `address.outside-service-area`; `timezone.unresolved`; a definite register negative; `request.throttled` or the daily limit (5 submissions a day per seller file, DD 6.5: "You've reached today's limit for submissions. Try again later."); `seller-access.wrong-state`; `file.decision-in-progress`. The blocked rows on S6 (outside area, time zone, register negative) carry a "Contact us" link (Jafar 6; waits for the owner's support contact, Open 2) |
| 7 | Done: S1 shows "Awaiting review" and "Submitted on {date}" in the seller's work time zone. That line is the only confirmation (no email to the seller, Jafar 8). The reviewers are told (identity E3). When approval is not required, S1 may turn to Home within moments: S1 re-reads on load and on focus (ID-UX F5), it never polls | Status unreadable: inline error with "Try again" |

Rules for every step page: one save per page, explicit (no autosave); the form keeps what was typed if a
save fails; leaving with unsaved changes asks first; a page never shows another seller's data; the
**certificate step** from `certification` sits on S1 in its own slot and is **not required to submit**
(brief 4-A step 5); it is labelled "(not needed to submit)" in the steps card. Form state lives **in memory
only**: nothing the seller types is written to localStorage, sessionStorage, IndexedDB or a service-worker
cache, and every response that carries decrypted business data is `Cache-Control: no-store` (Hassan,
decision, recorded in 9). A reload or an ended session loses unsaved text; saved pages are kept.

**Acting-as (DD 6.4).** In a "Login as Seller" session every seller-side business-identity action (S2 to S6
saves, submit, request a change, tax registration) is refused. S2 to S6 and the S7 identity cards render
read-only with an Attention banner "You're signed in as this seller. Edit their details from the seller's
page." linking to P2; there is no AI in such a session. The refusal code's name is API needs 4 (open).

### F14. Edit while waiting: the withdrawal warning (brief 4-A step 7; AC 10)
| # | Step | Branch |
|---|---|---|
| 1 | The seller opens S2 to S5 while the state is `awaiting-review`. A top `InfoBanner` (Attention) says that changing anything withdraws the submission | Fields stay editable |
| 2 | "Save and continue" on a changed value opens **D3** "Save and withdraw your submission?" (no warning for an unchanged page). Confirm saves and withdraws; S1 now shows the state the draft is in (usually `ready-to-submit`) | Cancel keeps the typed text and closes the dialog |
| 3 | S1 also offers "Withdraw submission" (D3) without editing (`my-file.withdraw`) | |
| 4 | `file.decision-in-progress` (a decision is being recorded): every field is read-only, an Attention banner says "MondaPac is recording a decision. Try again in a moment.", no countdown. The page re-reads on focus | |
| 5 | **Withdrawn by an admin's edit** (Jafar 4): S1 shows an Info `InfoBanner` "Your submission was withdrawn on {date} because MondaPac edited your details. Submit again when you're ready." The same banner, with the cause "edited" or "reapply-refused", comes from `my-file.read` (latest withdrawal: cause, by whom, date). Rate: withdraw and cancel are limited to 10 a day (DD 6.5) | |

### F15. Rejection and submitting again (brief 4-B step 4; AC 11)
| # | Step | Branch |
|---|---|---|
| 1 | After a reject, the next sign-in lands on S1 "Changes needed" with the reason from `identity` (`ReasonQuote`, Seller Owner only) and the date | Not the Seller Owner: no reason; "Ask your shop owner" (ID-UX) |
| 2 | The seller opens the step pages, corrects, and on S6 presses **"Submit again"** (same button, new label). Fields that changed since the last submission are not marked for the seller | `seller-access.reapply-limit`: S1 changes to "Not approved" (final); S6 shows no submit button, only the contact route (ID-UX 3.2 S1; the way out is an admin action, "Allow one more application" on P2, F18 step 6, with E23; the seller has no control) |
| 3 | After submit again: S1 "Awaiting review". The previous reason stays readable on S1 until the new decision | |

### F16. Admin queue and one decision (brief 4-B; DD 7.3)
| # | Step | Branch |
|---|---|---|
| 1 | P1 opens on "Awaiting review" (default). A row shows kind: "New application" or "Change request"; a Kind `FilterChip` filters them (Jafar 10). A reviewer who holds only one of the two approve permissions still sees the other kind's rows, with actions disabled and the reason beside them | View-only admin: row actions disabled with the reason (AC 17) |
| 2 | "Review" opens P3 for the pending submission | Pending submission withdrawn meanwhile: P3 shows "This submission was withdrawn" with a link back; no actions |
| 3 | The reviewer reads the details against the register, records the named checks (and can set a recorded check back with "Undo": it counts as missing again), re-looks-up or records a manual register check where needed | `request.throttled` or `lookup.limit` on re-lookup (30 re-lookups per admin per 24 hours): inline message |
| 4 | **Approve** (D3). Enabled only when the API's allowed-actions say so; a disabled button names the missing item beside it (3.2 P3) | Each refusal has one code and one text (5): `review.not-current-revision` ("This isn't the current submission."), `review.checks-missing`, `review.register-blocks`, `review.identifier-held` ("Another approved or suspended seller already holds this number. Open that seller", with a link; a **reviewer-only** message, the seller's answer never differs, brief s7). Also `seller-access.wrong-state`, `conflict.stale`. P3 refreshes and says what changed |
| 5 | **Reject** opens D4 in "Application" mode: required reason text, optional prepared reason | `seller-access.reason-required` (also checked before submit) |
| 6 | Toast (the identity toasts, "Seller approved. We've emailed them." and "Application rejected. We've emailed the seller your reason.") and the next step: back to P1 on the same tab and page. P3 keeps E4 and E5 | `file.decision-in-progress`: "A decision is being recorded for this seller. Refresh in a moment." |

### F17. Bulk approve and reject (SEL-03, AC 22)
| # | Step | Branch |
|---|---|---|
| 1 | On "Awaiting review" the table has checkboxes; selecting rows shows `BulkActionBar` with "{n} selected", **Approve** and **Reject…**. At most 50 ids per request and 10 bulk requests a minute per admin (Hassan; DD 6.5). The request carries each row's seller id and submission, so a row that changed meanwhile is skipped | Selecting a 51st row is refused with a status message "You can select up to 50 sellers at a time"; `bulk.too-many` is the server's answer; `request.throttled` on the rate. If any id is not found in the admin's Market the **whole request** is refused, with the same answer as an unknown id (AC 22), and D10 is not shown |
| 2 | Approve: D3 with the count and "Sellers without a current submission are skipped" | Without the permission the bar's actions are disabled with the reason |
| 3 | Reject: D4 in "Bulk" mode: a prepared reason is **required** (brief s7); its text is previewed read-only | |
| 4 | **D10** reports the counts from `[{sellerId, code}]`: approved or rejected, skipped (`review.not-current-revision`, no pending submission, a decision under way), refused (each item runs the full approval guard, so `review.checks-missing`, `review.register-blocks` and `review.identifier-held` appear here), with the skipped and refused rows named by store name and one reason each | A whole-request failure is an error banner, not D10 |
| 5 | Identity-change requests cannot be bulk-decided (different permission and no free text) | Rows of kind "Change request" are not selectable and say why |

### F18. Admin edits, submits for a seller, changes slug or time zone (brief 4-C; DD 6.2)
| # | Step | Branch |
|---|---|---|
| 1 | P2 "Edit details" (permission `sellers.seller.edit`) opens the same form fields as S2 to S5 on one admin page. The edit form shows a banner by the seller's state: **awaiting review** "Saving withdraws the pending submission." (the save then goes through D3 "Save and withdraw the submission?", Jafar 4); **suspended** "This seller is suspended. Your edit changes business data only." and **invited** "This seller hasn't accepted the invitation yet. Your edit changes their saved details." (Jafar 9; an admin may edit both, DD 14.3 Reza 5) | Without the permission: no button, a line says view only. Without `sellers.business-details.view` the cards show only clear fields and the details cards say "Your role can't view business details." (Hassan M4) |
| 2 | Saving an **approved** seller's business identity needs **both** `sellers.seller.edit` and `sellers.identity-change.approve` (Hassan H1). The edit form for an approved seller therefore shows the same **Checks** section and **register state** as P3, and the admin records the required checks in the same request. The save applies at once and the owner is emailed (E21); a line above the Save bar says so. Refusals are the P3 codes: `review.checks-missing`, `review.register-blocks`, `review.identifier-held`, with the same texts. For a seller that is not approved the edit changes the draft only | With only `seller.edit` the Save button is disabled with "You also need permission to approve identity changes." (nothing is sent). `file.change-pending`: "A change request is waiting. Decide it first." with a link to P3 (Jafar 4). `file.change-request-required` (a draft save on an approved file) is a safeguard: the form never offers it, and the text reads "Use Request a change for these details." |
| 3 | "Submit for this seller" (D3): recorded as submitted by MondaPac. Enabled when the draft is complete | The same codes as F13 step 6 |
| 4 | "Change web address" opens D7: the new slug with the S5 checks; a warning that the old address is retired for ever | `slug.*` codes |
| 5 | "Correct time zone" opens D8: a list of zones the API supplies; audited | |
| 6 | **"Allow one more application"** (Jafar 3; identity R-7) on P2 for a seller in `not-approved`, permission `identity.seller-access.approve`. Opens **D3**: "The owner can submit again and is emailed." (E23). The button is absent in every other state | `seller-access.wrong-state`; without the permission the button is disabled with the reason |
| 7 | A seller with `file-check-needed` (identity says approved but no approved revision exists; test data only) shows a Critical banner on P2 "This seller is approved but has no reviewed details. They can't sell until this is checked." There is **no action**: no path exists until a mini-review designs one (DD 3.1) | P1 lists these sellers under the filter "Needs a check" on All |

### F19. Admin-only settings, card C1 (SEL-12, SEL-25, SEL-26; AC 14, 15, 16)
| # | Step | Branch |
|---|---|---|
| 1 | P2 shows C1 with three rows (3.2) | No `sellers.seller-settings.edit`: the controls are disabled with the reason; AI row needs its own permission |
| 2 | Each row changes through D3 with the consequence in one sentence, then saves that row only | `conflict.stale`: row refreshes. Save failure: the control returns to the old value and the row shows the error |
| 3 | Each saved change shows "Changed by {admin} on {date}" under the row (read from the setting itself, with the admin's display name from identity R-11; DD 14.3 Reza 10) | |

### F20. Market setting "Require approval for new sellers" (SEL-15; AC 19)
Slice 15, after ADR 14.1. P4 holds one row. Turning off opens D3 with its consequences (3.2 P4); turning on
needs a plain D3. A Market with several hosted Markets shows the Market name in the page title; a change
never touches another Market. View-only roles see the row locked with the reason.

### F21. Approved seller: store profile and change request (brief 4-D; AC 20, 23, 24)
| # | Step | Branch |
|---|---|---|
| 1 | S7: Seller Owner or Staff with `sellers.store-profile.view` opens it; with `.edit` the fields are editable. Texts, phone and contact email save at once | Without edit: read-only fields and a banner; without view: B5 |
| 2 | The **business identity** values (store name, business name, business number, address) are read-only cards with "Request a change" (Seller Owner only) | Staff: the button is disabled with "Only the shop owner can change these details." |
| 3 | "Request a change" asks for re-confirmation (**D9**, depends on identity R-2); then the edit form; submit creates a change request. The current value stays live; the new value shows beside it in a `DataRow` with "Waiting for review" and "Cancel request". E18 goes to the sign-in address | `reconfirmation.required`: D9 (10-minute window bound to the session, never satisfied in acting-as); wrong password: field error; `file.change-pending`: "Another change request is waiting. Cancel it or wait for the decision." (both final codes, DD 14.3). Submissions count towards 5 a day per seller file |
| 4 | Admin decides on P3 (change-request variant). Approved: the value moves and E19. Not approved: the old value stays; E20. **S7 shows the last rejected request and its reason (the prepared reason's text) in the identity card until the owner starts a new request.** There is no dismissal (Jafar 5). The read returns only the latest rejected request, so an earlier one disappears when a newer decision exists | |
| 5 | Tax registration changes (yes or no, from a date) apply from that date, are not reviewed, are audited (Q4); the card says "MondaPac doesn't decide whether you must register." | |
| 6 | Slug and time zone are read-only on S7 with "To change this, contact us." (admin only, brief s7) | |

## 3. Screen specifications

### 3.0 Rules for every screen
1. **Shell.** Seller steps S2 to S6 sit in the **limited shell** of ID-UX F5 (compact header below 760 px,
   one destination). S7 sits in the full seller shell. Admin screens use the admin shell. Frames keep
   `Sidebar` and `Topbar` as instances.
2. **Step pages** (`Seller · Setup step`): back link "Back to your seller account"; H1; "Step {n} of {total}"
   as words; one card per group; a `FormActionBar` at the bottom (sticky below 760 px) with the primary
   "Save and continue", a secondary "Back to checklist", and a status text (Saved, Unsaved changes).
   Form column at most `size/form-max`.
3. **Validation, loading, errors** follow ID-UX 3.0 rules 3 and 4: error summary (Critical `InfoBanner`)
   takes focus; field errors are icon plus text under the field; the primary button shows
   `State=Loading` at the same width; lists load as 8 skeleton rows; no page spinner.
4. **Market-driven fields.** The address fields and their order, the postcode pattern, the region list,
   the phone pattern, the business-number label and help, the tax-registration question and the prepared
   reasons all arrive from the API as translation keys and field descriptors. The frontend has no
   field list, no `AU`, no `ABN`, no `GST`, no `AUD` and no country name. Examples below show the AU
   values only because AU is the launch Market.
5. **Never, on any screen:** the word "verified" about a business or a register match; a register value
   shown to a seller or placed in a reason; a message that a business number or slug is "already
   registered" by someone (the slug is public and may say "not available"; the number never does); any
   certification claim in copy, a badge or a field help; personal data in a URL path, page title or
   telemetry; a server message string.
6. **Permissions in the UI** follow ID-UX 3.0 rule 6: no View, no menu item, B5 on the URL; View without
   the action, the control is disabled and gives its reason. The panel renders the **allowed-actions
   list the API supplies** (ID-UX 8.2) and never infers a permission.
7. **Plain text.** Every text field shows what was typed. A line under free-text areas says "Plain text
   only. Web addresses and formatting are shown as typed." Display uses `dir="auto"` and keeps line breaks.
8. **Dates and times** use the viewing person's locale. Times that belong to a seller (submission, decision,
   change request, certificate-related times later) are shown in **the seller's work time zone, for the
   seller and for admins alike, with the zone named** ("10:14 AEST"); the Market's zone is used only when
   the seller has none yet (ADR-0005 decision 2; DD 14.3 Reza 11). Times that belong to the admin (a check
   they recorded) use the same rule and also name the zone. The zone's display name is formatted with
   `Intl` in the page locale.

### 3.1 Seller panel
| Screen and purpose | Content, top to bottom | Fields, validation, actions | States | Never shown |
|---|---|---|---|---|
| **S1 Your seller account** (changed). Where the seller stands, and what to do next | Status `StatusBadge` (3.3) and H1 as ID-UX. Card 1 status banner by state (3.3). Card 2: `ReasonQuote` (changes needed or not approved; owner only). Card 3 steps (`ChecklistItem`, each with a supporting line such as "2 fields left"): Account created, Email confirmed (identity); **Business details, Address and area, Business number, Shop web address** (sellers); a slot for `certification` steps, "(not needed to submit)"; **Review and submit**; MondaPac reviews your application (identity). Card 4 help (always last, ID-UX 3.2.6) with "Protect your account" | Each step with a route opens its page. "Withdraw submission" (D3) on `awaiting-review` only. "Submitted on {date}" under the status in `awaiting-review`. When MondaPac submitted on the seller's behalf a line says "MondaPac submitted these details for you on {date}" (accepted, Jafar). After a withdrawal an Info banner gives the cause and date (F14 step 5). "Contact us" links on the blocked states (support contact, Open 2) | Skeleton cards; load error with "Try again"; one banner and one step state per 3.3; `outside-service-area` makes Address and area "Needs attention" and the submit step "Waiting"; `ready-to-submit` shows the submit step as the one action | Other menu items; reviewer names; notes; internal checks; a promised decision time; register values |
| **S2 Business details** | Back link; H1; step counter; card "Your shop": Store name (help: "Customers see this name. Don't use words that claim a certification, and don't copy another brand." (L)); Business name (help: "The legal name of your business."); Phone; Contact email (optional; help: "For customers and MondaPac to reach your business. You still sign in with {signInEmail}."); the sign-in email as read-only text | Required: store name, business name, phone (`tel`, `autocomplete="tel"`; pattern from the Market). Contact email: format, `autocomplete="email"`. Text rules: no control, bidi or URL-like text (ID-UX HF13); lengths from the API | Default; dirty; saving; saved; field errors; `phone.required`; withdrawal banner (F14); read-only under `file.decision-in-progress`; load error | A second "repeat email" field; "confirm phone" |
| **S3 Address and area** | Card "Where your shop works from" with the Market's address fields in the Market's order (street, locality, region, postcode in AU). Below it a checkbox "My registered business address is different" (brief s7); ticked, it reveals a second group, "Registered business address", with the same Market-driven fields. Helper: "Only the address where your shop works from sets your service area and time zone." After save, a result block: "Your work time zone: {zoneName} ({zoneId})" with the current local time; or the outside-area banner. Line: "We use this to work out your local time for cut-offs and certificate dates. Only MondaPac can change it." | Fields from the descriptor; `autocomplete` tokens `address-line1`, `address-level2`, `address-level1`, `postal-code`. No lookup while typing | Saved inside an area; saved outside: Attention `InfoBanner` "We're not in your area yet. We've saved your details. You can submit once we open there." (no date promised); `timezone.unresolved`: Attention banner "We couldn't work out your time zone from this address. Check the address, or contact us." | The names of other areas, or which areas are open |
| **S4 Business number and tax registration** | Card 1: Business number, labelled `{identifierLabel}` with Market help (AU: "11 digits"). After save, a result under the field (below). Card 2: the Market's tax-registration question as a two-option `SegmentedControl` (Yes, No), with "MondaPac doesn't decide whether you must register." When the answer is Yes, a "Registered from" date field follows (domain design 14.3, Reza 13). Only when the Market's configuration makes the number optional is it marked "(optional)" | Number: required when `businessIdentifier.required`; format and checksum are checked **on save** by the server, with no live lookup. Tax answer required; the "Registered from" date required when the answer is Yes. Number is `dir="ltr"`, `inputmode` from the scheme, `autocomplete="off"` | Result states in `Field` status line: **Checking** ("Checking with the official register…", `role="status"`); **Matched** ("Matched with the official register", Success, `check`); **Not matched** (Critical, `alert-circle`: "We couldn't match this number with the official register. Check it and try again, or contact us."; one message for not found and cancelled); **Could not be checked** (Info: "We couldn't check this right now. You can still submit, and a reviewer will check it."); `lookup.limit` ("You've changed this number too many times. Try again later."); `identifier.format`, `identifier.checksum` (one text: "That doesn't look like a valid {identifierLabel}. Check the number and try again."); register not configured for the Market: no result line, no "could not be checked" message | Any register value (name, address, status text); "verified"; "already registered"; whether another seller holds the number |
| **S5 Shop web address** | Card: one input with the fixed prefix (the storefront address from Market configuration, `dir="ltr"`) and the slug; help "Lowercase letters, numbers and hyphens. {min} to {max} characters."; a status line under the field; "You can only change this later by asking MondaPac." | Checks on blur and after 600 ms idle, at most one request in flight; no check for an invalid format (the format error is local) | **Idle**; **Checking** (`role="status"`); **Available** (Success: "Available now. It's held for you when you submit."); **Not available** (`slug.taken` and `slug.reserved`: the same text, "That address isn't available. Try another."); `slug.format` (rule named in words); `request.throttled` ("Too many checks. Wait a moment.") | Why a slug is reserved; who holds a slug; a promise that "available" will still be true at submit |
| **S6 Review and submit** | H1; `InfoBanner` Info "MondaPac reviews these details before you can sell. You'll get an email when there's a decision."; card of `DataRow`s (Layout=Single): every saved value with an "Edit" link to its step; a **Missing** state (Attention, text "Missing") for each empty required value; a **Blocked** state for outside-area, time zone, or a definite register negative; at the bottom `FormActionBar` with "Submit for review" ("Submit again" after changes were needed) | Submit disabled with the reason beside it ("Finish {n} items first", linking to the first). One submit; the button shows Loading | Default; submitting; `file.incomplete`; blocked by area, zone or register; throttled; `file.decision-in-progress`; success moves to S1; `awaiting-review`: no button, "Withdraw submission" instead | Register result values; internal checks |
| **S7 Store profile** (PNL-02). Approved sellers edit what customers will read | Page title "Store profile". Cards: **General** (Store name, Business name, Business number, shown as read-only `DataRow`s with "Request a change"; Phone; Contact email; sign-in email read-only with "To change it, contact us."; when the API says AI is on for this shop, the read-only line "AI is on for your shop." with no control, Jafar 11); **Address** (read-only `DataRow`s for the operating and, when given, the registered address, both part of business identity, so changed only with "Request a change"; time zone read-only); **Description**; **Policies**; **SEO** (the brief's name; SEL-24 calls it "Meta"; title, keywords and description for search); **Social** (links); **Tax registration** (the Market's question, "from" date, "Record a change"); **Settings** (D 18, slice 20; spec in 3.1a): "Minimum order", one optional amount in the Market's currency, shown in the Market's price convention, default "No minimum"; editable with `sellers.store-settings.edit`, otherwise read-only; locale `Tab`s above the text cards only when the Market has more than one locale. `FormActionBar` per card group | Text areas with counters from the API. Social links: `https` only, hosts from an allow-list (facebook.com, instagram.com, youtube.com with `www.` and `m.`, DD 14.3; the helper names them); each URL at most 512 characters; links render with `rel="nofollow noopener noreferrer ugc"`; `link.host-not-allowed`. Phone and contact email apply at once. Staff with edit: same page; the identity cards show "Only the shop owner can change these details." | Default; dirty; saving; saved Toast "Saved."; field errors; **Pending**: the identity card shows `DataRow` (Layout=Compare, kind Change) with Current and Requested values, a "Waiting for review" Badge and "Cancel request" (D3); **Not accepted**: the same row with "Not accepted" and the prepared-reason text, shown until the owner starts a new request (no dismissal); **acting-as**: identity cards and tax card read-only with the acting-as banner (F13 notes); view-only (read-only fields, banner "You can view this page but not change it."); no view: B5; locked while a decision is recorded | The pending value on any public surface; the register's values; a version list; a control for the AI switch |

**3.1a S7 Settings card: minimum order (D 18, slice 20; Reza).** Built from existing `Card`, `Field`, `Input`
(with the `Prefix` of row 2 in section 4), `Button` and `FormActionBar`; no new component.
- **Layout.** Card title "Settings". One `Field` "Minimum order (optional)"; the default stays "No minimum". The `Input` has a fixed prefix showing the
  Market's ISO currency code (`AUD`, `NZD`, `MYR`; never a bare "$", which is ambiguous across Markets),
  then the amount. Help line under the label: currency code and price convention from Market configuration
  ("Amount in {currencyCode}, including GST" is the AU rendering; a Market with no tax convention omits the
  phrase). Second help line: "Customers can't check out your items with less than this. Shipping isn't counted. A change applies at once, including to open carts." A text action "Remove minimum" shows only while a value is
  saved. The card has its own `FormActionBar` (Save, status text).
- **Input behaviour.** `type="text"`, `inputmode="decimal"`, `autocomplete="off"`, `dir="ltr"` (digits stay
  left-to-right inside an RTL page). No `type="number"` (locale decimals, scroll-wheel edits, Persian
  digits). Parsing is by the page locale with `Intl`: accepts Latin, Persian and Arabic-Indic digits and the
  locale's decimal and grouping marks; the number of decimals allowed and the conversion to minor units come
  from the currency's exponent (`Intl.NumberFormat(...).resolvedOptions()`), never "x100" and never
  "AUD". A saved value is displayed in the field without grouping and elsewhere with
  `Intl.NumberFormat(locale, { style: "currency", currency })`. The request carries `Money`
  `{ amount, currency }` with the currency taken from the Market, not typed by the person.
- **States.**
  | State | Behaviour |
  |---|---|
  | None (default) | Empty field, no placeholder text. Under the field: "No minimum. Customers can order any amount." "Remove minimum" hidden; Save disabled until a change |
  | Set | Field holds the saved amount; "Remove minimum" visible; read-back line "Current minimum: {amount}" |
  | Dirty, saving, saved | As the other S7 cards: "Unsaved changes", Save shows Loading, then Toast "Saved." and the status text. Focus stays on Save |
  | Empty and saved | Valid: clears to "No minimum" (same as Remove). No error. The Toast is "Minimum removed." (not "Saved.") for both clearing the field and "Remove minimum" |
  | Invalid amount | `minimum-order.amount` (also raised locally for text that is not a number, zero, negative, or more decimals than the currency allows): `Field` Error "Enter an amount greater than zero, for example {example}." `{example}` is formatted from the locale and currency by code. Error summary takes focus (3.0); the typed text is kept |
  | Wrong currency | `minimum-order.currency` cannot come from the screen's own fixed prefix, so it means the Market changed under the page: Attention banner "This amount isn't in {currencyCode}. Reload the page and try again." with a Reload button; typed text kept |
  | Save conflict | Another session saved first (the save carries the expected version, D 18; a stale save is refused): Attention banner "This setting was changed somewhere else. The latest value is {amountOrNone}. Check it and save again." The field keeps the person's entry, the read-back line shows the latest, Save stays enabled. |
  | Load error | Card-level error with "Try again", as other S7 cards |
  | No edit permission | Read-only `DataRow` "Minimum order" with the formatted amount or "No minimum"; banner "You can view this page but not change it." No Save, no Remove |
  | No view permission | B5, as the whole page |
  | Acting-as | Read-only with the acting-as banner, because the value blocks checkout for buyers (decided, D 6.4; Hassan L4) |
- **Money formatting.** Always `Intl.NumberFormat` with the user's locale and the Market currency: en-AU
  "A$50.00" or "$50.00" (as `Intl` returns), fa-IR Persian digits and the locale's currency pattern. Do not
  concatenate a symbol and a number; do not store or display a derived amount (`sellers` does no tax).
- **Accessibility.** Visible label; help and error linked with `aria-describedby`; `aria-invalid` on error;
  the prefix is part of the accessible name through the help ("Amount in AUD"), not announced twice; "Remove
  minimum" is named "Remove minimum order"; saved and conflict messages are `role="status"` (the error
  summary is `role="alert"`); target 48 px (Touch) and one column at 320 px.
- **Persian.** Label "حداقل سفارش"; the English keys of section 5 are the source and the Persian text is
  translated from them in the i18n catalogue, with the Market's own currency and tax-convention words.
  The page is RTL, the amount field stays `dir="ltr"`.
- **Hand-off to cart (O-4 closed, Jafar, 2026-10-07).** The buyer messages below belong to cart's own ux
  spec, not to `sellers`; they are recorded here so cart builds the same wording. Money is formatted with
  `Intl` and the Market currency, never "$" or AUD. Each message is shown per seller group, and shipping is
  excluded from the amount compared.
  - **below-minimum:** "{seller} requires at least {minimum} per order. Add {remaining} more to check out."
    When the Market's convention is known, append "({priceBasis})" to {minimum}.
  - **check-unavailable:** "We can't check the minimum order for {seller} right now. Try again in a moment."
    Checkout stays blocked for that group, and the copy never implies "no minimum".
  - A seller with an explicit "none" gets no message.
  - **Edge cases.** A cleared minimum releases the cart on its next read. A currency mismatch shows
    check-unavailable to the buyer; the sellers domain design 18 runbook item covers it. Mixed tax flags are
    treated as check-unavailable.

### 3.2 Admin panel
| Screen and purpose | Content, top to bottom | Fields, validation, actions | States | Never shown |
|---|---|---|---|---|
| **P1 Sellers** (changed; template `Admin · Sellers`, Phase 3 frame). Find sellers and clear the queue | Title "Sellers" with count and Market name. Search field (store name, slug or the full `{identifierLabel}`). Tabs with counts: **Awaiting review** (default), **Incomplete**, **Changes needed**, **Not approved**, **Approved**, **Suspended**, **Invited**, **All**. `FilterChip`s: "Outside service area" on Incomplete; Kind (New application, Change request) on Awaiting review; "Needs a check" on All (`file-check-needed`, F18 step 7). Columns: Seller (store name over slug; owner name over email beneath on wide screens), Status (`StatusBadge`, 3.3), Kind (New application or Change request; Awaiting review only), Since, Actions. No KPI strip, health, order or certificate columns | Row menu (`Menu`): Review (Awaiting review) or Open; Suspend…, Lift suspension, View reason, Reset owner's two-step verification, Resend or Cancel invitation (identity actions as ID-UX P1). **Bulk bar on Awaiting review** only (F17). Primary "Add seller" (D6). Search is a POST body, never in the URL. Search works on **All, Awaiting review and Incomplete** (the tabs read from `sellers`' rows); on the tabs that come from `identity` (Changes needed, Not approved, Approved, Suspended, Invited) the field is disabled with "Search works on All, Awaiting review and Incomplete." (DD 7.8, the single rule). A row with a disabled approve or reject shows the reason beside it. Row menu adds "Allow one more application" for Not approved rows (D3, F18 step 6) | Skeleton rows; empty per tab (3.5); no result for a search: "No sellers match." with "Clear search"; load error with "Try again"; view-only roles (every action disabled with reason); a row whose decision is under way shows "Decision being recorded" and no actions | Sign-ups with an unconfirmed email; reason text in a row; business number in a row |
| **P2 Seller page** (template `Admin · Seller detail`) | Summary bar: store name; seller-state `StatusBadge` (3.3); a slot for the certification chip, **never merged with the seller badge** (CERT-12); owner name and email; actions "Review" (when pending), "Edit details", "Submit for this seller", "Change web address", "Correct time zone", and "Allow one more application" (Not approved only). Cards: Business details (`DataRow`s: store name, business name, business number, operating address and (when different) registered address, each labelled, phone, contact email, work time zone, slug, tax registration with its from date, created, origin: self-registered or invited); Status (identity state, link to P3, previous decisions summary); **C1 Admin-only settings**; a slot for Certificates (owned by `certification`); tabs **Overview** and **History** | Edit mode swaps `DataRow`s for the S2 to S5 fields with a `FormActionBar`. Edit-mode banners by state: approved "Changes to business identity apply at once and the owner is emailed."; awaiting review "Saving withdraws the pending submission."; suspended; invited (F18 step 1). Approved-seller edit includes Checks and register state (F18 step 2). Seller-owned times in the seller's zone, named | Skeleton; load error; **invited, not accepted** banner; **suspended** banner with "View reason"; view-only (no action buttons, a line); not found: B5 not found, byte-identical for another Market's id (AC 1); decision under way | A seller of another Market; AI-related data |
| **P3 Review a submission** (template `Admin · Seller review`, from `Admin · Certificate review`). Decide on one submission | Summary bar: store name, kind Badge, "Submission {n}", submitted date, time in the queue, "Submitted by the seller" or "Submitted by MondaPac", email confirmed (yes or no, from identity). Actions: **Approve**, **Reject…** (onboarding; permission `identity.seller-access.approve`) or **Approve change**, **Reject change…** (permission `sellers.identity-change.approve`). Main column: **(1) Details against the register**: `DataRow`s (Layout=Compare): label, seller's value, register value, flag: Matches, **Differs** (Attention: "Differs from the register. Check before you approve."), Not compared. Both addresses are shown, labelled "Operating address" and "Registered address" (the latter only when given). Compared fields are business name, tax registration and postcode. Banner by register state (3.2a). Fixed line: "A match doesn't prove the applicant controls the business." **(2) Checks**: one `CheckboxRow` per named check from Market configuration, with a "Required" `Badge`, and who recorded it and when. Includes the store-name check "Store name makes no certification claim and doesn't imitate another brand" (required, DD 16.2-6). **(3) Changes since the last submission**: a "Changed" mark on each changed row; **(4) History**: `TimelineItem` list of earlier submissions and decisions, with earlier reasons (visible to admins with the identity view permission). Side column: Status, Service area and time zone, **Other sellers with this business number** (list of store names, each with its status Badge and a link to P2; empty: "None found"), Email confirmed | Record a check: tick saves that one check at once (`State=Saving`, then recorded by you). Re-lookup button ("Look up again", `refresh-cw`), "Record a manual register check" (a check row, shown when the lookup was not performed or unavailable) with the Market's manual link: **admins only, on P3 only, never on a seller screen**; the URL is built by the server from a validated template and arrives ready to use; the link opens in a new tab with `rel="noopener noreferrer"` and its accessible name says "(opens in a new tab)"; frontend telemetry never records an outbound link URL (Hassan, recorded in 9). Each recorded check has an "Undo" text action that sets it back to not done (Jafar 1); the approval guard counts it missing. Approve: D3. Reject: D4. The page needs `sellers.business-details.view` (implied by the approve and reject permissions); without it P3 says "Your role can't view business details." | See 3.2a | Raw register responses; the register access key; a seller's decrypted values in the page title or URL |
| **P4 Seller settings** (Market; template `Shared · Settings`). Slice 15 | Title "Seller settings" with the Market name; one `SettingRow` "Require approval for new sellers" with a `Switch`, a description, and "Last changed by {admin} on {date}". A note: "Applies to new sign-ups in {marketName} only." | Turn off: D3 with the consequences listed (3.4). Turn on: plain D3. View-only role: locked, with "Your role can view these settings but not change them." | Loading; saving; saved Toast; stale; save failed (control returns to the old value); view-only; no view: B5 | A control for any other Market; any setting not built (brief s3 lists them) |
| **C1 Admin-only settings** (card on P2). Per-seller switches | `CardHeader` "Admin-only settings", subtitle "The seller can't change these." Three `SettingRow`s. **Allowed product types**: `SegmentedControl` "All types" or "Only selected types"; when selected, a `CheckboxRow` list of type names the API supplies. Until `catalog` supplies types (slice 14) the row is locked to "All types" with "Restricting types arrives with the product catalog." **Category proposals**: `Switch`, default off; description "Lets this seller suggest categories." **AI features**: `Switch`, default off; description "Turns AI suggestions on or off for this shop. AI never decides approvals, certificates or payments." (L) | Each row saves on its own through D3 (consequence sentence): restricting types: "Offers of a type that's no longer allowed are taken off sale."; turning off proposals: "Suggestions waiting for a decision are closed."; AI on: "We'll email the shop owner that AI is on for their shop."; AI off: no email. AI row needs `sellers.ai-switch.edit` | Per-row loading and saving; saved line with admin and date; error returns the control; locked rows show the reason in text; no edit permission: all three disabled | The AI state on any seller screen |
| **P2-H History tab** (VER-14; slice 19) | Table of revisions: date, kind, author kind (seller or admin), result. Values are hidden until the reviewer presses "Show values", after the line "Viewing this is recorded." | Requires `sellers.business-history.view` (protected) | Locked (no permission: tab hidden); loading; empty ("No history yet."); each reveal recorded | Values without the reveal step |

**3.2a P3 register states (DD 3.4).**
| State | Banner and effect on the page |
|---|---|
| `active` | Info "The official register lists this number as active." Mismatches flagged on rows. Approve allowed |
| `not-found`, `cancelled` | Critical "The register doesn't list this number as active." Approve disabled: "Approve is unavailable while the register result is negative." Reject allowed. The reviewer can ask the seller to correct |
| `not-performed`, `unavailable` | Attention "Lookup not performed" (or "The register couldn't be reached"). Shows the manual link, "Look up again" and "Record a manual register check". Approve disabled until a successful lookup or a manual check is recorded (AC 32): "Look it up again or record a manual check first." |
| Result older than the maximum age | Same as not performed ("The last lookup is out of date") |
| Market has no register adapter (`none`) | Banner "This Market has no register lookup. Record a manual check." with the manual link if configured |

**Approve is disabled, with the missing item beside the button,** when the API's denial code says so: a
required check is unrecorded or was undone (`review.checks-missing`: "Record {n} required checks first");
the register state blocks, including a result older than 30 days (`review.register-blocks`, above); the
submission is not the pending one (`review.not-current-revision`); another seller holds the number
(`review.identifier-held`); a decision is being recorded (`file.decision-in-progress`). The reason is text,
not a tooltip.

### 3.3 Seller-facing states (DD 3.3 mapped to words)
The Persian terms are the brief's (section 4 table). English is the panel text; legal reads the final
wording (L).

| Code | English badge | Persian (brief s4) | Tone, icon | S1 banner (title; body) |
|---|---|---|---|---|
| `details-incomplete` | Details needed | اطلاعات ناقص | Neutral, `clipboard` | "Finish your details"; "Complete the steps below, then submit them for review." |
| `ready-to-submit` | Ready to submit | (part of اطلاعات ناقص) | Info, `send` | "Your details are ready"; "Submit them for review when you're ready." |
| `outside-service-area` | Not in your area yet | بیرون از محدودهٔ فعال | Attention, `map-pin` | "We're not in your area yet"; "Your details are saved. You can submit once we open there." |
| `awaiting-review` | Awaiting review | ارسال‌شده، در انتظار بازبینی | Info, `clock` | "We're reviewing your application"; "We'll email you when there's a decision. Until then you can't sell. Changing your details withdraws your submission." |
| `changes-needed` | Changes needed | نیاز به اصلاح | Attention, `alert-circle` | "Your application needs changes"; "Read the reason, update your details and submit again." |
| `not-approved` | Not approved | سقف ارسال دوباره پر شده | Critical, `x` | "Your application wasn't approved"; "You've reached the limit for new applications. Contact us if you have questions." |
| `approved` | Approved | تأییدشده | Success, `check` | Not shown on S1 (Home) |
| `suspended` | Suspended | معلق | Critical, `ban` | No session; ID-UX A10 |

Seller states use `StatusBadge` (icon, tone and word as in the table); `Badge` stays for flags such as
"Required", "Waiting for review" and "Changed". Rules: badge = icon + word, never colour alone. "Approved" means MondaPac approved the seller to sell.
It is **never** shown as, or beside, a certificate status without the separate `CertChip` and a different
word; where both appear, the seller badge reads "Seller approved". `not-approved` and `suspended` share
the Critical tone and differ by icon and word (ID-UX 6). "Rejected" is never shown to a seller. The
admin sees the same words; the P1 tabs use "Changes needed" and "Not approved" for the two cases.
No review time is promised (Open 1).

### 3.4 Dialogs
Rules of ID-UX 3.3 apply (title names the action and object; destructive confirm opens with focus on
Cancel; sheet layout below 480 px; focus trap and return; no outside-click close while text is typed).
- **D3 (new uses).** Withdraw submission; Save and withdraw your submission (seller); Save and withdraw the
  submission (admin edit of an awaiting-review seller); **Allow one more application** ("The owner can
  submit again and is emailed."); Cancel change request;
  Approve (one sentence: "{storeName} gets full access to the seller panel and an email."); Approve change
  ("The new details go live at once and the owner is emailed."); Submit for this seller; Approve selected
  (with count); the C1 changes; Turn off approval ("New sign-ups in {marketName} won't need a person to
  approve them. A seller whose details are complete and whose business number the register lists as active
  with no differences is approved automatically; everyone else still goes to a person. Sellers already
  waiting aren't approved." ) and Turn on ("New sign-ups will wait for approval.").
- **D4 modes.** *Application* (single reject): optional `Select` "Prepared reason" (from the Market list;
  choosing one fills the text, which stays editable: Open 4) and required `Textarea` "Reason for the
  seller" with counter; helper from ID-UX plus "Don't copy values from the official register."
  *Bulk*: prepared reason required; its text shown read-only; no free text; the request lists each
  seller with its submission (F17). *Change request*: prepared
  reason required; no free text (DD 3.1). The seller reads the reason text in the email and on S1 or S7.
  An empty reason is a field error and nothing is sent.
- **D7 Change shop web address.** Current address read-only; new slug with the S5 status line; warning
  "The old address is retired and can never be used again."; "Change address".
- **D8 Correct time zone.** Current zone; `Select` of zones (from the API); helper "This changes cut-off and
  expiry times for this seller. The change is recorded."; "Correct time zone".
- **D9 Confirm it's you.** For a request to change business identity. Password field and, when two-step
  verification is on, the code (ID-UX A7 rules); "Continue". Wrong: `credentials.invalid`; throttled as
  elsewhere. Wording and flow belong to identity (R-2); this spec only fixes where it sits.
- **D10 Bulk result.** Three counts with icons and words (done, skipped, refused), the skipped and refused
  store names as a list with a one-line reason each, "Close".

### 3.5 Empty, loading, error and locked, in one place
| Surface | Empty | Loading | Error | Locked or read-only |
|---|---|---|---|---|
| S1 steps | n/a | 4 skeleton cards | "We couldn't load your account. Try again." | Steps after a blocked one show Waiting |
| S2 to S5 | A new file shows empty fields | Skeleton fields | Load error with "Try again"; save error keeps the text | `file.decision-in-progress`, view-only |
| S6 | "Nothing saved yet. Start with your business details." with a link | Skeleton rows | As above | No submit button in `awaiting-review` and `not-approved` |
| S7 | Description and similar: "Nothing here yet." in the text area helper | Skeleton cards | Section-level "Try again" | Staff or no edit; identity cards for non-owners |
| P1 | Awaiting review: "No sellers are waiting. You're up to date." Incomplete: "No incomplete applications." Changes needed, Not approved, Suspended, Invited: "No sellers here." Outside-area filter: "No sellers are outside the service area." | 8 skeleton rows | Card-level error with "Try again" | View-only: disabled actions with reasons |
| P3 | Other sellers: "None found." History: "No earlier submissions." | Skeleton cards | "We couldn't load this submission." | Withdrawn, decided, or decision under way: read-only |
| C1 | Never empty (defaults are written at creation; a missing row is a fault, DD 2.1): shows "We couldn't load these settings." | Skeleton rows | Row-level error | Rows locked by permission or by catalog availability |
| P4 | Never empty | Skeleton row | Row-level | View-only |
Session ended mid-form: the user returns to the same page after sign-in; **unsaved text is not kept**:
form state is in memory only, with no localStorage, sessionStorage, IndexedDB or service-worker cache on
seller and admin edit pages (Hassan's decision, recorded in 9). Saved details are kept. This overrides ID-UX
B3's keep-input rule for these pages.

## 4. Design-system impact (fills brief section 12)

"Existing" is `docs/design/figma/README.md` section 5, `icons.json` and the ID-UX components planned for
1.1.0 and 1.2.0 (marked "ID 1.1.0" or "ID 1.2.0"). All changes are additive: two MINOR releases.
**1.3.0 "Seller setup"** (seller steps, S1) and **1.4.0 "Seller admin"** (S7, admin screens). Both need
ID 1.1.0 and 1.2.0 first.

| Screen element | Existing library component or template | Change needed in Figma first | Release |
|---|---|---|---|
| Field with a status line (Checking, Available, Matched, Not available) | `Field` (ID 1.1.0): Label, Helper, Error, Counter | New property `Status` (None, Checking, Success, Info, Critical) with icon and text; `Checking` uses a static icon under reduced motion | MINOR 1.3.0 |
| Slug input with a fixed prefix; also the minimum-order amount (currency code as the prefix, S7 3.1a) | `Input` (+ Type=Password and Code, ID 1.1.0) | New BOOLEAN `Show prefix` and TEXT `Prefix` (left-to-right, muted); logical start side. Reused as is for the amount: no money component, no new token. Add a Usage note: amount fields show the ISO currency code, never a bare symbol | MINOR 1.3.0 |
| Step supporting line ("2 fields left"), route arrow | `ChecklistItem` (+ Waiting and Needs attention, ID 1.1.0) | New TEXT `Detail`; BOOLEAN `Show chevron` for a step that opens a page | MINOR 1.3.0 |
| Summary, read-only values, register compare, current vs requested | None | New component `DataRow`: Layout Single or Compare; slots Label, Value, Compare value, Flag (`Badge`), Action link; State Default, Missing, Blocked, Changed. Used on S6, S7, P2, P3 | MINOR 1.3.0 |
| Save bar on forms | Composed in ID-UX B3 | New component `FormActionBar`: Primary, Secondary, status text; State Clean, Dirty, Saving, Error; Sticky layout below 760 px. ID-UX B3 adopts it (additive) | MINOR 1.3.0 |
| Form column width | `size/*` has no content width | New dimension token `size/form-max` (design track picks the value on the existing scale; same in Desktop and Touch) | MINOR 1.3.0 |
| Yes/No and All/Only-selected | `SegmentedControl` | None. Document radio-group semantics in its Usage panel | n/a |
| Reviewer checks | `CheckboxRow` (ID 1.2.0) | New `State=Saving`; the description line carries "Recorded by {name} on {date}"; trailing `Badge` "Required"; BOOLEAN `Show undo` with a text action "Undo" on a recorded check | MINOR 1.4.0 |
| Switch rows in C1 and P4 | `Switch`, `CardHeader` | New component `SettingRow`: Label, Description, control slot, meta line ("Last changed by…"); State Default, Saving, Locked (with reason line), Error. Used on C1 and P4 and by every later SEL-15 setting | MINOR 1.4.0 |
| Bulk selection | `BulkActionBar`, `Checkbox`, `TableCell` | None. Add a selection-cap message state to the bar's usage panel | n/a |
| Row and account menus | `Menu`, `MenuItem` (ID 1.1.0) | None | n/a |
| Dialogs D3, D4, D7 to D10 | `Dialog`, `Select`, `Textarea`, `Toast` (ID 1.2.0) | None to the components; frames for each mode and use (section 8.1) | n/a |
| Seller state (S1, P1, P2) | `StatusBadge` | None: icon, tone and word of 3.3. `Badge` is kept only for flags ("Required", "Waiting for review", "Changed") | n/a |
| Seller and certificate badges side by side | `StatusBadge`, `CertChip` | None; rule in 3.3 | n/a |
| P1 and S7 unchanged components | P1: `Tab`, `FilterChip`, `TableCell`, `IdentityTile`, `Pagination`. S7: `Input`, `Checkbox`, `Switch`, `Button`, `Tab` | None. P1 has fewer columns than the existing `Admin · Sellers` frame in Phase 3 (no KPI strip, health, order or certificate columns) | n/a |
| Register result banner, edit warning, outside-area banner | `InfoBanner` | None | n/a |
| Quoted reason | `ReasonQuote` (ID 1.1.0) | None | n/a |
| Icons | 58 plus 9 from ID 1.1.0 | Add 3: `pencil`, `refresh-cw`, `globe`. Reused: `clipboard`, `map-pin`, `clock`, `send`, `alert-circle`, `x`, `check`, `ban`, `external-link`, `info`, `search` | MINOR 1.3.0 |
| Templates | Seller `Home`, `Orders`; Admin `Home`, `Sellers`, `Certificate review`; ID-UX `Auth`, `Seller · Your seller account`, `Shared · *` | New: `Seller · Setup step`, `Seller · Store profile` (form with grouped cards), `Admin · Seller detail`, `Admin · Seller review`, `Shared · Settings`. Updated frames: `Admin · Sellers` (Phase 3 columns, tabs, bulk), `Seller · Your seller account` (all 3.3 states) | MINOR 1.3.0 (Setup step, Your seller account) and 1.4.0 (the rest) |
| Mobile navigation | None (D16) | Not part of this module; blocks S7 and admin pages on phones | Open |

- **P3 checks use `CheckboxRow`, not brief s12's `ChecklistItem`,** on purpose: checks are ticked and saved
  one at a time (Saving state, Undo). The brief's change log needs a row for this.
- **Brief s12's "components not in README" list** is covered as follows: Select, Textarea, Dialog, Toast
  (ID 1.2.0); multi-select (a `CheckboxRow` list in C1, ID 1.2.0); slug field states (`Field` Status, row 1
  above); form states (error summary and focus, unsaved change, session end mid-form, save failure: 3.0,
  3.5 and `FormActionBar`); touch density (3.0 rule 2, 6); no-permission page (B5, ID-UX); D16 mobile
  navigation (still open, last row above).
- **Brief s12's two "(در G2)" blanks** (new templates; design-system version) are filled at the G2 record:
  five templates plus two updated frames, and version 1.4.0.
- **New components (3):** `DataRow`, `FormActionBar`, `SettingRow`. Each is used on at least two screens
  and in both panels, as the update procedure requires.
- **Changed components (4):** `Field`, `Input`, `ChecklistItem`, `CheckboxRow`. **New tokens (1):**
  `size/form-max`. **New icons (3).** **New templates (5)**, plus two updated frames.
- **Design-system version after this module:** 1.4.0, on top of ID-UX's 1.2.0. Nothing is renamed or
  removed, so no MAJOR. Light and dark both; the Audit plugin file must be clean (ADR-0017).

## 5. Copy

Keys are `sellers.<surface>.<element>[.<variant>]`, kebab-case, ICU MessageFormat, en-AU spelling. Errors
are `sellers.error.<code>`; unknown codes use `identity.error.unknown`. Values from Market configuration
are keys the Market owns (`{identifierLabel}`, `{taxQuestion}`, address labels, prepared reasons, check
names). (L) marks text for legal review.

**Words used everywhere:** details; business number (the Market's own label beside it, e.g. ABN);
"matched with the official register" and "not matched" (never "verified"); submit, submit again,
withdraw; awaiting review, changes needed, not approved; prepared reason; work time zone; shop web address.

| Key (prefix `sellers.`) | en-AU text |
|---|---|
| `steps.business · address · number · slug · submit` | Business details · Address and area · Business number · Shop web address · Review and submit |
| `steps.detail.fields-left` | {count, plural, one {# field left} other {# fields left}} |
| `steps.optional-cert` | (not needed to submit) |
| `step.counter · step.back · action.save-continue · status.saved · status.dirty` | Step {current} of {total} · Back to your seller account · Save and continue · Saved · Unsaved changes |
| `unsaved.title · body` | Leave without saving? · You have unsaved changes on this page. |
| `business.label.store-name · help.store-name (L)` | Store name · Customers see this name. Don't use words that claim a certification, and don't copy another brand. |
| `business.label.business-name · help.business-name · label.phone · label.contact-email · help.contact-email · label.sign-in-email` | Business name · The legal name of your business. · Phone · Contact email · For customers and MondaPac to reach your business. You still sign in with {signInEmail}. · Sign-in email |
| `address.title · help.zone · result.zone · action.contact` | Where your shop works from · We use this to work out your local time for cut-offs and certificate dates. Only MondaPac can change it. · Your work time zone is {zoneName} ({zoneId}). · Contact us |
| `error.address.outside-service-area` | We're not in your area yet. We've saved your details. You can submit once we open there. |
| `error.timezone.unresolved` | We couldn't work out your time zone from this address. Check the address, or contact us. |
| `number.label.tax-yes · .tax-no · help.tax` | Yes · No · MondaPac doesn't decide whether you must register. |
| `number.status.checking · .matched · .not-matched · .unavailable` | Checking with the official register… · Matched with the official register · We couldn't match this number with the official register. Check it and try again, or contact us. · We couldn't check this right now. You can still submit, and a reviewer will check it. |
| `error.identifier.format · .checksum · lookup.limit` | That doesn't look like a valid {identifierLabel}. Check the number and try again. (both codes) · You've changed this number too many times. Try again later. |
| `slug.label · help · help.later` | Shop web address · Lowercase letters, numbers and hyphens. {min} to {max} characters. · You can only change this later by asking MondaPac. |
| `slug.status.checking · .available` | Checking… · Available now. It's held for you when you submit. |
| `error.slug.taken · .reserved · .format · request.throttled` | That address isn't available. Try another. (taken and reserved) · Use {min} to {max} lowercase letters, numbers and hyphens, with no hyphen at the start, end or in a row. · Too many checks. Wait a moment. |
| `submit.title · banner · action.submit · action.again · help.blocked` | Review and submit · MondaPac reviews these details before you can sell. You'll get an email when there's a decision. · Submit for review · Submit again · Finish {count, plural, one {# item} other {# items}} first. |
| `submit.row.missing · row.blocked · row.edit` | Missing · Blocked · Edit |
| `error.file.incomplete · file.decision-in-progress · slug-lost` | Some required details are missing. They're listed below. · MondaPac is recording a decision. Try again in a moment. · That web address was taken before you submitted. Choose another. |
| `status.details-incomplete · .ready · .outside-area · .awaiting-review · .changes-needed · .not-approved · .approved · .suspended` | Details needed · Ready to submit · Not in your area yet · Awaiting review · Changes needed · Not approved · Approved · Suspended |
| `seller-badge.approved` | Seller approved |
| `status.submitted-by-admin` | MondaPac submitted these details for you on {date}. |
| `edit-warning.banner · dialog.title · dialog.body · dialog.action` | Your application is waiting for review. If you change anything, your submission is withdrawn and you'll need to submit again. · Save and withdraw your submission? · Your details will be saved and your submission withdrawn. Submit again when you're ready. · Save and withdraw |
| `withdraw.title · body · action` | Withdraw your submission? · It leaves MondaPac's review queue. Your details stay saved. · Withdraw submission |
| `profile.title · card.identity.locked · action.request-change · help.owner-only` | Store profile · These details need a review before they change. · Request a change · Only the shop owner can change these details. |
| `profile.help.plain-text · toast.saved · help.contact-only` | Plain text only. Web addresses and formatting are shown as typed. · Saved. · To change this, contact us. |
| `change.status.waiting · .not-accepted · action.cancel · title.cancel · body.cancel` | Waiting for review · Not accepted · Cancel request · Cancel this request? · Your current details stay as they are. |
| `change.label.current · .requested · help.live` | Current · Requested · Your current details stay in use until MondaPac reviews this. |
| `store-settings.title · minimum-order.label · .help.unit · .help.applies` | Settings · Minimum order (optional) · Amount in {currencyCode}{priceBasis, select, none {} other {, {priceBasis}}} (`priceBasis` is a Market key, for example "including GST") · Customers can't check out your items with less than this. Shipping isn't counted. A change applies at once, including to open carts. |
| `store-settings.minimum-order.none · .current · .action.remove · .remove-label` | No minimum. Customers can order any amount. · Current minimum: {amount} · Remove minimum · Remove minimum order |
| `store-settings.minimum-order.toast.removed` | Minimum removed. |
| `error.minimum-order.amount · .currency · .conflict` | Enter an amount greater than zero, for example {example}. · This amount isn't in {currencyCode}. Reload the page and try again. · This setting was changed somewhere else. The latest value is {amountOrNone}. Check it and save again. |
| `tax.title · help · action.record` | Tax registration · MondaPac doesn't decide whether you must register. · Record a change |
| `error.link.host-not-allowed` | Use a link to one of these sites: {hosts}. |
| `admin.title · search.label · search.help · search.disabled` | Sellers · Search sellers · Store name, shop web address, or the full {identifierLabel}. · Search works on All, Awaiting review and Incomplete. |
| `admin.filter.kind · filter.needs-check · banner.needs-check` | Kind · Needs a check · This seller is approved but has no reviewed details. They can't sell until this is checked. |
| `admin.action.allow-more · allow-more.title · allow-more.body` | Allow one more application · Allow one more application? · The owner can submit again and is emailed. |
| `admin.edit.banner.awaiting · banner.suspended · banner.invited` | Saving withdraws the pending submission. · This seller is suspended. Your edit changes business data only. · This seller hasn't accepted the invitation yet. Your edit changes their saved details. |
| `admin.edit.save-withdraw.title · body · action` | Save and withdraw the submission? · The pending submission leaves the review queue and the owner is told. · Save and withdraw |
| `admin.edit.need-both · no-details` | You also need permission to approve identity changes. · Your role can't view business details. |
| `error.file.change-pending · file.change-request-required` | A change request is waiting. Decide it first. (admin) / Another change request is waiting. Cancel it or wait for the decision. (seller) · Use Request a change for these details. |
| `error.limit.daily` | You've reached today's limit for this. Try again later. |
| `error.acting-as · banner.acting-as` | This can't be done while you're signed in as the seller. · You're signed in as this seller. Edit their details from the seller's page. |
| `status.submitted-on · status.withdrawn` | Submitted on {dateTime} · Your submission was withdrawn on {date} because MondaPac edited your details. Submit again when you're ready. |
| `status.ai-on` | AI is on for your shop. |
| `common.contact-us` | Contact us |
| `review.action.undo · review.undone` | Undo · Set back to not done. |
| `admin.tab.awaiting · .incomplete · .changes · .not-approved · .approved · .suspended · .invited · .all` | Awaiting review · Incomplete · Changes needed · Not approved · Approved · Suspended · Invited · All |
| `admin.kind.application · .change` | New application · Change request |
| `admin.filter.outside-area · empty.outside-area` | Outside service area · No sellers are outside the service area. |
| `admin.empty.awaiting · .incomplete · .other · .search` | No sellers are waiting. You're up to date. · No incomplete applications. · No sellers here. · No sellers match. |
| `admin.bulk.selected · cap · approve · reject` | {count} selected · You can select up to {max} sellers at a time. · Approve · Reject… |
| `admin.bulk.change-locked` | Change requests are decided one at a time. |
| `review.title · meta.submission · meta.by-seller · meta.by-admin · meta.confirmed` | Review {storeName} · Submission {number} · Submitted by the seller · Submitted by MondaPac · Email confirmed |
| `review.section.register · checks · changes · history · others` | Details against the register · Checks · Changes since the last submission · History · Other sellers with this {identifierLabel} |
| `review.flag.matches · .differs · .not-compared · .changed` | Matches · Differs from the register. Check before you approve. · Not compared · Changed |
| `review.register.active · .negative · .not-performed · .unavailable · .stale · .none` | The official register lists this number as active. · The register doesn't list this number as active. · Lookup not performed. · The register couldn't be reached. · The last lookup is out of date. · This Market has no register lookup. Record a manual check. |
| `review.register.disclaimer` | A match doesn't prove the applicant controls the business. |
| `review.action.relookup · manual-check · manual-link` | Look up again · Record a manual register check · Open the register's search page |
| `review.check.recorded · check.required · check.store-name` | Recorded by {name} on {dateTime} · Required · Store name makes no certification claim and doesn't imitate another brand. |
| `error.review.checks-missing · register-blocks · not-current-revision · identifier-held` (same keys for disabled actions) | Record {count, plural, one {# required check} other {# required checks}} first. · Approve is unavailable while the register result is negative. / Look it up again or record a manual check first. · This isn't the current submission. · Another approved or suspended seller already holds this number. Open that seller. |
| `review.busy · others.none · withdrawn` | A decision is being recorded. · None found. · This submission was withdrawn. |
| `reject.mode.application.title · .bulk.title · .change.title` | Reject this application? · Reject {count} applications? · Not accept this change? |
| `reject.label.prepared · label.reason · help.no-register · help.change` | Prepared reason · Reason for the seller · Don't copy values from the official register. · The shop owner sees the text of this reason. |
| `error.seller-access.reason-required` | Choose or write a reason before you continue. |
| `bulk.result.title · done · skipped · refused · skipped-help` | Result · {count} done · {count} skipped · {count} refused · Skipped: no current submission, or a decision is under way. |
| `slug-dialog.title · warning · action` | Change shop web address · The old address is retired and can never be used again. · Change address |
| `zone-dialog.title · help · action` | Correct time zone · This changes cut-off and expiry times for this seller. The change is recorded. · Correct time zone |
| `confirm-you.title · body · action` | Confirm it's you · Enter your password to change your business details. · Continue |
| `admin.edit.banner.approved · action.edit · submit-for · dialog.submit-for` | Changes to business identity apply at once and the owner is emailed. · Edit details · Submit for this seller · Submit these details for this seller? It's recorded as submitted by MondaPac. |
| `settings.card.title · subtitle · locked.types` | Admin-only settings · The seller can't change these. · Restricting types arrives with the product catalog. |
| `settings.types.title · .all · .selected · proposals.title · .help · ai.title · .help (L)` | Allowed product types · All types · Only selected types · Category proposals · Lets this seller suggest categories. · AI features · Turns AI suggestions on or off for this shop. AI never decides approvals, certificates or payments. |
| `settings.confirm.types · proposals-off · ai-on` | Offers of a type that's no longer allowed are taken off sale. · Suggestions waiting for a decision are closed. · We'll email the shop owner that AI is on for their shop. |
| `settings.meta.changed · help.view-only` | Changed by {name} on {date} · Your role can view these settings but not change them. |
| `market.title · approval.label · approval.help · note.market` | Seller settings · Require approval for new sellers · New sign-ups wait for a person to approve them. · Applies to new sign-ups in {marketName} only. |
| `market.off.title · body · action · on.title · body · action` | Turn off approval? · New sign-ups in {marketName} won't need a person to approve them. A seller whose details are complete, and whose business number the register lists as active with no differences, is approved automatically. Everyone else still goes to a person. Sellers already waiting aren't approved. · Turn off approval · Require approval? · New sign-ups will wait for approval. · Require approval |
| `history.title · reveal · reveal.notice · empty` | History · Show values · Viewing this is recorded. · No history yet. |

Emails (prefix `sellers.mail.`; each has `.subject`, `.heading`, `.body`, `.action`; account-type line and
ignore line from `identity.mail.common`):
| Template | Subject (en-AU) | Button |
|---|---|---|
| `change-requested` | You asked to change your MondaPac business details | Open your store profile |
| `change-approved` | Your MondaPac business details change was approved | Open your store profile |
| `change-rejected` (L) | Your MondaPac business details change wasn't approved | Read the reason |
| `edited-by-admin` | MondaPac edited your business details | Open your store profile |
| `ai-on` (L) | AI is switched on for your MondaPac shop | none |
| `reapply-allowed` (E23; owner of the text open, API needs 3) | You can submit your MondaPac application again | Open your seller account |

## 6. Accessibility, responsiveness, RTL and locale

Gate: WCAG 2.2 AA (ID-UX 6; the brief names 2.1 AA as its minimum).
- **Forms.** Real `<form>` with Enter to save; `autocomplete` tokens as in 3.1; labels visible and not
  placeholder-only; optional fields say "(optional)", no asterisks; the business-number field has
  `autocomplete="off"`. 3.3.7: nothing the user already gave is asked again; "Submit again" is prefilled.
- **Status messages.** The slug status, the register result, "Saved", "Recorded" and the bulk count use
  `role="status"` and announce once per result; the slug check is not announced per keystroke. Error
  summaries are `role="alert"` and take focus (ID-UX 3.0).
- **Focus order.** Steps: back link, H1, fields, `FormActionBar`. After a save that changes the page state
  (S3 result, S4 result), focus stays on the Save button and the result is a status message. After a
  decision on P3, focus moves to the page H1 of the next page.
- **Compare rows.** `DataRow` Compare is a description list or table with column headers ("Seller entered",
  "Official register", "Result"); "Differs" is icon plus text. Selecting a row in P1: each checkbox is named
  "Select {storeName}"; the selection count is a status message; menu buttons are "Actions for {storeName}".
- **Disabled controls** stay focusable when they give a reason (Approve, row actions, C1 rows) and the
  reason is text next to the control.
- **Dialogs.** As ID-UX; D4 and D7 keep typed text on an outside click.
- **Motion.** The "Checking" state is a static icon plus text under `prefers-reduced-motion`.
- **Targets.** 48 px on step pages (Touch density, as on Auth); 32 px on admin screens with a 24 px hit
  area for checkboxes. Toasts last at least 6 seconds and never carry the only copy of a reason.
- **Widths.** Smallest width 320 px for S1 to S7 and every dialog; design frames 360 and 1280.
  - S1 to S6 reflow to one column; the `FormActionBar` is sticky and the primary button is full width;
    two-column address pairs stack. Seller owners sign up on phones, so S2 to S6 are phone-first.
  - S7 is one column at every width, with cards stacked; it needs the mobile navigation (D16) on phones.
  - P1: full table from 760 px; below that each row is a stacked card with the same actions menu and no
    bulk selection (bulk is a desktop and tablet task; Jafar accepted). P2 and P3: the side column drops below the
    main column under 1024 px; Approve and Reject stay in the summary bar and repeat in a sticky bottom bar
    below 760 px. These need D16 on phones.
- **RTL.** Logical properties only; the slug, business number, phone, emails, URLs and the manual link
  stay left-to-right (`dir="ltr"` on their fields and values) inside an RTL page; free text uses
  `dir="auto"`; icons that point (back, chevron) mirror; the address field order is the Market's, not
  the page direction's. Text may grow 40%: buttons wrap, never truncate. No text in images.
- **Locale and Market.** Nothing is hardcoded to AU or AUD (3.0 rule 4). Dates, numbers and plurals come
  from the user's locale. The one money value is the S7 minimum order (3.1a): `Intl` with the user's locale and the Market's currency, minor units by the currency's exponent, no assumed AUD. A second Market with another identifier,
  address format and tax question must render with no code change; the second-fixture ZZ values are the
  test (ADR-0003 decision 9): a Storybook or Playwright case per Market fixture for S3, S4 and P3.
- **Certification claims.** No screen or email states or implies a certification. Seller "Approved" is
  never styled as a certificate. The store-name help text and the review check are the only places the word
  "certification" appears next to the store name, and they forbid claims.

## 7. Open points

Closed by the G2 reviews and DD 14.3 (kept here as a record, not as open items): bulk and device rules
(bulk below 760 px); version history for the seller (none); the manual register link and browser storage (Hassan,
sections 3.1 F13 notes and 3.2 P3); "Submitted by MondaPac" on S1 (Jafar accepted); the slice for P2-H
(slice 19); the AI line on S7 (optional, Jafar 11); the dismissal of "Not accepted" (none).

**Still open**
1. **Review time (owner question 16.1-2).** The spec follows the team recommendation: no promised time, and
   S1 and emails say none. If the owner answers otherwise, only the `sellers.status.awaiting-review` body
   and the identity keys change. Who reviews at launch is the owner's call; the UI shows nobody's name.
2. **Support contact (ID-UX 7.4; Jafar 6).** S1, S2 to S6 and S6's blocked rows ("Contact us"), A10 and
   the `not-approved` state all use it; they wait for the owner's answer there.
3. **Wording that needs legal.** "Matched with the official register", "Not matched", the store-name
   help, the AI row description and line, and E20, E22 and E23. They avoid "verified" and any
   certification claim; the final text is legal's.
4. **Prepared reasons.** I propose that choosing a prepared reason fills the editable text in D4 (single
   mode). The brief fixes only that bulk and change-request modes need a code. Jafar's review did not
   address it.
5. **"Your area is now open" email** (E24, DD 10, Jafar 7): a proposal for the owner or Hadi. If accepted,
   the template and its brief change-log row are added; until then S1 is the only place a waiting seller
   learns it.
6. ~~Brief change-log row for `CheckboxRow` replacing `ChecklistItem` on P3~~ Done: the row is in the
   brief's change log (2026-10-07). Jafar's acceptance of section 4 is recorded in 9.

### For Jafar
- **Step order, grouping and the phone-versus-tablet priority** are provisional (brief risk 14): five pages
  (details, address, number, slug, submit) are my reading. Research should test phone and address on one
  page; whether a seller without a business number exists in practice (Q3 is mandatory in AU); and the
  slug prefilled from the store name by code (S5, editable).
- **Accepted by Jafar, now fixed in the spec:** the certificate slot before "Review and submit" with "(not
  needed to submit)"; "Seller approved" beside a `CertChip`; the words "Details needed", "Not in your area
  yet", "Differs from the register. Check before you approve." and the disclaimer (legal review still
  needed); "Submitted by MondaPac on {date}" on S1; no version history for sellers; no bulk below 760 px.

### API needs (for Mohammad)
Items 1 to 14 of the first draft are answered in DD 14.3 (Reza 1 to 14) and are applied above: the status
read and withdrawal fields, address descriptors, slug codes, `validate-identifier`, editing suspended and
invited sellers, the review payload and `review.*` codes, `not-done` for a check, the change-request read
and codes, capability flags, P1 counts and search, setting metadata, the seller-zone rule, social hosts,
contact email and the "Registered from" date, and no mail for a submission on a seller's behalf. What
remains:
1. **Admin edit of an approved seller (Hassan H1):** the edit read must return the required checks, their
   state and the register state, so the form can show them; and the same `review.*` denial codes as hints
   before save. Confirm the shape.
2. **Withdrawal read:** confirm the cause values are exactly `edited`, `cancelled` and `reapply-refused`
   and that "by whom" is a kind (seller or admin), not a name.
3. **E23:** is the "allow one more application" email `identity`'s (R-7 says "with a mail") or `sellers`'
   (this spec's key `sellers.mail.reapply-allowed`)? One owner.
4. **Acting-as refusal:** the code returned when a seller-side business-identity action is refused in an
   acting-as session (DD 6.4); the spec uses `access.denied` with the banner of F13 notes until named.
5. **D9 (identity R-2):** what the re-confirmation collects and whether it is a dialog or a page belongs to
   `identity`'s UX; `sellers` only places the dialog before the change form.
6. **Daily limits:** `request.throttled` carries `retryAfterSeconds`; for 24-hour windows (5 submissions, 5
   new numbers, 10 withdrawals) confirm the same code is used, or a distinct one, so `error.limit.daily`
   can replace the minutes text.
7. **Minimum order (3.1a), resolved 2026-10-07:** a stale save is refused (version check); the upper
   bound is the per-Market `minimumOrderMax` (D 4.1), and above it the field shows
   `error.minimum-order.amount` with the Market's maximum; acting-as is read-only (D 6.4);
   `MarketConfig` supplies the `priceBasis` text key. The wording (D 18 O-4) is closed (Jafar, 2026-10-07).

## 8. Hand-off notes

### 8.1 Design track: what to build in Figma, in order
Follow `docs/design/figma/update-procedure.md` (Sandbox, review, publish, Export tokens). Both releases
need ID 1.1.0 and 1.2.0 first.
1. **1.3.0 "Seller setup":** `size/form-max`; icons `pencil`, `refresh-cw`, `globe`; `Field` Status;
   `Input` prefix; `ChecklistItem` Detail and chevron; `DataRow` (Single and Compare, all states);
   `FormActionBar`. Templates `Seller · Setup step` (frames for S2 to S6 including: the withdrawal
   banner, `file.decision-in-progress`, outside area, time zone unresolved, each S4 result state, each S5
   status, S6 with missing and with blocked rows, "Submit again") and the updated `Seller · Your seller
   account` (all states of 3.3, with and without a reason, with the certificate slot).
2. **1.4.0 "Seller admin":** `CheckboxRow` Saving; `SettingRow`; templates `Seller · Store profile`
   (default, pending change, not accepted, Staff read-only, view-only, multi-locale `Tab`; the Settings card in each state of 3.1a, in en and fa/RTL),
   `Admin · Seller detail` (invited, suspended, edit mode, view-only), `Admin · Seller review`
   (onboarding and change request; every register state of 3.2a; Approve disabled with each reason; a
   Differs row; changed marks; empty and populated "other sellers"), `Shared · Settings` (P4 states, C1
   states) and the updated `Admin · Sellers` Phase 3 frame (tabs, kind column, bulk bar, 50-cap message,
   empty states). Dialog frames: D3 (each use), D4 (three modes), D7 to D10.
3. Each release: README section 8 checklist, both themes, Audit with zero warnings, token export, changelog,
   README counts, `claude/design-status.md`. Owner review: a short Persian summary with screenshots of
   S1 (changes needed), S4 (result states) and P3.

### 8.2 Frontend track: which screens wait for which backend slice
Every screen also waits for ID-UX D1 and D2 ADRs and slice F0.

| Screens | Backend slice | Library release |
|---|---|---|
| S1 (sellers steps), S2, S3, S5 | 2 | 1.3.0 |
| S4 (tax, number, format) | 3; result states need 4a | 1.3.0 |
| S6, withdrawal flow | 5 | 1.3.0 |
| P1 Phase 3, P2 read | 6 | 1.4.0 |
| P3 read, checks, re-lookup, manual check | 7a-read | 1.4.0 |
| P3 single decision, D4, D3 uses | 7a-decide | 1.4.0 |
| P3 with automatic approval (no UI change; banner text only) | 7a-auto | 1.4.0 |
| S6 "Submit again", S1 not-approved, P2 "Allow one more application", E23 | 7b | 1.3.0 (S1, S6); 1.4.0 (P2) |
| P2 edit (both permissions, checks in the form), submit for seller, D7, D8, bulk and D10 | 8 (edit of an approved seller also needs 10) | 1.4.0 |
| S7 (identity change, D9) | 10 (with 12 for profile texts) | 1.4.0 |
| S7 texts and Social | 12 | 1.4.0 |
| C1 category proposals | 13; types 14; AI 16 | 1.4.0 |
| P4 | 15 | 1.4.0 |
| P2-H | 19 | 1.4.0 |

- Build the P1 row menu and the P3 action buttons from the allowed-actions list the API supplies.
- The panel server sends `x-market-id` (board request 6); labels, address fields and prepared reasons
  come from the API. Frontend acceptance includes the ZZ fixture rendering of S3, S4 and P3.
- Mail templates are built by the backend from the `sellers.mail.*` keys of section 5.
- **Before the frontend of S7 and the admin screens on phones:** the mobile navigation (D16).
- Slice 17 is one frontend PR per row of the table above (Ali change 5).

## 9. Review record (2026-10-07)

| Reviewer | Result | What was applied |
|---|---|---|
| Jafar (product-designer) | Accept with changes | Items 1 and 3 to 11 are applied in sections 1 to 5 and 7 (the codes and "Undo", "Allow one more application" and E23, admin-edit banners and the withdrawal line, no dismissal on S7, "Contact us" links, "Submitted on", suspended and invited banners, the Kind chip, the optional AI line). Item 2 is settled by D 7.8: search works on All, Awaiting review and Incomplete |
| Jafar, on section 1.4 | Accepted all four changes for design, with conditions (1.4); **the identity owner's acceptance (DD R-12) is pending: planned in identity mini-review 1, needed before slice 5** | |
| Jafar, on section 4 (brief s12) | **Accepts section 4 and brief s12 with six wording edits, now applied:** `StatusBadge` for seller states, the `CheckboxRow` note, the unchanged-components row, "SEO", the cross-reference to the brief's component list, and the note on the two blanks | |
| Hassan (security-tester) | Accept with changes, UX decisions applied | No browser storage and `no-store` (3.1 F13 notes, 3.5); manual register link admin-only on P3, server-built, `noopener noreferrer`, no telemetry (3.2 P3); admin edit of an approved seller needs both permissions and records the checks (F18); acting-as refusals (F13 notes); limits of DD 6.5 (F13, F17); `sellers.business-details.view` (F18, P3); social links (S7) |
| Ali (cto) | Accept with changes | Slice names in 8.2 (7a-read, 7a-decide, 7a-auto, 19); seller-zone times (3.0 rule 8); no approval by `sellers` alone (`file-check-needed`, F18 step 7) |
| Mohammad (DD 14.3) | Answered Reza 1 to 14 | API needs closed; six remain (7) |
| Reza, on D 18 minimum order (2026-10-07) | Accept with changes, applied | S7 Settings card specified in 3.1a (states, money formatting, accessibility, Persian note); copy keys in section 5; no new component, `Input` Prefix reused (section 4). Open 7a points resolved 2026-10-07 (see section 7 item 7) |
| Owner | Pending | Review time and support contact (7, 1 and 2); the "area opened" email proposal (7, 5) |
