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
  value with `after` and refuses with `changed-since` when they differ. A later request for the same
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

| Area | Default | Review key |
|---|---|---|
| people | on, high | `system-requests.people.review` |
| money | on, high | `system-requests.money.review` |
| delivery | on, medium | `system-requests.delivery.review` |
| catalogue | on, medium | `system-requests.catalogue.review` |
| certification | on, medium | `system-requests.certification.review` |
| marketplace | off, low | `system-requests.marketplace.review` |
| content | off, low | `system-requests.content.review` |

The queue needs `system-requests.request.view`; the policy page needs `policy.view` and
`policy.manage`. All keys are protected.

## For a module that adds a reviewed area

1. Export a `SystemChangeReverter` for each subject kind (`<module>.<subject>`), and add
   `registerSystemChangeReverter('<module>', '<module>.<subject>', TOKEN)` to the module's
   providers. Registration is sealed once the application has started.
2. In the use case that saves the change: write it, then call `openReview` in the same unit with
   the values before and after (plain JSON, depth 3, about 12 KB at most, never a secret). An
   `err` answer is the use case's own refusal.
3. The page asks for a note only when `areaPolicy(context, area).enabled`.

## API (admin)

`GET system-requests/admin/requests` is a super list: views (`needs-my-review`, `all-open`,
`mine`, `approved`, `reverted`, `overdue`, `all`) with a count each, search (`SR-12` or text),
filters, sort, page numbers with a total (10,000 rows at most) or a cursor, and each row's actions.
Other routes: `requests-count` (menu badge), `requests/:id`, comments, approve, bulk-approve,
reject, withdraw, `review-policy`, and the two policy writes.

## Not in this package

- Saved filters, column picker and CSV/XLSX export come with the shared super-list kit (phase 0,
  handoffs in `super-list/`).
- The area hooks in the owning modules (settings, roles, payouts, ...) are follow-ups, one per
  module; until then only the review policy itself opens requests.
- Notifications and reminders for overdue requests, and an impact count per request.
- The admin panel pages (frontend package).
