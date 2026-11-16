# system-requests: implementation notes (backend, package 1)

Admin Inbox › System requests. Owner decisions of 15 Nov 2026 (design artifact
"System requests", copy in the project files at `design/system-requests/`). Built under speed
mode from the design; no separate brief.

## What it does

- A change an admin makes in a reviewed area **goes live at once**. The owning module writes it
  and, in the same unit, calls `SystemRequestRecorder.openReview` (contracts/recorder.ts). That
  opens a request (SR-n, numbered per Market) that keeps the values before and after, the admin's
  note (1 to 500 characters), the risk and the review date.
- **Maker-checker**: another admin who holds the area's review key approves (the change stays) or
  rejects with a reason (the value before is restored). The author can never approve or reject
  their own request; they may withdraw it, which also restores the value before. A database CHECK
  enforces this too.
- **Revert only if unchanged**: the owning module's `SystemChangeReverter` compares the current
  value with `after` and refuses with `changed-since` when they differ. It may also answer
  `not-permitted` (403 `system-requests.revert-not-permitted`) when the decider may not make the
  change the revert would make; the request then stays open. A later request for the same
  subject supersedes the earlier ones, which can then only be approved.
- **High risk** decisions and every review-policy change spend a fresh admin step-up proof
  (`system-requests.request.decide-high`, `system-requests.policy.change`).
- **Bulk approve** takes low-risk requests only (at most 100, each in its own unit).
- **No expiry**: an open request past its review date (default 7 days, 1 to 90 per Market) is
  overdue.
- The review policy (areas on/off, default risk, review period) is itself always reviewed, at
  high risk, by the people reviewers.
- Every write is audited and refused in an acting-as session.

## Areas and keys

| Area          | Default    | Review key                             |
| ------------- | ---------- | -------------------------------------- |
| people        | on, high   | `system-requests.people.review`        |
| money         | on, high   | `system-requests.money.review`         |
| delivery      | on, medium | `system-requests.delivery.review`      |
| catalogue     | on, medium | `system-requests.catalogue.review`     |
| certification | on, medium | `system-requests.certification.review` |
| marketplace   | off, low   | `system-requests.marketplace.review`   |
| content       | off, low   | `system-requests.content.review`       |

The queue needs `system-requests.request.view`; the policy page needs `policy.view` and
`policy.manage`. All keys are protected.

## For a module that adds a reviewed area

1. Export a `SystemChangeReverter` for each subject kind (`<module>.<subject>`), optionally with
   `describe` (the queue's subject label, see "Labels for the panel"), and add
   `registerSystemChangeReverter('<module>', '<module>.<subject>', '<area>', TOKEN)` to the
   module's providers. A kind is reviewed in that one area: `openReview` throws for a change of
   the kind filed under another area. Registration is sealed once the application has started;
   other modules can register but never look a reverter up.
2. In the use case that saves the change: lock and write the subject, then call `openReview` in
   the same unit with the values before and after (plain JSON, depth 3, 10 KB at most, no control
   characters, never a secret). An `err` answer is the use case's own refusal.
3. The page asks for a note only when `areaPolicy(context, area).enabled`.

## Hooked areas

- **settings** (area marketplace, kind `settings.market-setting`, subject = the setting code):
  every change of a Market setting (List paging, Cart mode, the AI description writer) passes the
  page's `note` and answers the request it opened (`request: {id, number}` or null); each setting
  view carries `review: {reviewed, risk}` so the page knows to ask for a note. The reverter writes
  the value before as a new version with its history and audit row.
- **commission-payouts** (area money): kind `commission-payouts.commission-rate` (subject = seller
  id, values `{rateBps}`, null = the Market rate) and `commission-payouts.payout-terms` (subject =
  seller id, values `{terms}`, the override's fields or null). The set and remove routes take
  `note` (in the body, or the `note` query on DELETE) and answer `request`. A revert restores the
  rate or the override (as a new version, audited with reason `correction`, the seller's schedule
  worked out again); terms the Market's bounds no longer allow are `gone`.
- **wallet** (area money): kind `wallet.market-status` (subject `wallet-settings`, values
  `{status, reason}`). The switch takes `note` and answers `request`. A revert is audited as
  `wallet.market-status.reverted` (with the request id, no step-up of its own); going back to `off`
  once the Market has journals is `changed-since`. A switch to `paused` or `frozen` is a stop and
  opens no request; a revert never lifts a stop (restoring `active` over `paused` or `frozen` is
  `not-permitted`, and the request stays open).
- Every money opening passes risk `high`, whatever the area's policy says, so the reviewer's
  step-up is spent before a revert writes.

### Known limits (follow-ups)

- A request that turned the AI description writer off cannot be withdrawn into a revert that turns
  it back on: the reverter answers `not-permitted`, because a permission check cannot run inside
  the decision unit. The author changes the setting again instead.
- A rate set for a seller with no rate row yet can race with a second first-time set (no row to
  lock); this predates the review hook.
- Withdraw checks that the caller is the author, not that the author still holds the edit
  permission of the subject.
- On DELETE routes the note travels in the `note` query, so it reaches access logs that keep the
  query string; the API's own logs drop it. A body on DELETE comes with the panel package.

## Supersession and locks

A new request on a subject supersedes the subject's open-ended earlier requests: they can be
approved but not reverted (the value they would restore is gone). When the newer request is
rejected or withdrawn, the subject holds the earlier value again, so the requests it superseded
become the latest again (the database allows clearing a supersession only for a reverted newer
request). The values before and after are shown only to the author and the area's reviewers.

Lock order: opening locks the subject (the owning module), then the Market's counter row, then
the earlier requests; a decision locks the request, then the subject (the reverter). An opening
and a revert of one subject at the same time can therefore deadlock; the unit of work retries
40P01, so nobody sees an error.

## API (admin)

`GET system-requests/admin/requests` is a super list: views (`needs-my-review`, `all-open`,
`mine`, `approved`, `reverted`, `overdue`, `all`) with a count each, search (`SR-12` or text),
filters, sort, page numbers with a total (10,000 rows at most) or a cursor, and each row's actions.
Other routes: `requests-count` (menu badge), `requests/:id`, comments, approve, bulk-approve,
bulk-approve-matching, reject, withdraw, `review-policy`, and the two policy writes.

### Labels for the panel (panel API package)

- Rows and the detail carry `requestedByName`, `decidedByName` and each `activity[].actorName`:
  admin display names read through identity's public facade (`changeActors`), one batched read per
  page (100 ids a call), after the read unit, never a join. Null when the name cannot be read (a
  refusal or a failure shows ids only; it never fails the page or a committed decision).
- `subjectLabel`: the owning module's label of the subject, from the optional
  `SystemChangeReverter.describe(context, subjectRefs)` (one call per kind per page, at most 100
  refs, outside any unit). Null when the module gives none, it throws, or the label is empty,
  over 200 characters or holds any `\p{C}` character (controls, bidi overrides and isolates,
  zero-width characters) or U+2028/U+2029. Implemented by: settings (the setting's name
  from its definition, e.g. "List paging"), commission-payouts (both kinds: the seller's public
  store name through sellers' facade), wallet ("Wallet status"), and the review policy itself
  ("Money review" for an area, "Review period" for the due days). Every queue viewer sees the label,
  so it names the subject only, never a value of the change.
- `supersededByNumber`: the SR number of `supersededBy` (kept), read in the same unit.
- The review policy page: each area and the review period carry `updatedByName` beside
  `updatedBy` (the same names port, one read per page; null when unknown or unreadable), on the
  view and on both policy writes' answers.

### Select all matching (rule 14)

`POST requests/bulk-approve-matching` takes the list's filter as a closed JSON body of strings,
parsed exactly as the list query: `view`, `q`, `area`, `risk`, `status` (comma lists),
`requestedBy`, `decidedBy`, `appliedFrom`, `appliedTo`, `overdue`, `subjectKind`, `subjectRef`. No
page, cursor, page size or sort (400 `unknown-field`). It approves only what bulk approve may:
open, low risk, an area whose review key the caller holds, not the caller's own; at most 100 per
call, oldest SR number first, each in its own unit with the same checks and audit row as
bulk-approve. Answer: `{approved: [{id, number, displayNumber}], failed: [{id, code}], remaining}`,
where `remaining` counts the approvable requests that still match (10,000 at most). The panel
repeats while `remaining > 0` and stops when `approved` is empty. `remaining` is `null` when the
count failed after the approvals had committed (the route never fails after a commit): the panel
treats null as "stop" and reloads the list. Refused in an acting-as session;
needs `system-requests.request.view`.

### Confirmed behaviour

- **Approve works on a gone subject.** Approving keeps the change and asks no reverter, so it
  never answers `subject-gone` (only reject and withdraw can). A unit test covers it.
- **Review-policy kinds** (written by the policy writes, area `review-policy`):
  - area policy: subjectKind `system-requests.policy-area`, subjectRef = the area
    (`people`, `money`, `delivery`, `catalogue`, `certification`, `marketplace`, `content`);
  - review period: subjectKind `system-requests.review-due-days`, subjectRef `market`.

## Not in this package

- Saved filters, column picker and CSV/XLSX export come with the shared super-list kit (phase 0,
  handoffs in `super-list/`).
- The area hooks in the other owning modules (roles, payouts, delivery, catalogue, ...) are
  follow-ups, one per module, for changes that can be reverted only (owner decision of 15 Nov
  2026: creating, deleting, merging, moving and importing get their own design later).
- Notifications and reminders for overdue requests, and an impact count per request.
- The admin panel pages (frontend package).
