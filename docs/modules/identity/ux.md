# identity: flows and screens (G2 UX specification)

| | |
|---|---|
| Author | Reza (ui-ux-designer) — 2026-10-03 |
| Status | Draft — G2 review pending |
| Module | `identity`, tier A, Phase 2. G1 approved by the owner on 2026-10-02 |
| Reviewers | Jafar (product-designer), Ali (cto), Hassan (security-tester). Mohammad (software-architect) writes the domain design in parallel |
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
- Board `claude/tracks.md` revision 13: request 8 item 4 (landing page of a seller that is not
  approved, from `sellers` G1 of 2026-10-03) and request 10 (a native client later)

**Not verified.** The Figma file was not opened; the library inventory comes from its README and the
plugin source. The `sellers` brief is not on this branch; its decisions are taken from the board.
Thresholds and durations left to G2 appear as named values (`{min}`, `{duration}`).

**Parallel draft.** Mohammad's `docs/design/domain/identity.md` was written while this document was.
I read it as it stood when I finished, unreviewed, and cite it as "DD n". Where it names a state
code or settles a rule this document follows it; 7.2 lists the rest.

**IDs.** A = screen on the shell-less Auth template; S, P, B = screen inside the shell of the Seller
panel, the Admin (platform) panel, or both; D = dialog; E = email; F = flow. "Criterion n" is
acceptance criterion n of brief section 10; "slice n" is a row of brief section 11.

## 1. Scope and inventory

Phase 2 UI is the two panels; the three account populations of ADR-0018 decision 3 sign in at
separate entry points. Customer screens are specified as **behaviour and copy only** (the "Cus"
variants): the brief makes Phase 2 customer work API and tests, the storefront has no design
direction, and customer flows get a mini-review when storefront design starts (brief sections 3, 4-D
and 8). Totals: **18 screens, 6 dialogs, 15 emails** (11 emails from the brief, 4 from the draft
domain design).

### 1.1 Screens and dialogs
| ID | Name | Panel | Slice | Criteria | Priority | Note |
|---|---|---|---|---|---|---|
| A1 | Sign in | Seller, Admin, (Cus) | 2, 5, 7 | 1, 2, 3, 7, 13, 20 | P0 | States: error, throttled, session ended, signed out, password changed |
| A2 | Sign up | Seller, (Cus) | 1, 5 | 3, 21 | P0 | No admin sign-up exists (criterion 22) |
| A3 | Check your email | Seller, (Cus) | 3, 5 | 16 | P0 | Also the answer to sign-in with an unconfirmed email |
| A4 | Confirm your email (from the link) | Seller, (Cus) | 3 | 16, 19 | P0 | Asks for the account's password (DD 6.7) |
| A5 | Forgot password | Seller, Admin, (Cus) | 4 | 13, 21 | P0 | |
| A6 | Choose a new password | Seller, Admin, (Cus) | 4 | 8, 19 | P0 | **Merged:** "link expired" and "link already used" are one state (7.3-2) |
| A7 | Two-step verification: enter code | Admin, Seller | 7, 12 | 7, 10, 30 | P0 Admin; optional Seller | **Merged:** "I have lost my device" is a mode of this screen |
| A8 | Two-step verification: set up | Admin (Auth), Seller (from B4) | 7, 12 | 10, 22, 30 | as A7 | **Merged:** backup codes are step 3, not a separate screen |
| A9 | Accept invitation | Admin, Seller | 8, 9, 11 | 19, 22, 29, 31, 37 | P0; P1 for staff | Three variants plus "invitation not usable" |
| A10 | Account suspended | Seller | 5, 9 | 7, 14 | P0 | No session exists; reason for the Seller Owner only |
| A11 | Confirm the reset of two-step verification | Seller | 12 | 30, 33 | optional Seller | From DD 7.3: the Seller Owner confirms, by the link in E15, a reset that an admin started |
| S1 | Your seller account (landing while not approved) | Seller | 5, 9 | 4, 6 | P0 | **Merged:** "awaiting approval" and "not approved" are states of one page |
| P1 | Seller accounts | Admin | 9 | 4, 5, 6, 9, 14, 31 | P0 | The existing `Admin · Sellers` template, reduced |
| B1 | Members ("Team" / "Admins") | both | 8, 11 | 23, 25, 29, 33, 34, 35 | P0 Admin, P1 Seller | Tab 1 of "Team & roles" (Seller) and "Roles & permissions" (Admin) |
| B2 | Roles | both | 8, 10 | 25 | as B1 | Tab 2 |
| B3 | Role: view, create, edit | both | 10, 11 | 23, 24, 25, 35, 36 | as B1 | One editor for both panels (decisions 8 and 8b) |
| B4 | Account security | both, (Cus: password) | 4, 7, 12 | 30, 32 | P0 | Change password; two-step verification |
| B5 | No access | both | 8 | 9, 15 | P0 | |
| D1 | Invite a team member / an admin | both | 8, 11 | 22, 29, 37 | as B1 | |
| D2 | Change role | both | 8, 11 | 23, 26, 33, 34 | as B1 | |
| D3 | Confirm action | both | 8 to 12 | 14, 25, 33 | P0 | One dialog, eight uses (3.3) |
| D4 | Reject seller, reason required | Admin | 9 | 6 | P0 | Its read-only state serves "View reason" |
| D5 | Suspend seller, reason required | Admin | 9 | 14 | P0 | |
| D6 | Add seller (sends an invitation) | Admin | 9 | 5, 31 | P0 | |

### 1.2 Emails
Text templates, outside Figma. Every email names its account type (criterion 3).

| ID | Email | To | Slice | Criteria | Priority |
|---|---|---|---|---|---|
| E1 | Confirm your email | New seller or customer account | 3 | 16, 19 | no feature ID |
| E2 | Welcome | Seller, after the email is confirmed | 5 | 4 | P0 (SEL-02) |
| E3 | A seller is waiting for approval | Admins who may approve, only after the seller's email is confirmed | 5 | 16 | P0 (SEL-02) |
| E4 | Seller approved | Seller Owner | 9 | 4 | P0 (SEL-02) |
| E5 | Application not approved, with the reason | Seller Owner only | 9 | 6 | P1 (SEL-13), needed by decision 9 |
| E6 | Account suspended, with the reason | Seller Owner only | 9 | 14 | P1 (SEL-13) |
| E7 | Suspension lifted | Seller Owner | 9 | 14 | P1 (SEL-13) |
| E8 | Reset your password | Any existing account | 4 | 8, 19, 21 | P0 (SEL-05) |
| E9 | Invitation: seller created by an admin | Invited seller | 9 | 31 | P0 (SEL-06) |
| E10 | Invitation: seller team member | Invited person | 11 | 29, 37 | P1 (PNL-05) |
| E11 | Invitation: admin | Invited person | 8 | 22, 37 | P0 (ADM-05) |
| E12 | You already have an account | Holder of an existing account when someone signs up with the same email, or invites it to a team | 1, 5, 11 | 21 | From DD 6.7; not in the brief (7.3-1) |
| E13 | Your password was changed | The account, after a reset or a change | 4 | 8, 32 | From DD 3.7 and 9; not in the brief |
| E14 | Two-step verification was changed or reset | The account | 7, 12 | 11, 30 | From DD 3.6 and 9; not in the brief |
| E15 | Confirm the reset of two-step verification | Seller Owner | 12 | 33 | From DD 7.3; not in the brief |

### 1.3 Listed in the brief or the task, and not designed
- **Deactivate a customer account** (brief section 3): the use case and its permissions stay (DD
  5.3), but Phase 2 has no customer list to reach it from. API and tests only (7.1-5).
- **Session list and "sign out other sessions"**: not in the brief, so no screen (DD 14.1 item 8
  agrees). Other sessions end by the rules of brief section 5.
- **"Keep me signed in"** is an owner question of the domain design (DD 6.1); A1 reserves its place.
  **Terms acceptance (VER-11)** waits for the `legal` module; A2 keeps an empty slot for it.
  **Changing the sign-in email** is out of scope.
- **"Apply again"** is specified for S1 but not shown in Phase 2: there is nothing to correct before
  `sellers` exists (DD 3.3 agrees; 7.1-2).

## 2. Flows

The API answers with a stable state code; the UI maps it to a translation key (section 5) and never
shows server text (brief section 6, INTL-11). Codes that the draft domain design names are used as
they are: DD 5.2 (`session.invalid`, `access.denied`, `access.seller-not-approved`,
`request.throttled`, `conflict.stale`) and DD 6.3 (`credentials.invalid`,
`email-verification-required`, `second-factor-required`, `second-factor-enrolment-required`,
`account.disabled`, `membership.none`, `seller-access.suspended`, `signed-in`). The other names are
**proposals** in the same style, for Mohammad to fix. Three answers can follow any step and are not
repeated: `market.*` (generic error page), `request.throttled` with `retryAfterSeconds`, and
`session.invalid` (A1 with "session ended"). **Uniform answer** means the same status, body and
screen whether or not an account exists. No flow depends on something only a browser can do (8.2).

### F1. Customer sign-up and email confirmation (behaviour only; CUS-01)
| # | Step | Failure or branch: state code and what the user sees |
|---|---|---|
| 1 | The customer opens sign-up from the storefront (link targets are configurable). The page says "customer account" | — |
| 2 | Enters email and password and submits | `validation.failed`: field errors. `password.rejected` with its rule: error on the password field |
| 3 | The API answers `sign-up.accepted` for a new email and for one that already has a customer account (uniform answer). The UI shows A3 | Existing account: nothing is created; its holder gets E12 instead of E1 |
| 4 | The customer opens the link in E1, types the account's password on A4 (DD 6.7) and sees "Email confirmed" | `link.rejected` (unknown, expired, used, other Market, other account type: one answer): A4 "link not usable" with "Send a new link". Wrong password: `credentials.invalid` |
| 5 | Sign-in follows F2. DD 3.2 proposes confirmation before any session for customers too, which keeps step 3 uniform | Not confirmed yet: `email-verification-required`, then A3 |

### F2. Sign-in, every population (SEL-04, CUS-01, admin)
The seller panel, the admin panel and (later) the storefront each have their own sign-in URL. No
page offers a switch that carries typed credentials to another population.

| # | Step | Failure or branch: state code and what the user sees |
|---|---|---|
| 1 | The user opens one population's sign-in page. Badge, H1 and page title name the account type | — |
| 2 | Submits email and password | Unknown email, wrong password, an account of another population or Market: `credentials.invalid`. One message; the password field is cleared |
| 3 | The same submit, after repeated failures | Too many failures for the account or the origin: `request.throttled` with `retryAfterSeconds`. Same answer for an email with no account. "Forgot password?" stays usable (criterion 13) |
| 4 | Password correct, email not confirmed | `email-verification-required`: A3 with resend. No session |
| 5 | Password correct, second factor enrolled | `second-factor-required`: A7 (F7). Nothing about the account's or the seller's status is shown yet (criterion 7) |
| 6 | Password correct, admin without a second factor | `second-factor-enrolment-required`: A8 (F6). No session |
| 7 | Authentication complete: customer, admin, or member of an approved seller (`signed-in`). Go to the return URL if it belongs to this panel, otherwise Home. Staff see only what their role permits | No session, and A1 says why (DD 6.3 step 6): `account.disabled` for a deactivated admin or customer account; `membership.none` for a seller-side account that is no longer in a team |
| 8 | Authentication complete, seller awaiting approval or not approved: limited session, `sellerAccess: pending` or `rejected`. Go to S1 (F5) | — |
| 9 | Authentication complete, seller suspended | `seller-access.suspended`, no session: A10. `reason` is present only for the Seller Owner |

### F3. Password reset and change (SEL-05, used for every population)
| # | Step | Failure or branch |
|---|---|---|
| 1 | "Forgot password?" on A1 opens A5 for the same population. The user enters the email | `validation.failed` (format only) |
| 2 | The API answers `password-reset.accepted` whether or not the account exists; A5 shows its "sent" state. E8 goes only to an existing account | `request.throttled`: the wait time, identical for any email |
| 3 | The user opens the link (valid for 60 minutes) and enters a new password on A6 | `link.rejected`: A6 "link not usable", back to A5. `password.rejected`: field error |
| 4 | Done: every open session of the account ends. The user lands on A1 with "Password changed". They are not signed in automatically, so the second factor is never skipped. E13 is sent | — |
| 5 | Change while signed in (B4): current password, new password, and a code when two-step verification is on (DD 6.5). Other sessions end, the current one continues; E13 is sent | `password.current-incorrect`, `password.rejected`, `second-factor.code-rejected` |

### F4. Seller sign-up to first sign-in, then rejection, re-application, suspension (brief 4-A)
| # | Step | Failure or branch |
|---|---|---|
| 1 | A2: name, email, password, confirm password | `validation.failed`, `password.rejected` |
| 2 | `sign-up.accepted` (uniform answer): A3 with "Send it again" and "Wrong address? Sign up again" | `request.throttled` on resend |
| 3 | The link in E1 opens A4; with the password typed there the email is confirmed. E2 goes to the seller; only now E3 goes to the admins | `link.rejected`, `credentials.invalid` |
| 4 | Sign-in (F2). Approval required (on for the AU Market): S1 "awaiting approval". Approval not required: Home, and S1 is never shown (criterion 5) | — |
| 5 | An admin approves (F9): E4. The seller's next request has full access; Home replaces S1 | — |
| 6 | An admin rejects with a reason: E5 to the Seller Owner, and the seller's sessions end (DD 3.3). After the next sign-in S1 shows "not approved" and the reason | — |
| 7 | "Apply again" on S1 returns the seller to "awaiting approval". Not on the screen in Phase 2 (7.1-2) | `seller-access.reapply-limit` (DD 8.1): a message replaces the button |
| 8 | An admin suspends: E6. Open sessions end at their next request (A1, "session ended"); the next sign-in ends on A10. Lifted: E7, and sign-in works again | — |

### F5. Limited sign-in and the landing page of a seller that is not approved
**Proposal** (answers board request 8 item 4; decision 6; brief section 12; DD 8.5 describes the
same page from the domain side):
- **One page, one route.** While the session is limited, the seller panel's Home route renders S1
  "Your seller account", inside the `AppShell`, with navigation reduced to what the server
  allow-list permits: in Phase 2 this page, Account security and Sign out.
- **Cards in a fixed order:** status banner; the reason (not approved, Seller Owner only); a steps
  card; help. `identity` owns the first two and three steps: "Account created", "Email confirmed",
  "MondaPac reviews your application".
- **Hand-over without a redesign.** In Phase 3 `sellers` adds its steps before the review step ("Add
  your business details", later the certificate step) and shows its "complete your details" form on
  this route under the same banner. Route, template, banner and step component stay: the `sellers`
  page **is** S1 with more steps. After approval the route is the normal Home
  (`panels-ux-strategy.md` 6.3).
- **Contract.** Status, reason and dates come from `identity`'s API; the frontend assembles the
  steps from definitions that each module owns, so `identity` never imports `sellers` (R7).
- **Phone width.** Seller Owners sign up on a phone. Below 760 px the limited shell is a compact
  header (brand mark, account menu); with one destination no drawer is needed, so S1 does not wait
  for the undesigned mobile navigation (D16).

| # | Step | Failure or branch |
|---|---|---|
| 1 | Sign-in completes with `sellerAccess: pending` or `rejected`: S1 | Any other panel URL redirects to S1; any other API call is `access.seller-not-approved` (DD 5.2; criterion 4) |
| 2 | S1 re-reads the status on load and when the window regains focus; it does not poll. Approved: Home and the full navigation replace it | The status cannot be loaded: inline error with "Try again" |
| 3 | Staff cannot meet this page under DD 3.3 (a seller with a team never returns to these states). If that changes, Staff see the status without the reason | — |

### F6. Admin first sign-in with mandatory enrolment (criteria 10 and 22)
| # | Step | Failure or branch |
|---|---|---|
| 1 | The admin has accepted an invitation (F8); the first admin's invitation comes from the operator routine (DD 7.4). After the password step of sign-in the API answers `second-factor-enrolment-required` | — |
| 2 | A8 step 1: a QR code, the same key as text with Copy, and an "Open authenticator app" link | — |
| 3 | A8 step 2: enter the 6-digit code the app shows | `second-factor.code-rejected`: field error. After too many wrong codes the challenge ends (`second-factor.challenge-ended`, DD 6.8) and sign-in starts again |
| 4 | A8 step 3: ten backup codes (DD 7.3), shown once, with Copy, Download and Print. Ticking "I've saved these codes" enables "Continue" | Leaving early: enrolment stands; the codes cannot be shown again, only replaced in B4 |
| 5 | Signed in: Admin Home. No admin session existed before this step | Setup abandoned before step 3: the next sign-in restarts at step 1 with a new key |

### F7. Second-factor challenge, recovery and reset
| # | Step | Failure or branch |
|---|---|---|
| 1 | A7: enter the 6-digit code and press "Verify" | `second-factor.code-rejected` (does not say whether the code was wrong or late); `second-factor.challenge-ended`: back to A1 |
| 2 | "Use a backup code instead" (same screen, second mode): one code, single use. B4 then shows how many are left | The same two codes |
| 3 | No phone and no backup codes: A7 says who can help (DD 7.3). Staff: the Seller Owner. Admin: another admin who may reset it. Seller Owner: the support contact (owner question 2). The last Platform Administrator: the operator, with no screen | — |
| 4 | Reset by another person, with D3. A Staff member: the Seller Owner, from B1. An admin: another admin, from B1. A Seller Owner: an admin starts it from P1, E15 goes to the owner, and nothing changes until the owner opens its link and confirms on A11 | The action is disabled, with the reason, when R1 or R11 forbids it. A11 with a bad link: `link.rejected` |
| 5 | After a reset the target's sessions end and E14 is sent. An admin must enrol again at the next sign-in (F6); a seller-side account signs in with its password and B4 shows two-step verification as off | — |

### F8. Invitation acceptance (admin, seller team member, seller created by an admin)
| # | Step | Failure or branch |
|---|---|---|
| 1 | The link in E9, E10 or E11 opens A9. The API returns a summary of the invitation: account type, invited email, role name, and for staff who invited them (7.2-5) | `invitation.rejected` (unknown, expired, used, cancelled, role deleted, seller no longer approved, other Market: one answer): A9 "not usable". No account is created (criterion 37) |
| 2 | The invitee chooses a password. The email is fixed and read-only (criterion 29). An existing seller-side account with no team signs in instead (DD 6.7) | `password.rejected`, `credentials.invalid` |
| 3 | The account now exists and no session is created (DD 3.4): A1 of that population with "Your account is ready. Sign in." | — |
| 4 | First sign-in. Admin: enrolment on A8, then Admin Home (criterion 22). Seller team member: the inviting seller's panel, with the invited role only. Seller created by an admin: S1 "awaiting approval" when approval is required (criterion 31), otherwise Home | — |

### F9. Admin review of a seller (SEL-03, SEL-06, SEL-07, decision 9)
| # | Step | Failure or branch |
|---|---|---|
| 1 | P1 opens on the tab "Awaiting approval". Each row carries the actions the API allows | An admin with View only sees the actions disabled with the reason (criterion 9); a direct call is `access.denied` |
| 2 | Approve (also offered on "Not approved" rows if DD 3.3 keeps that correction): D3 confirmation. Toast; E4 is sent | `conflict.stale` (the status changed meanwhile): the row refreshes and a message explains |
| 3 | Reject…: D4 with a required reason. E5 is sent | `seller-access.reason-required` (also checked before submit) |
| 4 | Suspend… (approved sellers): D5 with a required reason. Every session of that seller ends. E6 is sent | As step 3 |
| 5 | Lift suspension: D3. E7 is sent | As step 2 |
| 6 | Add seller: D6 with name and email. A row appears under "Invited" with Resend and Cancel | `validation.failed` |
| 7 | Phase 3 (DD 8.4) | Approve and reject move to the `sellers` review screen and leave P1; suspend and lift suspension stay |

### F10. Role editor, both panels (ADM-05, PNL-05, R1 to R12)
| # | Step | What the user sees of the rules |
|---|---|---|
| 1 | B2 lists system, default and custom roles with their member counts | No custom role yet: empty state with "Create role" |
| 2 | Opening a system or default role shows B3 read-only. A default role offers "Duplicate" | R3, R9, R10: no Edit or Delete on these roles; a banner says why. Direct call: `role.read-only` |
| 3 | "Create role" or "Duplicate" opens B3: a name and permissions from this panel's catalogue only | R2: the other panel's permissions never appear. `role.name-taken`, `role.limit-reached` |
| 4 | The user ticks permissions | R1: a permission the user does not hold is disabled, with the reason. R11: a protected permission carries a "Protected" tag and is disabled unless the user holds the system role. Tampered request: `role.permission-not-grantable`, nothing is saved |
| 5 | Save. The toast says the change applies from each person's next action | R4. R10 is stated on the page: new features are never added to a custom role automatically |
| 6 | Delete a custom role: D3 | Delete is disabled while members hold the role (`role.in-use`, DD 2.3). The dialog says how many pending invitations stop working (R12) |
| 7 | Rules with no control of their own: R5 to R8 | Their one UI consequence: role names and reasons never appear in URLs, page titles or telemetry (R5) |

### F11. Team management for a Seller Owner, and admin management (same template)
| # | Step | What the user sees of the rules |
|---|---|---|
| 1 | B1 lists members and pending invitations | Managing is the Seller Owner's alone in Phase 2 (criterion 35). A Staff role can at most view (DD 5.3, `identity.team-member.view`): every action is then disabled with the reason. Without it the menu item is hidden and the URL gives B5. A seller that is not approved has S1 only |
| 2 | Invite: D1 with email and role. The row shows "Invited" | R1: roles holding permissions the inviter lacks are disabled in the picker, with the reason. The answer is uniform for any email (DD 6.7). `invitation.already-pending`, `member.limit-reached` |
| 3 | Resend or cancel a pending invitation (R12) | — |
| 4 | Change role: D2. Applies from the member's next request; they stay signed in (R4) | Own row: no action, "You can't change your own role" (R1). Member holds permissions the actor lacks: disabled (`member.outranks-actor`). Last holder of a system role: disabled (`member.last-holder`, R3) |
| 5 | Remove from team (Seller) or Deactivate account (Admin; with "Reactivate account" if DD 3.1 keeps re-enabling): D3. Their sessions end at once | The same three rules |
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
   configuration, because an account belongs to one Market. Touch density at every width.
2. **Account type** is named three times: Badge, H1 and document title; never by colour alone.
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
   reason.

### 3.1 Auth template
| Screen and purpose | Content, top to bottom | Fields, validation, actions | States | Never shown |
|---|---|---|---|---|
| **A1 Sign in.** Authenticate one population | Badge; H1; banner slot; Email; Password with show/hide; "Sign in"; "Forgot password?". Seller only: "New to MondaPac? Create a seller account" and the fixed note "Seller and customer accounts are separate. Each has its own password."; "Keep me signed in on this device" if the owner approves it (DD 6.1) | Email: required, format, `autocomplete="username"`. Password: required, `current-password`. No password rules are shown here | `credentials.invalid`: summary; email kept, password cleared. Throttled: summary with the wait; "Sign in" disabled until it passes; the reset link stays active. `account.disabled` and `membership.none`, only after complete authentication: summary. Banners: session ended, signed out, password changed, account ready | Before authentication is complete: which value was wrong; attempts left; that the account is unconfirmed, awaiting approval, suspended or deactivated. Ever: that the email has an account of another type |
| **A2 Sign up (Seller).** Create the seller account (`identity`'s share of SEL-01) | Badge; H1; one line on what happens next; Your name; Email; Password with the policy rule; Confirm password (SEL-01 lists it; 7.1-4 proposes to drop it); "Create account"; "Already have a seller account? Sign in"; legal text slot (L) | Name: required, maximum length from the API. Email: format. Password: policy. The confirmation must match. Customer variant: email and password only | Field errors; success is A3 | "This email is already registered" |
| **A3 Check your email.** Send the user to their inbox | Mail icon; H1; "We've sent an email to {email}" (true for E1 and for E12); a hint about delay and spam; "Send it again"; "Wrong address? Sign up again"; "Back to sign in". Reached from sign-in (F2 step 4), the body says the email must be confirmed first | No fields | Sent; sent again (status message); throttled, with the wait | Whether the address already had an account |
| **A4 Confirm your email.** Finish the confirmation from the link | Form: Badge; H1; Password; "Confirm email" (the link works only with the account's password, DD 6.7). Confirmed: H1, the next step for this account type, "Sign in". Not usable: H1, one explanation covering expired and used, Email, "Send a new link" | Password: required, `current-password`. Email (not-usable state): required, format; the answer to "Send a new link" is uniform | Checking (a skeleton card and "Checking your link…", so an error never flashes); form; wrong password (`credentials.invalid`); confirmed; not usable; new link sent | Which cause applied; the account's email or name |
| **A5 Forgot password.** Ask for a reset link | H1 names the account type; Email; "Send reset link"; "Back to sign in" | Email: required, format | Sent: "If a seller account uses {email}, we've sent a link…", with the 60 minutes | Confirmation that the account exists; a different delay for a known email |
| **A6 Choose a new password.** Complete the reset | Badge; H1; New password with the policy rule; confirmation as decided for A2; the note that this signs the user out everywhere; "Save new password" | New password: policy. The account email sits in a hidden username field for password managers | Link not usable (as A4, leading to A5); success goes to A1 with a banner | The account email; automatic sign-in |
| **A7 Two-step verification.** Second step of sign-in | Mode 1: H1; code field; "Verify"; "Use a backup code instead". Mode 2: H1; backup-code field; "Verify"; "Use your authenticator app instead". Under both, "Can't use either?" opens help for this population (F7 step 3) | One field per mode (section 6). No auto-submit and no "remember this device" | Code rejected; challenge ended after too many wrong codes (back to A1 with a message) | The seller's status (it comes after this step); whether the code was wrong or late |
| **A8 Set up two-step verification.** Enrol an authenticator app | Three steps labelled in words ("Step 1 of 3"). Step 1: QR code on a white plate; the same key as text in groups of four with Copy; "Open authenticator app". Step 2: code field and "Verify". Step 3: ten backup codes (DD 7.3) as a list in mono type; Copy, Download, Print; the checkbox "I've saved these codes"; "Continue" | The checkbox enables "Continue". Admin (Auth template): no skip, and a line says admin accounts must use it. Seller (in the shell, from B4): "Cancel" until step 2 succeeds | Code rejected; challenge ended; done | The key or the codes once the step is left; either of them in a URL, browser storage or a log |
| **A9 Accept invitation.** Turn an invitation into an account | Badge; H1 and body by variant (admin; seller team member, with who invited them and the role; seller created by an admin); Email, read-only; Password; confirmation as A2; "Accept and continue". Seller variants add the note that this account is separate from a customer account with the same email. An existing seller-side account with no team sees "Sign in and join" with its current password (DD 6.7) | Password: policy | Accepted: A1 with "Your account is ready. Sign in." (no session, DD 3.4). Not usable: one message and no self-service resend | Why it is not usable (cancelled, role deleted and suspended seller look the same) |
| **A10 Account suspended.** Explain why sign-in stopped | Badge; `InfoBanner` (Critical) "This seller account is suspended". Seller Owner: `ReasonQuote` with the reason and its date, and the support contact. Staff: "Ask your shop owner for details". "Back to sign in" | None. Shown only after complete authentication; no session exists | Seller Owner; Staff | The reason to Staff; the name of the admin who acted |
| **A11 Confirm the reset of two-step verification** (Seller Owner; link in E15). Let the owner approve a reset that an admin started (DD 7.3) | Badge; H1; what will happen: two-step verification is turned off, every session ends, and sign-in needs only the password until it is set up again; "Turn off two-step verification"; the line "Didn't ask for this? Close this page and change your password." | No fields | Checking; confirm; done (A1 with a banner); link not usable (as A4, without resend: the owner asks support again) | Who started the reset; the account's email |

### 3.2 Inside the shell
| Screen and purpose | Content, top to bottom | Fields, validation, actions | States | Never shown |
|---|---|---|---|---|
| **S1 Your seller account** (Seller; F5; "Account status" in DD 8.5). Landing while not approved | H1 with a status `Badge`: "Awaiting approval" (Info, clock) or "Not approved" (Critical, x). Card 1: `InfoBanner` Info "We're reviewing your application", or Critical "Your application wasn't approved". Card 2 (Seller Owner, not approved): `ReasonQuote` with the label "Reason from MondaPac", the text exactly as written, and its date. Card 3, steps (`ChecklistItem`): "Account created" and "Email confirmed" done, with dates; a slot for Phase 3 steps; "MondaPac reviews your application" waiting. Card 4: "Protect your account" with a link to two-step setup (on the allow-list, DD 5.2), and the support contact | None in Phase 2. With `sellers`, the last step of a seller that is not approved becomes "Apply again" with its button, or the limit message | Skeleton cards; inline error with "Try again" | Other menu items; internal notes; reviewer names; a promised decision time |
| **P1 Seller accounts** (Admin; template `Admin · Sellers`, reduced). Decide on sellers | Title "Sellers" with the count and Market name. Tabs with counts: Awaiting approval (default), Approved, Not approved, Suspended, Invited, All. Columns: Seller (owner's name over email); Status (`Badge`, icon and word); Since (date of the last status change); Actions. No KPI strip, bulk bar, certificate, health or order columns in Phase 2: those belong to `sellers` | Primary: "Add seller". The row menu holds only the allowed actions: Approve, Reject…, Suspend…, Lift suspension, View reason, Reset owner's two-step verification (DD 7.3); for invitations Resend and Cancel | Skeleton rows; an empty state per tab; load error in the card with "Try again"; for View-only roles the actions are disabled with the reason | Sign-ups whose email is not confirmed; reason text in the table; another Market's sellers |
| **B1 Members.** Manage people and invitations | Seller: page "Team & roles", tabs Team and Roles. Admin: page "Roles & permissions", tabs Admins and Roles. Columns: Person (name over email; "You" on the own row); Role (a lock icon marks a system role); Two-step verification (On or Off; Seller only); Status (Active, Invited, Deactivated); Actions. Seller panel in Phase 2: an Info banner says team members can sign in now and that the parts they can use arrive as features are added (the consequence stated in brief section 3) | Primary: "Invite team member" or "Invite admin". Row actions: Change role, Reset two-step verification, Remove from team or Deactivate account; for invitations Resend and Cancel. Actions that a rule forbids stay visible, disabled, with the reason (F11 steps 4 to 6) | Skeleton rows; empty (owner only): "It's just you so far" with the invite action; view-only (every action disabled with the reason) | Members of another seller or Market; last sign-in times or sessions |
| **B2 Roles.** List roles by type | Rows grouped System, Default, Custom. Columns: Role; Type (`Badge`); Permissions (a count, or "All" for a system role); Members (count); Actions | Primary: "Create role". Row actions: View; custom: Edit, Duplicate, Delete…; default: Duplicate | Skeleton rows; empty custom group: "No custom roles yet" and one line of explanation | Roles of another seller, panel or Market |
| **B3 Role.** View a role; create or edit a custom one | Back link; H1 is the role name; type `Badge`. System and default roles: a read-only banner says why; a default role offers "Duplicate". Custom: Role name; the line "New features are never added to a custom role automatically" (R10); the counter "{selected} of {total} permissions selected". Permissions: one card per resource with "Select all" (three-state checkbox), then a `PermissionRow` per permission: checkbox, label, one-line description, and a "Protected" tag with a lock where R11 applies. Labels come from `permission.<key>.label` | Role name: required, unique within this seller or the platform, maximum length from the API. A row the user may not give is disabled with its reason in text: not held (R1) or protected (R11). "Save role" and "Cancel" are fixed to the bottom of long lists; leaving with unsaved changes asks first | Skeleton; error summary; saved Toast. Seller panel in Phase 2: the catalogue is short (DD 5.3: two view permissions can be chosen; team and role management is protected and shown locked). An Info banner says more permissions arrive with new features, and a role with no permissions can be saved (DD 5.6 has such default roles) | The other panel's permissions (R2); unknown or retired keys (R7); Market or vertical names in labels |
| **B4 Account security.** Own password and second factor | Password card: Current password; New password with the policy rule; confirmation as A2; a code field when two-step verification is on (DD 6.5); "Change password". Two-step card: "On since {date}" or "Off", and the backup codes left. Admin: a line says it must stay on. Seller Owner: a line says it becomes compulsory before payouts are switched on (decision 7). Customer: the password card only | Seller, off: "Set up" asks for the password again, then A8 in the shell (DD 3.6). On: "Get new backup codes" (asks for a current code, shows the codes once) and "Move to a new phone" (current code, then A8). Seller only: "Turn off…" (D3, with a code) | `password.current-incorrect`; `password.rejected`; Toast on success | The current key or old codes; a session list |
| **B5 No access.** Answer to a page the role does not include | Lock icon; H1; who to ask (Seller: the shop owner; Admin: an admin who manages roles) | "Go to Home" | One state | The missing permission key; whether the requested record exists (7.3-6) |

### 3.3 Dialogs
The title names the action and its object; the primary button repeats the verb. A destructive
confirmation uses the Destructive button and opens with focus on "Cancel".
- **D1 Invite.** Email (required, format); Role (`Select`; roles the user may not give are disabled
  with the reason); helper: the person sets their own password and the link works for `{duration}`;
  "Send invitation". The success Toast is the same for any email (DD 6.7).
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
- **D6 Add seller.** Name; Email; helper: the seller chooses their own password, and where approval
  is required the account still needs it after they accept; "Send invitation".

### 3.4 Emails
One layout: subject; heading; an account-type line; two or three sentences; one button; the link's
lifetime as a duration, not a clock time; "If you didn't ask for this, you can ignore this email";
footer (L); always a plain-text part. Subjects carry no personal data and no reason text. E5 and E6
quote the reason in the body and go to the Seller Owner only. E2 has two bodies, by whether approval
is required. E3 carries no seller name or email, only a link to P1. E13 and E14 are notices without
a button; E15's button opens A11. Link targets are configurable per population (brief section 6); a
token is never in the URL path.

## 4. Design-system impact (fills the table of brief section 12)

"Existing" is what `docs/design/figma/README.md` section 5 and the plugin source show. Every change
is additive, so both releases are MINOR: **1.1.0 "Auth"** and **1.2.0 "Panel"**.

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
| Reason shown to the seller | None | New component `ReasonQuote` (label, quoted text, date); used in A10, S1 and D4 | MINOR 1.2.0 |
| Steps on S1 | `ChecklistItem` (Done; To do with two fixed buttons) | New variant `State=Waiting`; BOOLEAN `Show actions`; TEXT for one action label | MINOR 1.2.0 |
| Limited shell on S1 | `Sidebar`, `Topbar`, `NavItem` | `Topbar`: BOOLEAN `Show search` and `Show notifications` | MINOR 1.2.0 |
| Account menu and row action menus | `Topbar` user block has no menu; `TableCell Type=Actions` holds only an `IconButton` | New components `Menu` and `MenuItem` (Default, Hover, Focus, Disabled, Destructive) | MINOR 1.2.0 |
| Role picker | None | New component `Select` (trigger states as `Input`; list built from `MenuItem`, plus Selected) | MINOR 1.2.0 |
| Reason field | None | New component `Textarea` (states as `Input`) | MINOR 1.2.0 |
| Dialogs D1 to D6 | None | New component `Dialog` (Size Sm, Md; Tone Default, Destructive); tokens `bg/scrim`, `size/dialog-sm`, `size/dialog-md`; effect `Elevation/Floating` | MINOR 1.2.0 |
| Confirmation after an action | None | New component `Toast` (Success, Critical) | MINOR 1.2.0 |
| Tables on P1, B1, B2 | `Tab`, `TableCell`, `Pagination`, `IdentityTile`, `CardHeader` | `TableCell`: new `State=Loading` (skeleton) | MINOR 1.2.0 |
| Empty lists | None (README section 14 lists Empty and Loading as open) | New component `EmptyState` (icon, title, body, optional action) | MINOR 1.2.0 |
| Permission list on B3 | `CardHeader`, `Checkbox` | New component `PermissionRow` (Default, Hover, Focus, Disabled, Read-only; Protected tag) | MINOR 1.2.0 |
| Reason beside a disabled control | `Tooltip` is the chart tooltip (label and value) | Inline helper text first; `Tooltip`: new variant `Type=Hint` for table rows | MINOR 1.2.0 |
| Emails; customer screens | Outside the panel design system | None now | — |

- **New templates (8):** `Auth`; `Seller · Your seller account`; `Admin · Seller accounts`;
  `Shared · Members`; `Shared · Roles`; `Shared · Role editor`; `Shared · Account security`;
  `Shared · No access`. Shared templates get a Seller frame and an Admin frame.
- **New components (10, plus `MenuItem`):** `BrandMark`, `Field`, `ReasonQuote`, `Menu`, `Select`,
  `Textarea`, `Dialog`, `Toast`, `EmptyState`, `PermissionRow`; each is used in both panels or in at
  least two places, as the update procedure requires. New tokens: 5. New icons: 9.
- **Design-system version after this module:** 1.2.0. Nothing is renamed or removed, so no MAJOR.

## 5. Copy

**Naming scheme.** `identity.<surface>.<element>[.<variant>]`, kebab-case segments.
- `<surface>`: a screen or dialog (`sign-in`, `seller-status`, `dialog.reject`), `common`, `error`,
  or `mail.<template>` (the prefix of DD 9). `<element>`: `title`, `body`, `label.<field>`,
  `help.<field>`, `action.<verb>`, `status.<state>`, `banner.<name>`, `toast.<name>`, `empty.title`,
  `empty.body`.
- Account type is a `<variant>` (`.seller`, `.admin`, `.customer`) holding a full sentence, never a
  spliced noun, so translators can inflect.
- Errors: `identity.error.` plus the state code, unchanged; an unknown code falls back to
  `identity.error.unknown`. Field checks: `identity.error.validation.<field>.<rule>`.
- Values use ICU MessageFormat (INTL-11). Permission labels are `permission.<key>.label` and
  `.description`, owned by the module that declares the key.
- In the tables, sibling keys and their texts are joined with " · ". (L) marks a row for legal
  review.

**Words used everywhere:** sign in, sign out, sign up; email; confirm your email; two-step
verification; backup code; seller account, admin account, customer account; team member; role;
permission; invitation; awaiting approval, not approved, suspended. en-AU spelling. Domain terms and
their UI words: verified = confirmed; disabled = deactivated; reinstate = lift suspension; revoke =
cancel (an invitation); recovery code = backup code.

| Key (prefix `identity.common.`) | en-AU text |
|---|---|
| `account-type.seller · .admin · .customer` | Seller account · Admin account · Customer account |
| `label.email · .password · .new-password · .confirm-password · .current-password · .name` | Email · Password · New password · Confirm password · Current password · Your name |
| `help.password · action.show-password · action.hide-password` | Use at least {min} characters. A short sentence works well. · Show password · Hide password |
| `action.sign-in · .back-to-sign-in · .cancel · .continue · .try-again · .copy · status.copied` | Sign in · Back to sign in · Cancel · Continue · Try again · Copy · Copied |
| `market` | MondaPac {marketName} |
| `support` (L) | Need help? Email {supportEmail}. |

| Key (prefix `identity.error.`) | en-AU text |
|---|---|
| `credentials.invalid` | Email or password is incorrect. Check both and try again. |
| `request.throttled` | Too many attempts. Try again in {minutes, plural, one {# minute} other {# minutes}}. |
| `second-factor.code-rejected · second-factor.challenge-ended` | That code didn't work. Enter the newest code from your app. · Too many wrong codes. Sign in again to try once more. |
| `password.rejected.too-short · .too-long · .too-common · .matches-identity · password.current-incorrect` | Use at least {min} characters. · Use {max} characters or fewer. · That password is too easy to guess. Choose a different one. · Don't use your email or name as your password. · Your current password is incorrect. |
| `account.disabled.admin · account.disabled.customer · membership.none` (L) | This admin account has been deactivated. Ask another admin if you think this is a mistake. · This customer account has been deactivated. Contact us if you think this is a mistake. · This account isn't part of a seller team any more. Ask the shop owner to invite you again. |
| `validation.email.required · .email.format · .password.required · .name.required · .confirm-password.mismatch · .reason.required · .role-name.required` | Enter your email. · Enter an email address like name@example.com. · Enter your password. · Enter your name. · The two passwords don't match. · Write a reason before you continue. · Give the role a name. |
| `access.denied · conflict.stale` | You don't have permission to do that. · Someone has just changed this. We've refreshed it. |
| `seller-access.reapply-limit` (L) | You've reached the limit for new applications. Contact us to continue. |
| `role.name-taken · role.in-use · role.limit-reached · role.permission-not-grantable · role.read-only` | A role with this name already exists. · Move its members to another role before you delete it. · You've reached the maximum number of roles. · Some permissions couldn't be saved because you can't give them. · This role can't be changed. |
| `member.self-change-refused · member.outranks-actor · member.last-holder · member.limit-reached · invitation.already-pending` | You can't change your own role. · This person has permissions you don't have, so you can't change their access. · At least one {roleName} must remain. · Your team has reached its maximum size. · This person already has an invitation. Resend it from the list. |
| `unknown · network · market · request.csrf` | Something went wrong on our side. Try again. · You're offline or the connection dropped. Check it and try again. · This page isn't available. · Refresh the page and try again. |

| Key (prefix `identity.`) | en-AU text |
|---|---|
| `sign-in.title.seller · .admin · .customer` | Sign in to your seller account · Sign in to your admin account · Sign in to your customer account |
| `sign-in.note.separate · action.forgot · action.sign-up.seller · label.keep-signed-in · help.throttled` | Seller and customer accounts are separate. Each has its own password. · Forgot password? · New to MondaPac? Create a seller account · Keep me signed in on this device · You can still reset your password. |
| `sign-in.banner.session-ended · .signed-out · .password-changed · .account-ready` | Your session has ended. Sign in again to continue. · You're signed out. · Password changed. Sign in with your new password. · Your account is ready. Sign in. |
| `sign-up.title.seller · title.customer · body.seller` | Create a seller account · Create a customer account · First confirm your email. Then MondaPac reviews your application before you can sell. |
| `sign-up.action.submit · action.sign-in.seller` | Create account · Already have a seller account? Sign in |
| `sign-up.legal` (L) | Legal text to be supplied; empty in Phase 2 |
| `check-email.title · body · body.from-sign-in` | Check your email · We've sent an email to {email}. Open it and follow the link to continue. · Confirm your email before you sign in. Use the link we sent to {email}, or send a new one. |
| `check-email.help · action.resend · status.resent · action.wrong-address` | It can take a few minutes. Check your spam folder too. · Send it again · Sent again. · Wrong address? Sign up again |
| `confirm-email.title · body · action.submit · status.checking` | Confirm your email · Enter your password to finish. · Confirm email · Checking your link… |
| `confirm-email.title.confirmed · body.confirmed.seller · body.confirmed.customer` | Email confirmed · Thanks. Sign in to see the status of your seller application. · Thanks. You can sign in now. |
| `link.title.rejected · body.rejected · action.send-new · status.sent` | This link can't be used · It may have expired or already been used. Enter your email and we'll send a new one. · Send a new link · If that address needs a link, we've sent one. |
| `forgot-password.title.seller · .admin · .customer` | Reset your seller account password · Reset your admin account password · Reset your customer account password |
| `forgot-password.action.submit · title.sent · body.sent.seller` (also `.admin`, `.customer`) | Send reset link · Check your email · If a seller account uses {email}, we've sent a link to reset its password. The link works for 60 minutes. |
| `reset-password.title · body · action.submit` | Choose a new password · Changing your password signs you out everywhere. · Save new password |
| `two-step.title · body · label.code · action.verify` | Enter your 6-digit code · Open your authenticator app and enter the code for MondaPac. · 6-digit code · Verify |
| `two-step.action.use-backup · title.backup · body.backup · label.backup-code · action.use-app` | Use a backup code instead · Enter a backup code · Each backup code works once. · Backup code · Use your authenticator app instead |
| `two-step.help.staff · help.admin` | No phone and no backup codes? Ask your shop owner to reset two-step verification for you. · No phone and no backup codes? Ask another admin who manages admin accounts to reset it. |
| `two-step.help.owner` (L) | No phone and no backup codes? Email {supportEmail} from the address you sign in with. |
| `two-step-setup.title · body.required.admin · label.step` | Set up two-step verification · Admin accounts must use two-step verification. · Step {current} of {total} |
| `two-step-setup.body.scan · alt.qr · body.manual · action.open-app · body.code` | Scan this code with an authenticator app on your phone. · QR code for your authenticator app · Can't scan it? Enter this key in the app instead. · Open authenticator app · Enter the 6-digit code the app shows. |
| `two-step-setup.title.codes · body.codes · label.saved · action.download · action.print · toast.done` | Save your backup codes · If you lose your phone, a backup code lets you sign in. Each code works once. We can't show them again. · I've saved these codes · Download · Print · Two-step verification is on. |
| `invitation.title.admin · .staff · .seller` | Set up your admin account · Join a seller team on MondaPac · Set up your seller account |
| `invitation.body.admin · body.staff · body.seller` | You've been invited to be a MondaPac admin with the role {roleName}. Choose a password, then set up two-step verification. · {inviterName} invited you to join as {roleName}. Choose a password to accept. · MondaPac has created a seller account for you. Choose a password to get started. |
| `invitation.help.email · note.separate · action.accept · title.rejected · body.rejected` | You'll sign in with this email. · This is a seller account. It's separate from any customer account that uses the same email. · Accept and continue · This invitation can't be used · Ask the person who invited you to send a new one. |
| `invitation.body.existing · action.join` | You already have a seller account with this email. Sign in to join the team. · Sign in and join |
| `two-step-reset.title · body · action.submit · help · banner.done` | Turn off two-step verification? · A MondaPac admin started this at your request. You'll be signed out everywhere and sign in with your password only, until you set it up again. · Turn off two-step verification · Didn't ask for this? Close this page and change your password. · Two-step verification is off. Sign in with your password. |
| `suspended.title · body.owner · body.staff` (L) | This seller account is suspended · Nobody on your team can sign in while it's suspended. The reason is below. · Nobody on the team can sign in while it's suspended. Ask your shop owner for details. |
| `reason.title · reason.label.date` | Reason from MondaPac · Written on {date} |
| `seller-status.title · status.pending · status.rejected` | Your seller account · Awaiting approval · Not approved |
| `seller-status.title.pending · body.pending` (L) | We're reviewing your application · We'll email you when there's a decision. Until then you can't sell or use the rest of the seller panel. |
| `seller-status.title.rejected · body.rejected.owner · body.rejected.owner-phase-2 · body.rejected.staff` (L) | Your application wasn't approved · Read the reason below. You can fix the problem and apply again. · Read the reason below. If you have questions, contact us. · Ask your shop owner for details. |
| `seller-status.step.created · step.email · step.review · status.waiting · action.reapply · toast.reapplied` | Account created · Email confirmed · MondaPac reviews your application · In progress · Apply again · Application sent. We'll email you when there's a decision. |
| `seller-status.title.secure · body.secure · action.secure` | Protect your account · Turn on two-step verification while you wait. · Set up two-step verification |
| `sellers.title · body.count · tab.pending · .approved · .rejected · .suspended · .invited · .all` | Sellers · {count, plural, one {# seller} other {# sellers}} in the {marketName} market · Awaiting approval · Approved · Not approved · Suspended · Invited · All |
| `sellers.label.seller · .status · .since · action.add · .approve · .reject · .suspend · .unsuspend · .view-reason · .reset-two-step · .resend · .cancel-invitation` | Seller · Status · Since · Add seller · Approve · Reject… · Suspend… · Lift suspension · View reason · Reset owner's two-step verification… · Resend invitation · Cancel invitation |
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
| `dialog.reset-two-step.title · body.admin · body.seller · action` | Reset two-step verification for {name}? · They're signed out and must set it up again at their next sign-in. · They're signed out and sign in with their password until they set it up again. · Reset |
| `dialog.delete-role.title · body · action` | Delete the role "{roleName}"? · This can't be undone. {count, plural, =0 {} one {# pending invitation with this role stops working.} other {# pending invitations with this role stop working.}} · Delete role |
| `dialog.cancel-invitation.title · body · action · action.keep` | Cancel the invitation to {email}? · The link in their email stops working. · Cancel invitation · Keep invitation |
| `members.title.seller · title.admin · tab.team · tab.admins · tab.roles` | Team & roles · Roles & permissions · Team · Admins · Roles |
| `members.label.person · .role · .two-step · .status · .you · status.active · .invited · .deactivated · .two-step-on · .two-step-off` | Person · Role · Two-step verification · Status · You · Active · Invited · Deactivated · On · Off |
| `members.action.invite.team · .invite.admin · .change-role · .reset-two-step · .remove · .deactivate · .reactivate` | Invite team member · Invite admin · Change role · Reset two-step verification · Remove from team… · Deactivate account… · Reactivate account |
| `members.empty.title · empty.body · banner.early` | It's just you so far · Invite the people who help run your shop. Each person gets their own sign-in. · Team members can sign in now. The parts of the panel they can use appear as MondaPac adds features. |
| `roles.action.create · .duplicate · .edit · .delete · status.system · .default · .custom · label.all` | Create role · Duplicate · Edit · Delete… · System · Default · Custom · All |
| `roles.empty.title · empty.body` | No custom roles yet · Default roles cover common jobs. Create a role when you need a different mix of permissions. |
| `role.label.name · label.count · action.select-all · status.protected · action.save` | Role name · {selected} of {total} permissions selected · Select all in {group} · Protected · Save role |
| `role.banner.system · banner.default` | System role. It always has every permission in this panel and can't be changed or deleted. · Default role from MondaPac. It can't be changed. Duplicate it to make your own version. |
| `role.help.custom · help.not-held · help.protected` | New features are never added to a custom role automatically. You choose when to add them. · You can't give a permission you don't have. · Only a {systemRoleName} can give this permission. |
| `role.banner.early · body.unsaved · toast.saved` | Only a few permissions exist so far. More appear here as MondaPac adds features. · You have unsaved changes. Leave without saving? · Role saved. Changes apply from each person's next action. |
| `security.title · title.password · action.change-password · toast.password-changed` | Account security · Password · Change password · Password changed. You've been signed out on your other devices. |
| `security.title.two-step · status.on · status.off · label.codes-left · action.set-up · .new-codes · .move · .turn-off` | Two-step verification · On since {date} · Off · {count, plural, one {# backup code left} other {# backup codes left}} · Set up · Get new backup codes · Move to a new phone · Turn off… |
| `security.help.admin · help.owner` | Admin accounts must keep two-step verification on. · Shop owners will need two-step verification before payouts are switched on. |
| `no-access.title · body.seller · body.admin · action` | You don't have access to this page · Your role doesn't include it. Ask your shop owner if you need it. · Your role doesn't include it. Ask an admin who manages roles. · Go to Home |

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
| `seller-rejected` (L) | Your MondaPac seller application wasn't approved | See what to change |
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

## 6. Accessibility and responsiveness

The gate is WCAG 2.1 AA; because the kickoff commits the panels to 2.2 AA, 2.5.8 (target size),
3.3.7 (redundant entry), 3.3.8 (accessible authentication) and 2.4.11 (focus not obscured) apply
too.
- **Focus order.** Auth: error summary when present, fields in visual order, show/hide button after
  its field, primary action, secondary links, footer. When the step changes without a page load (A1
  to A7, the steps of A8) focus moves to the new H1 and the document title changes. In the shell:
  skip link, sidebar, top bar, content (kickoff section 11).
- **Errors.** The summary is `role="alert"` and takes focus. Field errors use `aria-describedby` and
  `aria-invalid` and are not announced on each keystroke. "Sent again", "Copied" and banners such as
  "session ended" are `role="status"`.
- **One-time code.** One input, `inputmode="numeric"`, `autocomplete="one-time-code"`; pasted spaces
  and hyphens are removed; no auto-advance, auto-submit or countdown. A backup code is a text input,
  not case-sensitive. No step asks the user to solve or remember anything (3.3.8): the design has no
  CAPTCHA; if security review adds one it needs an accessible alternative.
- **Password managers and paste.** Real forms; `autocomplete` values `username`, `current-password`,
  `new-password`; A6 and A9 carry the account email as a username field. Paste is never blocked; no
  `maxlength` below the policy maximum. Show/hide is a button with `aria-pressed`.
- **Timeouts (2.2.1).** Link lifetimes are given as durations in the email and on the page; an
  expired link leads to a one-step recovery. After a session ends the user returns to the same page,
  and B3 keeps unsaved input across the sign-in. A throttle wait is text refreshed at most once a
  minute (kickoff section 7), never a ticking live region. DD 6.1 proposes an idle sign-out after 30
  minutes for admins: the panel warns before it and lets the admin stay signed in (7.2-9). The code
  check allows one time step either way (DD 7.1).
- **Status without colour.** Each status is a `Badge` with an icon and a word; "Not approved" and
  "Suspended" share the Critical tone and differ by icon and word. Errors are icon plus text. A
  disabled control gives its reason in text. Optional fields say "(optional)"; no asterisks.
- **Dialogs and menus.** Focus is trapped and returns to the trigger; Esc closes; a dialog holding
  typed text does not close on an outside click. Menu buttons are named "Actions for {name}";
  disabled items stay focusable and expose their reason.
- **Other.** The QR code has alt text and the text key is its equivalent. Toasts stay at least 6
  seconds, pause on hover and focus, and never carry the only copy of a reason or a code. The reason
  is plain text with `dir="auto"` and its line breaks. Motion stops under `prefers-reduced-motion`.
- **RTL readiness (STO-13).** Logical properties only; directional icons mirror; emails, codes, the
  setup key and the QR code stay left-to-right. Text may grow by 40%: buttons wrap to two lines and
  never truncate. No text inside images.
- **Widths.** Smallest supported width: **320 CSS px** (reflow, 1.4.10) for the Auth template, S1,
  B4, B5 and every dialog; dialogs become full-screen sheets below 480 px. Design frames are 360 and
  1280 wide. P1, B1, B2 and B3 show full tables from 760 px; below that each row reflows to a
  stacked card with the same actions menu, but reaching those pages on a phone needs the mobile
  navigation (D16), which is not designed. Targets: 48 px on Auth; at least 32 px on desktop, with a
  24 px hit area for checkboxes.

## 7. Open points

### 7.1 For Jafar (product-designer), with Hadi where product scope is touched
1. **Landing page (F5).** Agree that S1 is the seller Home route in limited mode and that `sellers`
   extends it with steps and its form, without a second page? DD 8.5 describes the same page as
   "Account status"; one title is needed.
2. **"Apply again"** is not shown in Phase 2: a rejected seller has nothing to correct (name and
   email only), and DD 3.3 keeps the use case behind the facade. It appears with `sellers` as its
   "submit for review" step. Until then S1 shows the reason and the support contact. Agree?
3. **"Your name"** on A2 and D6 is the account holder's name (SEL-01 says only "name"; shop name and
   slug belong to `sellers`). Confirm with Hadi.
4. **Confirm password.** SEL-01 lists "password and repeat password". Recommendation: one field with
   show/hide. The repeat field stays in this document until Hadi decides.
5. **Deactivate customer** has no admin screen in Phase 2 (1.3). A find-by-email page can come by a
   mini-review when customers exist. Agree?
6. **The note on the Team page** that staff can sign in before there is much for them to use
   (`identity.members.banner.early`). Agree to show it?
7. **Default roles.** DD 5.6 proposes six per panel for the owner. Once approved, their names and
   one-line purposes become keys `identity.roles.default.<code>.name` and `.description`. The
   enquiry with Brisbane sellers (brief section 8) has not been done.
8. **Mobile navigation (D16)** is needed before B1 to B3 can be reached on a phone; S1 avoids it.
9. **One status word:** "Not approved" for the brief's "rejected", in both panels.

### 7.2 For Mohammad: what the screens need from the API, and where this differs from the draft
1. Names for the codes of section 2 that DD has not named (sign-up and reset acceptance,
   `link.rejected`, `invitation.rejected`, `password.rejected` and its rules,
   `second-factor.code-rejected`, `role.*`, `member.*`), in the error body of DD 5.2; and the
   password policy values (DD 6.5: 12 to 128 characters) readable before submit.
2. The panel's own read after sign-in. The facade of DD 8.1 returns ids and codes; the account menu
   and B1 also need the display name, the email and the role's name, and S1 and A10 need the reason
   and its date for the Seller Owner.
3. **Password on email confirmation** (DD 6.7 option B) makes a new user type the password on A4 and
   again on A1. Recommendation: a correct password on A4 also completes sign-in when no second
   factor applies; otherwise A1 opens with the email filled in.
4. S1: the dates of the two finished steps and of the last decision, next to the state.
5. Invitation preview for a valid token: account type, email, role name, inviter's display name, and
   whether the address already has an account (the "sign in and join" variant).
6. Per row, the allowed actions and a denial code for each refused one (R1, R3, R11), for members,
   roles and sellers; per permission in B3, a grantable flag with a denial code. The panel must not
   re-implement the `GrantPolicy` of DD 5.5.
7. Roles: DD settles one role per account and that an assigned role cannot be deleted. Still open:
   the limits, "Duplicate" for default roles (my proposal), and whether the action segment is a
   closed vocabulary (I9); the editor works either way.
8. P1: the list (owners with a confirmed email, and invitations); whether search by email is
   possible (DD 11.2); what a row shows while a two-step reset waits for the owner.
9. Lifetimes (DD 6.1): does the API expose the idle and absolute expiry, so the panel can warn an
   admin before the idle sign-out?
10. `account.disabled` and `membership.none` after complete authentication (DD 6.3) and re-enabling
    (DD 3.1) are not in the brief; they are specified here (A1, B1) on the assumption that Ali
    accepts them (DD 14.1).
11. DD 8.4 moves approve and reject to `sellers` in Phase 3. P1 then keeps suspend, lift suspension,
    invitations and the two-step reset. Is that the intended end state of P1?
12. DD 14.4 has three owner questions (default roles, "keep me signed in", dependencies); they and
    7.4 here should reach the owner as one list.

### 7.3 For Hassan (security-tester)
1. E12 (an email to the holder when someone signs up again with their address; DD 6.7 uses the same
   means) and the A3 sentence "We've sent an email": acceptable for a uniform answer?
2. One `link.rejected` and one `invitation.rejected` for every cause, so the brief's separate
   "expired" and "already used" states become one. Confirm.
3. If A4 keeps the password (7.2-3), may a correct password there complete sign-in?
4. Seller Owner without phone and codes (DD 7.3): the path is support contact, an admin starts the
   reset, the owner confirms by the link in E15 on A11. The owner's mailbox is then the only proof.
   Is that enough, and what does support check before starting?
5. Role name (free text) and inviter name in invitation emails and on A9: acceptable?
6. B5: is "no access" identical to "not found" for a record of another seller or Market?
7. The fixed note on A1 about separate accounts: I believe it reveals nothing. Confirm.
8. Copy, Download and Print for the setup key and backup codes: acceptable exposure?
9. E13 and E14 carry no link. Confirm their content: what changed, when, and "if this wasn't you,
   reset your password".
10. Rule 5 of 3.0 (nothing personal in URLs, titles or telemetry) as a frontend acceptance check.

### 7.4 Questions only the owner can answer
| # | Question | Options | Recommendation |
|---|---|---|---|
| 1 | The words a seller reads at the three hard moments (rows `seller-status.*` and `suspended.*` in section 5) | (a) Soft for rejection, plain for suspension: "Your application wasn't approved", with the reason and "apply again"; "This seller account is suspended". (b) Direct for both: "Application rejected", "Account suspended" | (a). A rejection is not final, so the message should point to the fix. A suspension must be unmistakable, so it stays plain. Legal should read the final wording |
| 2 | Whom does a locked-out or rejected shop owner contact? S1, A10, A7 and several emails need a contact, and the two-step reset of a shop owner starts there | (a) One support email address per Market, shown on those screens and emails. (b) No contact on screen; the seller replies to the email they received. (c) A contact form, later | (a). It costs one mailbox that someone reads. Without it a shop owner who lost their phone has no way back in. The address is needed before the first real account |

The domain design has its own owner questions (DD 14.4); they are not repeated here.

### 7.5 Inconsistencies found while reading
1. Brief section 12 cites the README for six missing components (Dialog, Select, Textarea, password
   field, code input, Toast). The README only lists what exists; the real gap is larger (section 4).
2. `frontend-kickoff.md` 4.6 and 6 list a Button `link` variant and loading state, sizes
   32/36/44/48, `Avatar`, `Card` and `SearchField`; the Figma library has none of them. Its seller
   row (13) has three statuses; the brief also needs "not approved" and "invited".
3. Brief sections 3 and 8 put customer screens out of scope, while criterion 3 and this task require
   their behaviour. Resolved as behaviour and copy only.
4. Brief section 12 names "link expired" and "link already used" as two states; brief section 5 and
   platform foundations 5.1 want one answer for an unknown token. Merged (7.3-2).
5. Brief section 9 points to the kickoff for accessibility, which says WCAG 2.2 AA; this task says
   2.1 AA. Section 6 applies 2.1 AA plus four 2.2 criteria.
6. SEL-01's "repeat password" is carried into the brief; 3.3.7 argues against it (7.1-4).
7. The draft domain design adds what the brief does not list: four emails (E12 to E15), a screen
   (A11), a password on the confirmation page (A4), a message for a deactivated account, and
   re-enabling. They are followed here and marked "DD".

## 8. Hand-off notes

### 8.1 Design track: what to build in Figma, in order
Follow `docs/design/figma/update-procedure.md`: Sandbox, review, publish, Export tokens.
1. **Release 1.1.0 "Auth"** (unblocks frontend work for slices 2 to 7): tokens `bg/qr` and
   `size/auth-card`; 9 icons; `BrandMark`; `Field`; `Input` variants Password and Code; `Button`
   Loading and Link; template `Auth` with frames for A1 (default, error, throttled, banner), A2, A3,
   A4 (form, confirmed, not usable), A5 (form, sent), A6, A7 (both modes), A8 (three steps), A9
   (three variants, not usable), A10 (owner, staff) and A11, for Seller and Admin where each
   applies.
2. **Release 1.2.0 "Panel"** (slices 8 to 12): tokens `bg/scrim`, `size/dialog-sm`,
   `size/dialog-md`; `Dialog`, `Textarea`, `Menu` and `MenuItem`, `Select`, `Toast`, `EmptyState`,
   `ReasonQuote`, `PermissionRow`; the new variants of `ChecklistItem`, `TableCell`, `Topbar` and
   `Tooltip`; then the seven in-shell templates with their dialogs. The role editor needs frames for
   custom, default, system, a row disabled by R1, a row disabled by R11, and the empty catalogue.
3. Each release: the README section 8 checklist, both themes, Audit with zero warnings, token
   export, changelog, README counts, `claude/design-status.md`.
4. The table of brief section 12 is filled from section 4 by the brief's owner at G2. Owner review:
   a short Persian summary with screenshots of A1, S1, A10, D4 and B3, and the two questions of 7.4.

### 8.2 Frontend track: which screens wait for which backend slice
Every screen also waits for the D1 and D2 ADRs and slice F0 (brief slice 13).

| Screens | Backend slice | Library release |
|---|---|---|
| A1, sign out (F12) | 2; the seller outcomes of sign-in need 5; admin sign-in needs 7 | 1.1.0 |
| A3, A4 | 3 | 1.1.0 |
| A5, A6; password card of B4 | 4 | 1.1.0 (B4: 1.2.0) |
| A2; S1 "awaiting approval" | 5 | 1.1.0 (S1: 1.2.0) |
| A7, A8 for admins | 7 | 1.1.0 |
| A9 admin; B1 Admins; B2 read-only; D1, D2; B5 | 8 | 1.2.0 |
| P1; D3 to D6; A10; S1 "not approved"; A9 for a seller created by an admin | 9 | 1.2.0 |
| B3 editor; B2 actions | 10 | 1.2.0 |
| B1 Team; A9 staff | 11 | 1.2.0 |
| A7, A8 for sellers; A11; two-step card of B4 | 12 | 1.2.0 (A11: 1.1.0) |

- Emails are built by `identity` on the backend (brief section 3, SEL-13; DD 9) from the
  `identity.mail.*` keys of section 5; frontend and backend share one key scheme.
- P1 is a Phase 2 screen: in Phase 3 approve and reject move to the `sellers` review screen (DD
  8.4), so build its actions as a list the API supplies.
- Error handling is one mapping from state code to `identity.error.<code>`, with the unknown-code
  fallback. No screen parses message text.
- The panel server sends `x-market-id` (board request 6); the Market name in the Auth footer comes
  from Market configuration. A return URL is accepted only when it is a path of the same panel.
- **Native client later (EXT-04).** Nothing here needs a browser: no step relies on cookies,
  redirects between sites or browser storage; email links have configurable targets; two-step setup
  offers a text key and an app link beside the QR code; copy, download and print are conveniences,
  not steps. Session transport is Mohammad's design (board request 10).
