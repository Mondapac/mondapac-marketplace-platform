# customers: build notes (speed mode)

The buyer's own data beside the `identity` account. The owner approved the customer plan on
2026-10-17 (all five packages, one PR each); under speed mode there is no separate G1/G2 brief.
This note records what is built and the rules it keeps.

## Package 1: delivery address book (this module's first slice)

- Table `customers.addresses`: one row per address of a customer account (`account_id`, no
  foreign key). Everything the customer typed (recipient first and last name, phone, address
  lines, suburb, region, postcode, delivery notes) is one ciphertext under the account's subject
  key (`customers.address.content`), so destroying the key at account deletion erases every
  address. Only the country, the default flag and the times are clear. At most one default per
  account (partial unique index).
- Routes `customers/me/addresses` (customer sessions only, CSRF on writes, `no-store`): list,
  add, change, remove, and `POST :id/default`. Use cases are `own-resources`; there is no
  permission key and no admin view. The customer comes from the session, never from the body.
- Rules: the first address is the default; removing the default makes the newest remaining one
  the default; `isDefault: false` never clears the default. At most the Market's
  `customers.addressBookLimit` addresses (AU 20). Recipient name and phone are required (delivery
  only, no SMS).
- Market configuration `customers.address`: country, postcode pattern and region list (AU: the
  eight states and territories, four-digit postcode). A Market without the section answers
  `customers.unavailable`.
- No address value reaches a log, an event, an audit row or an error (a refused field gives its
  path and a code only). Writes run serializable (the limit and the one default span rows).

## Package 2: the address at checkout and on the order

- `POST /orders/checkout` takes `{ "addressId": "<uuid>" }`, one of the customer's own
  addresses. Ordering reads it through `CUSTOMERS_CHECKOUT_FACADE` (use case
  `customers.read-delivery-address`, `own-resources`) before the cart or the stock is touched:
  missing is `validation.failed` (400), another customer's, unknown or erased is
  `ordering.address-not-found` (422). Stripe Checkout still collects no address.
- The order keeps a fixed copy in `ordering.orders.ship_to_ciphertext`: the address and its
  country as one ciphertext under the customer account's subject key (`ordering.order.ship-to`),
  written once at insert. A later change or removal in the address book never touches it;
  destroying the key at account deletion erases it while the order's money stays.
- Who sees it: the customer on `GET /orders/:id` and the seller on its own seller order page
  (view, ship, deliver), as `shipTo` (recipient name, phone, address lines, suburb, region,
  postcode, delivery notes, country), never the customer's email or account id. Lists and the
  admin order page carry no address. `shipTo` is null on orders placed before this package and
  once the account was erased.

## Next packages

3. Customer profile API. 4. Marketing consent record in `legal`.
5. Customer account deletion (v1.5).

## Open follow-ups (Hassan, PR #405 review: GO, two low findings)

- Rows under a destroyed account key still count toward the limit and can be promoted to the
  default. Package 5 (account deletion) deletes the account's `customers.addresses` rows with the
  key, which closes this.
- One damaged ciphertext row makes the list answer 500 (`addressFromJson` throws). Later: let
  `open` return a typed failure, skip the row and log only the address id and a code.
