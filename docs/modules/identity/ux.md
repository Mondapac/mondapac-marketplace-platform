# identity: flows and screens (G2 UX specification)

| | |
|---|---|
| Author | Reza (ui-ux-designer) — 2026-10-03 |
| Status | Approved at G2, 2026-10-03 (Jafar, Ali, Hassan); Figma 1.1.0 and 1.2.0 before any frontend slice. |
| Module | `identity`, tier A, Phase 2. G1 approved by the owner on 2026-10-02 |
| Reviewers | Jafar (product-designer), Ali (cto), Hassan (security-tester). Mohammad (software-architect) writes the domain design in parallel |
| Review applied | Jafar: changes 1 to 12 and his answers to the first draft's open points. Ali: required changes 8 and 9, his slice names and his owner list. Hassan: findings 2, 3, 6, 7, 13 and 15, the session lifetimes and his answers to the first draft's 7.3 |
| Used for | The Figma work (ADR-0017) and the frontend slices. No Figma work was done for this document |

**Ground truth**
- `docs/modules/identity/brief.md`: sections 2 to 5 (roles, scope, flows, hard rules, R1 to R12), 7
  (owner decisions), 10 (acceptance criteria 1 to 37), 11 (slices 0 to 13), 12 (screen list)
- ADR-0018, ADR-0017, ADR-0013, ADR-0020 decision 3; `docs/design/domain/platform-foundations.md`
  5.1 and 6 (state codes, access rules)
- `docs/design/figma/README.md` (library v1.0.0), `docs/design/figma/update-procedure.md`,
  `docs/design/tokens/`, and the plugin source `docs/design/figma/plugin/src/` as the record of what
  each library component contains
- `docs/design/frontend-kickoff.md` (accessibility, en-AU, RTL-ready, breakpoints);
  `docs/design/research/panels-ux-strategy.md` (principles in 5, seller Home "setup guide" in 6.3)
- `docs/features/`: SEL-01 to SEL-07, SEL-13, CUS-01, ADM-05, PNL-05, STO-13, INTL-11, EXT-04
- `docs/modules/sellers/brief.md` (G1): section 4 (the states a seller sees), section 7 (status
  words) and section 12
- Board `claude/tracks.md` revision 13: request 8 item 4 (landing page of a seller that is not
  approved, from `sellers` G1 of 2026-10-03) and request 10 (a native client later)

**Not verified.** The Figma file was not opened; the library inventory comes from its README and the
plugin source. Values that live in configuration appear as named values (`{min}`, `{duration}`);
the numbers G2 set are given beside them.

**Domain design.** Mohammad's `docs/design/domain/identity.md` is cited as "DD n", with its section
numbers as they stood at the G2 review. Where it names a state code or settles a rule this document
follows it; 7.2 lists what the screens still need from it. Reviews are cited as "Jafar n", "Ali n"
(his required changes) and "Hassan n" (his findings).

**IDs.** A = screen on the shell-less Auth template; S, P, B = screen inside the shell of the Seller
panel, the Admin (platform) panel, or both; D = dialog; E = email; F = flow. "Criterion n" is
acceptance criterion n of brief section 10; "slice n" is a row of DD 12.1, with Ali's names (1a to
1d, 8a, 8b).

## 1. Scope and inventory

Phase 2 UI is the two panels; the three account populations of ADR-0018 decision 3 sign in at
separate entry points. Customer screens are specified as **behaviour and copy only** (the "Cus"
variants): the brief makes Phase 2 customer work API and tests, the storefront has no design
direction, and customer flows get a mini-review when storefront design starts (brief sections 3, 4-D
and 8). Totals: **18 screens, 6 dialogs, 17 emails** (11 emails from the brief, 4 from the domain
design that Ali accepted, 2 required by Hassan 2 and 6).

### 1.1 Screens and dialogs
| ID | Name | Panel | Slice | Criteria | Priority | Note |
|---|---|---|---|---|---|---|
| A1 | Sign in | Seller, Admin, (Cus) | 2, 5, 7 | 1, 2, 3, 7, 13, 20 | P0 | States: error, throttled, session ended, signed out, password changed, two-step paused (Hassan 2) |
| A2 | Sign up | Seller, (Cus) | 1d, 5 | 3, 21 | P0 | No admin sign-up exists (criterion 22) |
| A3 | Check your email | Seller, Admin, (Cus) | 3, 5, 7 | 16 | P0 | Also the answer to sign-in with an unconfirmed email, and to an admin's sign-in after a two-step reset (Hassan 6) |
| A4 | Confirm your email (from the link) | Seller, (Cus) | 3, 5 | 5, 16, 19 | P0 | Asks for the account's password and completes sign-in (DD 6.7, 8.6-3) |
| A5 | Forgot password | Seller, Admin, (Cus) | 4 | 13, 21 | P0 | |
| A6 | Choose a new password | Seller, Admin, (Cus) | 4 | 8, 19 | P0 | **Merged:** "link expired" and "link already used" are one state (Hassan confirmed) |
| A7 | Two-step verification: enter code | Admin, Seller | 7, 12 | 7, 10, 30 | P0 Admin; optional Seller | **Merged:** "I have lost my device" is a mode of this screen |
| A8 | Two-step verification: set up | Admin (inside A9, or from the link in E16), Seller (from the link in E16) | 7, 8b, 12 | 10, 22, 30 | as A7 | **Merged:** backup codes are step 3, not a separate screen. Outside an admin's invitation acceptance, every enrolment starts from the mailed link (Hassan 6; his decision of 2026-10-03) |
| A9 | Accept invitation | Admin, Seller | 7 (admin), 9, 11 | 19, 22, 29, 31, 37 | P0; P1 for staff | Three variants plus "invitation not usable". The admin variant holds the A8 steps (Hassan 6) |
| A10 | Account suspended | Seller | 5, 9 | 7, 14 | P0 | No session exists; reason for the Seller Owner only |
| A11 | Confirm the reset of two-step verification | Seller | 12 | 30, 33 | optional Seller | From DD 7.3: the Seller Owner confirms, by the link in E15, a reset that an admin started |
| S1 | Your seller account (landing while not approved) | Seller | 5, 9 | 4, 6 | P0 | **Merged:** "awaiting approval" and "changes needed" are states of one page (Jafar 6) |
| P1 | Seller accounts | Admin | 9 | 4, 5, 6, 9, 14, 31 | P0 | A Phase 2 frame of the existing `Admin · Sellers` template (Jafar 9) |
| B1 | Members ("Team" / "Admins") | both | 8a, 8b, 11 | 23, 25, 29, 33, 34, 35 | P0 Admin, P1 Seller | Tab 1 of "Team & roles" (Seller) and "Roles & permissions" (Admin) |
| B2 | Roles | both | 8a, 10 | 25 | as B1 | Tab 2 |
| B3 | Role: view, create, edit | both | 10, 11 | 23, 24, 25, 35, 36 | as B1 | One editor for both panels (decisions 8 and 8b) |
| B4 | Account security | both, (Cus: password) | 4, 7, 12 | 30, 32 | P0 | Change password; two-step verification |
| B5 | No access | both | 8a | 9, 15 | P0 | Second state "not found", the same for another seller's or Market's record (Hassan) |
| D1 | Invite a team member / an admin | both | 8b, 11 | 22, 29, 37 | as B1 | |
| D2 | Change role | both | 8a, 11 | 23, 26, 33, 34 | as B1 | |
| D3 | Confirm action | both | 8b to 12 | 14, 25, 33 | P0 | One dialog, eight uses (3.3) |
| D4 | Reject seller, reason required | Admin | 9 | 6 | P0 | Its read-only state serves "View reason" |
| D5 | Suspend seller, reason required | Admin | 9 | 14 | P0 | |
| D6 | Add seller (sends an invitation) | Admin | 9 | 5, 31 | P0 | |

### 1.2 Emails
Text templates, outside Figma. Every email names its account type (criterion 3).

| ID | Email | To | Slice | Criteria | Priority |
|---|---|---|---|---|---|
| E1 | Confirm your email | New seller or customer account | 3 | 16, 19 | no feature ID |
| E2 | Welcome | Seller, after the email is confirmed | 5 | 4 | P0 (SEL-02) |
| E3 | A seller is waiting for approval | Admins who may approve, only after the seller's email is confirmed | 9 | 16 | P0 (SEL-02) |
| E4 | Seller approved | Seller Owner | 9 | 4 | P0 (SEL-02) |
| E5 | Application needs changes, with the reason | Seller Owner only | 9 | 6 | P1 (SEL-13), needed by decision 9 |
| E6 | Account suspended, with the reason | Seller Owner only | 9 | 14 | P1 (SEL-13) |
| E7 | Suspension lifted | Seller Owner | 9 | 14 | P1 (SEL-13) |
| E8 | Reset your password | Any existing account | 4 | 8, 19, 21 | P0 (SEL-05) |
| E9 | Invitation: seller created by an admin | Invited seller | 9 | 31 | P0 (SEL-06) |
| E10 | Invitation: seller team member | Invited person | 11 | 29, 37 | P1 (PNL-05) |
| E11 | Invitation: admin | Invited person | 7, 8b | 22, 37 | P0 (ADM-05) |
| E12 | You already have an account | Holder of an existing account when someone signs up with the same email, or invites it to a team | 3, 5, 11 | 21 | From DD 6.7; not in the brief, accepted by Ali |
| E13 | Your password was changed | The account, after a reset or a change | 4 | 8, 32 | From DD 3.7 and 9; not in the brief, accepted by Ali |
| E14 | Two-step verification was changed or reset | The account | 7, 8b, 12 | 11, 30 | From DD 3.6 and 9; not in the brief, accepted by Ali |
| E15 | Confirm the reset of two-step verification | Seller Owner | 12 | 33 | From DD 7.3; not in the brief, accepted by Ali |
| E16 | Set up two-step verification (a link valid for 60 minutes) | Admin, at the first sign-in after a reset; a seller-side account on request, from B4 or S1 (Hassan, 2026-10-03) | 7, 8b, 12 | 10, 30 | Required by Hassan 6; not in the brief |
| E17 | Too many wrong two-step codes | The account, when its factor step is paused | 7, 12 | 11, 13 | Required by Hassan 2; not in the brief |

### 1.3 Listed in the brief or the task, and not designed
- **Deactivate a customer account** (brief section 3): the use case and its permissions stay (DD
  5.3), but Phase 2 has no customer list to reach it from: API and tests only. "Find and deactivate
  a customer" goes on the board as a mini-review that must land before the first real customer
  (Jafar, answer 5).
- **Session list and "sign out other sessions"**: not in the brief, so no screen (DD 14.1 item 9;
  Ali: not in Phase 2). Other sessions end by the rules of brief section 5.
- **Terms acceptance (VER-11)** waits for the `legal` module; until then the legal slot of A2 and A9
  holds only the privacy collection notice (Jafar 12). **Changing the sign-in email** is out of
  scope.
- **Re-applying** is not in Phase 2: it has no caller before `sellers`, whose G2 owns the step and
  its wording. "Allow another application" is not in Phase 2 either; it moves to the `sellers` G2
  (Ali, 14.1 item 8). A seller whose application needs changes reads the reason and the support
  contact (Jafar 1).

## 2. Flows

The API answers with a stable state code; the UI maps it to a translation key (section 5) and never
shows server text (brief section 6, INTL-11). Codes are those of DD 5.2 (`session.invalid`,
`access.denied`, `access.seller-not-approved`, `request.throttled`, `conflict.stale`), DD 6.3
(`credentials.invalid`, `email-verification-required`, `second-factor-required`,
`second-factor-enrolment-required`, `account.disabled`, `membership.none`,
`seller-access.suspended`, `signed-in`) and DD 8.6 item 1. Names DD does not have yet are
**proposals** for Mohammad (7.2). Three answers can follow any step and are not
repeated: `market.*` (generic error page), `request.throttled` with `retryAfterSeconds`, and
`session.invalid` (A1 with "session ended"). **Uniform answer** means the same status, body and
screen whether or not an account exists. No flow depends on something only a browser can do (8.2).

### F1. Customer sign-up and email confirmation (behaviour only; CUS-01)
| # | Step | Failure or branch: state code and what the user sees |
|---|---|---|
| 1 | The customer opens sign-up from the storefront (link targets are configurable). The page says "customer account" | — |
| 2 | Enters email and password and submits | `validation.failed`: field errors. `password.rejected` with its rule: error on the password field |
| 3 | The API answers `sign-up.accepted` for a new email and for one that already has a customer account (uniform answer). The UI shows A3 | Existing account: nothing is created; its holder gets E12 instead of E1 |
| 4 | The customer opens the link in E1 and types the account's password on A4 (DD 6.7). Confirming completes sign-in (DD 8.6-3, Jafar 2): the customer is signed in and returns to the storefront with "Email confirmed" | `link.rejected` (unknown, expired, used, other Market, other account type: one answer): A4 "link not usable" with "Send a new link", answered `verification-resend.accepted` for any address. Wrong password: `credentials.invalid`. A deactivated account: `account.disabled` |
| 5 | Later sign-ins follow F2. Customers confirm their email before their first session (DD 3.2, accepted by Ali), which keeps step 3 uniform | Not confirmed yet: `email-verification-required`, then A3 |

### F2. Sign-in, every population (SEL-04, CUS-01, admin)
The seller panel, the admin panel and (later) the storefront each have their own sign-in URL. No
page offers a switch that carries typed credentials to another population.

| # | Step | Failure or branch: state code and what the user sees |
|---|---|---|
| 1 | The user opens one population's sign-in page. Badge, H1 and page title name the account type | — |
| 2 | Submits email and password | Unknown email, wrong password, an account of another population or Market: `credentials.invalid`. One message; the password field is cleared |
| 3 | The same submit, after repeated failures | Too many failures for the account or for the origin (Hassan 3: 30 in 15 minutes from one address or IPv6 /64): `request.throttled` with `retryAfterSeconds`, the same generic message for both counters and for an email with no account. "Forgot password?" stays usable (criterion 13) |
| 4 | Password correct, email not confirmed | `email-verification-required`: A3 with resend. No session |
| 5 | Password correct, second factor enrolled | `second-factor-required`: A7 (F7). Nothing about the account's or the seller's status is shown yet (criterion 7). After 10 wrong codes in 24 hours the factor step is paused (F7 step 1) |
| 6 | Password correct, admin without a second factor (only after a reset: an admin first enrols inside invitation acceptance) | `second-factor-enrolment-required`: a link is mailed (E16) and A3 says so (F6 step 6). No session |
| 7 | Authentication complete: customer, admin, or member of an approved seller (`signed-in`). Go to the return URL if it belongs to this panel, otherwise Home. Staff see only what their role permits | No session, and A1 says why (DD 6.3 step 6): `account.disabled` for a deactivated admin or customer account; `membership.none` for a seller-side account that is no longer in a team |
| 8 | Authentication complete, seller awaiting approval or whose application needs changes: limited session, `sellerAccess: pending` or `rejected`. Go to S1 (F5) | — |
| 9 | Authentication complete, seller suspended | `seller-access.suspended`, no session: A10. `reason` is present only for the Seller Owner |

### F3. Password reset and change (SEL-05, used for every population)
| # | Step | Failure or branch |
|---|---|---|
| 1 | "Forgot password?" on A1 opens A5 for the same population. The user enters the email | `validation.failed` (format only) |
| 2 | The API answers `password-reset.accepted` whether or not the account exists; A5 shows its "sent" state. E8 goes only to an existing account | `request.throttled`: the wait time, identical for any email |
| 3 | The user opens the link (valid for 60 minutes) and enters a new password on A6 | `link.rejected`: A6 "link not usable", back to A5. `password.rejected`: field error |
| 4 | Done: every open session of the account ends. The user lands on A1 with "Password changed". They are not signed in automatically, so the second factor is never skipped. E13 is sent | — |
| 5 | Change while signed in (B4): current password, new password, and a code when two-step verification is on (DD 6.5). Other sessions end, the current one continues; E13 is sent | `password.current-incorrect`, `password.rejected`, `second-factor.code-rejected` |

### F4. Seller sign-up to first sign-in, then rejection and suspension (brief 4-A)
| # | Step | Failure or branch |
|---|---|---|
| 1 | A2: name, email, password (one field with show/hide, Jafar answer 4) | `validation.failed` (also for a name with control, bidi or URL-like text, Hassan 13), `password.rejected` |
| 2 | `sign-up.accepted` (uniform answer): A3 with "Send it again" (answered `verification-resend.accepted` for any address) and "Wrong address? Sign up again" | `request.throttled` on resend |
| 3 | The link in E1 opens A4; with the password typed there the email is confirmed and sign-in completes (DD 8.6-3). E2 goes to the seller; only now E3 goes to the admins (from slice 9, where reviewers first exist) | `link.rejected`, `credentials.invalid` |
| 4 | The seller lands from A4, and from every later sign-in (F2). Approval required (on for the AU Market): S1 "awaiting approval". Approval not required: Home, and S1 is never shown (criterion 5) | — |
| 5 | An admin approves (F9): E4. The seller's next request has full access; Home replaces S1 | — |
| 6 | An admin rejects with a reason: E5 to the Seller Owner, and the seller's sessions end (DD 3.3). After the next sign-in S1 shows "changes needed", the reason and the support contact (Jafar 1 and 6) | — |
| 7 | Phase 2 has no way to re-apply and no "allow another application" (1.3). With `sellers`, its submit-for-review step re-applies; after the re-apply limit S1 shows the final state "not approved" (Jafar 6) | — |
| 8 | An admin suspends: E6. Open sessions end at their next request (A1, "session ended"); the next sign-in ends on A10. Lifted: E7, and sign-in works again | — |

### F5. Limited sign-in and the landing page of a seller that is not approved
Answers board request 8 item 4, decision 6 and brief section 12; Jafar agreed, with change 7. DD
8.5 describes the same page, with the same title, from the domain side.
- **One page, one route.** While the session is limited, the seller panel's Home route renders S1
  "Your seller account", inside the `AppShell`, with navigation reduced to what the server
  allow-list permits: in Phase 2 this page, Account security and Sign out.
- **Cards in a fixed order:** status banner; the reason (changes needed, Seller Owner only); a steps
  card; help. `identity` owns the first two and three steps: "Account created", "Email confirmed",
  "MondaPac reviews your application".
- **Step contract (Jafar 7).** A step is {owning module, title key, state, optional route}. Its
  state is one of Done, To do, Waiting, Needs attention (the `ChecklistItem` states). A step with a
  route opens its own page in the limited shell, and that page returns to S1; S1 never holds an
  inline form. This suits phones and lets `certification` own its step.
- **Hand-over without a redesign.** In Phase 3 `sellers` adds its steps before the review step ("Add
  your business details", later the certificate step), each with its own page. The seven seller
  states of the `sellers` brief (section 4) become variants of the status banner; approved and
  suspended never reach S1 (Home and A10). Route, title, template, banner and step component stay:
  the `sellers` landing **is** S1 with more steps. After approval the route is the normal Home
  (`panels-ux-strategy.md` 6.3).
- **Contract.** Status, reason and dates come from `identity`'s API; the frontend assembles the
  steps from definitions that each module owns, so `identity` never imports `sellers` (R7).
- **Phone width.** Seller Owners sign up on a phone. Below 760 px the limited shell is a compact
  header (brand mark, account menu); with one destination no drawer is needed, so S1 does not wait
  for the undesigned mobile navigation (D16).

| # | Step | Failure or branch |
|---|---|---|
| 1 | Sign-in, or confirming the email on A4, completes with `sellerAccess: pending` or `rejected`: S1 | Any route not on the server allow-list redirects to S1 (Jafar 7); any other API call is `access.seller-not-approved` (DD 5.2; criterion 4) |
| 2 | S1 re-reads the status on load and when the window regains focus; it does not poll. Approved: Home and the full navigation replace it | The status cannot be loaded: inline error with "Try again" |
| 3 | Staff cannot meet this page under DD 3.3 (a seller with a team never returns to these states). If that changes, Staff see the status without the reason | — |

### F6. Admin enrolment: inside invitation acceptance, and again after a reset (criteria 10 and 22)
Hassan 6: a password alone never enrols a second factor. An admin's first enrolment happens inside
invitation acceptance; enrolling again after a reset also needs a link mailed to the account.

| # | Step | Failure or branch |
|---|---|---|
| 1 | The admin opens the link in E11 (valid for 72 hours, Hassan 15); the first admin's invitation comes from the operator routine (DD 7.4). A9 admin variant: name and password, then "Continue" | `invitation.rejected`: A9 "not usable" |
| 2 | Still inside A9, A8 step 1: a QR code, the same key as text with Copy, and an "Open authenticator app" link | — |
| 3 | A8 step 2: enter the 6-digit code the app shows. A correct code accepts the invitation: from here the account exists, with the factor on | `second-factor.code-rejected`: field error. After too many wrong codes the attempt ends and the link starts again at step 1 with a new key. Leaving before a code is accepted creates nothing; the link stays usable until it expires (7.2-2) |
| 4 | A8 step 3: ten backup codes (DD 7.3), shown once, with Copy, Download and Print. Ticking "I've saved these codes" enables "Continue" | Leaving early: enrolment stands; the codes cannot be shown again, only replaced in B4 |
| 5 | A1 of the admin panel with "Your account is ready. Sign in." (no session, DD 3.4). Sign-in is password and code (A7), then Admin Home | — |
| 6 | After a reset (F7 step 5) the admin signs in with the correct password. The API answers `second-factor-enrolment-required` and mails E16, a link valid for 60 minutes; A3 says so, with "Send it again" | `request.throttled` on resend |
| 7 | The link opens A8 on the Auth template: the password first (as on A4), then steps 1 to 3. A correct code ends in a session: Admin Home | `link.rejected`: A8 "link not usable" with "Back to sign in" (signing in again mails a new link). `credentials.invalid` |

### F7. Second-factor challenge, recovery and reset
| # | Step | Failure or branch |
|---|---|---|
| 1 | A7: enter the 6-digit code and press "Verify" | `second-factor.code-rejected` (does not say whether the code was wrong or late); `second-factor.challenge-ended`: back to A1. After 10 wrong codes or backup codes in 24 hours (Hassan 2) the factor step is refused for 24 hours or until a password reset, and E17 is sent: A1 says so and offers "Forgot password?" |
| 2 | "Use a backup code instead" (same screen, second mode): one code, single use. B4 then shows how many are left | The same two codes |
| 3 | No phone and no backup codes: A7 says who can help (DD 7.3). Staff: the Seller Owner. Admin: another admin who may reset it. Seller Owner: the support contact (7.4), which follows a written identity check before an admin starts the reset (Hassan's answer to the first draft's 7.3 item 4). The last Platform Administrator: the operator, with no screen | — |
| 4 | Reset by another person, with D3. A Staff member: the Seller Owner, from B1. An admin: another admin, from B1. A Seller Owner: an admin starts it from P1, E15 goes to the owner, and nothing changes until the owner opens its link (valid for 24 hours, Hassan 15) and confirms on A11 | The action is disabled, with the reason, when R1 or R11 forbids it. A11 with a bad link: `link.rejected` |
| 5 | After a reset the target's sessions end and E14 is sent. An admin enrols again through the link of E16 at the next sign-in (F6 steps 6 and 7); a seller-side account signs in with its password and B4 shows two-step verification as off, and setting it up again starts from the link in E16 | — |

### F8. Invitation acceptance (admin, seller team member, seller created by an admin)
| # | Step | Failure or branch |
|---|---|---|
| 1 | The link in E9, E10 or E11 opens A9. The API returns a summary of the invitation: account type, invited email, role name, and for staff who invited them (DD 8.6-5) | `invitation.rejected` (unknown, expired, used, cancelled, role deleted, seller no longer approved, inviter no longer active or allowed, other Market: one answer): A9 "not usable". No account is created (criterion 37) |
| 2 | The invitee gives their name (staff and admin) and chooses a password. The email is fixed and read-only (criterion 29). An existing seller-side account with no team signs in instead (DD 6.7). Admin: the A8 steps follow inside A9 (F6 steps 2 to 4) | `validation.failed`, `password.rejected`, `credentials.invalid` |
| 3 | The account now exists and no session is created (DD 3.4): A1 of that population with "Your account is ready. Sign in." | — |
| 4 | First sign-in. Admin: password and code, then Admin Home (criterion 22). Seller team member: the inviting seller's panel, with the invited role only. Seller created by an admin: S1 "awaiting approval" when approval is required (criterion 31), otherwise Home | — |

### F9. Admin review of a seller (SEL-03, SEL-06, SEL-07, decision 9)
| # | Step | Failure or branch |
|---|---|---|
| 1 | P1 opens on the tab "Awaiting approval". Each row carries the actions the API allows | An admin with View only sees the actions disabled with the reason (criterion 9); a direct call is `access.denied` |
| 2 | Approve, on "Awaiting approval" rows only: D3 confirmation. Toast; E4 is sent. A seller whose application needs changes cannot be approved (DD 3.3; Jafar 1) | `seller-access.wrong-state` or `conflict.stale` (the status changed meanwhile): the row refreshes and a message explains |
| 3 | Reject…, on "Awaiting approval" rows only: D4 with a required reason. E5 is sent | `seller-access.reason-required` (also checked before submit); `seller-access.wrong-state` as in step 2 |
| 4 | Suspend… (approved sellers): D5 with a required reason. Every session of that seller ends. E6 is sent | As step 3 |
| 5 | Lift suspension: D3. E7 is sent | As step 2 |
| 6 | Add seller: D6 with name and email. A row appears under "Invited" with Resend and Cancel | `validation.failed` |
| 7 | Phase 3 (DD 8.4) | Approve and reject move to the `sellers` review screen and leave P1; suspend and lift suspension stay |

### F10. Role editor, both panels (ADM-05, PNL-05, R1 to R12)
| # | Step | What the user sees of the rules |
|---|---|---|
| 1 | B2 lists system, default and custom roles ("Owner", "Ready-made" and "Custom" in the seller panel, Jafar answer 7) with their member counts | No custom role yet: empty state with "Create role" |
| 2 | Opening a system or default role shows B3 read-only. A default role offers "Duplicate" | R3, R9, R10: no Edit or Delete on these roles; a banner says why. Direct call: `role.read-only` |
| 3 | "Create role" or "Duplicate" opens B3: a name and permissions from this panel's catalogue only. "Duplicate" fills in the name "Copy of {roleName}"; permissions the user can't give arrive unticked, with a banner (Jafar 11) | R2: the other panel's permissions never appear. `role.name-taken`, `role.limit`; a name with control, bidi or URL-like text: `validation.failed` (Hassan 13) |
| 4 | The user ticks permissions | R1: a permission the user does not hold is disabled, with the reason. R11: a protected permission carries a "Protected" tag and is disabled unless the user holds the system role; in the seller panel no one can give it in Phase 2, the owner included (DD 5.4), and the reason says so (Jafar 5). Tampered request: `role.not-grantable`, nothing is saved |
| 5 | Save. The toast says the change applies from each person's next action | R4. R10 is stated on the page: new features are never added to a custom role automatically |
| 6 | Delete a custom role: D3 | Delete is disabled while members hold the role (`role.in-use`, DD 2.3). The dialog says how many pending invitations stop working (R12) |
| 7 | Rules with no control of their own: R5 to R8 | Their one UI consequence: role names and reasons never appear in URLs, page titles or telemetry (R5) |

### F11. Team management for a Seller Owner, and admin management (same template)
| # | Step | What the user sees of the rules |
|---|---|---|
| 1 | B1 lists members and pending invitations | Managing is the Seller Owner's alone in Phase 2 (criterion 35). A Staff role can at most view (DD 5.3, `identity.team-member.view`): every action is then disabled with the reason. Without it the menu item is hidden and the URL gives B5. A seller that is not approved has S1 only |
| 2 | Invite: D1 with email and role. The row shows "Invited" | R1: roles holding permissions the inviter lacks are disabled in the picker, with the reason. The answer is uniform for any email (DD 6.7). `invitation.already-pending`, `member.limit` |
| 3 | Resend or cancel a pending invitation (R12) | — |
| 4 | Change role: D2. Applies from the member's next request; they stay signed in (R4) | Own row: no action, "You can't change your own role" (R1, `member.self`). Member holds permissions the actor lacks: disabled (`member.outranks-actor`). Last holder of a system role: disabled (`member.last-holder`, R3) |
| 5 | Remove from team (Seller) or Deactivate account (Admin): D3. Their sessions end at once. "Reactivate account" on a deactivated admin row (accepted by Ali) acts at once, with a Toast | The same three rules |
| 6 | Granting a system role | Seller panel: never offered in Phase 2 (one Seller Owner, no transfer). Admin panel: offered only to a holder of the top admin role (criterion 34) |

### F12. Sign out and the end of a session
"Sign out" in the account menu leads to A1 of the same population with "You're signed out". Any
request on an ended session returns `session.invalid`: A1 with "Your session has ended", keeping the
page as the return URL. The cause is not stated: expiry, revocation and another Market give one
answer. There is no session list (1.3).

## 3. Screen specifications

### 3.0 Rules for every screen
1. **Auth template (A1 to A11).** Page on `bg/page`; brand mark above one card (`bg/surface`,
   `border/default`, `radius/card`, width `size/auth-card`; full width less a `space/4` gutter on
   phones). In the card: account-type `Badge` (icon and words), H1, body, form, one full-width
   primary action. Secondary links sit under the card. Footer: the Market name from Market
   configuration, because an account belongs to one Market, and the support contact, always in this
   place (3.2.6, Jafar 10). Touch density at every width.
2. **Account type** (Jafar 4): the Badge (icon and words) and the document title name it on every
   Auth screen, and the H1 as well on A1, A2, A5, A9 and A10; never by colour alone. Document titles
   are the keys `identity.<surface>.page-title.<type>`.
3. **Validation.** Required and format checks run on blur and on submit; server codes map to fields.
   After a failed submit an error summary (`InfoBanner`, Critical) appears above the form and takes
   focus; each field error is text with an icon under its field.
4. **Loading and success.** The primary button shows `State=Loading` at the same width and the form
   is read-only; no page spinner; lists in the shell load as 8 skeleton rows (kickoff section 9).
   Success is the next screen, an `InfoBanner` (Success) on it, or a Toast.
5. **Never, on any screen:** text, layout or timing that differs by whether an account exists; a
   seller's status or reason before authentication is complete; an email, token, role name or reason
   in a URL path, page title or client telemetry (R5, input I15); a server message string.
6. **Permissions in the UI** (panels-ux-strategy section 5): without View, the menu item is hidden
   and the URL gives B5; with View but without the action, the control is disabled and gives its
   reason. A record that does not exist and a record of another seller or Market give one answer,
   byte-identical to "not found", and one screen: B5 "not found" (Hassan).

### 3.1 Auth template
| Screen and purpose | Content, top to bottom | Fields, validation, actions | States | Never shown |
|---|---|---|---|---|
| **A1 Sign in.** Authenticate one population | Badge; H1; banner slot; Email; Password with show/hide; "Sign in"; "Forgot password?". Seller only: "New to MondaPac? Create a seller account" and the fixed note "Seller and customer accounts are separate. Each has its own password."; "Keep me signed in on this device", unticked, with its help line (opt-in, sellers only, 14 days idle and 30 days at most; never on the admin panel; Ali and Hassan) | Email: required, format, `autocomplete="username"`. Password: required, `current-password`. No password rules are shown here | `credentials.invalid`: summary; email kept, password cleared. Throttled: summary with the wait; "Sign in" disabled until it passes; the reset link stays active. `account.disabled` and `membership.none`, only after complete authentication: summary. Banners: session ended, signed out, password changed, account ready. Two-step paused (Hassan 2), only after a correct password: summary with "Forgot password?" | Before authentication is complete: which value was wrong; attempts left; that the account is unconfirmed, awaiting approval, suspended or deactivated. Ever: that the email has an account of another type |
| **A2 Sign up (Seller).** Create the seller account (`identity`'s share of SEL-01) | Badge; H1; one line on what happens next, by whether approval is required (criterion 5, Jafar 11); Your name; Email; Password with show/hide and the policy rule (one field, Jafar answer 4); "Create account"; "Already have a seller account? Sign in"; legal slot (L): the privacy collection notice (Jafar 12) | Name: required, maximum length from the API, no control, bidi or URL-like text (Hassan 13). Email: format. Password: policy (15 to 128 characters, Hassan). Customer variant: email and password only | Field errors; success is A3 | "This email is already registered" |
| **A3 Check your email.** Send the user to their inbox | Mail icon; H1; "We've sent an email to {email}" (true for E1 and for E12); a hint about delay and spam; "Send it again"; "Wrong address? Sign up again"; "Back to sign in". Reached from sign-in (F2 step 4), the body says the email must be confirmed first. Admin after a two-step reset (F6 step 6): the body says a link to set it up again was sent, with its 60 minutes; no "Wrong address?" | No fields | Sent; sent again (status message); throttled, with the wait | Whether the address already had an account |
| **A4 Confirm your email.** Finish the confirmation from the link and sign in | Form: Badge; H1; a body that says what happens next, by account type and by whether approval is required (criterion 5, Jafar 11); Password; "Confirm email" (the link works only with the account's password, DD 6.7). Not usable: H1, one explanation covering expired and used, Email, "Send a new link" | Password: required, `current-password`. Email (not-usable state): required, format; "Send a new link" answers `verification-resend.accepted` for any address | Checking (a skeleton card and "Checking your link…", so an error never flashes); form; wrong password (`credentials.invalid`); not usable; new link sent. Success completes sign-in (DD 8.6-3, Jafar 2): a seller lands on S1, or on Home when approval is not required, with the banner "Email confirmed."; a customer is signed in. A later sign-in step that stops it answers as in F2 | Which cause applied; the account's email or name |
| **A5 Forgot password.** Ask for a reset link | H1 names the account type; Email; "Send reset link"; "Back to sign in" | Email: required, format | Sent: "If a seller account uses {email}, we've sent a link…", with the 60 minutes | Confirmation that the account exists; a different delay for a known email |
| **A6 Choose a new password.** Complete the reset | Badge; H1; New password with show/hide and the policy rule (one field); the note that this signs the user out everywhere; "Save new password" | New password: policy. The account email sits in a hidden username field for password managers | Link not usable (as A4, leading to A5); success goes to A1 with a banner | The account email; automatic sign-in |
| **A7 Two-step verification.** Second step of sign-in | Mode 1: H1; code field; "Verify"; "Use a backup code instead". Mode 2: H1; backup-code field; "Verify"; "Use your authenticator app instead". Under both, "Can't use either?" opens help for this population (F7 step 3) | One field per mode (section 6). No auto-submit and no "remember this device" | Code rejected; challenge ended after too many wrong codes (back to A1 with a message); paused after 10 wrong codes in 24 hours (back to A1, which says so; Hassan 2) | The seller's status (it comes after this step); whether the code was wrong or late |
| **A8 Set up two-step verification.** Enrol an authenticator app | Three steps labelled in words ("Step 1 of 3"). Step 1: QR code on a white plate; the same key as text in groups of four with Copy; "Open authenticator app". Step 2: code field and "Verify". Step 3: ten backup codes (DD 7.3) as a list in mono type; Copy, Download, Print; the checkbox "I've saved these codes"; "Continue" | The checkbox enables "Continue". Admin (Auth template, inside A9 or from the link in E16): no skip, and a line says admin accounts must use it; from the link the password comes first ("Step 1 of 4", Hassan 6). Seller (Auth template, from the link in E16 that "Set up" on B4 or S1 sends): the password first, as for an admin; "Cancel" until step 2 succeeds; done: "Two-step verification is on." with a link to Account security | Code rejected; challenge ended; done; link not usable (from E16, with "Back to sign in") | The key or the codes once the step is left; either of them in a URL, browser storage or a log |
| **A9 Accept invitation.** Turn an invitation into an account | Badge; H1 and body by variant (admin; seller team member, with who invited them and the role; seller created by an admin); Email, read-only; Your name (admin and staff); Password with show/hide (one field); legal slot (L): the privacy collection notice (Jafar 12); "Accept and continue". Seller variants add the note that this account is separate from a customer account with the same email. Admin variant: "Continue" leads to the A8 steps inside this screen (Hassan 6). An existing seller-side account with no team sees "Sign in and join" with its current password (DD 6.7) | Name: required, no control, bidi or URL-like text (Hassan 13). Password: policy | Accepted: A1 with "Your account is ready. Sign in." (no session, DD 3.4); an admin only once the A8 code is accepted. Not usable: one message and no self-service resend | Why it is not usable (cancelled, role deleted and suspended seller look the same) |
| **A10 Account suspended.** Explain why sign-in stopped | Badge; `InfoBanner` (Critical) "This seller account is suspended". Seller Owner: `ReasonQuote` with the reason and its date. Staff: "Ask your shop owner for details". "Back to sign in". The support contact is in the footer, as on every Auth screen (3.2.6) | None. Shown only after complete authentication; no session exists | Seller Owner; Staff | The reason to Staff; the name of the admin who acted |
| **A11 Confirm the reset of two-step verification** (Seller Owner; link in E15). Let the owner approve a reset that an admin started (DD 7.3) | Badge; H1; what will happen: two-step verification is turned off, every session ends, and sign-in needs only the password until it is set up again; "Turn off two-step verification"; the line "Didn't ask for this? Close this page and change your password." | No fields | Checking; confirm; done (A1 with a banner); link not usable after one use or 24 hours (Hassan 15; as A4, without resend: the owner asks support again) | Who started the reset; the account's email |

### 3.2 Inside the shell
| Screen and purpose | Content, top to bottom | Fields, validation, actions | States | Never shown |
|---|---|---|---|---|
| **S1 Your seller account** (Seller; F5; DD 8.5). Landing while not approved | H1 "Your seller account" with a status `Badge`: "Awaiting approval" (Info, `clock`) or "Changes needed" (Attention, `alert-circle`); with `sellers`, "Not approved" (Critical, `x`) once the re-apply limit is reached (Jafar 6). Card 1: `InfoBanner` Info "We're reviewing your application", or Attention "Your application needs changes". Card 2 (Seller Owner, changes needed): `ReasonQuote` with the label "Reason from MondaPac", the text exactly as written, and its date. Card 3, steps (`ChecklistItem`): "Account created" and "Email confirmed" Done, with dates; a slot for Phase 3 steps; "MondaPac reviews your application" Waiting, or Needs attention when changes are needed. Card 4, help, always last (3.2.6): "Protect your account" with "Set up two-step verification", which sends E16 as on B4 (on the allow-list, DD 5.2), and the support contact | None: no inline form (F5). With `sellers`, its steps open their own pages | Skeleton cards; inline error with "Try again" | Other menu items; internal notes; reviewer names; a promised decision time (none for now, Jafar) |
| **P1 Seller accounts** (Admin; a Phase 2 frame of the existing template `Admin · Sellers`, Jafar 9). Decide on sellers | Title "Sellers" with the count and Market name; a search field that takes an exact email (DD 8.6-8). Tabs with counts: Awaiting approval (default), Approved, Changes needed, Suspended, Invited, All. Columns: Seller (owner's name over email); Status (`Badge`, icon and word: as S1, plus Approved Success `check`, Suspended Critical `ban`, Invited Neutral `send`); Since (date of the last status change); Actions. A row whose owner must still confirm a two-step reset says so, with the link's expiry (DD 8.6-8). No KPI strip, bulk bar, certificate, health or order columns in Phase 2: those belong to `sellers` | Primary: "Add seller". The row menu holds only the allowed actions: Approve and Reject… (awaiting approval only, Jafar 1), Suspend…, Lift suspension, View reason, Reset owner's two-step verification (DD 7.3); for invitations Resend and Cancel. A disabled item gives its reason on its description line (`MenuItem`) | Skeleton rows; an empty state per tab; load error in the card with "Try again"; for View-only roles the actions are disabled with the reason | Sign-ups whose email is not confirmed; reason text in the table; another Market's sellers |
| **B1 Members.** Manage people and invitations | Seller: page "Team & roles", tabs Team and Roles. Admin: page "Roles & permissions", tabs Admins and Roles. Columns: Person (name over email; "You" on the own row); Role (a lock icon marks a system role); Two-step verification (On or Off; Seller only); Status (Active, Invited, Deactivated); Actions. Seller panel in Phase 2: an Info banner says team members can sign in now and that the parts they can use arrive as features are added (the consequence stated in brief section 3) | Primary: "Invite team member" or "Invite admin". Row actions: Change role, Reset two-step verification, Remove from team or Deactivate account (Reactivate account on a deactivated row); for invitations Resend and Cancel. Actions that a rule forbids stay visible, disabled, with the reason (F11 steps 4 to 6) | Skeleton rows; empty (owner only): "It's just you so far" with the invite action; view-only (every action disabled with the reason) | Members of another seller or Market; last sign-in times or sessions |
| **B2 Roles.** List roles by type | Rows grouped System, Default, Custom (seller panel: Owner, Ready-made, Custom; Jafar answer 7). Columns: Role, with its one-line purpose for a ready-made role; Type (`Badge`); Permissions (a count, "All" for a system role, "None yet" for none, Jafar 11); Members (count); Actions | Primary: "Create role". Row actions: View; custom: Edit, Duplicate, Delete…; default: Duplicate | Skeleton rows; empty custom group: "No custom roles yet" and one line of explanation | Roles of another seller, panel or Market |
| **B3 Role.** View a role; create or edit a custom one | Back link; H1 is the role name; type `Badge`. System and default roles: a read-only banner says why; a default role offers "Duplicate". Custom: Role name; the line "New features are never added to a custom role automatically" (R10); the counter "{selected} of {total} permissions selected". Permissions: one card per resource with "Select all" (three-state checkbox), then a `CheckboxRow` per permission: checkbox, label, one-line description, and a trailing "Protected" `Badge` with a lock where R11 applies. Labels come from `permission.<key>.label` | Role name: required, unique within this seller or the platform, maximum length from the API, no control, bidi or URL-like text (Hassan 13). A row the user may not give is disabled with its reason in text: not held (R1), or protected (R11; in the seller panel "Only the shop owner can do this. It can't be given to team members yet.", Jafar 5). "Duplicate" fills in "Copy of {roleName}" and leaves unticked, under an Info banner, the permissions the user can't give (Jafar 11). "Save role" and "Cancel" are fixed to the bottom of long lists; leaving with unsaved changes asks first | Skeleton; error summary; saved Toast. Seller panel in Phase 2: the catalogue is short (DD 5.3: two view permissions can be chosen; team and role management is protected and shown locked). An Info banner says more permissions arrive with new features, and a role with no permissions can be saved (DD 5.6 has such default roles) | The other panel's permissions (R2); unknown or retired keys (R7); Market or vertical names in labels |
| **B4 Account security.** Own password and second factor | Password card: Current password; New password with show/hide and the policy rule (one field); a code field when two-step verification is on (DD 6.5); "Change password". Two-step card: "On since {date}" or "Off", and the backup codes left. Admin: a line says it must stay on. Seller Owner: a line says it becomes compulsory before payouts are switched on (decision 7). Customer: the password card only | Seller, off: "Set up" sends E16, a link valid for 60 minutes, and the card says so, with "Send it again"; A8 opens from that link (DD 3.6; Hassan's decision of 2026-10-03). On: "Get new backup codes" (asks for a current code, shows the codes once) and "Move to a new phone" (current code, then A8). Seller only: "Turn off…" (D3, with a code) | `password.current-incorrect`; `password.rejected`; Toast on success | The current key or old codes; a session list |
| **B5 No access.** Answer to a page the role does not include, and to a record that cannot be found | No access: lock icon; H1; who to ask (Seller: the shop owner; Admin: an admin who manages roles). Not found: H1 and one line, the same for a record that does not exist and for one of another seller or Market (Hassan: byte-identical answers) | "Go to Home" | No access; not found | The missing permission key; whether the requested record exists anywhere |

### 3.3 Dialogs
The title names the action and its object; the primary button repeats the verb. A destructive
confirmation uses the Destructive button and opens with focus on "Cancel". Below 480 px every
dialog uses the `Dialog` sheet layout (Jafar 9).
- **D1 Invite.** Email (required, format); Role (`Select`; each option shows the role's one-line
  purpose, or a custom role's permission count, Jafar 11; roles the user may not give are disabled
  with the reason on the description line); helper: the person sets their own password and the link
  works for `{duration}` (admin 72 hours, Hassan 15; team member 7 days, DD 6.6); "Send
  invitation". The success Toast is the same for any email (DD 6.7).
- **D2 Change role.** Name; current role; `Select`; the note that the change applies from their next
  action; "Change role".
- **D3 Confirm action.** One sentence of consequence. Uses: approve seller; lift suspension; remove
  from team; deactivate admin; reset two-step verification (for a Seller Owner the dialog says the
  owner must confirm by email); turn off two-step verification; delete role; cancel invitation.
- **D4 Reject seller.** `Textarea` "Reason for the seller" (required; maximum length from the API,
  with a counter); helper: the shop owner sees this text in an email and at sign-in, so say what was
  wrong and what to change, and add no internal notes; "Reject application". An empty reason is a
  field error and nothing is sent (criterion 6). Read-only state for "View reason": the text, its
  author and date.
- **D5 Suspend seller.** Consequence line (the whole team is signed out); the same reason field;
  "Suspend seller" (criterion 14).
- **D6 Add seller.** Name (no control, bidi or URL-like text, Hassan 13); Email; helper: the seller
  chooses their own password, and where approval is required the account still needs it after they
  accept; "Send invitation".

### 3.4 Emails
One layout: subject; heading; an account-type line; two or three sentences; one button; the link's
lifetime as a duration, not a clock time; "If you didn't ask for this, you can ignore this email";
footer (L); always a plain-text part. Subjects carry no personal data and no reason text. E5 and E6
quote the reason in the body and go to the Seller Owner only. E2 has two bodies, by whether approval
is required. E3 carries no seller name or email, only a link to P1. E13, E14 and E17 are notices
without a button: what changed or happened, when, and "if this wasn't you, reset your password"
(Hassan confirmed). E15's button opens A11; E16's opens A8. Names and role names are escaped
(Hassan 13). Lifetimes: E1 24 hours; E8 and E16 60 minutes; E9 and E10 7 days; E11 72 hours; E15
24 hours. Link targets are configurable per population (brief section 6); a token is never in the
URL path.

## 4. Design-system impact (fills the table of brief section 12)

"Existing" is what `docs/design/figma/README.md` section 5 and the plugin source show. Every change
is additive, so both releases are MINOR: **1.1.0 "Auth"**, with everything the Auth screens, S1 and
A10 use (Jafar 8), and **1.2.0 "Panel"**.

| Screen element | Existing library component or template | Change needed in Figma first | Release |
|---|---|---|---|
| Page frame before sign-in (A1 to A11) | None: every template sits inside the shell | New template `Auth`, Seller and Admin frames, 360 and 1280 wide, light and dark | MINOR 1.1.0 |
| Brand mark | Drawn inside `Sidebar`; not a component | New component `BrandMark`; `Sidebar` uses the instance | MINOR 1.1.0 |
| Account-type tag, statuses, role type | `Badge` (Tone, Leading, Label, Icon swap) | None. `StatusBadge` holds order statuses and is not used | — |
| Label, helper and error text of a field | `Input` has no label, helper or error message | New component `Field` (Label, Optional mark, Helper, Error with icon, Counter) wrapping Input, Textarea, Select | MINOR 1.1.0 |
| Email and name inputs | `Input`, 6 states; its search icon can be hidden | None | — |
| Password field | None | `Input`: new variant `Type=Password` with a show/hide `IconButton` | MINOR 1.1.0 |
| One-time code and backup code | None | `Input`: new variant `Type=Code` (mono text style). One field, not six boxes | MINOR 1.1.0 |
| Buttons | `Button`: Primary, Secondary, Destructive, Ghost × Sm, Md, Touch × Default, Hover, Focus, Disabled | New `State=Loading`; new `Variant=Link` for text actions such as "Forgot password?" | MINOR 1.1.0 |
| Error summary, banners, status banner | `InfoBanner` (Info, Attention, Critical, Success; title, body, action) | None | — |
| QR code plate | None | Composed in the template; new colour token `bg/qr` (white in both themes) | MINOR 1.1.0 |
| Auth card width | `size/*` has no card width | New dimension token `size/auth-card` | MINOR 1.1.0 |
| Step label, backup-code list, checkbox with label | Text styles, `Checkbox` | Composed in the template; no component | — |
| Icons | 58, including `eye`, `store`, `shield-check`, `users`, `clock`, `ban`, `check`, `alert-circle`, `download`, `printer`, `send`, `x` | Add 9: `eye-off`, `lock`, `mail`, `key`, `user`, `log-out`, `copy`, `smartphone`, `trash` | MINOR 1.1.0 |
| Reason shown to the seller | None | New component `ReasonQuote` (label, quoted text, date); used in A10, S1 and D4 | MINOR 1.1.0 |
| Steps on S1 | `ChecklistItem` (Done; To do with two fixed buttons) | New variants `State=Waiting` and `State=Needs attention` (Jafar 7); BOOLEAN `Show actions`; TEXT for one action label | MINOR 1.1.0 |
| Limited shell on S1 | `Sidebar`, `Topbar`, `NavItem` | `Topbar`: BOOLEAN `Show search` and `Show notifications` | MINOR 1.1.0 |
| Account menu and row action menus | `Topbar` user block has no menu; `TableCell Type=Actions` holds only an `IconButton` | New components `Menu` and `MenuItem` (Default, Hover, Focus, Disabled, Destructive; an optional description line, so the reason for a disabled item can be read on touch, Jafar 9) | MINOR 1.1.0: sign out (slice 2) and S1's account menu need it |
| Role picker | None | New component `Select` (trigger states as `Input`; list built from `MenuItem`, plus Selected) | MINOR 1.2.0 |
| Reason field | None | New component `Textarea` (states as `Input`) | MINOR 1.2.0 |
| Dialogs D1 to D6 | None | New component `Dialog` (Size Sm, Md; Tone Default, Destructive; Layout Centred, or Sheet below 480 px, Jafar 9); tokens `bg/scrim`, `size/dialog-sm`, `size/dialog-md`; effect `Elevation/Floating` | MINOR 1.2.0 |
| Confirmation after an action | None | New component `Toast` (Success, Critical) | MINOR 1.2.0 |
| Tables on P1, B1, B2 | `Tab`, `TableCell`, `Pagination`, `IdentityTile`, `CardHeader` | `TableCell`: new `State=Loading` (skeleton) | MINOR 1.2.0 |
| Empty lists | None (README section 14 lists Empty and Loading as open) | New component `EmptyState` (icon, title, body, optional action) | MINOR 1.2.0 |
| Permission list on B3; later the multi-select of `sellers` | `CardHeader`, `Checkbox`, `Badge` | New component `CheckboxRow` (label, description, trailing `Badge`; Default, Hover, Focus, Disabled, Read-only), the first draft's `PermissionRow` made general (Jafar 9) | MINOR 1.2.0 |
| Reason beside a disabled control | `Tooltip` is the chart tooltip (label and value) | Inline helper text; in menus the `MenuItem` description line. The `Tooltip` change is deferred (Jafar 9) | — |
| Emails; customer screens | Outside the panel design system | None now | — |

- **New templates (7):** `Auth` and `Seller · Your seller account` (1.1.0); `Shared · Members`,
  `Shared · Roles`, `Shared · Role editor`, `Shared · Account security` and `Shared · No access`
  (1.2.0). Shared templates get a Seller frame and an Admin frame. P1 is a **Phase 2 frame of the
  existing `Admin · Sellers`** (1.2.0), not a new template (Jafar 9).
- **New components (10, plus `MenuItem`):** `BrandMark`, `Field`, `ReasonQuote`, `Menu` (1.1.0);
  `Select`, `Textarea`, `Dialog`, `Toast`, `EmptyState`, `CheckboxRow` (1.2.0). Each is used in both
  panels or in at least two places, as the update procedure requires. New tokens: 5. New icons: 9.
- **Design-system version after this module:** 1.2.0. Nothing is renamed or removed, so no MAJOR.

## 5. Copy

**Naming scheme.** `identity.<surface>.<element>[.<variant>]`, kebab-case segments.
- `<surface>`: a screen or dialog (`sign-in`, `seller-status`, `dialog.reject`), `common`, `error`,
  or `mail.<template>` (the prefix of DD 9). `<element>`: `title`, `body`, `label.<field>`,
  `help.<field>`, `action.<verb>`, `status.<state>`, `banner.<name>`, `toast.<name>`, `empty.title`,
  `empty.body`.
- Account type is a `<variant>` (`.seller`, `.admin`, `.customer`) holding a full sentence, never a
  spliced noun, so translators can inflect.
- Errors: `identity.error.` plus the state code, unchanged; the codes are those of DD 8.6 item 1
  (Jafar 3). When the body carries `details.rule`, the rule is the last segment
  (`identity.error.password.rejected.length`). An unknown code falls back to
  `identity.error.unknown`. Field checks: `identity.error.validation.<field>.<rule>`.
- Success codes have no error key; they lead to the screen's next state. `sign-up.accepted`: A3.
  `password-reset.accepted`: A5 "sent". `verification-resend.accepted`: `check-email.status.resent`
  on A3, `link.status.sent` on A4.
- Document titles: `identity.<surface>.page-title.<type>`, one per Auth surface and account type
  (Jafar 4).
- Values use ICU MessageFormat (INTL-11). Permission labels are `permission.<key>.label` and
  `.description`, owned by the module that declares the key.
- In the tables, sibling keys and their texts are joined with " · ". (L) marks a row for legal
  review.

**Words used everywhere:** sign in, sign out, sign up; email; confirm your email; two-step
verification; backup code; seller account, admin account, customer account; team member; role;
permission; invitation; awaiting approval, changes needed, not approved, suspended. en-AU spelling.
Domain terms and their UI words: verified = confirmed; disabled = deactivated; reinstate = lift
suspension; revoke = cancel (an invitation); recovery code = backup code; rejected = changes needed
(to the seller and on the P1 tab), or not approved once the re-apply limit is reached (Jafar 6). In
the seller panel only: system role = Owner, default role = Ready-made (Jafar, answer 7).

| Key (prefix `identity.common.`) | en-AU text |
|---|---|
| `account-type.seller · .admin · .customer` | Seller account · Admin account · Customer account |
| `label.email · .password · .new-password · .current-password · .name` | Email · Password · New password · Current password · Your name |
| `help.password · action.show-password · action.hide-password` | Use at least {min} characters. A short sentence works well. · Show password · Hide password |
| `action.sign-in · .back-to-sign-in · .cancel · .continue · .try-again · .copy · status.copied` | Sign in · Back to sign in · Cancel · Continue · Try again · Copy · Copied |
| `market` | MondaPac {marketName} |
| `support` (L) | Need help? Email {supportEmail}. |
| `privacy-notice` (L; draft: legal confirms the APP 5 notice for the AU Market and supplies other Markets' text) | We collect these details to create and protect your account. Read how we handle them in our privacy policy. |
| `banner.idle-warning · action.stay-signed-in · banner.absolute-warning` | You'll be signed out in {minutes, plural, one {# minute} other {# minutes}} because you haven't been active. · Stay signed in · Your session ends in {minutes, plural, one {# minute} other {# minutes}}. After you sign in again you'll come back to this page. |

| Key (prefix `identity.error.`) | en-AU text |
|---|---|
| `credentials.invalid` | Email or password is incorrect. Check both and try again. |
| `request.throttled` | Too many attempts. Try again in {minutes, plural, one {# minute} other {# minutes}}. |
| `second-factor.code-rejected · second-factor.challenge-ended` | That code didn't work. Enter the newest code from your app. · Too many wrong codes. Sign in again to try once more. |
| `second-factor.locked` (proposal, Hassan 2) | Too many wrong codes. Two-step sign-in is paused for 24 hours. Reset your password to try again sooner. |
| `password.rejected.length · .common · .contains-identity · password.current-incorrect` | Use {min} to {max} characters. · That password is too easy to guess. Choose a different one. · Don't use your email or name in your password. · Your current password is incorrect. |
| `account.disabled.admin · account.disabled.customer · membership.none` (L) | This admin account has been deactivated. Ask another admin if you think this is a mistake. · This customer account has been deactivated. Contact us if you think this is a mistake. · This account isn't part of a seller team any more. Ask the shop owner to invite you again. |
| `validation.email.required · .email.format · .password.required · .name.required · .name.characters · .reason.required · .role-name.required · .role-name.characters` | Enter your email. · Enter an email address like name@example.com. · Enter your password. · Enter your name. · Remove web addresses and special formatting characters from the name. · Write a reason before you continue. · Give the role a name. · Remove web addresses and special formatting characters from the role name. |
| `access.denied · conflict.stale · seller-access.wrong-state` | You don't have permission to do that. · Someone has just changed this. We've refreshed it. · This seller's status has changed, so that action isn't available. We've refreshed the list. |
| `seller-access.reapply-limit` (L; shown only by the `sellers` step, never in Phase 2) | You've reached the limit for new applications. Contact us to continue. |
| `role.name-taken · role.in-use · role.limit · role.not-grantable · role.read-only` | A role with this name already exists. · Move its members to another role before you delete it. · You've reached the maximum number of roles. · Some permissions couldn't be saved because you can't give them. · This role can't be changed. |
| `member.self · member.outranks-actor · member.last-holder · member.limit · invitation.already-pending` | You can't change your own role. · This person has permissions you don't have, so you can't change their access. · At least one {roleName} must remain. · Your team has reached its maximum size. · This person already has an invitation. Resend it from the list. |
| `unknown · network · market · request.csrf` | Something went wrong on our side. Try again. · You're offline or the connection dropped. Check it and try again. · This page isn't available. · Refresh the page and try again. |

| Key (prefix `identity.`) | en-AU text |
|---|---|
| `sign-in.title.seller · .admin · .customer` | Sign in to your seller account · Sign in to your admin account · Sign in to your customer account |
| `sign-in.note.separate · action.forgot · action.sign-up.seller · label.keep-signed-in · help.keep-signed-in · help.throttled` | Seller and customer accounts are separate. Each has its own password. · Forgot password? · New to MondaPac? Create a seller account · Keep me signed in on this device · Only on a device you don't share. You stay signed in for up to 30 days. · You can still reset your password. |
| `<surface>.page-title.seller · .admin · .customer` for `sign-in`, `sign-up`, `check-email`, `confirm-email`, `forgot-password`, `reset-password`, `two-step`, `two-step-setup`, `invitation`, `suspended`, `two-step-reset` (Jafar 4) | Sign in · Create account · Check your email · Confirm your email · Reset your password · Choose a new password · Two-step verification · Set up two-step verification · Accept invitation · Account suspended · Turn off two-step verification; each written out in full per type, e.g. `sign-in.page-title.seller` = "Sign in – Seller account – MondaPac" |
| `sign-in.banner.session-ended · .signed-out · .password-changed · .account-ready` | Your session has ended. Sign in again to continue. · You're signed out. · Password changed. Sign in with your new password. · Your account is ready. Sign in. |
| `sign-up.title.seller · title.customer · body.seller · body.seller.no-approval` | Create a seller account · Create a customer account · First confirm your email. Then MondaPac reviews your application before you can sell. · First confirm your email. Then you can start setting up your shop. |
| `sign-up.action.submit · action.sign-in.seller` | Create account · Already have a seller account? Sign in |
| `sign-up.legal` (L) | Terms acceptance, when the `legal` module exists (VER-11); empty in Phase 2 |
| `check-email.title · body · body.from-sign-in` | Check your email · We've sent an email to {email}. Open it and follow the link to continue. · Confirm your email before you sign in. Use the link we sent to {email}, or send a new one. |
| `check-email.body.re-enrol` | Your two-step verification was reset. We've sent a link to {email} to set it up again. The link works for 60 minutes. |
| `check-email.help · action.resend · status.resent · action.wrong-address` | It can take a few minutes. Check your spam folder too. · Send it again · Sent again. · Wrong address? Sign up again |
| `confirm-email.title · body.seller · body.seller.no-approval · body.customer` | Confirm your email · Enter your password to confirm your email. Then you'll see the status of your application. · Enter your password to confirm your email and go to your seller panel. · Enter your password to confirm your email and sign in. |
| `confirm-email.action.submit · status.checking · banner.confirmed` | Confirm email · Checking your link… · Email confirmed. |
| `link.title.rejected · body.rejected · action.send-new · status.sent` | This link can't be used · It may have expired or already been used. Enter your email and we'll send a new one. · Send a new link · If that address has an account waiting to be confirmed, we've sent a new link. |
| `forgot-password.title.seller · .admin · .customer` | Reset your seller account password · Reset your admin account password · Reset your customer account password |
| `forgot-password.action.submit · title.sent · body.sent.seller` (also `.admin`, `.customer`) | Send reset link · Check your email · If a seller account uses {email}, we've sent a link to reset its password. The link works for 60 minutes. |
| `reset-password.title · body · action.submit` | Choose a new password · Changing your password signs you out everywhere. · Save new password |
| `two-step.title · body · label.code · action.verify` | Enter your 6-digit code · Open your authenticator app and enter the code for MondaPac. · 6-digit code · Verify |
| `two-step.action.use-backup · title.backup · body.backup · label.backup-code · action.use-app` | Use a backup code instead · Enter a backup code · Each backup code works once. · Backup code · Use your authenticator app instead |
| `two-step.help.staff · help.admin` | No phone and no backup codes? Ask your shop owner to reset two-step verification for you. · No phone and no backup codes? Ask another admin who manages admin accounts to reset it. |
| `two-step.help.owner` (L) | No phone and no backup codes? Email {supportEmail} from the address you sign in with. |
| `two-step-setup.title · body.required.admin · label.step` | Set up two-step verification · Admin accounts must use two-step verification. · Step {current} of {total} |
| `two-step-setup.title.again · body.password` | Set up two-step verification again · Enter your password to continue. |
| `two-step-setup.body.scan · alt.qr · body.manual · action.open-app · body.code` | Scan this code with an authenticator app on your phone. · QR code for your authenticator app · Can't scan it? Enter this key in the app instead. · Open authenticator app · Enter the 6-digit code the app shows. |
| `two-step-setup.title.codes · body.codes · label.saved · action.download · action.print · toast.done` | Save your backup codes · If you lose your phone, a backup code lets you sign in. Each code works once. We can't show them again. · I've saved these codes · Download · Print · Two-step verification is on. |
| `invitation.title.admin · .staff · .seller` | Set up your admin account · Join a seller team on MondaPac · Set up your seller account |
| `invitation.body.admin · body.staff · body.seller` | You've been invited to be a MondaPac admin with the role {roleName}. Enter your name and choose a password, then set up two-step verification. · {inviterName} invited you to join as {roleName}. Enter your name and choose a password to accept. · MondaPac has created a seller account for you. Choose a password to get started. |
| `invitation.help.email · note.separate · action.accept · title.rejected · body.rejected` | You'll sign in with this email. · This is a seller account. It's separate from any customer account that uses the same email. · Accept and continue · This invitation can't be used · Ask the person who invited you to send a new one. |
| `invitation.body.existing · action.join` | You already have a seller account with this email. Sign in to join the team. · Sign in and join |
| `two-step-reset.title · body · action.submit · help · banner.done` | Turn off two-step verification? · A MondaPac admin started this after a request to support. You'll be signed out everywhere and sign in with your password only, until you set it up again. · Turn off two-step verification · Didn't ask for this? Close this page and change your password. · Two-step verification is off. Sign in with your password. |
| `suspended.title · body.owner · body.staff` (L) | This seller account is suspended · Nobody on your team can sign in while it's suspended. The reason is below. · Nobody on the team can sign in while it's suspended. Ask your shop owner for details. |
| `reason.title · reason.label.date` | Reason from MondaPac · Written on {date} |
| `seller-status.title · status.pending · status.rejected · status.rejected-final` | Your seller account · Awaiting approval · Changes needed · Not approved |
| `seller-status.title.pending · body.pending` (L) | We're reviewing your application · We'll email you when there's a decision. Until then you can't sell or use the rest of the seller panel. |
| `seller-status.title.rejected · body.rejected.owner · body.rejected.staff` (L) | Your application needs changes · Read the reason below, then contact us to continue. · Ask your shop owner for details. |
| `seller-status.title.rejected-final · body.rejected-final` (L; with `sellers` only) | Your application wasn't approved · You've reached the limit for new applications. Contact us if you have questions. |
| `seller-status.step.created · step.email · step.review · status.waiting · status.needs-changes` | Account created · Email confirmed · MondaPac reviews your application · In progress · Needs changes |
| `seller-status.title.secure · body.secure · action.secure` | Protect your account · Turn on two-step verification while you wait. · Set up two-step verification |
| `sellers.title · body.count · tab.pending · .approved · .rejected · .suspended · .invited · .all` | Sellers · {count, plural, one {# seller} other {# sellers}} in the {marketName} market · Awaiting approval · Approved · Changes needed · Suspended · Invited · All |
| `sellers.label.seller · .status · .since · action.add · .approve · .reject · .suspend · .unsuspend · .view-reason · .reset-two-step · .resend · .cancel-invitation` | Seller · Status · Since · Add seller · Approve · Reject… · Suspend… · Lift suspension · View reason · Reset owner's two-step verification… · Resend invitation · Cancel invitation |
| `sellers.label.search · help.search · status.reset-waiting` | Search sellers · Enter the full email address. · Two-step reset waiting for the owner (link expires {dateTime}) |
| `sellers.empty.title · empty.body · help.view-only` | No sellers are waiting · You're up to date. · Your role can view sellers but not change them. |
| `sellers.toast.approved · .rejected · .suspended · .unsuspended · .reset-started` | Seller approved. We've emailed them. · Application rejected. We've emailed the seller your reason. · Seller suspended. Their team has been signed out. · Suspension lifted. The seller can sign in again. · We've emailed the shop owner a link to confirm the reset. |
| `dialog.approve.title · body · action` | Approve this seller? · They get full access to the seller panel and an email to say so. · Approve seller |
| `dialog.unsuspend.title · body · action` | Lift this suspension? · The seller's team can sign in again and gets an email to say so. · Lift suspension |
| `dialog.reject.title · label.reason · help.reason · action` | Reject this seller application? · Reason for the seller · The shop owner sees this in an email and when they sign in. Say what was wrong and what to change. Don't add internal notes. · Reject application |
| `dialog.suspend.title · body · action` | Suspend this seller? · Everyone on the seller's team is signed out and can't sign in until you lift the suspension. · Suspend seller |
| `dialog.add-seller.title · help · note.approval · action` | Add a seller · We'll email them a link to choose their own password. You never see or set it. · The account still needs approval after they accept. · Send invitation |
| `dialog.invite.title.team · title.admin · label.role · help · action · toast.sent` | Invite a team member · Invite an admin · Role · They'll get an email with a link to set their own password. The link works for {duration}. · Send invitation · Invitation sent to {email}. |
| `dialog.change-role.title · body · action` | Change role for {name} · The change applies from their next action. They stay signed in. · Change role |
| `dialog.remove-member.title · body · action` | Remove {name} from your team? · They're signed out straight away and can't sign in to your seller panel again. · Remove from team |
| `dialog.deactivate-admin.title · body · action` | Deactivate {name}'s admin account? · They're signed out straight away and can't sign in. · Deactivate account |
| `dialog.reset-two-step.title · body.admin · body.seller · action` | Reset two-step verification for {name}? · They're signed out. At their next sign-in we email them a link to set it up again. · They're signed out and sign in with their password until they set it up again. · Reset |
| `dialog.delete-role.title · body · action` | Delete the role "{roleName}"? · This can't be undone. {count, plural, =0 {} one {# pending invitation with this role stops working.} other {# pending invitations with this role stop working.}} · Delete role |
| `dialog.cancel-invitation.title · body · action · action.keep` | Cancel the invitation to {email}? · The link in their email stops working. · Cancel invitation · Keep invitation |
| `members.title.seller · title.admin · tab.team · tab.admins · tab.roles` | Team & roles · Roles & permissions · Team · Admins · Roles |
| `members.label.person · .role · .two-step · .status · .you · status.active · .invited · .deactivated · .two-step-on · .two-step-off` | Person · Role · Two-step verification · Status · You · Active · Invited · Deactivated · On · Off |
| `members.action.invite.team · .invite.admin · .change-role · .reset-two-step · .remove · .deactivate · .reactivate` | Invite team member · Invite admin · Change role · Reset two-step verification · Remove from team… · Deactivate account… · Reactivate account |
| `members.toast.reactivated` | {name}'s account is active again. They can sign in. |
| `members.empty.title · empty.body · banner.early` | It's just you so far · Invite the people who help run your shop. Each person gets their own sign-in. · Team members can sign in now. The parts of the panel they can use appear as MondaPac adds features. |
| `roles.action.create · .duplicate · .edit · .delete · status.system.admin · .system.seller · .default.admin · .default.seller · .custom · label.all · label.none` | Create role · Duplicate · Edit · Delete… · System · Owner · Default · Ready-made · Custom · All · None yet |
| `roles.default.<code>.name · .description` | Name and one-line purpose of each ready-made role of DD 5.6, written once the owner approves the set (DD 14.4) |
| `roles.empty.title · empty.body.admin · empty.body.seller` | No custom roles yet · Default roles cover common jobs. Create a role when you need a different mix of permissions. · Ready-made roles cover common jobs. Create a role when you need a different mix of permissions. |
| `role.label.name · label.count · action.select-all · status.protected · action.save` | Role name · {selected} of {total} permissions selected · Select all in {group} · Protected · Save role |
| `role.banner.system.admin · .system.seller · banner.default.admin · .default.seller` | System role. It always has every permission in this panel and can't be changed or deleted. · Owner role. It always has every permission in this panel and can't be changed or deleted. · Default role from MondaPac. It can't be changed. Duplicate it to make your own version. · Ready-made role from MondaPac. It can't be changed. Duplicate it to make your own version. |
| `role.help.custom · help.not-held · help.protected · help.owner-only` | New features are never added to a custom role automatically. You choose when to add them. · You can't give a permission you don't have. · Only a {systemRoleName} can give this permission. · Only the shop owner can do this. It can't be given to team members yet. |
| `role.label.copy-of · banner.not-copied` | Copy of {roleName} · Some permissions weren't copied because you can't give them. |
| `role.banner.early · body.unsaved · toast.saved` | Only a few permissions exist so far. More appear here as MondaPac adds features. · You have unsaved changes. Leave without saving? · Role saved. Changes apply from each person's next action. |
| `security.title · title.password · action.change-password · toast.password-changed` | Account security · Password · Change password · Password changed. You've been signed out on your other devices. |
| `security.title.two-step · status.on · status.off · label.codes-left · action.set-up · .new-codes · .move · .turn-off` | Two-step verification · On since {date} · Off · {count, plural, one {# backup code left} other {# backup codes left}} · Set up · Get new backup codes · Move to a new phone · Turn off… |
| `security.status.link-sent` | We've sent a link to {email}. Open it within 60 minutes to set up two-step verification. |
| `security.help.admin · help.owner` | Admin accounts must keep two-step verification on. · Shop owners will need two-step verification before payouts are switched on. |
| `no-access.title · body.seller · body.admin · action` | You don't have access to this page · Your role doesn't include it. Ask your shop owner if you need it. · Your role doesn't include it. Ask an admin who manages roles. · Go to Home |
| `no-access.title.not-found · body.not-found` | We can't find that page · It may have been removed, or the link may be wrong. |

**Emails** (prefix `identity.mail.`, as DD 9; each template has `.subject`, `.heading`, `.body`,
`.action`; no plurals are needed). Shared keys: `common.account-line.seller` = "This email is about
your seller account. A customer account with the same email is separate." (also `.admin`,
`.customer`); `common.ignore` = "If you didn't ask for this, you can ignore this email.";
`common.footer` (L).

| Template | Subject (en-AU) | Button |
|---|---|---|
| `confirm-email.seller` · `.customer` | Confirm your email for your MondaPac seller account · … customer account | Confirm email |
| `welcome.seller` | Welcome to MondaPac: your seller account | View your account |
| `admin-seller-waiting` | A new seller is waiting for approval | Open seller accounts |
| `seller-approved` | Your MondaPac seller account is approved | Sign in |
| `seller-rejected` (L) | Your MondaPac seller application needs changes | Read the reason |
| `seller-suspended` (L) | Your MondaPac seller account has been suspended | — |
| `seller-unsuspended` | Your MondaPac seller account is active again | Sign in |
| `reset-password.seller` · `.admin` · `.customer` | Reset the password for your MondaPac seller account · … admin account · … customer account | Choose a new password |
| `invitation.seller` | Set up your MondaPac seller account | Set up account |
| `invitation.staff` | You're invited to join a seller team on MondaPac | Accept invitation |
| `invitation.admin` | You're invited to be a MondaPac admin | Accept invitation |
| `existing-account.seller` · `.customer` | You already have a MondaPac seller account · … customer account | Sign in |
| `password-changed.seller` · `.admin` · `.customer` | The password for your MondaPac seller account was changed · … admin account · … customer account | — |
| `two-step-changed.seller` · `.admin` | Two-step verification changed on your MondaPac seller account · … admin account | — |
| `two-step-reset-confirm` (L) | Confirm the reset of two-step verification on your MondaPac seller account | Review the request |
| `two-step-setup-link.seller` · `.admin` | Set up two-step verification on your MondaPac seller account · Set up two-step verification again on your MondaPac admin account | Set up two-step verification |
| `two-step-locked.seller` · `.admin` | Too many wrong two-step codes on your MondaPac seller account · … admin account | — |

## 6. Accessibility and responsiveness

The gate is **WCAG 2.2 AA in full** (kickoff section 11, which brief section 9 points to; Jafar 10).
The 2.2 criteria that shape these screens: 2.4.11 (focus not obscured), 2.5.8 (target size), 3.2.6
(consistent help), 3.3.7 (redundant entry) and 3.3.8 (accessible authentication).
- **Consistent help (3.2.6).** The support contact sits in the same place on every Auth screen (the
  footer, 3.0 rule 1, A10 included) and on S1 (the help card, always last).
- **Focus order.** Auth: error summary when present, fields in visual order, show/hide button after
  its field, primary action, secondary links, footer. When the step changes without a page load (A1
  to A7, the steps of A8) focus moves to the new H1 and the document title changes. In the shell:
  skip link, sidebar, top bar, content (kickoff section 11).
- **Errors.** The summary is `role="alert"` and takes focus. Field errors use `aria-describedby` and
  `aria-invalid` and are not announced on each keystroke. "Sent again", "Copied" and banners such as
  "session ended" are `role="status"`.
- **One-time code.** One input, `inputmode="numeric"`, `autocomplete="one-time-code"`; pasted spaces
  and hyphens are removed; no auto-advance, auto-submit or countdown. A backup code is a text input:
  10 characters (Crockford base32, shown in two groups of five), not case-sensitive, spaces and
  hyphens ignored (Hassan). No step asks the user to solve or remember anything (3.3.8): the design
  has no CAPTCHA, and no remote CAPTCHA service may be added (Hassan).
- **Password managers and paste.** Real forms; `autocomplete` values `username`, `current-password`,
  `new-password`; A6 and A9 carry the account email as a username field. Paste is never blocked; no
  `maxlength` below the policy maximum. Show/hide is a button with `aria-pressed`. A2, A6, A9 and B4
  have one new-password field and no repeat (Jafar, answer 4: a usability choice under 3.3.7).
- **Timeouts (2.2.1).** Link lifetimes are given as durations in the email and on the page; an
  expired link leads to a one-step recovery. After a session ends the user returns to the same page,
  and B3 keeps unsaved input across the sign-in. A throttle wait is text refreshed at most once a
  minute (kickoff section 7), never a ticking live region. The code check allows one time step
  either way (DD 7.1). Session lifetimes (Hassan):

  | Population | Idle | Absolute | In the UI |
  |---|---|---|---|
  | Admin | 30 minutes | 12 hours | Never "keep me signed in" |
  | Seller | 12 hours | 24 hours | The default |
  | Seller, "keep me signed in" | 14 days | 30 days | Opt-in on A1, sellers only |
  | Customer | 14 days | 30 days | — |

  On the panels an `InfoBanner` (Attention, `role="alert"`) warns 2 minutes before the idle limit,
  with "Stay signed in". The panel counts idle time from its own last request, using the idle
  duration in the actor summary (DD 8.6-9), and makes no timer-driven call (Hassan): only pressing
  "Stay signed in" sends a request. The absolute limit cannot be extended; the same banner warns 2
  minutes before it, without the button (7.1-3).
- **Status without colour.** Each status is a `Badge` with an icon and a word. "Changes needed"
  (Attention) and "Suspended" (Critical) also differ by tone (Jafar 6); "Not approved" and
  "Suspended" share the Critical tone and differ by icon and word. Errors are icon plus text. A
  disabled control gives its reason in text. Optional fields say "(optional)"; no asterisks.
- **Dialogs and menus.** Focus is trapped and returns to the trigger; Esc closes; a dialog holding
  typed text does not close on an outside click. Menu buttons are named "Actions for {name}";
  disabled items stay focusable and show their reason on the description line, readable on touch.
- **Other.** The QR code has alt text and the text key is its equivalent. Toasts stay at least 6
  seconds, pause on hover and focus, and never carry the only copy of a reason or a code. The reason
  is plain text with `dir="auto"` and its line breaks. Motion stops under `prefers-reduced-motion`.
- **RTL readiness (STO-13).** Logical properties only; directional icons mirror; emails, codes, the
  setup key and the QR code stay left-to-right. Text may grow by 40%: buttons wrap to two lines and
  never truncate. No text inside images.
- **Widths.** Smallest supported width: **320 CSS px** (reflow, 1.4.10) for the Auth template, S1,
  B4, B5 and every dialog; below 480 px a dialog uses the `Dialog` sheet layout. Design frames are
  360 and 1280 wide. P1, B1, B2 and B3 show full tables from 760 px; below that each row reflows to
  a stacked card with the same actions menu, but reaching those pages on a phone needs the mobile
  navigation (D16), which must land before the frontend of B1 to B3 (Jafar, answer 8). Targets: 48
  px on Auth; at least 32 px on desktop, with a 24 px hit area for checkboxes.

## 7. Open points

The G2 review settled the first draft's open points: Jafar answered 7.1, DD 8.6 answered 7.2, and
Hassan confirmed 7.3, with two conditions now in the text (B5's answer is byte-identical to "not
found"; support follows a written identity check before a shop owner's reset). The points raised
while applying the review are answered below. Still open: the privacy notice text (legal) and the
owner question of 7.4.

### 7.1 Readings for Jafar's final check: answered 2026-10-03
Jafar agrees with items 1 and 2; Hassan confirmed the stance of item 3; item 4 waits for legal.
1. **`Menu` and `MenuItem` move to 1.1.0** with the three items of change 8: sign out (F12, slice
   2) and the account menu of S1's limited shell need them, so without them S1 would still wait on
   1.2.0.
2. **A9 asks for "Your name"** in the admin and staff variants. B1, E10 and the account menu show a
   name, and only A2 and D6 asked for one.
3. **The absolute session limit** (12 hours for admins, Hassan) cannot be extended. The panel warns
   before it and brings the user back to the same page, with B3's input kept, after the new sign-in.
   I read the limit as essential under 2.2.1. Confirm.
4. **Privacy notice:** `identity.common.privacy-notice` is a draft; legal confirms it (Jafar 12).

### 7.2 For Mohammad: answered by DD 8.6 rows 1 and 2, 3.4 and 3.6 (Ali)
1. Codes not in DD 8.6 item 1: `role.name-taken`; `invitation.already-pending`; the paused factor
   step of Hassan 2 (proposal: `second-factor.locked` with `retryAfterSeconds`); names with control,
   bidi or URL-like text, Hassan 13 (proposal: `validation.failed` with `details.rule`
   `characters`).
2. Hassan 6, as F6 assumes it: an admin invitation is accepted only when the A8 code is accepted,
   and leaving earlier creates nothing. After a reset, a correct password at sign-in mails E16 and
   answers `second-factor-enrolment-required`; the link page takes the password, then enrols, and
   ends in a session.
3. The invitation lifetime by kind (admin 72 hours, Hassan 15; others 7 days), readable for D1.
4. With `sellers`: the status read says whether the re-apply limit is reached, so S1 and P1 can show
   "Not approved" instead of "Changes needed".
5. Invitation acceptance takes a display name in the admin and staff variants, under the sign-up
   name rules (Hassan 13); a `seller-owner` invitee keeps the name the admin gave in D6. Answered:
   DD 3.4 (Jafar).

### 7.3 For Hassan
1. A seller-side account's first, optional enrolment. **Decided by Hassan 2026-10-03:** it starts
   from the mailed link (E16), like every enrolment outside an admin's invitation acceptance,
   because from Phase 5 the Seller Owner's factor proves a payout-account change. B4, S1 and A8
   follow it; "Move to a new phone" still starts with a current code (DD 3.6). He also confirmed the
   12-hour admin limit stance (7.1 item 3) and accepted the 15-minute tag expiry on the admin
   enrolment secret.

### 7.4 Asked of the owner
The orchestrator puts this question in the single owner list with DD 14.4.

| # | Question | Options | Recommendation |
|---|---|---|---|
| 1 | Whom does a locked-out shop owner, or one whose application needs changes, contact? S1, A7, the Auth footer (A10 included) and several emails show the contact, and a shop owner's two-step reset starts there. **Asked of the owner** | (a) One support email address per Market, from Market configuration. (b) No contact on screen; the seller replies to the email they received. (c) A contact form, later | (a), with a named person who reads it (Jafar) and a written identity check before a shop owner's two-step reset (Hassan). Needed before the first real account |

Told, not asked, and shown in the Persian summary: the words a seller reads ("Changes needed", "Not
approved", "This seller account is suspended"): a design decision set by the `sellers` G1, and
legal reads the final text (Jafar, Ali); "keep me signed in" for sellers only, opt-in, at most 30
days (Ali); no promised review time on S1, since the `sellers` G2 asks the owner (Jafar). The
ready-made roles question of DD 14.4 decides the keys `identity.roles.default.<code>.*`.

### 7.5 Inconsistencies found while reading
1. Brief section 12 cites the README for six missing components (Dialog, Select, Textarea, password
   field, code input, Toast). The README only lists what exists; the real gap is larger (section 4).
2. `frontend-kickoff.md` 4.6 and 6 list a Button `link` variant and loading state, sizes
   32/36/44/48, `Avatar`, `Card` and `SearchField`; the Figma library has none of them. Its seller
   row (13) has three statuses; identity also needs "changes needed", "not approved" and "invited".
3. SEL-01's "repeat password" is carried into the brief; it is dropped here (Jafar, answer 4), and
   Hadi records that in the brief's change log.

## 8. Hand-off notes

### 8.1 Design track: what to build in Figma, in order
Follow `docs/design/figma/update-procedure.md`: Sandbox, review, publish, Export tokens.
1. **Release 1.1.0 "Auth"** (unblocks frontend work for slices 2 to 7, S1 and A10; Jafar 8):
   tokens `bg/qr` and `size/auth-card`; 9 icons; `BrandMark`; `Field`; `Input` variants Password
   and Code; `Button` Loading and Link; `ReasonQuote`; `Menu` and `MenuItem` with the description
   line; the `ChecklistItem` variants; the `Topbar` booleans. Template `Auth` with frames for A1
   (default, error, throttled, two-step paused, banner), A2, A3 (with the admin re-enrolment body),
   A4 (form, not usable), A5 (form, sent), A6, A7 (both modes), A8 (three steps; from the link with
   the password first), A9 (three variants, the admin one with the A8 steps; not usable), A10
   (owner, staff) and A11, for Seller and Admin where each applies. Template
   `Seller · Your seller account` (awaiting approval, changes needed, and the final not approved).
2. **Release 1.2.0 "Panel"** (slices 8a to 12): tokens `bg/scrim`, `size/dialog-sm`,
   `size/dialog-md`; `Dialog` with the sheet layout, `Textarea`, `Select`, `Toast`, `EmptyState`,
   `CheckboxRow`; the `TableCell` loading variant; the Phase 2 frame of `Admin · Sellers`; then the
   five shared templates with their dialogs. The role editor needs frames for custom, default and
   system roles (both panels' words), a row disabled by R1, a row disabled by R11 (both panels'
   reasons), a duplicate with unticked rows, and the empty catalogue.
3. Each release: the README section 8 checklist, both themes, Audit with zero warnings, token
   export, changelog, README counts, `claude/design-status.md`.
4. The table of brief section 12 is filled from section 4: Reza fills it, Jafar approves (Ali 11).
   Owner review: a short Persian summary with screenshots of A1, S1 (changes needed), A10, D4 and
   B3, which shows the status words instead of asking about them, and the question of 7.4.

### 8.2 Frontend track: which screens wait for which backend slice
Every screen also waits for the D1 and D2 ADRs and slice F0 (brief slice 13).

| Screens | Backend slice | Library release |
|---|---|---|
| A1, sign out (F12) | 2; the seller outcomes of sign-in need 5; admin sign-in needs 7 | 1.1.0 |
| A3, A4 | 3 | 1.1.0 |
| A5, A6; password card of B4 | 4 | 1.1.0 (B4: 1.2.0) |
| A2 seller; S1 "awaiting approval" | 5 | 1.1.0 |
| A9 admin with the A8 steps; A7; A8 from the link in E16; the re-enrolment body of A3 | 7 | 1.1.0 |
| B1 Admins (list, change role); B2 read-only; D2; B5 | 8a | 1.2.0 |
| D1 for admins; deactivate (D3) and reactivate; reset an admin's two-step verification | 8b | 1.2.0 |
| P1; D3 to D6; A10; S1 "changes needed"; A9 for a seller created by an admin | 9 | 1.2.0 (A10, S1: 1.1.0) |
| B3 editor; B2 actions | 10 | 1.2.0 |
| B1 Team; A9 staff | 11 | 1.2.0 |
| A7, A8 for sellers (from the link in E16); A11; two-step card of B4 | 12 | 1.2.0 (A8, A11: 1.1.0) |

- Emails are built by `identity` on the backend (brief section 3, SEL-13; DD 9) from the
  `identity.mail.*` keys of section 5; frontend and backend share one key scheme.
- P1 is a Phase 2 screen: in Phase 3 approve and reject move to the `sellers` review screen (DD
  8.4, ADR-0022), so build its actions as a list the API supplies.
- **Hosting (Hassan 7), input to the D2 ADR:** each panel and the storefront on its own host, so a
  script injected into one panel cannot use the other's session. The sign-in pages of F2 then live
  on separate hosts, and a return URL stays a path of the same host.
- **Before the frontend of B1 to B3:** the mobile navigation (D16) (Jafar, answer 8). **Before the
  first real account:** the support contact (7.4) and support's written identity check for a shop
  owner's two-step reset (Hassan). **Before the first real customer:** the mini-review "find and
  deactivate a customer" (1.3). Each is a board item.
- The QR code is drawn in the browser; no remote QR or CAPTCHA service (Hassan). Rule 5 of 3.0 is a
  frontend acceptance check (Hassan agreed).
- Error handling is one mapping from state code to `identity.error.<code>`, with the unknown-code
  fallback. No screen parses message text.
- The panel server sends `x-market-id` (board request 6); the Market name in the Auth footer comes
  from Market configuration. A return URL is accepted only when it is a path of the same panel.
- **Native client later (EXT-04).** Nothing here needs a browser: no step relies on cookies,
  redirects between sites or browser storage; email links have configurable targets; two-step setup
  offers a text key and an app link beside the QR code; copy, download and print are conveniences,
  not steps. Session transport is Mohammad's design (board request 10); admins never get bearer
  tokens (Hassan 14).
