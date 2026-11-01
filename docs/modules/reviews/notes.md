# reviews: buyer reviews and ratings, package 1 (backend core)

Speed mode (CLAUDE.md): no G1/G2 or design document. This note records the owner's decisions
(hand-off `reviews-package1.md` in the Project, outside the repo; Persian design
`reviews-ratings-design-fa.html`, sections 3 to 6, 9 and 13; build approved 2026-10-26) and what
the code does.

## Owner decisions (binding)

- N1 Only verified buyers: the account owns a seller order whose fulfilment is `delivered`.
  Refunded orders may review. Eligibility is asked of ordering at write time through
  `ORDERING_FACADE.myDeliveredSellerOrders` (added in this package, rule `own-resources`, at most
  200 seller orders, newest delivery first) and of catalog (`offerSellUnits`) for offer to
  product. Nothing is copied into the `reviews` schema.
- N2 Product review: rating 1 to 5, title and body optional. Seller rating per seller order:
  satisfaction 1 to 5, asDescribed, arrivedOk, a reason code only when it did not arrive ok. Lengths
  are Market config (AU 120 and 2000).
- N3 Product stars aggregate on the product across sellers; each review keeps `offer_id` and
  `seller_id` of the latest purchase for the "Bought from" label.
- N4 Windows are Market config `reviews.reviewWindowDays` (AU 60, from delivery) and
  `reviews.editWindowDays` (AU 30, from the first submit). The author may delete at any time. One
  review per (market, account, product): a later purchase of the same product answers
  `purchase-recorded` and only moves the label and `last_purchase_at`. One seller rating per seller
  order. A review the author deleted can be written again on the same row (`resubmitted`).
- N5 No text, or a clean text: published at once. Any automatic-check hit: `held` with signal codes.
- N6 Seller replies: the table exists, no endpoint (package 4).
- N8 A product summary is shown from the first review. The seller summary returns `count`,
  `minimumCount` (AU 10) and `meetsMinimum`; the web decides. `SELLER_RATINGS_SHOWN` is untouched.
- N10 The author's short name is read at read time and never stored (see open question 1).
- N11 `ReviewsFacade.detachAuthor(accountId)` drops the author link and keeps the rating and text
  as "Former customer". Identity has no account-deletion event today, so nothing calls it yet.

## The switch is runtime

There is no `reviews.enabled` in Market config. The state is the row of
`reviews.market_settings` (no row = `off`), moved by an admin (`GET`/`PUT /reviews/admin/settings`,
`reviews.settings.view` / `reviews.settings.manage`, protected platform key, audited as
`reviews.market-status.changed`, refused in acting-as, idempotent). While `off` every buyer and
public read and write, and every facade read, answers `reviews.disabled` (404 over HTTP). Turning
it off deletes nothing. `detachAuthor` and the summary-rebuild job do not wait for the switch
(the job does nothing while off).

## Automatic checks (pure domain, `domain/text-checks.ts`)

Signals: `profanity` (Market config `reviews.autoChecks.blockedTerms`, whole words, compatibility-folded and
lower case), `phone-number`, `email-address`, `web-address`, `street-address`, `markup`
(HTML or script), `repeated-text` (a character run, or one word making up too large a share of
the words). The text is never logged, audited, evented, put in a signal row or in a failure body:
`moderation_actions` and `review_signals` carry codes only.

## Anti-abuse

- Daily limit: counted from the author's own rows in the insert-only log (submit, edit, delete) plus seller ratings, so delete-and-resubmit and edits are limited too. Submit, edit and rate are refused at the limit; a delete never is, and a buyer at the limit still gets the real answer for a review that exists. It is a soft limit: the count and the insert share one READ COMMITTED unit, so parallel requests of one account can overshoot by the number in flight.
- Refused: a member of the seller (`SellerAffinity`, `reviews.own-store`); more than
  `maxSubmissionsPerAccountPerDay` reviews plus ratings in 24 hours (`reviews.rate-limited`, 429).
- Signal, not refuse, for the same address or payment fingerprint as the seller: NOT built, see
  the package 5 TODO below.

## Tables (schema `reviews`)

`product_reviews`, `seller_ratings`, `review_replies`, `review_reports`, `moderation_actions`
(insert-only: update, delete and truncate are refused by trigger for every role),
`review_signals` (insert-only), `rating_summaries` (rebuilt, never the source of truth),
`market_settings`. Every row has `market_id` and `tenant_id`; ids of other modules are plain
UUIDs with no key to another schema. Composite market-scoped keys tie replies, reports and the
log to their review inside the schema. Reviews and ratings are never deleted (trigger); the
application role may change only the columns granted. The migration and `down.sql` are in
`prisma/migrations/20261026100000_reviews_core`.

Product summaries are refreshed by the write that changes a review (recomputed from the
published source rows with a group-by, not incremented); seller summaries only by the job and repaired by the worker job
`reviews.rebuild-summaries`, every `reviews.summaryRebuildMinutes` (AU 1440, daily; the smallest of the hosted Markets). Product summaries are also refreshed on every review write; seller summaries only by this job. The job lists the subjects once, rebuilds them in batches of 100 (one short unit each) and writes only the rows whose numbers changed.

## HTTP

Buyer (own resources, refused in acting-as): `GET /reviews/me/to-review`, `GET /reviews/me`,
`POST /reviews/products` (201, or 200 for `purchase-recorded`), `PATCH /reviews/products/:id`,
`DELETE /reviews/products/:id`, `POST /reviews/seller-orders/:sellerOrderId/rating`.
Public (anonymous, reasons in `http-reachable-anonymous-system.json`):
`GET /reviews/products/:productId` (published only, newest first, `stars` filter, keyset cursor,
page size from Market config; `sort=helpful` is refused until helpful votes exist),
`GET /reviews/products/:productId/summary`, `GET /reviews/sellers/:sellerId/summary`.
Admin: settings, above (the switch change needs a fresh step-up proof, action
`reviews.settings.change`). Bodies and queries are closed (an unknown field is a 400).

## Package 2: admin moderation queue

Routes under `/reviews/admin/moderation` (admin host, English LTR panel at `/reviews/moderation`):
`GET` queue (tabs held, reported, actioned; keyset cursor; counts), `GET :id` one review with
report reasons and history, `POST :id/{publish,hide,restore,remove}` and `POST :id/dismiss-reports`.
Permission `reviews.moderation.queue`. It is named so it is not a `.view` key: the Viewer role
would otherwise get it automatically (open owner question, Viewer role). Moderation works whether
the review switch is on or off.
- Publish, hide, restore and remove each need a fresh step-up proof of the one action
  `reviews.review.moderate`, spent once inside the unit of work. Dismissing reports needs none.
- `moderation_actions` is insert-only and holds the moderator id and a reason code, never text.
- Daily cap: the write flow takes advisory lock class 1703 (`reviews.lock-account`) before counting
  the account's submissions of the day, so two parallel submits cannot both pass. Moderator
  publish rows do not count against the author's cap.
- Own store: `identity.ownAccountTiedToSeller` answers a boolean (same normalised email between
  the customer and an active member of the seller). The reviews module fails closed if it cannot answer.
- Switch stays OFF. Real use still needs the review policy text and the Viewer-role decision.

## Open questions for the owner

1. Where does the public short name come from? `identity.customerShortNames` serves a seller's
   own orders and refuses other callers, so the public list cannot use it. Until a public-safe
   source exists `UnavailableReviewerNames` is bound and every non-anonymous review shows as
   "Verified buyer" (safe, never a wrong name). Swap `REVIEWER_NAMES` when decided.
2. Seller team membership: identity keeps one population per account, so a customer session is
   never a team member and `StructuralSellerAffinity` answers "not tied". A person with a
   customer account and a seller account on the same email is not caught; that needs an identity
   query that does not exist. Swap `SELLER_AFFINITY` when it does.
3. Step-up for the admin switch: identity has no admin step-up primitive yet (only seller step-up
   actions exist), so the routes are protected by the permission, the protected key and audit
   only; the same known gap as the wallet switch. Add `@RequiresStepUp` when admin step-up lands.
4. Account deletion has no event or hook in identity; `detachAuthor` is ready for it.

## TODO for package 5 (anti-abuse signals)

Raise a `review_signals` row (code `same-address-as-seller`, `same-payment-fingerprint`) when the
buyer's delivery address or payment fingerprint matches the seller's. It needs an address and a
fingerprint comparison from ordering and payments that is not cheap today, so it is left out of
package 1. Also then: a `held` queue and moderation endpoints (package 2), helpful votes, seller
replies (package 4), notifications, search ranking and photos.

## Privacy and moderation notes (after the Opus review)

- The moderation log never holds the author's account id (`actor_account_id` is null for submits,
  edits, deletes and automatic holds; only moderators, package 2, are recorded by id), so deleting
  the account (`detachAuthor`) removes every link (N11).
- The author may delete a review in any status (N4), including one a moderator hid or removed: the
  text is cleared and the log keeps the earlier status. Such a review cannot be written again
  (`reviews.already-reviewed`).
- Public reads show `publishedOn` and `editedOn` as a UTC day, never an exact time. The public
  review id is a random UUIDv4 (`product_reviews.public_id`, made by the database); the internal
  UUIDv7 `id` stays in the author's own views only. The public list cursor is the public id of the
  last review shown: it carries no time, and an id that is not a review of that product is a 400.
- The seller summary returns only `count`, `minimumCount` and `meetsMinimum` until the seller has
  the Market minimum of rated orders (the averages, histogram and shares are null), and the write
  path never refreshes it: only the job does, so a poller cannot read one rating from one change.
- N11 reaches the order ids too: `detachAuthor` also nulls `product_reviews.last_seller_order_id`
  and `seller_ratings.seller_order_id` (ordering still ties those orders to the person). NULL
  order ids do not collide on the one-rating-per-order key; a CHECK keeps them set while the
  account link is set.
- A switch that cannot be read fails closed: `reviews.unavailable` (503), never read as "off". An unexpected database error that is thrown is a 500.

## Indexes

The public list of one product reads two partial indexes `WHERE status = 'published'`
(`product_reviews_public_list_idx`, and `_rating_idx` with the star filter); they are hand-written
in the migration because Prisma cannot declare them. The ordering read for reviews uses
`ordering.order_lines (market_id, seller_order_id)`, built CONCURRENTLY in its own migration
`20261026110000_ordering_order_lines_seller_order_index`. The seller index on `product_reviews`
and the plain `review_reports` index were dropped (no reader in package 1; add back with the
package that needs them).

## Review nits left as notes

- Settings: two admins switching at once can write a duplicate audit row (no row lock on the
  switch); take `SELECT ... FOR UPDATE` when the moderation package touches it.
- A moderator `hold` (package 2) must also block delete-and-resubmit, as `hidden` and `removed` do.
- Contact-detail checks do not fold look-alike letters (Cyrillic, Greek); add a UTS #39 skeleton in
  package 5. Package 5 should also signal a very short paid-to-delivered time on pickup and many
  reviews of one seller from fresh accounts.
- Deleting a `removed` review clears its text; ask whether removed text must be kept for a period.
- No database guard on status moves or on `account_id` changing to anything but NULL (the
  application enforces both); consider a BEFORE UPDATE trigger like the wallet's.
- `review_reports` allows many rows with a NULL reporter (NULLs are distinct); decide in package 2
  (`NULLS NOT DISTINCT` or a partial unique index).
- The repair job could rebuild only subjects touched since its last run instead of listing all.

- Street-address patterns (English and Japanese suffixes) are constants in the domain; move them
  to `reviews.autoChecks.addressSuffixes` in Market config before a non-English Market launches.
- A database CHECK failure puts the failing row (title and body) in the Postgres error DETAIL.
  Config bounds match the CHECKs today; if they ever diverge, catch and re-throw a code-only
  error in the repository writes. Confirm the global exception filter never logs Prisma details.
- `GET /reviews/me` returns at most 100 reviews and has no cursor.
- `myDeliveredSellerOrders` returns at most 200 seller orders, newest delivery first; a buyer with
  more than 200 deliveries inside the window loses the rest.
- Delete then resubmit resets `created_at`, so the edit window restarts (bounded by the review
  window). Confirm with the owner that "first submit" in N4 allows this.
- Two reviews of one product written at once can leave the summary short by one until the repair
  job runs; the summary is never the source of truth.
- Spec deviations to acknowledge in the PR: no admin step-up on the switch, no public short name
  (N10), structural-only own-store check (open questions above).

## Out of scope in this package

Any UI, the admin moderation queue, seller reply endpoint, notifications, search ranking, photos
and helpful votes.

## Package 3: buyer web pages (apps/web)

Owner approved the build 2026-11-01. Everything is behind the runtime switch above: while it is
`off` the API answers `reviews.disabled` (404) and the web draws nothing about reviews.

- Product page: a "Customer reviews" section (stars summary, five-row chart that filters the list,
  published reviews newest first, "Show more"). Server-read by `src/reviews/reviews-source.ts`;
  the filter and "Show more" go through the site's own `app/api/product-reviews/[id]` route (the
  session relay drops query strings, and these reads are anonymous). Text is shown as plain text.
- "Bought from" is resolved from the product's own offers (seller id to store name); a seller who
  no longer offers the product leaves the label out. The public body has no seller name.
- Reviewer names: the page shows what the API sends. Until open question 1 is decided every
  non-anonymous review reads "Verified buyer"; a "named" author without a usable name does too.
- Account: `/account/reviews` (not in the account menu yet: the switch is runtime and the menu is
  static; Orders shows a "N waiting for your review" link when the switch is on). Lists what waits
  for a review, the review form (stars, title, text, "show me as Verified buyer"), edit and delete
  of the buyer's own reviews, and the seller-order rating (satisfaction, as described, arrived ok,
  optional reason). Product and seller names come from the account's orders.
- Relay: GET `reviews/me`, `reviews/me/to-review`; POST `reviews/products`,
  `reviews/seller-orders/:id/rating`; PATCH and DELETE `reviews/products/:id`. PATCH is a new method
  for the relay and the `/api` route. Admin and public reads do not cross.
- Messages are in `messages/en.json` (`reviews`); the layout uses logical CSS properties only, so
  a Persian catalogue (W3) needs no other change. Review text carries `dir="auto"`.
- Length limits are Market config in the API; the forms do not hard-code them and show the API's
  field refusals.
- Not in this package: seller rings on the seller page (`SELLER_RATINGS_SHOWN` stays false), the
  "Top rated" sort and card stars (package 5), seller replies (package 4), helpful votes, photos.
- Agent reviews (Hassan, Reza) of the PR are folded in: the site list route answers 404 only for
  "off", 429 with `retry-after` for a throttle and 503 for a fault, all `no-store`; author names sit
  in `<bdi>`; averages and percents use the language's number format; a saved form leaves a page
  notice; a failed star filter goes back to the earlier filter.
- Differences from design section 7, on purpose: the star chart filters the list instead of the
  "With text / 1-2 star" chips, and one review count is shown (the API has no separate rating
  count). A hidden review shows "Not shown" only: the API does not return the reason yet.

## Package 4a: the seller's side of the API (backend)

- New seller permissions, not protected: `reviews.seller.view`, `reviews.seller.reply`,
  `reviews.seller.report`. Routes under `reviews/seller`: GET list, POST and PATCH
  `:reviewId/reply`, POST `:reviewId/report`. Writes are refused in an acting-as session.
- A seller sees only its own published reviews and an order reference (the seller order id); never
  the buyer's name, email or address. One reply per review (unique key, so a race makes one row).
  Editing a reply is allowed for `reviews.replyEditWindowDays` (default 7) after it was written;
  `reviews.replyMaxLength` defaults to 2000. Both are Market config.
- A reply goes through the same text checks as a review (contact details, links, markup, the
  Market's blocked words). Unlike a review it is refused, not held: a reply has no queue.
- A report stores a reason code from a closed list (`personal-information`, `abusive`, `irrelevant`,
  `not-a-purchase`, `extortion`) in `review_reports`, one per team member; it opens the existing
  "reported" tab of the admin queue. The seller can never hide or remove a review.
- A review moves to another seller when the buyer buys the product again from someone else. The
  earlier seller's reply (and, when the author deletes and writes the review again, every published
  reply) is then set to `superseded` (kept as history, never shown or edited) and
  the new seller starts clean; a seller only ever reads and edits its own reply. The one-reply
  rule is "one published reply per review" (partial unique index, migration
  `20261101230000_reviews_reply_per_seller`). Open question for the owner: keep the old reply
  instead? Clearing is the safe default. Hidden and
  removed replies are a moderator's decision and are never superseded. A reply is written or edited
  only after the review row is locked, so it cannot slip in beside a concurrent move.
- Reply max length is capped at 2000 in Market config, matching the table CHECK.
- Not in 4a: the public reply under a review on the product page (package 3 list), notices for the
  seller, buyer and admin (4b), the seller panel screens (4c), the daily digest, appeals.
