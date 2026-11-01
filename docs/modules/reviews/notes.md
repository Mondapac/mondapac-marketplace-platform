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
- Signal, not refuse, for the same address or payment fingerprint as the seller: built in package 5
  (see "Package 5" below).

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
Admin: settings, above. Bodies and queries are closed (an unknown field is a 400).

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

## Package 5 (1 Nov 2026): helpful votes, overlap signals, rating totals

All of it sits behind the reviews Market switch (off). Mock data is synthetic and lives only in test
fixtures and the DB specs, on both Market fixtures (AU and ZZ); nothing is seeded into a real database.

- **Helpful votes:** `PUT` and `DELETE /reviews/products/:publicId/helpful` (signed-in buyer, CSRF,
  `no-store`). A vote is on a PUBLISHED review only, once per account (a repeat is the same answer), not
  on your own review (`reviews.own-review`, 403), not by a member of the seller (`reviews.own-store`),
  and at most `maxHelpfulVotesPerAccountPerDay` (AU 200, ZZ 3; over it the vote is rolled back,
  `reviews.rate-limited`). Table `reviews.helpful_votes` (insert and delete only; an update is refused);
  `product_reviews.helpful_count` is kept exact by database triggers in the same transaction, and the
  the application role holds a column grant on `helpful_count` because the triggers run as the invoker; a guard trigger (`pg_trigger_depth() < 2`) refuses any direct write, and a review is born with 0. A vote is never shown with its
  voter. `detachAuthor` deletes the votes of the deleted account. The public list shows `helpfulCount`
  and takes `sort=helpful` (keyset on helpful count, published time, id; partial index
  `product_reviews_public_list_helpful_idx`).
- **Overlap signals:** `same-address-as-seller` (ordering decides, with at least two shared address fields after folding case
  and spacing) and `same-payment-fingerprint`. A signal only: it holds the review for a moderator like
  the other submit signals and is recorded on seller ratings, and never refuses a buyer. The port `SellerOverlapSource` returns only two yes or no answers
  (`sameAddress`, `samePaymentFingerprint`); the comparison is made in ordering and payments. **Open:** ordering and payments publish no such comparison yet,
  so the bound source is `UnavailableSellerOverlap` (answers "cannot say", no signal). Wiring it is a
  follow-up with ordering and payments; reviews never receives an address or card detail.
- **Rating totals for search:** facade `productRatingTotals` (rule system, at most 1000 per page, from
  the rebuilt summaries). Search copies them (see docs/modules/search/search.md).
- **UI follow-ups (not in this package):** packages 2 and 3 are not merged. The review list should show
  the vote button and `helpfulCount` (vote state per viewer needs a small read for "did I vote", not
  built), and the admin queue should show the overlap signals on a held review.
- **Still open from the older list:** look-alike letters in contact checks (UTS #39), a very short
  paid-to-delivered time on pickup, many reviews of one seller from fresh accounts, notifications,
  photos, seller replies (package 4).

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
- Contact-detail checks do not fold look-alike letters (Cyrillic, Greek); add a UTS #39 skeleton in a
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
