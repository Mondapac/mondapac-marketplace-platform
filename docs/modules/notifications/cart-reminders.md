# Notifications: abandoned-cart email (personalization 1c, speed mode)

The first marketing mail. It goes through `sendMarketingMail` (package 1b), so consent, sender,
contact and the one-click unsubscribe are the same as for every marketing mail
(docs/modules/legal/notes.md).

- **Who:** signed-in customers only, whose consent `legal` holds at send time. A guest cart is never
  read, so a guest is never mailed. An unsubscribe stops the next reminder.
- **When:** the job `notifications.cart-reminders` runs every 15 minutes per hosted Market. Stage 1
  goes to a cart idle 4 to 12 hours; stage 2 to a cart idle 24 to 72 hours. Idle means the cart's
  `last_changed_at`; a new change starts new stages. A cart idle past 72 hours gets nothing more.
- **Stop on order:** `cart.clear-ordered-lines` (run after payment) sets `cart.carts.ordered_at`; the
  next change clears it. While it is set the cart is not listed, so lines left after an order get no
  reminder until the buyer changes the cart.
- **At most once:** a stage is taken in `notifications.cart_reminders` (account, cart change,
  stage) before the send. Overlapping runs send once; a failed send is not repeated (the run is
  logged as failed). Rows are deleted after 30 days.
- **Content:** a count of items and the cart page link (`notifications.cartReminders.cartPage`),
  English only (other locales fall back). No product, price or name; no address or id in logs.
- **Switch:** `notifications.cartReminders.mode` in `config/markets/<CODE>.json`: `off`, `test`
  (only the account ids in `testAccountIds` are mailed) or `live`. AU ships in `test` with no test
  account, so it mails nobody until test accounts are added. Without the section the Market sends
  no reminder.
- **Reads:** `cart.list-idle-account-carts` (rule `system`) behind `CART_REMINDER_FACADE`, at most 200
  carts per page, 10 pages per stage and run.

## Data (Mojtaba, review of 1c)

- `cart.carts.ordered_at`: nullable; `carts_ordered_at_check` (`ordered_at <= last_changed_at`)
  backs "the mark is written with the change it belongs to". `markOrdered` writes only while
  `last_changed_at` still equals the mark.
- `notifications.cart_reminders`: PK (market, account, cart change, stage), purge index
  (market, taken_at), purged in batches of 1000. `account_id` is a pseudonymous identifier
  (privacy review); no address or cart content is stored.
- Later, not at launch: a partial index `(market_id, last_changed_at, id) WHERE status = 'active'
  AND account_id IS NOT NULL AND ordered_at IS NULL` once guest carts far outnumber account carts.

## Before `live`

- The legal notes' items "Before the first real marketing send" and the PR #407 follow-ups: the
  footer's business name, ABN and postal address (Spam Act s17), the deployed notifications secret
  (K1), DKIM with the `List-Unsubscribe` headers, and the storefront unsubscribe page.
- The owner switches `mode` to `live`; nothing else changes.
