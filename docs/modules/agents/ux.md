# agents: UX screen specs (G2, speed mode)

Owner: Reza (UI/UX). Mockup approved by the owner; this file matches it. Speed mode: only existing
tokens (`docs/design/tokens/tokens.css`, `--mp-color-*`) and `packages/ui` components. New
components are built in code first and listed in section 9 for Figma back-port. Copy is English
(i18n keys per ADR-0002; no hardcoded currency or country). Money is formatted from
`{amount, currency}` by the shared formatter; dates in the agent's own time zone.

## 0. Shared rules

- Apps: `apps/agent` (`agent.localhost:3003`, BFF per ADR-0034/0045); admin additions in `apps/admin`.
- Shell: `AppShell` + `Sidebar` + `Topbar` + `AccountMenu`. Agent nav: Dashboard, My shops, Issues.
  Below 760px the sidebar becomes the `AppShell` drawer (menu button); the agent app has no bottom bar
  (3 items fit the drawer; the seller bottom bar is not reused).
- Status colours only through `Badge`/`Banner` tones (`Badge`: success, attention, info, critical, neutral; `Banner`: no neutral, use info); never colour alone, always a text label.
- Loading: `RouteLoading` (page) and `SkeletonRows` (tables/lists). Route error: `RouteError`. Section error: `LoadError` with "Try again".
- Permission refused: `NoAccess` ("You do not have access to this page."). Cross-agent resource ids return the same not-found page (no existence leak).
- Disabled agent (any signed-in page): the session is ended server-side; the next request shows the sign-in page with a `Banner` tone critical: "Your account is disabled. Contact MondaPac support." No data is shown.
- Breakpoints: 375 (single column, 16px page padding), 768 (two-column grids, sidebar still a drawer), 1280 (fixed sidebar, content max 1120px). Dark mode: tokens switch with the theme (`theme-menu`); no per-screen overrides; focus ring `--mp-color-focus-ring` in both.
- A11y baseline: one `h1` per page, skip link from `AppShell`, visible focus, targets at least 44px on 375, `prefers-reduced-motion` respected, all status/error text announced via `role="status"` (polite) or `role="alert"` (errors), contrast AA in both themes.

## 1. Agent set-up (AGT-01)

Route: `/setup?token=...` (email link). Layout: `AuthLayout`, single card, 3 steps shown as a text progress line "Step 1 of 3" (a real sequence).
1. **Verify**: `TextField` "Email" (read-only, from link), `OtpField`-style code input "Handover code" (8 characters, from the admin). Primary `Button` "Continue".
2. **Password**: `TextField` "New password" + "Confirm password", rule list under the field (Market policy text from server). Primary "Set password".
3. **Authenticator**: QR image (`ImageSlot`), manual key with "Copy key" `FieldAction`, `OtpField` 6 digits "Code from your app". Primary "Finish set-up". Success: redirect to the dashboard, toast "Account ready".

States:
- Loading: submit button shows busy state, fields disabled. Step 3 QR: skeleton until loaded.
- Field error: `FieldStatus` under the field plus `SettingsErrorSummary`-style summary at top; focus moves to the first invalid field. Wrong code: "That code is not right. Check it with MondaPac and try again. {n} tries left."
- Invitation expired or revoked: `Banner` critical: "This invitation has expired. Ask MondaPac to send a new one." No form shown; no retry button.
- Code locked (5 wrong tries): `Banner` critical: "Too many wrong codes. This invitation is locked. Ask MondaPac to reissue it." Form removed.
- Already set up: redirect to sign-in with info `Banner` "Your account is already set up. Sign in."
- Back from step 2/3 to step 1 is not allowed once the code is accepted (code is single-use); "Back" exists only between password and nothing; step 3 cannot be skipped (second factor is mandatory; no "Skip").
- Responsive: card 100% wide at 375, 440px centred at 768/1280. Keyboard: Enter submits the step; step heading receives focus on step change.

## 2. Agent dashboard (AGT-06)

Route: `/`. Layout: `Topbar` title "Dashboard"; month `Select` ("This month", previous months) at top right (wraps below title at 375).
- `StatGrid` of 4 `StatCard`: Sales (net per the agent's basis label), Earnings (accrued), Rate ("5.00% of net sales", basis name), Open issues (count, link to Issues; tone attention when above 0).
- `DashboardCard` "Referral code": code in large mono text, `Button` secondary "Copy code" (toast "Code copied"), helper "Give this code to shops when they apply to sell."
- `DashboardCard` "By month": `LedgerTable` (month, orders, sales, earnings) with `LedgerTotals`. Earnings are labelled "Accrued; payment is not available yet" via a neutral `Badge` (AGT-11 is out of scope).
- Empty (no linked shops): `EmptyState` icon, title "No shops yet", body "Share your referral code. Shops you bring in appear here once approved." Action: "Copy code".
- Empty months: table row "No earnings in this period."
- Error: `LoadError` per card ("Could not load earnings. Try again."). Refunds shown as negative lines in the ledger, never hidden.
- Responsive: 375 one column, stat cards stacked, ledger becomes `DataList` cards; 768 two columns; 1280 four stat columns, ledger and referral side by side. Numbers right-aligned, tabular figures.
- A11y: stat cards are `dl` pairs; the copy button announces the result via `role="status"`.

## 3. My shops

Route: `/shops`. `DataList`/table: Shop name, Status (`Badge`: active success, paused neutral, suspended critical), Linked since, Orders (month), Sales (month), Earnings (month). Month `Select` as on the dashboard. Totals only: no customer name, address, email, or order rows anywhere (AGT hard rule). Row is not a link (no shop detail page); open issues for a shop show as a `Badge` attention "2 open issues" linking to `/issues?shop=...`.
- Empty: same `EmptyState` as the dashboard. Error: `LoadError`. Unlinked shop (ended link): shown under "Past shops" with a muted "Unlinked {date}" and totals clipped to the linked interval, with helper text "Totals cover the time the shop was linked to you."
- Responsive: 375 cards (name + status on top, three figures in a row of labels), 768/1280 table. Table has a caption and `scope` headers; sort is not offered.

## 4. Agent issue thread (AGT-08, AGT-09)

Routes: `/issues` (list, `Tabs`: Open, Fixed, Closed; rows: title, shop, severity `Badge`, status `Badge`, updated) and `/issues/[id]` (thread).
Status badges: open attention "Open", agent_responded info "You replied", resolved success "Marked fixed", closed neutral "Closed". Severity: critical, attention, neutral.
Thread layout: `BackLink` "Issues"; header (title, shop, severity, status, raised date, raised by "MondaPac"); description card; comment list oldest first (author "You" or "MondaPac", time in agent zone); composer at bottom: `TextAreaField` "Comment" (max length from server, counter), `Button` primary "Send comment", secondary "Mark as fixed" (opens `Dialog`: "Mark this issue as fixed? MondaPac will review it and may reopen it." buttons "Mark as fixed" / "Cancel").
- Actions by state: open or responded: comment + "Mark as fixed" enabled. Resolved: composer stays (comments allowed), "Mark as fixed" replaced by info `Banner` "Waiting for MondaPac to close this issue." Closed: composer replaced by info `Banner` "This issue is closed." (with close reason when "withdrawn": "MondaPac withdrew this issue.").
- Disabled states: Send disabled while empty or sending; both buttons disabled while a request is in flight.
- Polling update: BFF poll every 15s by default (Market config; BFF rate-limited) while the tab is visible (paused when hidden, resume on focus). New comments append, a `role="status"` line says "New comment from MondaPac"; the scroll position is kept and a "New comments" `FieldAction` jumps down if the user is not at the bottom. A status change updates the badge and shows a toast. Poll failure: after 3 misses a quiet attention `Banner` "Live updates paused. Retrying." with no data loss.
- Conflict (version changed): `SettingsConflictBanner` pattern text "This issue changed. Reload to see the latest." with "Reload"; the typed comment is kept.
- Errors: send failure keeps the text, `FieldStatus` error "Could not send. Try again." Not found / other agent's issue: not-found page. Empty list: `EmptyState` "No issues", body "Nothing needs your attention."
- Responsive: composer sticky at the bottom at 375 (above the keyboard); thread max width 720px at 768/1280.

## 5. Admin: agents list and create (AGT-07)

Routes: `/agents` (list), `/agents/new` (create), `/agents/[id]` (detail). Nav item "Agents" under `agents.read`.
- List: `SearchField` (name, email, referral code), `FilterChip` Status (Active, Invited, Disabled). Columns: Name, Email, Referral code, Rate and basis, Linked shops, Status `Badge` (Active success, Invited attention, Invitation expired critical, Disabled neutral). Primary `Button` "Create agent" (hidden without `agents.manage`; read-only users see the list only).
- Create: `SettingsPage` form: Name, Email, Rate (percent field, converted to basis points; 0 to 100, two decimals), Basis `RadioGroup` (Net sales, Share of commission, Gross sales, each with one-line help), Time zone `Select` (default from Market). Submit "Create agent" opens the step-up `Dialog` (section 7), then shows the **code-once screen**: `Banner` attention "Copy this code now. It is shown only once and cannot be viewed again." Code in a large mono block, "Copy code" button, checkbox `CheckboxRow` "I have given this code to the agent"; "Done" disabled until ticked. An invitation email is sent automatically (stated under the code). Leaving the screen discards the code; the detail page offers "Reissue code" (step-up) which shows a new one the same way.
- Detail: header (name, status, referral code with "Regenerate" action, step-up), `Tabs`: Overview, Shops, Earnings, Issues. Overview actions in `ActionMenu`: Set rate, Reissue invitation, Revoke invitation, Reset second factor, Disable / Enable agent. Disable `Dialog`: "Disable {name}? Their shop links end now and they cannot sign in." Reason field required.
- States: loading `SkeletonRows`; empty list `EmptyState` "No agents yet" with "Create agent"; error `LoadError`; refused `NoAccess`; email already used: `FieldStatus` "An agent with this email already exists." Invitation locked/expired shows on detail as critical `Banner` with "Reissue code".
- Responsive: 375 cards, 768/1280 table; forms single column max 560px.

## 6. Admin: issue thread (AGT-08)

Routes: `/agents/[id]/issues` (list inside the Issues tab) and `/agents/[id]/issues/[issueId]`. "Raise issue" button on a shop row in the Shops tab: `Dialog` with Title, Description (`TextAreaField`), Severity `Select`.
Thread is the same component as section 4 with admin framing: authors "You/{admin}" and "{agent name}". Actions by state:
- open or responded: comment, "Close as withdrawn" (`Dialog`, reason required, copy "Close this issue as withdrawn? The agent will be told it is no longer needed.").
- resolved: "Close issue" (primary) and "Reopen" (secondary; `Dialog` with required reason "Why is it not fixed?").
- closed: read-only info `Banner` with close reason and date: "Closed as fixed on {date}" for `confirmed`, "Withdrawn: {reason}" for `withdrawn`. Reopen is not offered (terminal).
- Same polling, conflict, error and not-found behaviour as section 4. A refused action (agent cannot close, admin cannot mark fixed) never shows as a disabled button; the action is simply absent.
- `agents.read` only: thread visible, composer and actions hidden, `SettingsViewOnlyBanner`.

## 7. Admin additions elsewhere

- **Seller list and seller detail** (`agents.linked-agent.view`): column "Linked agent" (name, or "None" muted); on detail a read-only row with name and linked-since date. Without the permission the column is absent. Admin with `agents.manage` sees "Manage link" opening section 7 link dialog.
- **Unmatched referrals** (`/agents/referrals`, tab "Unmatched referrals" on the agents list): table: Submitted code, Shop, Application date, Status. Row action "Link to agent" (`SearchSelect` agent, reason, step-up) or "Dismiss" (reason). Empty: `EmptyState` "No unmatched referrals". Badge counts in the tab label when above 0.
- **Set rate** (detail, step-up): `Dialog` with Rate and Basis, `Banner` info "Applies to orders placed from now on. Earnings already recorded do not change." and an effective-from timestamp line. Rate history table below (Effective from, rate, basis, set by).
- **Link / unlink / move shop**: `Dialog` with `SearchSelect` shop (link), target agent (move), required `TextAreaField` "Reason" (min 10 characters), summary line "{shop} will move from {A} to {B}". A shop with another agent shows an attention `Banner` "This shop is linked to {A}. Use Move instead." History table (`ActivityTable`): date, action, from, to, reason, admin.
- **Step-up** (all rate, link, regenerate and reissue actions): `Dialog` "Confirm it is you" with `OtpField` "Authenticator code", primary "Confirm". Wrong code: `FieldStatus` error, 5 tries then the dialog closes with a critical toast "Too many tries. Sign in again." Dialog does not close on backdrop click while submitting.
- **Reset agent second factor** (needs `identity.agent-account.reset-second-factor`, item absent otherwise): `Dialog`: "Reset the authenticator for {name}? They must set up a new one at next sign-in. This does not sign them in." Reason required, step-up. Success toast "Authenticator reset".

## 8. Accessibility checklist

Dialogs trap focus and return it to the trigger; the code-once block is `readonly` text with a copy button, not an image; step progress text is not colour-only; tables have captions; the polling status is polite, never steals focus; every icon button has an accessible name; QR has alt "QR code for your authenticator app" plus the text key.

## 9. Section 12 rows for the brief

| Element | Existing component | Change needed | Version impact |
|---|---|---|---|
| App shell, nav, drawer | `AppShell`, `Sidebar`, `Topbar`, `AccountMenu` | none (agent nav items only) | none |
| Set-up wizard | `AuthLayout`, `TextField`, `OtpField`, `ImageSlot`, `Button` | step progress line (new `StepProgress`) | minor |
| Stats, ledger | `StatGrid`, `StatCard`, `DashboardCard`, `LedgerTable`, `LedgerTotals` | none | none |
| Shop list | `DataList`, `Badge`, `Select` | none | none |
| Issue list and thread | `Tabs`, `Badge`, `TextAreaField`, `Dialog`, `Banner`, `EmptyState` | new `IssueThread` (comment list, composer, live-update line) | minor |
| Code-once screen | `Banner`, `CheckboxRow`, `Button` | new `OneTimeCode` (large mono block with copy) | minor |
| Referral code card | `DashboardCard`, `Button`, `Toaster` | new `CopyableCode` (shared with `OneTimeCode`) | minor |
| Step-up dialog | admin's existing step-up flow (`apps/admin/src/step-up`, `useGuardedCall`) | none: reuse | — |
| Admin forms and tables | `SettingsPage`, `SearchField`, `FilterChip`, `ActionMenu`, `SearchSelect`, `ActivityTable` | none | none |
| Agent status badges | `Badge` | none (existing tones) | none |

New components to back-port to Figma: `StepProgress`, `IssueThread` (with comment item and composer), `OneTimeCode`/`CopyableCode`, plus the agent set-up and code-once screen templates.

> Checked 2026-11-06 (after drafting): `Badge` tones are neutral, info, attention, critical, success; `Banner` tones are info, success, critical, attention (no neutral). The admin app already has a step-up flow (`apps/admin/src/step-up`), reused above.
