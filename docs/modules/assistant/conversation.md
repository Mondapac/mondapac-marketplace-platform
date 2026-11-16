# Buyer assistant conversation (package 4)

Source: the buyer assistant plan (sections 4 to 8 and 11), ADR-0019, the settings of
[settings.md](settings.md). Backend only; the storefront widget is package 5.

## Route

`POST /assistant/conversations/:id/messages`, body `{ text, visitor? }` (closed: any other field
is 400). `id` is a canonical UUID v7 the widget generates for a new conversation and repeats for
the next messages; the conversation is the subject of its own encryption key.

| Caller                                             | Use case (rule)                              | Who owns the conversation                                                                                                                                   |
| -------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Signed-in customer (session cookie and CSRF token) | `assistant.send-message` (`own-resources`)   | the account of the session                                                                                                                                  |
| Anyone else                                        | `assistant.send-guest-message` (`anonymous`) | the assistant's own guest cookie `__Host-assistant-guest-<Market>` (30 days, HttpOnly, Secure, SameSite=Lax; the store keeps only the SHA-256 of the token) |

A seller or admin session is not read on this route. A conversation answers only its owner in its
Market; anything else is 404 `assistant.conversation-not-found`. The owner never comes from the
body or the model.

## Answer

A refusal is ordinary JSON: 400 `validation.failed`, 403 `assistant.off` (off, not configured, not
in the rollout) or `assistant.sign-in-required`, 404, 409 `assistant.conversation-full` (30 buyer
messages), 429 `request.throttled` with `Retry-After`, 503 `assistant.paused` (a spend cap) or
`assistant.unavailable` (limiter or store down: fail closed).

An answer is `200 text/event-stream`, `Cache-Control: no-store`, sent after the server checked the
whole reply: `conversation {id}`, one `card` per card, one `text {text}` per checked sentence, one
`notice {code}` per fixed message, then `done {}`. Each `data` line is one JSON object.

- Cards: `product` (offer, product, seller ids, name, short text, `price` and `regularPrice` as
  `{ amount: "<minor units>", currency }`, `taxInclusive`), `page` (a site page the storefront
  builds the link for), `support` (the public support email), and under the `cart-suggestions`
  scope `cart-action` and `cart` (see "Cart cards" below).
- Notices: `see-cards` (a price, stock, delivery or minimum-order sentence was dropped),
  `see-certification` (a certification sentence was dropped), `tool-failed`, `unavailable` (the
  model failed or timed out: a support card comes with it), `refused`, `cart-actions-not-ready`
  (the Market's scope is `read-only`), `cart-sign-in` (a cart line or the cart was asked for by a
  buyer who is not signed in; the cart page link comes with it), `support-form-not-ready`.

## What the model gets and does

- One model entry point (`platform/ai`, `ModelGateway`); only the files on the boundary rule's
  allow-list import it, and no provider SDK is imported anywhere (plain HTTPS to the Messages
  API). Provider failures are logged with the Market, tier and failure kind only.
- Instructions version `buyer-assistant-4`; the last 12 messages; read-only tools that call the
  `search`, `catalog`, `sellers`, `certification` and `notifications` facades with the buyer's own
  `CallContext`: `search_products`, `list_bestsellers`, `list_specials`, `get_product`,
  `get_seller`, `list_categories`, `show_page`, `support_contact`. `open_support_form` answers
  "not ready yet"; `suggest_cart_change` too under the `read-only` scope. Under `cart-suggestions`
  the model also gets `get_cart` and the real `suggest_cart_change`, and the cart rules are added
  to the instructions (same prompt version).
- Product cards carry the seller's public store name and the lowest buyer price of the Offer from
  pricing (`price`, `taxInclusive`, `priceFrom` when the Variants differ; `regularPrice` only on a
  special), read through the product page use case (one read per distinct product). A price that
  cannot be read leaves the card without one. `get_product` (description, attributes, brand, who
  sells it) and `get_seller` (store name, city, selling-since year, product count) show a product
  card (the cheapest Offer, with catalog's live badges and whether each is only a seller claim)
  and a store card (`kind: 'seller'`). The store card has no certification badge: a store-level
  certificate is not an Offer claim (R1). An unknown, malformed or not-selling id answers "not
  found" alike; a failed read answers `tool-failed`. `productCount` null means unknown, never zero.
  Known limits: the city name is read in English (the ServiceArea directory guarantees `en`; a
  Market read in another language needs a language source before launch), the store count comes
  from the store query by name, and each list tool call does one product page read per distinct
  product (a batched card read is a follow-up).
- The model gets ids and, for lists, `get_product` and `get_seller`, every seller-entered text
  (names, short texts, descriptions, attributes, store names) between `<<seller-text` and
  `seller-text>>` (a forged marker inside the text is removed; 200 characters for names, 1500 for
  descriptions, 20 attributes, 5 sellers): data, never instructions. It never gets a price,
  a stock figure or a certification badge: those reach the buyer only on the cards.
- The model never sees a price, stock figure or badge. Its reply is checked
  sentence by sentence (`domain/reply-guard.ts`): money, stock, delivery, minimum-order and
  certification sentences are dropped with a notice; markup, links, addresses and invisible
  characters are removed. Tool calls are schema-checked; at most 4 model rounds and 25 s a turn,
  15 s a call, 600 output tokens.
- Emails and runs of 8 or more digits in the buyer's text are masked before it is stored or sent;
  the reply guard also removes them, and bare domains, from what the model writes.
- At most 3 tool calls a round (more are answered as refused) and 24 cards a turn; the support
  card always fits. The turn and its spend commit in their own unit, before the text is stored,
  so a storage failure never loses the count. A call cut at its timeout is counted at the most it
  can cost. A guest request with no client origin is refused (`assistant.unavailable`).

## Cart cards (stage 1, S1-B1)

Only under the Market's `cart-suggestions` scope (default `read-only`). The assistant never
changes a cart: both tools are reads through `cart`'s `CartAssistantFacade` with the buyer's own
`CallContext`, and the storefront changes the cart through the cart's own routes, with the buyer's
session and CSRF token, only after the buyer clicks (ADR-0019 R4).

- `suggest_cart_change` takes `action` (`add`, `set_quantity`, `remove`), `offer_id` (add; the model
  now gets the `offerId` of each listed product), `line_id` (from `get_cart`) and `quantity` (1 to
  999; add defaults to 1). Any other field, a malformed id or quantity is refused.
- `add` asks `cart.read-assistant-offer-units` (rule `anonymous`): the Offer's units on sale now,
  checked as the cart's add checks them (catalog, sellers, pricing, inventory; fail closed), at
  most 10, each with its price, Variant label and `maxQuantity` (the Market's line ceiling, lowered
  by the stock read only while stock is low: the "max N" of the brief, never a stock count). The
  proposed quantity is lowered to the largest max (`limited: true`). A signed-in buyer's cart is
  read too: each unit's `lineId` and `inCart`. The buyer picks the unit when there are several.
- `set_quantity` and `remove` need the signed-in buyer's own line (`cart.view-assistant-cart`, rule
  `own-resources`): a line id not in that cart is "not found"; a guest gets the cart page link and
  `cart-sign-in`. A line that cannot be bought now can be lowered or removed, never raised; a
  raise above the max is lowered to it.
- Cart mode (`settings.read-cart-mode` through `SettingsFacade.cartMode`, `multi-store` on any
  failure): in `single-store`, `otherStore` is true when the buyer's cart holds lines of another
  store (the widget then asks to move them to saved items or remove them first), null for a guest
  (the widget reads its own cart), false in `multi-store`. Enforcement stays in `cart`/`ordering`.
- `get_cart` shows the `cart` card: lines grouped by store with the cart evaluator's subtotal and
  minimum-order state, each line's price and max, and the total of the stores with something
  buyable (null when one is unknown or currencies mix).
- The model reads line ids, offer ids, names and sizes (as seller text), quantities in the buyer's
  own cart and whether each line can be bought now: never a price, subtotal, total, minimum or max.
  Its descriptions and the cart rules say it changes nothing and must not say a change was made.
- Card JSON: every Money is `{ amount: "<minor units>", currency }`. `cart-action`: `action`,
  `offerId`, `productId`, `sellerId`, `sellerName`, `name`, `lineId` and `currentQuantity` (line
  changes), `quantity` (add: how many more; set: the new total; remove: 0), `limited`, `units[]`
  (`variantId`, `label`, `price`, `taxInclusive`, `maxQuantity`, `lineId`, `inCart`), `cartMode`,
  `otherStore`. `cart`: `lineCount`, `total`, `groups[]` (`sellerId`, `sellerName`, `subtotal`,
  `minimumOrder {state, minimum}`, `lines[]`).
- History keeps a `cart-action` card as its product card and a `cart` card as the cart page link:
  an old action button or an old cart is never replayed.

## Limits, spend and storage

- Message limits per 10 minutes from the settings: per account, or per client origin plus per
  guest token, counted in `platform.rate_limit_counters` (class `assistant-message`, keyed HMAC).
- Spend: each call is priced from the Market's configured token price and counted in
  `assistant.spend_days` (Market calendar day). At the daily or monthly cap the Market answers
  `assistant.paused` until the next day or month; the first pause of a day is recorded (admin
  read `spend.lastAutoOff`) and logged as a warning. The same unit writes one
  `assistant.spend-cap-reached.v1` event (payload: the cap only) to `assistant.outbox`, once per
  Market and day; notifications turns it into the admin bell notice
  `admin.assistant-spend-cap-reached`, shown to admins holding `assistant.settings.view`.
  Notifications reads the event through `assistant/contracts/admin-notice.contract.ts`, a contract
  file only notifications may import (the assistant index would close a cycle).
- Storage (`assistant.conversations`, `assistant.messages`): text only when the retention setting
  keeps it, encrypted under the conversation's key. The daily purge job deletes conversations
  older than the retention in force (a shorter setting applies to older conversations too; a guest
  30 days at most) and destroys their keys. No transcript text is ever logged.
- The model call never runs inside a database transaction: one read-only unit before it, one
  read-write unit after it.

## Before the switch is turned on (not code)

- ADR-0019 R7: the provider's no-retention, no-training terms and the Market's data residency
  need the owner's approval; the real-model evaluation must be recorded as passed for the
  provider, model and prompt version.
- Privacy note: conversations are personal data (masked, encrypted, purged as above).
- R7 (Hassan, L2): the adapter calls the provider's global endpoint and one provider is bound for
  every Market. Before a Market is switched on, either the owner approves that endpoint for the
  Market's data residency, or provider and region become Market configuration.
- Open question for Ali (cto): ADR-0019 decision 7 lets a seller switch AI off (SEL-25). Should
  that seller's product names and short texts then stay out of the assistant's model input?
- Evaluation: `domain/evaluation-set.ts` (version = prompt version) runs offline against the reply
  guard in `pnpm verify` (claim leakage 0); the real-model run of the same set is recorded before
  the switch; it should add a short local number ("13 xx xx") and a domain or number spelled
  in words, which the guard does not catch. The "injection carried by a file" sample does not
  apply: this surface takes no files.

## A signed-in buyer's history (stage 0, B2)

Three routes on the same controller, for a signed-in customer only (session cookie; DELETE also
needs the CSRF token). A guest is answered 403 `assistant.sign-in-required` before any use case;
a seller or admin session is not read here. Every answer is `Cache-Control: no-store`.

| Route                                       | Use case (`own-resources`)      | Answer                                                                                                                                        |
| ------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /assistant/conversations?cursor&limit` | `assistant.list-conversations`  | `{ items: [{ id, title, turns, full, startedAt, lastMessageAt }], nextCursor }`, newest activity first, 20 a page (at most 50), keyset cursor |
| `GET /assistant/conversations/:id`          | `assistant.view-conversation`   | the same fields plus `messages: [{ position, role, text, cards, at }]`, oldest first                                                          |
| `DELETE /assistant/conversations/:id`       | `assistant.delete-conversation` | 204                                                                                                                                           |

- Listed: the account's conversations of the Market that keep text and whose last message is
  within the retention in force (the shorter of the stored one and the current setting; `none`
  lists nothing). A conversation of another account, a guest's, an unknown one or an expired one
  is 404 `assistant.conversation-not-found`.
- Title: the first buyer message (masked before it was stored, masked again), on one line, at
  most 30 user-perceived characters with an ellipsis. A conversation with no stored buyer message
  is not listed.
- Cards come back as stored: kind and ids only (`product` with `offerId`, `page` with `page`,
  `support`). A price or product text is never replayed from an old answer; the widget reads the
  product again if it shows one.
- List and view answer 403 `assistant.off` while the Market's switch is off. Delete works while
  it is off: a buyer can always erase their own conversation. Delete removes the conversation,
  its messages (cascade) and destroys its key in one unit.
- Continue a listed conversation with the existing POST; `full: true` means it has its 30 buyer
  messages and the POST answers 409 `assistant.conversation-full`.
- A deleted or purged conversation's id is spent: the POST answers 404
  `assistant.conversation-not-found` for it before any model call (its key can never be created
  again, and a failed write would roll back the spend).
- Index (migration `20261116010000_assistant_conversations_account_index`, built CONCURRENTLY,
  partial `WHERE account_id IS NOT NULL`): (`market_id`, `account_id`, `last_message_at` DESC,
  `id` DESC) for the list.

## Preview for `internal` (stage 0, B4)

- `POST /assistant/admin/preview-token` (admin session, CSRF, `assistant.settings.manage`,
  protected) answers `{ token, expiresAt }`: valid 30 minutes, for this Market only. Each issue
  is an audit row `assistant.preview-token.issued` naming the expiry (a security event, s3); the
  token is never stored or logged. Without `ASSISTANT_PREVIEW_TOKEN_KEY` the route answers 503
  `assistant.preview-unavailable` and no token verifies.
- The storefront sends the token as the `x-assistant-preview` header with
  `GET /assistant/storefront` and each `POST .../messages`. A valid token puts that browser in
  the rollout whatever the audience; the kill switch, a missing key or model, the spend caps,
  customers-only and the message limits still apply. The read answers `preview: true` so the
  widget can mark itself. Invalid, expired or another Market's token counts as none.
- Format `ap1.<expiry>.<nonce>.<mac>`: HMAC-SHA-256 under an HKDF key of
  `ASSISTANT_PREVIEW_TOKEN_KEY` over (purpose, Market, expiry, nonce); constant-time compare; an
  expiry past the lifetime is refused even with a valid MAC. The token names no account.
- Replay: a token is a bearer token for its 30 minutes and is not bound to a browser. Accepted
  because it unlocks only what any visitor gets with `audience: all`, under the same limits and
  caps. Changing the key revokes every token at once; after a rotation admins take a new token
  from the panel. Each environment (testbed, staging, production) has its own key, so a token
  never crosses between them; a `dev-only-` key is refused when `NODE_ENV` is production. The
  panel should pass it to the storefront
  in the URL fragment (never a query string) and keep it in the tab's session storage only (F1/F3).
- `?visitor=` stays a rollout aid, never a control.

## Tables (Mojtaba's sign-off before merge)

Migration `20261019224946_assistant_conversations`. `conversations`: one owner (account, or a
32-byte guest token hash), `turns` 0 to 30, `retention_days` 0 or 30 (365 for an account only),
index on (`market_id`, `retention_days`, `last_message_at`) for the purge; the application role
updates only `turns` and `last_message_at`. `messages`: PK (Market, conversation,
position 1 to 60), `text_cipher`, card refs (ids only, at most 40), cascade delete with the
conversation; the application role can neither UPDATE nor DELETE them. `spend_days`: PK (Market, day), counts
never negative, one auto-off record per day; never deleted by the application role.

One `spend_days` row per Market and day is updated by every turn: watch its lock waits; split
it into slots per day if they grow.
