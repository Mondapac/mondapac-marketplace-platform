# engagement: build notes (speed mode)

The shopping behaviour behind personalization. The owner approved the personalization plan on
2026-10-18 (handoff `handoffs/personalization.md`, decisions 1 to 6); under speed mode there is no
separate G1/G2 brief. This module is package 1a of that plan. Package 1d (recommendations) reads
what it records through methods it will add to `ENGAGEMENT_FACADE`.

## Package 1a: behaviour capture

- Table `engagement.behaviour_events`: one row per event, inserted and deleted, never changed.
  Subject: `account_id` (signed-in customer) or `guest_hash` (SHA-256 hex of the engagement guest
  cookie token), exactly one (CHECK). Kinds and their columns (CHECKs):
  `product-viewed` (product, offer?), `category-viewed` (category), `search-performed`
  (search text), `added-to-cart` (offer, variant). Ids are plain UUIDs with no foreign key.
- Table `engagement.personalization_settings`: the customer's switch, one row per Market and
  account. No row means on.
- Route `POST /engagement/events` (customer route population, reads the session, `no-store`):
  the storefront reports an event with a closed body `{ kind, productId?, offerId?, variantId?,
  categoryId?, query? }` and gets `{ recorded }`. A signed-in customer goes to
  `engagement.record-event` (`own-resources`, CSRF), anyone else to
  `engagement.record-guest-event` (`anonymous`, listed in
  `test/contracts/http-reachable-anonymous-system.json`). Abuse is bounded by the global
  per-origin rate limit (`default` class).
- Guest consent (owner decision 2026-10-18, cookie bar option A): a guest's event is recorded
  only when the storefront sends `Engagement-Consent: granted`, which it does after the buyer
  accepts the behaviour cookie in the cookie bar. Without it the guest is treated like
  `Sec-GPC: 1`: nothing recorded, no cookie set, a guest cookie sent is expired. Withdrawal: the
  storefront stops sending the header. Every guest call without the header expires a guest
  cookie sent, a refused (400) call too, so withdrawal works even when the storefront's own
  consent cookie is gone. Signed-in customers use the account switch instead.
- Host: no deployment is decided yet. The API sets the guest cookie on the host that serves
  it. If the API is served on the storefront's own host (through the storefront's server, the
  BFF), the storefront can also delete the cookie itself; if it is a separate API host, the
  expiry above is the only withdrawal path, and it is enough on its own.
- Guest cookie `__Host-engagement-guest-<market>` (Secure, HttpOnly, SameSite=Lax, Path=/), 32
  random bytes, set on the first recorded guest event with `Max-Age` 30 days and never extended,
  separate from the cart cookie. Only its hash is stored. A guest's history is not merged into an
  account at sign-in.
- Routes `GET/PUT customers/me/personalization` `{ enabled }` (customer sessions only, CSRF on
  the write): `engagement.view-personalization`, `engagement.set-personalization`.
- Job `engagement.purge-expired-events`, daily per Market (rule `system`).
- Facade `ENGAGEMENT_FACADE.forgetAccount` (rule `system`): deletes an account's events and
  switch; for account deletion (customers package 5), which does not exist yet.
- No permission key, no domain event, no outbox row.

## Privacy impact note (PIA)

Owner decisions 4 and 5 of 2026-10-18; Australian Privacy Principles (APP 1, 3, 5, 6, 11).

| Question | Answer |
|---|---|
| What is collected | Event kind, catalog ids (product, offer, variant, category), the search text as typed (normalized, max 200 characters), the time, the Market, and the account id or the hash of a random guest token. No name, email, address, IP address, user agent or device id is stored with an event. |
| Why | To show recently viewed items and better recommendations (package 1d). Not sold, not shared with a third party, no third-party pixel or SDK. |
| Sensitive information | Purchases or views are never used to infer religion, diet or health (decision 5; halal is sensitive information). No code reads events to label a shopper; an explicit buyer preference or filter is the only source for that. The search text can still contain such words, so it is never logged and never leaves the module except to package 1d's own ranking. |
| Retention | 12 months for a signed-in customer, 30 days for a guest (the guest cookie lives 30 days too), deleted by the daily purge. |
| Choice | Off switch in the account (`PUT customers/me/personalization`); switching off deletes what was recorded and stops recording (recording and the switch run serializable, so no event survives a racing switch-off). A guest is recorded only after accepting the behaviour cookie in the cookie bar (`Engagement-Consent: granted`). `Sec-GPC: 1` (Global Privacy Control) records nothing for anyone, sets no cookie and expires a guest cookie sent. |
| Deletion | With the account through `forgetAccount` (to be called by customers package 5). |
| Security | Only the guest token's SHA-256 is stored; the token is only in `Set-Cookie`. Logs carry the route, outcome code, Market and correlation id only: never the body, the search text, an id of the shopper or the cookie. The app role may select, insert and delete events, never update them. |
| Notice | The storefront privacy policy and the account page must say what is recorded, why, for how long, and how to switch it off, before the storefront goes live (storefront design thread). |

## Follow-ups

- Package 1d: read methods on the facade (recently viewed for an account or a guest hash); only
  sellable offers of the Market are shown.
- Storefront: call the route on product, category and search pages and after a cart add; the
  account page toggle; privacy policy text (above).
- Customers package 5 (account deletion): call `ENGAGEMENT_FACADE.forgetAccount`.
- Physical model doc `docs/design/data/engagement.md` (Mojtaba), marking `search_query`,
  `account_id` and `guest_hash` as personal data.

## Review follow-ups (PR #411: Hassan GO with follow-ups, Mojtaba approved with follow-ups)

Fixed in the PR: recording runs serializable like the switch (Hassan M1); `Sec-GPC: 1` expires a
guest cookie sent (I1); `down.sql` sets `lock_timeout`.

Open, before the storefront sends real traffic:
- Hassan L1: the 30-day guest limit is enforced by the cookie's `Max-Age` only; store the issue
  time of each token hash (or put it in the token) and reissue a token older than 30 days.
- Hassan L2: a stricter rate class or a per-origin event cap for the anonymous route; every
  request without a cookie mints a token and a row.
- Hassan I2: after a switch-off and sign-out, browsing is recorded again under the guest cookie;
  say so in the privacy text, or clear the guest cookie on switch-off.
- Hassan I3: customers package 5 passes `forgetAccount` an account id from its own flow, never
  from user input.
- Mojtaba 1: partial indexes per subject (`WHERE account_id IS NOT NULL` / `guest_hash IS NOT
  NULL`) instead of `(market_id, occurred_at)`, so each purge scans only its own subject.
- Mojtaba 2: purge in batches (for example 5,000 rows a unit), per-table autovacuum tuning, and a
  written volume threshold for partitioning (by subject, then by month, so purge drops partitions).
- Mojtaba 5: `kind` as `text` with the CHECK (house standard), next time the table changes.
