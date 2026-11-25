# catalog: implementation notes

## Review of catalogue structure edits (Admin Inbox > System requests)

Field edits of existing PLATFORM catalogue structure are reviewed in area `catalogue` (on by
default, risk medium; a Market can switch it off). The edits are category details
(`PATCH catalog/admin/categories/:id`), attribute definitions (`PUT catalog/admin/attributes/:id`)
and the attribute links of a category (`PUT catalog/admin/categories/:id/attribute-links`).

- Each takes an optional `note` (1 to 500 characters, required when the area is reviewed, so a
  save without one is a `validation.failed` on `note` and nothing is kept). Each answers
  `request: {id, number}`, or null when no request was opened (area off, or the edit changed
  nothing). The links route returns it at the top level next to `links`.
- Each admin read (category, attribute, attribute links) carries `review: {reviewed, risk}`, so the
  panel asks for a note only when it is needed.
- The request holds small plain values (see `application/catalogue-review.ts`). Category details
  are flattened per locale; an edit whose values exceed the request limits is refused with
  `too-large-for-review` where the area is reviewed.
- Reverters (`application/catalogue-reverters.ts`) are registered with system-requests and write
  through the same domain path as the edit. See `docs/modules/system-requests/notes.md` for the
  outcomes and the known limits.
- A revert runs the checks an edit has, because the rules change over time. The reverters have a
  `check` that System requests calls before the unit opens: the decider holds the edit key, the
  claim-text check passes on every text the revert would write (for an attribute that includes the
  switched-off values it keeps), the content filter and locale rules hold for a category, and the
  units and publish rules hold for an active attribute. A failure, or a check that cannot answer,
  is `not-permitted` and nothing is written. A revert that would clear `material` on a published
  attribute is refused by the domain (`changed-since`), and a revert reads at most the newest 200
  revisions of an attribute.
- Imports (the attribute file import) run through a variant of the edit use case with a recorder
  that never reviews, so a file import never needs a note.

## Structure changes in Admin Inbox > System requests (owner decision of 18 Nov 2026)

- Applied now and reviewed after: category create, move and reorder, and attribute create. The
  routes take `note` (a move falls back to its reason) and answer `request`. The reverters are in
  `application/catalogue-structure-reverters.ts` and write through the in-unit functions of
  `categories/category-write-core.ts` (`discardInUnit`, `hideInUnit`, `reorderInUnit`) and the
  restructure (`restructureInUnit`).
- Wait for another admin's approval: category discard, merge, archive and products move;
  attribute discard, merge, merge of values and archive (not of a `material` attribute, which has
  its own two-person request); feature-set create. Where the area is reviewed the route checks
  the action as it would before applying it, files the proposal in the same unit and answers
  HTTP 202 with only `{request}`; nothing changes. A second proposal of the same subject is 409
  `system-requests.already-pending` with `pendingNumber`. The appliers
  (`application/catalogue-appliers.ts`) compare the subject with `before`, then run the same
  in-unit function as the route (`discardInUnit`, `restructureInUnit`, `discardAttributeInUnit`,
  `writeArchive`, `writeMerge`, `mergeValuesInUnit`, `startProductsMoveInUnit`,
  `createFeatureSetInUnit`) as the approving admin, naming the request in the audit row.
- Each approval kind is registered with every key its route's use case declares (`routeKeys`
  in `catalog.module.ts`): a products move needs `catalog.category-tree.restructure` and
  `catalog.product.approve`. What a pre-unit `check` cleared (`ClearedByRequest`) is dropped by the
  next check of the request and is handed only to the same admin in the same Market, so a
  decision that failed never reuses an earlier check.
- The tree read, the attribute list and the feature-set list carry `review`, so the panel asks for
  the note: the create, reorder and discard dialogs of a category, the restructure and move
  products dialogs (the reason is the note), and the add, discard, archive, merge and merge values
  dialogs of an attribute. A 202 shows "Sent for approval (SR-n)" and leaves the item as it is.
  Where an action only files a request its dialog says "Send for approval", says that nothing
  changes until another admin approves it, and shows no "can't be undone" line or terminal banner.
  The panel has no feature-set create page yet.
- Not hooked: the category-tree import and the attribute file import (see the system-requests
  notes); they run unreviewed.
- Impact counts on the request's detail page (19 Nov 2026): the category and attribute appliers
  answer `impact` (`application/catalogue-impact.ts`) with the counts of the admin impact dialogs,
  behind the same read keys (`catalog.category-tree.view`, `catalog.attribute.restructure`), in a
  read-only unit of the request's Market; the category product facts read is bounded at 2 s
  ("at least" after). Once System requests' abort signal fired, no read starts. See "Impact counts" in the system-requests notes.

## Add product is the edit form in add mode (seller #991, admin #994)

One page, no wizard. The same form serves Add and Edit; Add differs only in what is not yet
known.

- **Route.** Seller `/products/new` renders `EditForm` with the `add` prop (blank product built
  by `blankProduct(options)`); admin `/catalog/products/new` renders `ProductAdd`, which reads
  the options client-side and gives `EditForm` the `creating` prop.
- **Nothing is created until the first Save draft.** Opening the page, typing and leaving writes
  nothing. Publish (admin) and Submit for review (seller) are inactive until the product exists.
- **Save sequence (`createAndSave`).** `POST` create (seller: type, condition, SKU; admin: type
  only), then `PUT .../draft` with the page content and the `variantIds` returned by the create,
  then `router.replace` to the edit URL. Before leaving, `flushSync(() => setDirty(false))`
  releases the unsaved-changes guard so it does not prompt. A busy ref (not state) blocks a
  double submit. A 401 at either call goes to `/session-ended`. Once the create has succeeded,
  a failed or refused draft save still moves to the edit page and is told there (seller: toast;
  admin: `?saved=failed|refused`, read by `startProblemOf`), because for the seller a second Save draft would
  find the SKU taken (the admin create has no SKU). A failed create stays on the page with its problem shown.
- **Reads before the first save** come from the options endpoints, not a product read:
  `GET catalog/seller/products/options` and `GET catalog/admin/platform-products/options` (use cases
  `OwnProductOptions`, `PlatformProductOptions`): product types, locales, tax categories,
  categories (seller also conditions and `sellerCanCreateProduct`; the seller's product types are
  filtered to the types that seller may sell). A failed category read
  degrades to an empty list; the other answers stay usable.
- **Loading and guards.** The seller page loads the options server-side; when
  `sellerCanCreateProduct` is false it shows `catalog.create.closed` instead of the form. The
  admin page loads them client-side with loading, failed and retry states, and shows a no-access
  message (with a back link) when the session lacks the edit permission.
- **Seller and admin differ in one card.** The seller gets a "Your offer" card (type,
  condition, SKU; all required, checked before the call). The admin picks the product type in
  the Organisation card; a missing type is reported at the top and focuses the field.
- **DOM order equals visual order.** The two-column layout is an explicit `lg:` grid with
  `col-start`/`row-start`/`row-span`; no `order-*` classes, so tab and screen-reader order match
  what is seen. Add a card by giving it an explicit cell, not by reordering.

## Brand archive reason

`POST catalog/admin/brands/:id/archive` takes an optional `reason` next to `version` (trimmed, at
most 500 characters, no control characters or line breaks; empty or null means none; anything else
is `validation.failed` on `reason`). It is used when an admin turns a seller's proposal down or
retires a live brand. The text is stored on the brand (`catalog.brands.archive_reason`, CHECK:
only on an archived row) for the proposing seller's notice; the audit row `catalog.brand.archived`
records only `reasonGiven` (audit rows and events carry no text, ADR-0009 decision 6). No decision
reads it; a merge never sets it. It is not in the brand answers yet: the notice slice reads it.

Any panel that shows the archive reason (the seller's notice, an admin view) must render it as plain
text, never as HTML: no `dangerouslySetInnerHTML`, no Markdown, no auto-linking.

## Saved filters of the phase 2 lists

Eleven admin lists and two seller lists register with `lists` (super list B0-1b), so they have
saved filters through the generic routes: `admin.catalog.variants`, `variant-requests`,
`attributes`, `products-missing-details`, `attribute-suggestions`, `brands`, `business-activities`,
`tags`, `tag-suggestions`, `category-proposals`, `review-queue` (the Product review queue and the
Revision queue are one list, told apart by the `kind` filter), and `seller.catalog.attribute-suggestions`
and `seller.catalog.topic-suggestions` (one set per store). The saved document is
`{ v: 1, q?, filters, sort, direction }` with no tabs; each list's own reading of its filter keys
checks the values. Each list is guarded by the key its list use case checks; admin filters are
shared with `catalog.saved-filter.share`, seller filters with `catalog.own-saved-filter.share`. The
lists have no column choice yet (no `columns`). A saved attribute `missing` locale is checked for
shape only; the Market's supported locales are not known when a filter is saved.

## Bulk decide of the review queue (list 13)

`POST /catalog/admin/review-queue/bulk-decide` (use case `catalog.review-queue-bulk-decide`, key
`catalog.product.approve`, admin only). Body: `kind` (`revision` or `offer`), `action` (`approve` or
`request-changes`), `reasonCode` (only with `request-changes`; the product or the offer change
reasons), `items` (1 to 50). Revision items are `{ id: productId, revisionId, version }`, offer
items `{ id: offerId, version }`; results are keyed by `id`. Each row runs the single use case as
the caller. A bulk approve passes no ticked check, so a revision whose review needs checks comes
back `skipped` with `review.checks-missing` (owner decision 20 Nov 2026). Offers and revisions are
separate calls because their reason codes differ.

## Search of the review queue (list 13)

`GET /catalog/admin/review-queue` and its `/export` take `q`: text, 2 to 100 characters once
trimmed (`''` is no search; shorter, longer, a non-string or a control character is
`validation.failed` on `q`). It keeps the rows of both kinds whose product code, product name or
seller public store name contains the text, in any case; `%`, `_` and `\` are matched as typed. The
name is the one the row shows, in the Market's default locale: the pending revision's for a product
revision, the published one for an Offer (an Offer on an unpublished product has no name to match).
Store names are owned by `sellers`: catalog asks `sellers.searchStoreNames` (through the
`StoreNameSearch` port) before the read unit, and the matched seller ids join the condition. That
method answers at most 200 sellers and accepts at most 80 characters, so a longer text matches
products only; a failed store search fails the read (`access.unavailable`, 503) rather than show
the queue without the store matches. When more than 200 stores match, the list answers
`searchCapped: true` (the rows of the stores left out are missing; narrow the search) and the export
is refused as `validation.failed` on `q` with `too-broad`, never a partial file. `q` composes with
every other filter and with `total`; `totals` stay the whole queue per kind. Saved filters keep `q`
under the same rule. No index was added. The expected plan (not measured) is that the partial queue
indexes pick the queue rows and the search filters them; Prisma's relation filters are uncorrelated
subqueries, which Postgres may hash over the whole tables. Before the catalogue reaches about 100k
products, or on the first slow-query report, capture `EXPLAIN (ANALYZE, BUFFERS)` on seeded data and,
if needed, move the search to a `$queryRaw` with a correlated `EXISTS` (database review of PR #1267).

## Claim term impact count (C-7)

`POST /catalog/admin/claim-terms/impact-count` (use case `catalog.claim-terms-impact-count`, key
`certification.type.edit` imported from `certification`, admin only, refused in acting-as). Body:
`{ typeCode?, termsByLocale: { <locale>: string[] } }`; answer `{ products, offers, total, complete }`.
Read-only. It scans published product texts (name, short description, description) and published Offer
descriptions, 100 texts a call to `certification.matchCandidateClaimTerms` (request X-1), stopping at
20,000 texts or 10 seconds (`complete: false`, "at least N"). Errors: `validation.failed` 400 (the
terms the matcher cannot use are refused with `details.fields`), `access.denied` 403,
`request.throttled` 429 (shares the claim-text check budget, 30 a minute), `access.unavailable` and
`claim-text.check-unavailable` 503 ("We couldn't count"; never a zero). Not yet counted: category
names and descriptions (seller and platform), attribute definition names and option labels,
category-proposal texts; they join with the rescan job (design 6.4, slice 18).

## Seller category scope by business activity (owner decision of 31 Oct 2026)

A seller may pick and save only categories inside the business activities assigned to them.
One helper decides it: `SellerCategoryScope.allowedCategoryIdsForSeller(context, sellerId)`
(`application/business-activities/allowed-category-ids.ts`, a Nest service of `CatalogModule`).
It answers the ids of every category at or below the categories linked to the seller's ACTIVE
activities (links are level 1-2; children inherit; the structure is `liveCategoryTree`'s, a hidden
node counting as a link of the chain). No activity, inactive ones only or no link: the empty set.
The assignment comes from `sellers.sellerBusinessActivities` through the port
`SellerActivityReader` (adapter `SellersSellerActivityReader`); any refusal or fault, and a tree that
cannot be built, is `access.unavailable` (fail closed, never "every category"). It opens its own
read-only unit, so callers ask it before theirs.

Where it applies (SELLER scope only; platform and admin paths are unchanged):

- seller picker `GET /catalog/seller/products/category-picker`: only choices inside the scope; an
  empty scope answers `choices: []` with `notice: "no-activity"` (the form says "Ask the team to set
  your business activity before choosing categories."); an unreadable scope is 503.
- seller submit (`SubmitProduct` passes the set to `FreezeRevision.freeze` options): a category
  outside is the issue `category.not-in-activity` at `categoryIds.<n>` of `revision.not-ready`
  (unless that place already has another issue); an unreadable scope is `access.unavailable`.
  Saved drafts and published revisions are never changed or deleted; the rule bites at the next
  submit, so seller-import drafts meet it when they are submitted.
- category proposal: a parent outside is `validation.failed` with `platformParentId`
  `category.not-in-activity`.

Deferred (docs/future-enhancements, FE-167 to FE-170): admin per-seller exceptions; the scope in
admin bulk moves, seller import check time and the seller's platform-product search; an impact
count before an activity or link is removed; the proposal form's parent list.

## Offer review policy at first publication (ADR-0051, risk-based Offer approval slice 2)

A seller's Offer submit (`own-offer.submit`) no longer reads the Market's `approval-required`
(that setting now governs product revisions only). The pure policy
`domain/offer-review-policy.ts` decides, version `OFFER_REVIEW_POLICY_VERSION` (2 since slice 2c, 3 since slice 4): it returns the
reasons that send the Offer to the queue, empty meaning publish at once.

| Reason code          | Rule       | Source today                                                                                                              |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------- |
| `emergency-stop`     | R0         | the Market switch `offer-review-emergency-stop` (slice 2b), the seller's stop and the category stop (slice 4) |
| `probation`          | R1         | the seller's standing (slice 4): fewer approved products than N in the current epoch, and not Trusted                     |
| `certificate-badge`  | R2         | kept and requested badge types, while `catalog.offer-review.certificate-badges` is `review`                               |
| `handling`           | R3         | handling other than `SEALED_ORIGINAL`                                                                                     |
| `contact-text`       | R5         | a link, domain, e-mail, phone number (dates excluded), `@handle` or a messaging app name in any locale of the description |
| `full-review`        | R6         | the seller's full-review flag (sellers, SEL-25; slice 4)                                                                  |
| `sensitive-category` | R7         | "always review" on a category of the product or an ancestor (slice 4)                                                    |
| `review-all`         | mode `all` | the Market's mode is `all` and no other reason applies                                                                    |

Mode `off` publishes everything except during an emergency stop. The settings are read through
`SettingsFacade.offerReviewPolicy` outside the unit (port `OfferReviewInputs`); a failure answers
mode `all` (review everything). In the submit unit the decision is stored in
`catalog.offer_review_referrals` (insert-only; reasons, policy version, Offer version) and audited
as `catalog.offer.review-referred`. R4 (price against the reference) runs in pricing (slice 3).
The rules on edits are in the next section (slice 2c).

## Edits of a live Offer (risk-based Offer approval slice 2c)

`offerEditReviewReasons` (policy version 2) judges a seller's edit of a **published** Offer. It
watches three fields: the description, the handling and a new certification tag. While the
emergency stop is on (R0, owner decision 2026-11-25), every watched change is held with
`emergency-stop`, in every mode (the Market's stop, and since slice 4 the seller's and the category's). Without a stop, mode `off` holds nothing. Otherwise R2 (a new badge while `certificate-badges` is `review`), R3 (handling other
than `SEALED_ORIGINAL`) and R5 (contact text in any locale) hold the change; in mode `all` any
watched change is held (`review-all`), except a handling change back to `SEALED_ORIGINAL`, which
lowers the risk and is instant in every mode (Hadi, 2026-11-25). R1 and R6 are publication
rules and do not apply to edits; since slice 4, R7 holds a watched edit of an Offer whose product is
in an "always review" category (`sensitive-category`, owner answer 4). A settings read failure answers the safe
settings (mode `all`).

- Green: the edit applies as before, and an `edit` referral with no reason is stored and audited.
- Red: the fields the policy does not watch (SKU, condition) apply at once; the watched part is
  stored as one `catalog.offer_pending_changes` row (`pending`, one per Offer), the Offer's
  version goes up (no `offer_history` row), the referral carries the reasons and the change id,
  and `catalog.offer-change.held` is audited. The answer is `applied: false` with
  `pendingChangeId` and `reasons`. A tag add asks certification first, so a type that is not
  allowed is refused and never queued.
- While a change waits, another watched edit answers 409 `offer.change-pending` unless the body
  has `replacePending: true`: the old change is then `superseded` (cause `resubmitted`). Edits of
  fields that are not watched apply. Deleting the Offer, or an admin withdrawing its product,
  supersedes it (cause `offer-deleted`).
- Decisions: the seller withdraws (`POST catalog/seller/offers/:offerId/pending-change/withdraw`);
  a reviewer with the Offer approve key approves, requests changes or rejects
  (`POST catalog/admin/offer-changes/:changeId/{approve|request-changes|reject}`; a note of 1 to
  2000 characters is required for the last two, optional on approve) and lists the waiting changes
  (`GET catalog/admin/offer-changes`, keyset `afterId`/`limit`). Approve is all or nothing: the
  description is claim-text checked again, every kept and requested tag is asked fresh, and a
  refused tag fails the whole approval (`claim.tag-not-allowed`) with the change still waiting.
  Each decision is one conditional update on `status = 'pending'`, so two deciders cannot both
  win (`conflict.stale`). A held value the Offer refuses on approval answers 422
  `offer-change.invalid` and applies nothing.
- No self-decision (Hassan N3 on PR #1350): an admin never approves, requests changes on or
  rejects a change their own account submitted, nor from a Login-as-Seller session for its seller
  (or one naming no seller): 403 `offer-change.own-submission`. The domain refuses the first case
  too. A held edit made in an acting-as session records the admin behind it as the submitter.
- Audit (Hassan N1): `catalog.offer-change.held` and `.approved` carry the held handling as a
  lower-case code (`sealed-original`, `repacked`, `prepared`, `fresh`); `.approved` also carries
  the ids of the tags it added. The audit vocabulary has no kind for type codes that grow at run
  time, so the requested type codes stay on the change row (its proposal columns are immutable)
  and `changeId` names it. Never the description or the note.
- Bypass guard (Hassan S1 on PR #1350): `Offer.edit`, `setHandling`, `addTags` and
  `applyApprovedChange` refuse a watched change of a live Offer without a `ReviewClearance` issued
  for that Offer. The brand is a run-time one (`domain/review-clearance.ts` remembers what it
  issued in a module-private `WeakSet`), so a cast or a look-alike object never passes, and a
  clearance issued for another Offer is refused. `application/offer-review-clearance.ts` issues a
  policy clearance only from an opaque verdict made by running the policy (`OfferEditReview.verdict`)
  that found no reason, and an approval clearance only for a change approved in the unit.
  `test/contracts/catalog-review-clearance.contract.spec.ts` is an import allow-list over the
  syntax tree of every source file: only the named files may import the issuing functions.
- The seller's Offer read carries `pendingChange` (the latest change, or null). No event or
  notification is sent for a decision yet.

## Probation, Trusted and the review flags (risk-based Offer approval slice 4)

- **Standing** (`catalog.seller_review_standings`, one row per seller and Market, created by the
  first approval or send-back): epoch, target kind, Changes needed in a row, `trustedAt`,
  `trustLostAt`. Credits (`seller_review_credits`, insert-only) count one per **product** per
  epoch, so deleting and recreating an Offer gains nothing. N is the Market setting
  `probationOffers` (0 to 100; unreadable or out of bounds reads as 100). `trustStatusOf` is pure:
  Trusted when `trustedAt` is stamped, when the admin flag Trusted from start was switched on after
  the last revocation, or when the count meets the target (N, or ceil(N/2) after misconduct).
- **Writes**: `offer.approve` credits the product and stamps Trusted at the target, in the
  approval's unit (`catalog.seller-review.trusted` audited once); `offer.request-changes` counts a
  Changes needed, and the second in a row starts a new epoch from zero
  (`catalog.seller-review.restarted`); an approval breaks the row. Once Trusted, Changes needed
  are ignored. When N was lowered under a count, the next submit (or send-back) stamps
  `trustedAt`, so raising N later never demotes. Misconduct revocation is in the domain and tested,
  not wired yet. Lock order: the Offer row, then the standing; each UPDATE raises the version by
  one (the guard trigger allows nothing else).
- **Seller flags** (sellers, SEL-25; `seller_admin_settings` plus the insert-only
  `offer_review_flag_changes`): Trusted from start (`sellers.offer-review-trust.manage`, protected,
  step-up `sellers.offer-review-trust.change`), full review (`sellers.offer-review-full.manage`,
  no step-up, no default role) and the seller stop (`sellers.offer-review-stop.manage`, protected,
  step-up `sellers.offer-review-stop.change`). Routes `GET` and `PUT
  sellers/admin/:sellerId/offer-review[/trusted|/full-review|/stop]`; catalog reads them through
  `SellersFacade.offerReviewFlagsOf`.
- **Category flags** (`category_offer_review_flags`, `category_offer_review_changes`): "always
  review" (R7, `catalog.category-review.manage`, step-up `catalog.category-review.change`) and the
  category stop (R0, `catalog.offer-review-stop.manage`, step-up
  `catalog.offer-review-stop.change`), both inherited by sub-categories through the live category
  paths. Routes `PUT catalog/admin/categories/:categoryId/offer-review[-stop]`,
  `GET catalog/admin/offer-review/category-flags` and `GET
  catalog/admin/sellers/:sellerId/review-standing`.
- Every change takes `{ on, reason, expectedVersion }` (reason 1 to 500 characters, kept in the
  change log, never logged or audited; a stale version is 409 `conflict.stale`), is refused in an
  acting-as session, and spends the step-up proof in its own unit only when it changes something.
- **Edits**: the seller and category stops hold watched edits like the Market's stop, and
  "always review" now holds watched edits too (`sensitive-category`, owner answer 4).
- **Review fixes of PR #1358**:
  - A first publication with degraded facts is judged in the safe settings (mode `all`, badges
    reviewed), like an edit, so a stop that could not be read never publishes in mode `off`
    (Hassan M1).
  - What a seller is told (Hadi's decision (b) on Hassan S1): the edit, add-tag and set-handling
    answers and the seller's own read of a held change keep `certificate-badge`, `handling` and
    `contact-text`, and show every other reason once as `held-for-review`
    (`sellerReviewReasonsOf`). The referral and change rows and the admin views keep the full
    codes, so a seller never learns of a stop, its probation, full review or the "always review"
    categories.
  - N = 0 means "no probation" while it lasts (Hadi's decision (a) on Hassan S2): Trusted live,
    but `trustedAt` is stamped only when N >= 1 and the count meets the target, so raising N again
    puts sellers below it back in probation.
  - A standing row is inserted only in its start state (the guard trigger; Hassan N1).
  - The standing read needs `sellers.seller.view` as well as `catalog.product.approve`, since it
    shows the seller's flags (Hassan N2).
- **Fail closed**: the facts are read outside the decision's unit. Sellers unavailable: probation
  and full review; standing unreadable: probation; categories unreadable: sensitive category;
  each marks the facts `degraded`, and a degraded edit verdict uses mode `all`. A failure never
  invents a stop.

## The admin review queue APIs (risk-based Offer approval slice 5)

- **Edits super list** (`GET catalog/admin/offer-changes`, Hadi's decision 2): the page read of
  the review queue (`sort` `submitted`, `direction`, `page`, `pageSize`, `paging` from the
  Market's "List paging"; `total` in `pages` mode) next to the slice 2c keyset read (`afterId`,
  `limit`), never mixed. Filters `reasons` (any of, comma-separated), `sellerId`, `categoryId`
  (the product's published revision, exact category), `submittedFrom`/`submittedTo` (the age)
  and `q` (the review queue's rules and escaping). `totalPending` is the tab count. Each row also
  carries `live` (the Offer's description, handling and open tag types now), `offer`, `product`,
  `storeName` and the caller's `actions`. Export at `offer-changes/export` (CSV, XLSX; codes and
  labels only, never the proposed description); one change by id at `offer-changes/:changeId`.
  No new index: the filters run on the few pending rows the `(market_id, status, submitted_at,
  id)` index picks.
- **First publications**: review queue Offer rows carry `reasons` (the latest first-publication
  referral) and `tagTypes` (open tags), for the chips and the bulk check.
- **Bulk approval of Offers** (Hadi's decision 3) is enforced in `review-queue.bulk-decide`: only
  `probation` (R1), `full-review` (R6) and `certificate-badge` (R2) when every R2 row of the batch
  is one seller's with one certificate type. Other rows are `skipped` with
  `review.bulk-not-allowed` and `blockers`, `review.bulk-certificate-mixed`, or
  `review.reasons-unknown` (no stored decision; fail closed). Offer results carry the product
  `name`. If the reasons cannot be read, an approval is refused whole (503); a send-back goes on.
- **Bulk approve re-reads the R0 stops** (Hassan M1, PR 1364): for every row it reads the Market
  emergency stop, the seller's review stop and the category stops (ancestors and merges, as the
  slice 4 policy). A stopped row is `skipped` with `review.bulk-not-allowed` and `emergency-stop`
  first in its blockers; if any stop cannot be read the whole approve is refused (503,
  fail closed). A row with no verdict is skipped as `offer.not-found`; stored first-publication
  reasons are used only when their Offer version equals the row's and the current version,
  otherwise `review.reasons-unknown`.
- **Stop banner** (`GET catalog/admin/offer-review/stops`): the Market stop and how many sellers
  (sellers facade `offerReviewStoppedSellerCount`, needs `sellers.seller.view`) and categories
  have their stop on; a part that cannot be read is null.
- First-publication reject is deferred (Hadi's decision 1; FE-20261125-offer-first-publication-reject).
- **Super list gaps closed** (CLAUDE.md rule 14): the review queue takes the Offer filters
  `reasons` (Offers whose latest first-publication referral carries any of them; resolved in the
  read unit to the waiting Offer ids, so an earlier submit's reasons never match) and
  `categoryId` (the product's published revision); both keep Offers only and are refused
  (`not-allowed`) with `kind=product-revision` or a revision filter, and the export takes them
  too. Both lists answer `sellers` (the stores with rows of the kinds kept, whatever the other
  filters; at most 100, `sellersCapped` beyond) as the seller filter's options; the panel takes
  the category options from `catalog/categories`, as the Products list. The Edits list has saved
  filters of its own (`admin.catalog.offer-changes`: `reasons`, `age` preset, `sellerId`,
  `categoryId`, `q`); `admin.catalog.review-queue` also keeps `reasons` and `categoryId`.

## Post-publication review (risk-based Offer approval slice 6)

An Offer published at once can still be checked after it went live, while it sells (ADR-0051).
Built from `/mnt/project-files/handoffs/offer-approval-6-spec.md`.

- **Tables** (migration `20261126000000_catalog_offer_post_reviews`):
  - `offer_post_reviews` holds one row per check, with `reasons` (`sample`, `price-no-reference`,
    `price-reference-unavailable`, `price-recheck-outside`), the sample's effective percent and
    `sample_doubled`. A row is born `open` at version 1. While open it only gains reasons (each
    once), and the sample columns are set once. It is decided once (`approved` | `taken-down`)
    and never deleted (guard trigger). One open row per Offer (partial unique).
  - `offer_post_review_reasons` is insert-only and keyed on (Market, Offer, reason, source). It
    makes every intake idempotent. The source is the pricing record id or `offer-version:N`.
  - `offer_pending_changes.superseded_cause` gains `taken-down`.
- **Sample at the submit.** It runs in the submit unit, after the Offer row, only for an Offer
  published at once.
  - The draw is HMAC-SHA-256 under an HKDF key of its own (info `catalog.offer-review-sampling`)
    over (Market, Offer, saved version), scaled to a bucket 0..9999. It is drawn when the bucket
    is under percent × 100.
  - The percent comes from the Market setting `samplingPercent`. An absent or invalid percent is
    the safe 100.
  - The percent is doubled (at most 100) for 30 days (720 h) after the seller became Trusted.
    This includes the submit that stamps Trusted.
  - A sampler failure counts as drawn and logs a code only.
  - Degraded facts already queue the Offer (safe settings), so it is never drawn.
  - Nothing reaches the seller. The answer is still `{ published }`. The audit
    `catalog.offer.review-referred` gains `sampled` (null when queued). `OFFER_REVIEW_POLICY_VERSION`
    is 4.
- **R6 on resubmit.** The review facts read `everTakenDown` for the Offer. A take-down, or a
  failed read, sets `fullReview`; a failed read also sets `degraded`. The facts also answer
  `trustedSince`.
- **Price reasons** come from pricing through `CatalogFacade.referOfferForPostReview`
  (`catalog.offer-post-review-refer`, system). The record id is the source. An unknown, deleted
  or mismatched Offer answers `post-review.offer-gone` with nothing written. A lost race is
  asked again three times, then `conflict.retry` makes the delivery retry.
- **Admin routes** under `catalog/admin/offer-post-reviews`. All are no-store, and each logs
  only its code, the Market and the correlation id.
  - **List.** `GET` is a super list with `status` (default `open`, `all`), `reasons`,
    `sellerId`, `categoryId`, `openedFrom`/`openedTo`, `q`, sort `opened` | `decided`, page
    1..20 and pageSize 1..50. It answers `totalOpen` and `sellers`.
  - **Export.** `GET export` gives CSV or XLSX, never the note.
  - **One row.** `GET :id` adds `note` only for a caller holding `catalog.product.approve`.
  - **Approve.** `POST :id/approve` needs `catalog.product.approve`. The note is optional. It
    still closes a row whose Offer is not live any more.
  - **Take down.** `POST :id/take-down` needs approve and `catalog.product.delete`, and is
    refused in any Login-as-Seller session. The body is `version`, `reasonCode`, `misconduct`
    and a required `note`.
    - The Offer goes `changes-needed`, unlisted, with `catalog.offer-changes-requested.v1` and
      `catalog.offer-listing-changed.v1`.
    - Its held edit is superseded (`taken-down`).
    - `misconduct` revokes Trusted. A seller with no standing gets one started.
    - The audit `catalog.offer.taken-down` holds codes only.
  - **Bulk approve.** `POST bulk-approve` takes 1..50 rows, uses the shared bulk kit (`done`,
    `skipped`, `failed`) and adds the product `name`.
  - **Own submission.** An admin behind one of the Offer's submits (Offer history, actor or
    acting admin) is refused with `post-review.own-submission` (403). The submit now records
    `acting_admin_account_id`.
- **Saved filters:** `admin.catalog.offer-post-reviews` (`status`, `reasons`, `age` preset,
  `sellerId`, `categoryId`, `q`).
- **Audit actions:** `catalog.offer.post-review-approved`, `catalog.offer.taken-down`,
  `catalog.seller-review.trust-revoked`. The note is never audited or logged.
- **Deferred:** the price and median column on the list (catalog stores codes only; pricing's
  read would need a facade for it), FE-20261125-post-review-price-column.
