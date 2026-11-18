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

1. Export a `SystemChangeReverter` for each subject kind (`<module>.<subject>`), optionally with
   `describe` (the queue's subject label, see "Labels for the panel") and `isInterested` (the
   separation-of-duties check), and add
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
  Structure changes (owner decision of 18 Nov 2026, "mixed"), with the subject's id as subject:
  - Reviewed after (reverter): `catalog.category-create` (values `{exists, slug, parentId}`; a
    reject discards the category when it never went live, else hides it, and a category hidden
    since is left as it is), `catalog.category-move` (`{parentId}` before and after; a reject moves
    it back, last among its old siblings, when it is still under the new parent; certification's
    retirement check runs in `check`), `catalog.category-reorder` (`{position, neighbourId,
    neighbourPosition}`; a reject swaps the two back when both still hold their places) and
    `catalog.attribute-create` (`{exists, code, status}`; a reject discards a draft, and a
    published attribute is `not-permitted`: it can only be approved). The create, move and reorder
    routes take `note` (a move uses its reason when no note is given).
  - Wait for approval (applier, HTTP 202 `{request}`, nothing written in catalog): kinds
    `catalog.category-discard` (key `catalog.category-tree.edit`),
    `catalog.category-restructure` (merge and archive, `catalog.category-tree.restructure`),
    `catalog.category-products-move` (`catalog.category-tree.restructure`),
    `catalog.attribute-discard` (`catalog.attribute.edit`), `catalog.attribute-restructure`
    (archive, merge and merge of values, `catalog.attribute.restructure`) and
    `catalog.feature-set-create` (`catalog.attribute.edit`; a feature set has no delete, so its
    create waits for approval; subject = the code asked for or made from the name). `before` is the
    subject's state (`{status, version, parentId}` for a category, `{code, status, version,
    material}` for an attribute); `after` is the action (`{action: 'merge', targetId, reason}`,
    ...). A restructure uses its reason as the note when no note is given. The archive of a
    `material` attribute keeps its own two-person request and files no proposal. The applier's
    `check` also checks the decider's key through the authorisation port, and runs certification's
    retirement check (merge, archive) or the claim-text check (feature set) before the unit; its
    `apply` writes through the same in-unit function as the route, naming the request in the audit
    row (`requestId`). The tree and attribute admin reads carry `review`.
  - Left out: the category-tree import and the attribute file import (a file does not fit a
    request's values, at most 10 KB and three levels; keeping it needs a staged-import store, a
    schema change; the attribute import also runs row by row in units of its own and cannot run in
    one decision unit); seller-scoped content, ClaimBasisPolicy, slug change, image set or remove,
    and feature-set edits (a slug change and an image carry redirect and storage effects a revert
    cannot undo cleanly). Imports run unreviewed.

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
  id, and the save's own event; only `claim-policy-changed.v1` makes catalog re-check tags, nothing
  consumes `certification-type-revised.v1` yet). **A revert never
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
  Since 18 Nov ("mixed"): `POST identity/admin/roles` (kind `identity.platform-role-creation`,
  values `{exists: false}` / `{exists: true, name, permissionKeys}`; a reject deletes the role only
  while nobody holds it and its keys are unchanged) and `POST identity/admin/invitations` (kind
  `identity.admin-invitation`, subject = invitation id, values `{exists: false}` /
  `{exists: true, roleId}`, never the address; a reject revokes it while pending, or disables the
  admin who accepted it and ends their sessions) take `note`, are reviewed after and answer
  `request`. `DELETE identity/admin/roles/:roleId` waits for approval (kind
  `identity.platform-role-deletion`, applier key `identity.platform-role.delete`): `note` in the
  body, 202 `{code: 'role.delete-requested', roleId, request}`, 409
  `system-requests.already-pending`; the approval deletes the role only while unchanged (name,
  keys, version) and unheld. Revoking an invitation is not reviewed. Details: identity notes,
  "Creations and the role delete in System requests".

### Known limits (follow-ups)

- A people revert that would widen access (a role edit that removed keys, a demotion, a disable)
  can only be approved: the author makes the change again instead. Only narrowing reverts run.
- Role names are free text (identity R5) and travel in the request's values for a rename's revert;
  they are shown only to the author and the people reviewers, never in an audit row or a log.

- A request that turned the AI description writer off cannot be withdrawn into a revert that turns
  it back on: the reverter answers `not-permitted`, because a permission check cannot run inside
  the decision unit. The author changes the setting again instead.
- Catalogue approvals run in the decision's unit with its default timeout, shorter than the 30 s a
  route's restructure may take: the approval of a merge or archive that marks very many products
  can time out and is then not applied (the request stays open). The check of a merge or archive
  hands the categories it cleared to the apply in memory, on the same instance; a missing hand-over
  is `not-permitted` (fail closed). The approval of a products move compares only the source
  category's status; the job reads the products again when it runs. A feature set proposed with no
  code gets a free code at approval (as the route does); one with a code taken since is
  `changed-since`. A merge proposal keeps at most 100 value pairs (`too-large-for-review` above).
- Catalogue: a restructure appends `platform-category-changed` and the action's own event
  (`moved`, `merged`, `archived`) for the same category version, which the catalog outbox's
  unique (market, aggregate id, version) index refuses on PostgreSQL; the route has the same
  problem and the DB specs keep a recording outbox for it. Reported as a follow-up.
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
- Creating a platform role and inviting an admin are reviewed after since 18 Nov, so they go
  live at once: an invitee can accept and sign in before the review, and a reject then disables
  the account. Holding the first sign-in until the invitation's request is approved is a
  follow-up. A created role that someone was given meanwhile cannot be deleted by a reject
  (`not-permitted`): reject the role assignment first. The hourly purge never deletes an accepted
  admin invitation (Hassan M1 on PR #1058), so a reject still reaches the admin it created however
  late it comes; an invitation that is `gone` is one that was never accepted and has expired.

## Actions that wait for approval (approval mode)

Owner decision of 18 Nov 2026 ("mixed"): a create or a move goes live at once and is reviewed
after, as every change so far (a reject undoes it: discard, hide, revoke or move back). A delete,
a merge or an import cannot be undone cleanly, so it waits for another admin's approval instead.

- Port: `SYSTEM_ACTION_PROPOSER` (`SystemActionProposer.proposeChange`, same implementation as the
  recorder). The owning module checks the admin's permission and validates the action as it would
  before applying it, then calls `proposeChange` in its open unit with `before` (what the subject
  holds now) and `after` (the action, e.g. `{action: 'delete'}`). It writes nothing else. The
  answer is `null` when the area is not reviewed in the Market (the module applies the action at
  once, in the same unit, as before), the new request, or `system-requests.already-pending`
  (`pendingNumber`): one open proposal per subject (also a partial unique index).
- The kind registers an applier (`registerSystemChangeApplier(module, kind, area, permission,
  token)`): the permission key the action needs (an array when its use case declares several; all
  are required), which system-requests checks itself (Hassan M1:
  a module `check` that answers `ok` for anyone cannot let a reviewer run an action they may not
  run); `apply` (in the approval's serializable unit: compares the subject with `before`, runs the
  module's own checks, writes the action as the approving admin naming the request; answers
  `applied`, `changed-since`, `gone` or `not-permitted`) and `check` (before the unit, fail closed:
  the module's further rules and the checks that open a unit of their own). `isInterested` and
  `describe` work as for a reverter. A kind is either reviewed after (reverter) or approved first
  (applier), never both. Every module that registers an applier gets its own security review.
- The request: `mode: 'approval'`, first activity `proposed`. Approve checks the registered key,
  runs `check`, then checks the area's review key and the action's key once more as the last step
  before the unit (Hassan L2; the authorisation check never runs inside the caller's unit), then
  `apply` with the decision; anything but `applied` leaves it open and writes nothing. Reject and
  withdraw change nothing and ask the module nothing (status `reverted`, decision `rejected` or
  `withdrawn`); they need no registered kind, so a retired kind never leaves a proposal stuck
  (Hassan L3). Two concurrent proposals of one subject: `findPendingProposal` takes the Market's
  counter lock first, so the second sees the first and answers `already-pending` (Mojtaba). A proposal is never superseded and supersedes nothing (CHECK), so reject and
  withdraw never need it to be the subject's latest. High risk spends the step-up proof as usual.
- Bulk approve and "select all matching" never take a proposal (`system-requests.one-by-one`; the
  matching filter leaves proposals out): each is applied on its own approval.
- Migration `20261118100000_system_requests_approval_mode`: `requests.mode` (no update grant), the
  CHECK and partial unique index above, activity kind `proposed`. Its `down.sql` refuses to run
  while any proposal exists.
- Which actions use it, per module, and their panel pages: catalog (see "Hooked areas"); the
  other modules are follow-up PRs (plan in the project files,
  `handoffs/system-requests/deferred-hooks-plan.md`).

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
  store name through sellers' facade), wallet ("Wallet status"), identity (`identity.admin-roles`
  and `identity.admin-status`: the admin's display name through identity's own
  `ChangeActorLabels`, this Market's admins only; `identity.platform-role`: a custom role's name
  through `ListPlatformRoles`, so only for a viewer holding `identity.platform-role.view`, who sees
  it on the roles page anyway), and the review policy itself
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

## Overdue reminders (package 2)

A worker job, `system-requests.remind-overdue-requests` (hourly, per hosted Market), runs the
system-rule use case `RemindOverdueSystemRequests`. For each open request past its stored review
date (`review_due_at`, set when it opened from the Market's review period) whose area is still
reviewed, it writes one `system-requests.request-overdue.v1` event to this module's outbox
(ADR-0006). The request id, SR number, area and age in days are the whole payload: never the note
or the values.

- **At most one per Market day**: `requests.last_reminded_at` is set by a conditional update in the
  same unit as the outbox write; "day" starts at midnight in the Market's zone (ADR-0005, the
  injected Clock), not after 24 hours. A restart or two overlapping runs never send twice.
- **Stops** when the request is decided or withdrawn (status no longer open), or when its area is
  turned off (`policy_areas.enabled`; the review-policy area is always on); it resumes if the area
  is turned on again while the request is still open. Changing the review period moves only
  requests opened afterwards (the date is a snapshot on the request).
- **Recipients and channel**: notifications subscribes to the event and writes one in-app admin
  notice, kind `admin.system-request-overdue-<area>` (params: `requestId`, `number`, `ageDays`).
  There is one kind per area so each is shown only to admins who hold that area's review key
  (review-policy requests: the people reviewers); the link path for the panel is
  `/system-requests/<requestId>`. The existing admin notice channel has no email.
- Migration `20261116100000_system_requests_overdue_reminders`: `requests.last_reminded_at` (with
  its column grant) and this module's `outbox` table. Reversible (`down.sql`).

## Not in this package

- Saved filters, column picker and CSV/XLSX export come with the shared super-list kit (phase 0,
  handoffs in `super-list/`).
- The area hooks in the other owning modules (roles, payouts, delivery, catalogue, ...) are
  follow-ups, one per module. Creating and moving are reviewed after; deleting, merging and
  importing wait for approval (owner decision of 18 Nov 2026, "Actions that wait for approval").
- An impact count per request, and email reminders (the reminder is an in-app admin notice).
- Excluding the author from their own request's reminder: notices are Market-wide and shown by
  permission (below), so an author who also holds the area's review key sees it too.
- The admin panel pages (frontend package).

## Panel: not yet

The admin panel pages (queue, detail, review policy, menu badge) are built. Left out for now:

- Saved filters and CSV/XLSX export: the queue shows Export disabled with the hint "Export comes
  with saved filters" until the shared kit has System requests routes for them.
- Requested by and Decided by pickers: the team list is not relayed to the browser and needs a
  different permission, so those two filters work from ids in the address only.
- Phone layout: checked on a 390x844 phone emulation, at 768 and 1280, in light and dark (queue,
  detail, review policy, menu badge in the drawer; loaded, empty and error states). Fixed: the
  detail facts overflowed on an unbroken name or reason, the status badges sat under the row menu,
  the reject sheet cut its title, the card note was squeezed beside the badges and cut, the
  outcome line repeated the facts, and the card number link, the unchanged-fields button and the view
  tabs were under 44 px. Remaining: the row checkbox hit area is 40 px (shared `SelectBox`), and the
  policy page Switch and "Awaiting review" link are 24 px tall (shared `Switch`).
