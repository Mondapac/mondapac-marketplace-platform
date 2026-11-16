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
- **Separation of duties**: a reviewer never decides a change about themselves either. A reverter
  may declare `isInterested(context, request)` on the port (platform/change-review); System
  requests asks it inside the decision's unit and refuses approve, bulk approve and reject with
  403 `system-requests.own-subject`. identity declares it: an admin's own role change or enabling,
  or an edit of the role the admin holds now. Withdraw is not affected, and a module without the
  check decides as before.
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

The recorder and the reverter port live in `platform/change-review/change-review.ts` (so identity,
which imports no module, can use them); system-requests implements them and re-exports them from
its contracts, which other modules keep importing. A reject or withdraw runs in a serializable
unit, so a reverter can keep a counted guard (identity's last Platform Administrator).

1. Export a `SystemChangeReverter` for each subject kind (`<module>.<subject>`), and add
   `registerSystemChangeReverter('<module>', '<module>.<subject>', '<area>', TOKEN)` to the
   module's providers. A kind is reviewed in that one area: `openReview` throws for a change of
   the kind filed under another area. Registration is sealed once the application has started;
   other modules can register but never look a reverter up.
2. In the use case that saves the change: lock and write the subject, then call `openReview` in
   the same unit with the values before and after (plain JSON, depth 3, 10 KB at most, no control
   characters, never a secret). An `err` answer is the use case's own refusal.
3. The page asks for a note only when `areaPolicy(context, area).enabled`.
4. Every check the module's own edit runs must hold for the restored value too, failing closed.
   A check that opens a unit of its own (the decider holding the subject's edit key, a reference
   to another module, Market data that changes over time) goes in the reverter's optional
   `check(context, request): Promise<'ok' | 'not-permitted'>`: `revertRequest` calls it after
   `prepareDecision` and before the decision unit opens (reject and withdraw); `not-permitted`
   writes nothing and leaves the request open (403 `system-requests.revert-not-permitted`).

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
- **catalog** (area `catalogue`, on by default, risk medium): field edits of existing PLATFORM
  catalogue structure. Three kinds, each with the id of the record as subject:
  `catalog.category-details` (names, short descriptions, keywords per locale, SEO, show in menu),
  `catalog.attribute-definition` (a summary of the definition with `revisionNo` and `version`; the
  full content is read back from the revision history) and `catalog.category-attribute-links`
  (`{featureSetId, filters}`). The edit routes take `note` and answer `request`; the three admin
  read views carry `review`. A revert writes the before fields as a new revision through the same
  domain path and audits `catalog.platform-category.details-reverted`,
  `catalog.attribute-definition.reverted` or `catalog.category-attributes.reverted` with the
  request id. It answers `changed-since` when the record no longer matches the `after` values, is
  no longer active, or the domain refuses the write, and `gone` only when the record is not found
  (including a record of another Market) or the request values are not ours. Before the unit
  opens, an optional `check` on the reverter (item 4 of "For a module that adds a reviewed area") runs the claim-text
  check on the text a revert would write back, the content filter and locale checks, the units
  and publish rules of an active attribute, and that the decider holds the subject's edit key
  (`catalog.category-tree.edit` or `catalog.attribute.edit`); any refusal, or a check that cannot
  be answered, is `not-permitted` with nothing written and the request left open.
  Left out (owner decision): create, delete, merge, move, import, seller-scoped content and
  ClaimBasisPolicy. Slug change, image set or remove, and feature-set edits are not hooked either:
  a slug change and an image carry redirect and storage effects a revert cannot undo cleanly.
  Imports run unreviewed.

- **shipping** (area delivery, medium risk by default, on by default): only changes that can be
  put back are reviewed; creating, deleting, merging, moving and importing are not.
  - `shipping.delivery-settings` (subject `delivery-settings`): the save of the Market's delivery
    settings (`PUT /shipping/admin/delivery-settings`). Values: the saved set without its version
    (`enabled` per method, `sameDayCutoffMinutes`, `scheduledDaysAhead`, `scheduledWindowMinutes`,
    `readyPrepMinutes`, `margin`, `roundingStepMinor`). A revert saves the values before as a new
    version, audited as `shipping.delivery-settings.reverted`; `changed-since` when the settings
    differ from the values after.
  - `shipping.seller-delivery-methods` (subject = seller id, values `{unsupported: [...]}`):
    `PUT /shipping/admin/sellers/:sellerId/delivery-methods`. Audited as
    `shipping.seller-delivery-methods.reverted`; `gone` when the seller no longer exists.
  - `shipping.fleet-selection` (subject `fleet-selection`): the page save
    (`PUT /shipping/admin/fleet-selection`). Values `{active: {method: modelId|null},
    reliability: {fleet: score|null}}`, only the items that changed (nothing changed opens
    nothing). A revert compares and raises the page version like an admin's save, restores each
    item still holding its value after, and audits `shipping.fleet-model.activation-reverted` and
    `shipping.fleet-reliability.reverted`; a model that no longer exists is `gone`. A fleet that
    had no score ends with reliability 50, not null, after the revert (the table has no delete; routing is the same).
  - `shipping.fleet-selection-model` (subject = model id, values `{name, rule}`): the edit of a
    model (`PUT /shipping/admin/fleet-selection/models/:modelId`); a revert writes a new version,
    audited as `shipping.fleet-model.reverted`; a name another model took since is
    `changed-since`.
  - Every write takes `note` in the body (closed key list) and answers `request: {id, number} |
    null`; the page reads carry `review: {reviewed, risk}` so the panel asks for a note.
- Every money opening passes risk `high`, whatever the area's policy says, so the reviewer's
  step-up is spent before a revert writes.
- **certification** (area certification, the area's risk): kind `certification.type-revision`
  (subject = type id) and `certification.claim-policy` (subject = type id; a type has one policy),
  values `{revisionId, revisionNo}` (both null before a type's first policy revision; the values
  after also list the changed diff paths, at most 100, and their count). Only a save **published**
  at once opens a request; a relaxing save waits for a second admin (H1) and opens none, nor does
  its approval. The save routes take `note` and answer `request`; the type and claim-policy views
  carry `review: {reviewed, risk}`. A revert writes the content before as a new published revision
  (audited `certification.type.reverted` / `certification.claim-policy.reverted` with the request
  id, and the save's own event, so catalog re-checks tags after a policy change). **A revert never
  loosens enforcement** (CERT-21, ADR-0012): it is classified by the save's own rule, and one that
  relaxes (a setting, a removed claim term or locale, a less strict basis, a removed non-manufacturer
  row) is `not-permitted`, as is any revert while a relaxation of the subject waits for a second
  admin. Content the Market's locales no longer allow is `gone`. The pre-unit `check` asks that
  the decider holds `certification.type.edit` / `certification.claim-policy.edit` and that every
  platform category a restored policy row adds or changes is still active; any error is
  `not-permitted`.
- **identity** (area people): kind `identity.platform-role` (subject = role id, values
  `{name, permissionKeys}`), `identity.admin-roles` (subject = admin account id, values
  `{roleIds}`) and `identity.admin-status` (subject = admin account id, values `{status}`). The
  routes `PUT identity/admin/roles/:roleId`, `POST identity/admin/accounts/:accountId/role` and
  `POST identity/admin/accounts/:accountId/enable` take `note` and answer `request`;
  `.../disable` takes `note` but is a stop and opens no request. `GET identity/admin/team` and
  `GET identity/admin/roles` carry `review`. Every opening is high risk. A revert never widens
  access: one that would add a key to a role, give an admin a role with a key the current one
  lacks (or the Platform Administrator role) or enable an admin is `not-permitted`; a narrowing
  revert keeps the last Platform Administrator (else `not-permitted`). Audited as
  `identity.role.reverted`, `identity.account-role.reverted`, `identity.account-status.reverted`.

### Known limits (follow-ups)

- A people revert that would widen access (a role edit that removed keys, a demotion, a disable)
  can only be approved: the author makes the change again instead. Only narrowing reverts run.
- Role names are free text (identity R5) and travel in the request's values for a rename's revert;
  they are shown only to the author and the people reviewers, never in an audit row or a log.

- A request that turned the AI description writer off cannot be withdrawn into a revert that turns
  it back on: the reverter answers `not-permitted`, because a permission check cannot run inside
  the decision unit. The author changes the setting again instead.
- Catalogue: a revert of an attribute edit keeps the options the edit added (revisions never
  remove an option) and switches them off; cancelling an open relaxation request that the edit
  triggered is not undone; a revert that would clear `material` on a published attribute is
  refused by the domain (`changed-since`: that needs the two-person request); a revert reads at
  most the newest 200 revisions of an attribute, an older one is `changed-since`; category values too
  large for a request (over 10 KB) are refused with `too-large-for-review` where the area is
  reviewed; a category revert restores details only, never image, slug, position or status.
- A rate set for a seller with no rate row yet can race with a second first-time set (no row to
  lock); this predates the review hook.
- Withdraw checks that the caller is the author, not that the author still holds the edit
  permission of the subject, unless the owning reverter's pre-unit `check` asks it
  (certification does).
- On DELETE routes the note travels in the `note` query, so it reaches access logs that keep the
  query string; the API's own logs drop it. A body on DELETE comes with the panel package.
- A published claim-policy save only tightens, so restoring the rows before always loosens: its
  request can be approved but never rejected or withdrawn (`not-permitted`, it stays open). Undoing
  a tightening is a relaxation for a second admin on the claim-policy page; the request then
  answers `changed-since` and can only be approved. The same holds for a type save that tightened
  a setting or added a claim term or a locale; text-only type edits (names, descriptions, icon)
  revert.
- Issuer changes, type deactivation and reactivation are state changes, not field edits, and are
  not reviewed; issuers have no field edit to review yet.
- The admin panel has no type or claim-policy edit page yet, so no panel asks for the note; the
  page that adds one shows the note field from the view's `review`.
- A revert of an admin's enabling (a disable) can deadlock with an enable of the same account: each
  takes the account's credential lock and the request's row in the opposite order. Postgres
  breaks it (40P01) and the unit of work's bounded retry runs the loser again, so nobody sees an
  error; under sustained contention the retries can run out and the call fails (to be repeated).
- Inviting or creating an admin, and creating a platform role, are not reviewed (owner decision):
  they are the cheapest way around the people review (create a wide role and invite into it
  instead of widening an existing one). A follow-up to review them, or to require an approved
  request before the new admin's first sign-in, is tracked.

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
reject, withdraw, `review-policy`, and the two policy writes.

## Not in this package

- Saved filters, column picker and CSV/XLSX export come with the shared super-list kit (phase 0,
  handoffs in `super-list/`).
- The area hooks in the other owning modules (roles, payouts, delivery, catalogue, ...) are
  follow-ups, one per module, for changes that can be reverted only (owner decision of 15 Nov
  2026: creating, deleting, merging, moving and importing get their own design later).
- Notifications and reminders for overdue requests, and an impact count per request.
- The admin panel pages (frontend package).
