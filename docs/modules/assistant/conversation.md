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
- Instructions version `buyer-assistant-5`; the last 12 messages; read-only tools that call the
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
  by the stock read only while stock is low: the "max N" of the brief, never a stock count). A
  signed-in buyer's cart is read too: each unit's `lineId`, `inCart` and `addable` (`maxQuantity -
  inCart`, since the cart's add caps the sum; 0 for a unit with no line when the cart holds its
  most lines, `cartFull`). The proposed quantity is lowered to the unit's `addable` (to the largest
  one when the buyer picks among several; the widget clamps to the chosen unit's), with
  `limited: true`; when nothing more fits there is no card. The cart and the mode are read once per
  turn; the Offer read runs beside them.
- `set_quantity` and `remove` need the signed-in buyer's own line (`cart.view-assistant-cart`, rule
  `own-resources`): a line id not in that cart is "not found"; a guest gets the cart page link and
  `cart-sign-in`. A line that cannot be bought now can be lowered or removed, never raised; a
  raise above the max is lowered to it.
- Cart mode (`settings.read-cart-mode` through `SettingsFacade.cartMode`, `multi-store` on any
  failure): in `single-store`, `otherStore` is true when the buyer's cart holds lines of another
  store (the widget then asks to move them to saved items or remove them first), null when not
  known (a guest's cart is not read here, or a line's store could not be checked: the widget reads
  the cart itself first; null never means "safe"), false in `multi-store`. Enforcement stays in `cart`/`ordering`.
- `get_cart` shows the `cart` card: lines grouped by store with the cart evaluator's subtotal and
  minimum-order state, each line's price and max, and the total of the stores with something
  buyable (null when one is unknown or currencies mix).
- The model reads line ids, offer ids, names and sizes (as seller text), quantities in the buyer's
  own cart and whether each line can be bought now: never a price, subtotal, total, minimum or max.
  Its descriptions and the cart rules say it changes nothing and must not say a change was made.
- Card JSON: every Money is `{ amount: "<minor units>", currency }`. `cart-action`: `action`,
  `offerId`, `productId`, `sellerId`, `sellerName`, `name`, `lineId` and `currentQuantity` (line
  changes), `quantity` (add: how many more; set: the new total; remove: 0), `limited`, `cartFull`
  (add only), `units[]` (`variantId`, `label`, `price`, `taxInclusive`, `maxQuantity`, `lineId`,
  `inCart`, `addable`), `cartMode`, `otherStore`. `cart`: `lineCount`, `total`, `groups[]` (`sellerId`, `sellerName`, `subtotal`,
  `minimumOrder {state, minimum}`, `lines[]`).
- Before `cart-suggestions` is switched on in a Market: the storefront widget renders the new
  cards (S1-F1; until then the scope stays off everywhere), the owner records "buyer cart
  contents" (product names and quantities) as an approved data category for the provider (R7),
  and the real-model evaluation of `buyer-assistant-4` passes, cart cases included.
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
- Real-model run: `apps/api/test/eval/assistant-real-model.eval.ts`, run by hand from the Actions
  workflow "Assistant real-model evaluation" (`.github/workflows/assistant-eval.yml`; inputs: model
  id and tier; main only; secret `ASSISTANT_EVAL_MODEL_API_KEY` in the GitHub Environment
  `assistant-eval`, which needs the owner's approval for each run), or locally with
  `pnpm --filter @mondapac/api eval:assistant` and the `ASSISTANT_MODEL_*` variables. Never part of
  `pnpm verify`. Each case of the set, plus the two real-model cases above, goes through the whole
  turn (scope `cart-suggestions`, both Market fixtures) with the real instructions, tools and reply
  guard over synthetic facades whose seller texts carry injections. A case passes when the turn
  answers, the tools the case is about ran (the injected seller texts or the cart were read), and
  none of its `mustNotShow`, no certification word, no price or stock figure and no contact detail
  of the synthetic texts reaches what the buyer is shown. Both fixtures must run. The
  cross-seller, cross-customer and cross-Market canaries and the field allow-list of decision 9
  are covered offline in `pnpm verify` (`conversation-use-cases.spec.ts`), not by this run. The JSON report per Market (prompt version,
  model, tier, commit, ref and run id, each case with what the model wrote and what the buyer would see; never the key) is
  kept as the run's artifact for 90 days: that run is the record the switch needs.

## Feedback and insights (B3)

### Thumbs on an answer

`POST /assistant/conversations/:id/messages/:messageId/feedback`, body `{ rating: "up" | "down",
reason?: "wrong" | "not-found" | "other" }` (closed; `reason` only with `down`). `messageId` is
the position (1 to 60) of an assistant message of the conversation; the reply to the buyer's
n-th message is position 2n. Answers 200 `{ rating, reason }` (`Cache-Control: no-store`).

| Caller | Use case (rule) | Owner check |
|---|---|---|
| Signed-in customer (session cookie and CSRF token) | `assistant.submit-feedback` (`own-resources`) | the account of the session |
| Anyone else | `assistant.submit-guest-feedback` (`anonymous`) | the assistant guest cookie |

Refusals: 400 `validation.failed`, 403 `assistant.off` (the Market switch is off), 404
`assistant.conversation-not-found` (unknown, another owner's, or a guest with no or an unknown
cookie: always the same answer) and 404 `assistant.message-not-found` (a buyer message, a position
that does not exist, or a conversation that keeps no text). One row per message in
`assistant.feedback`; giving it again replaces the earlier one (last write wins). The row is
deleted with its message (cascade), so it follows the conversation's retention and the purge.

### Admin insights

`GET /assistant/admin/insights?from&to&page&pageSize`, admin session, permission
`assistant.settings.view` (use case `assistant.view-assistant-insights`). `from` and `to` are days
of the Market's calendar (`YYYY-MM-DD`, both included; default the 30 days ending today; at most 92).
The answer holds:

- `days`: every day of the range with `conversations` and `spendMicroUsd` (from `spend_days`), and
  their `totals`.
- `feedback`: `up`, `down`, `upShare` (null with no thumbs) and the `down` count by reason, for
  assistant messages written in the range.
- `handoffs`: assistant replies that showed the support card.
- `unanswered`: turns whose reply carried the notice `unavailable` or `tool-failed`, whose product
  search was empty, or that got a thumbs down; grouped by normalized query (Unicode-folded, lower
  case, no punctuation), most asked first, then newest; top 200 groups, paged with `page` and
  `pageSize` (default 50, at most 100). Each row: `query` (the newest wording, 200 characters at
  most), `count`, `lastAt` and the count per reason. `truncated` says that more than 1000 flagged
  turns existed and only the newest 1000 were grouped. This is the data of the F3 super list.

Retention limits what it shows: a conversation that keeps no text (retention `none`) has no
messages, so its unavailable, failed or empty turns, hand-offs and thumbs are not in these
numbers (only its spend day is); and a guest's conversation is purged after 30 days, so a thumbs
share over a longer range covers the surviving account conversations only.

Buyer text is the masked text that was stored, decrypted per conversation only to build these
rows; no account, guest or conversation id leaves the module. Only conversations that keep text
appear (a conversation with retention `none` leaves its spend day only). The route is
`no-store` and the text is never logged.

Each assistant message now stores `notices` (the fixed notice codes of the reply, at most 8) and
`empty_search`, written with the message, to feed the unanswered rows.

### Tables (Mojtaba's sign-off before merge)

Migration `20261116120000_assistant_feedback`. `feedback`: PK (Market, conversation, position),
FK to `messages` on the same three columns with `ON DELETE CASCADE`; CHECKs: rating `up|down`,
reason only with `down` and one of three values, the application role
can SELECT and INSERT, and UPDATE only `rating`, `reason` and `updated_at`; no DELETE (the cascade
needs none). `messages` gains `notices VARCHAR(32)[]` and `empty_search`; two partial indexes
on (`market_id`, `created_at`) for assistant rows: all of them (the range reads) and the flagged
ones only (the unanswered read).

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
- Cards come back as stored: kind and ids only (`product` with `offerId`, `seller` with
  `sellerId`, `page` with `page`, `support`). A price or product text is never replayed from an old answer; the widget reads the
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

## Basket planner and typed lists (stage 1, S1-B2)

Source: smart-baskets design sections 1 to 3. Off by default: the admin switch "Basket proposals
from a list" (`basketProposals`, versioned like the other fields). While it is off `plan_basket` is
not sent to the model and, if the model asks for it anyway, the call is refused before anything runs.

- **Tool** `plan_basket { items: [{ text, quantity, unit? }] }`: 1 to 40 lines; `text` 2 to 80
  characters (no controls, invisible format characters except the Persian ZWNJ, or markup);
  `quantity` more than 0; `unit` is `kg`, `g`, `l`, `ml` or `each` (a count is a whole number up
  to 99). Anything else refuses the whole call. The model parses a typed or pasted list (Persian,
  English or mixed) and nothing else: it never picks a product, a pack, a store or a number.
- **Planner** `domain/plan-basket.ts` (pure, no model): one storefront search per distinct line
  with the buyer's own `CallContext` (6 results, the search's own order), then per line: _found_
  when a result carries every word of the line and its pack fits, _unsure_ (up to 3 options) when
  results exist but none fits clearly, _not found_ otherwise. Pack size comes from the product
  name (`domain/pack-size.ts`: "2 kg", "500 g", "1,5 L", "6 x 330 ml", Persian units and digits);
  a wanted weight or volume with no readable size is never guessed, it becomes an option. Packs are
  rounded up; a pack more than twice the wish is an option only; the line says `larger` when the
  packs add up to more than asked. A result with no price, or in another currency, is dropped.
- **Modes** (`cart.mode`, read through settings): `multi-store` takes each line's best result
  from any store and groups the card by store with a subtotal each and a total; `single-store`
  picks one store by lines covered, then total, then store id, shows lines it does not have as
  `not-in-store`, and lists up to 3 other stores with coverage and total. The same input always
  gives the same basket.
- **Card** `basket-proposal` (`{ kind, proposal }`, money as `{ amount: "<minor units>", currency }`):
  `stores[]` (lines with `quantity` packs, unit `price`, `lineTotal`, `sizeNote`, up to 2
  `alternatives`; `subtotal`, `subtotalIsFrom`), `uncertain[]`, `notFound[]`, `alternativeStores[]`,
  `total`, `totalIsFrom`, `deliveryShownAtCheckout: true`. A price is a "from" price when the Offer's
  Variants differ. Delivery fees and minimum orders are not read here (no published read): the
  storefront shows them at checkout. History keeps only the ref `basket`; a proposal is never
  replayed (prices go stale).
- **What the model reads**: line counts (found, unsure, not found), the texts of not-found lines
  and the cart mode, never a product, store, price or total. It cannot change a cart; the
  storefront adds lines with the buyer's session after a click.
- **Failure**: a search that cannot be read, or a plan slower than 12 s, gives `tool-failed` and
  no card: a line is never reported "not found" because a read failed.
- **Load limits**: at most 8 plans run at once in a process, 2 per signed-in buyer, and 4 for
  all guests of a Market together (guests have no id); a plan over the limit is refused as
  `tool-failed`, not queued.
- Evaluation set `buyer-assistant-5`: guard cases for totals, injections and diet claims in a
  list, four list-parsing cases (English, Persian, mixed, bullets and fractions) whose expected calls
  must pass the schema, and twelve invalid calls the parser must refuse.
- **Sell unit** (`variantId`, `maxQuantity`, on every line and option): after planning, the server reads the units of each proposed Offer through the cart's READ facade (`offerUnits`, the buyer's own `CallContext`, at most 60 Offers, 4 at a time, within 4 s after the plan is done; a slow read never fails a plan, the Offers not reached have no unit) and puts on the line the unit whose price is the price shown (for a "from" price the cheapest unit, when it is at that price). `variantId` is null when the units could not be read in time or none has that price: the storefront then does not add that line from the card (it opens the product page). `maxQuantity` is the highest quantity one cart line of that unit may hold now; the cart's add still checks again and the storefront shows its answer. Neither field reaches the model.
- **Variants**: the card carries `offerId` and, when read, `variantId` (see above); cart lines are keyed by both. A
  weight or volume line whose Offer has Variants at different prices (`priceFrom`) is never
  auto-picked (the size is often the Variant): it is an option and the buyer picks. F1 reads the
  product page and settles the Variant (the buyer picks it when there are several) before it adds
  any line, whether or not `priceFrom` is set: equal prices do not mean one Variant. A count
  wish for an item whose name says it holds several ("12 pack", "6 x 330 ml") is also an option.
- **Rollout**: do not switch "Basket proposals from a list" on before the storefront widget
  (S1-F1) renders `basket-proposal`: until then the buyer would see no card. `not-in-store` means
  "not among the store's results for this search", not "the store does not sell it".
- Known limits: multi-store mode does not group lines by store to save delivery (no fee read);
  unit and digit tables are metric, English and Persian; pack size is read from the name, so products with no size in the name become
  options for weight and volume lines; a line's options come from at most 6 search results;
  coverage in single-store mode is therefore judged on those results; a product whose name only contains the line's word inside a longer word is an option, not a pick. Stage 2 adds `cheapest`.

## Storefront wiring (stage 0, F1; `apps/web`)

- **Path.** The widget talks to the API through the buyer relay (`app/api/[...path]`, same
  origin, no CORS): `chatUrl` is `/api/assistant`. The relay allows only `GET assistant/storefront`
  (query `visitor` and `lang`, each only when well shaped) and `POST
  assistant/conversations/<uuid>/messages` (strict UUID). On these paths, and only these, the
  assistant guest cookie `__Host-assistant-guest-<MARKET>` and the session cross both ways (the
  guest-cart cookie does not), the `x-assistant-preview` header crosses when it has the token
  shape, and the wait is 30 s (the server gives up at 25 s). The answer is buffered, which is
  what the server sends anyway (one write after the reply guard). The POST keeps the
  same-origin rule; logs name the route, never the conversation id or the token.
- **Setup split.** The server render (`loadAssistant`) gives `chatUrl`, the Market support email
  (the footer's `email` message, validated as a plain address) and, for a customer, the session's
  CSRF token. The visitor id lives in the browser, so the widget (`assistant-gate.tsx`) calls
  `GET <chatUrl>/storefront?visitor=&lang=` and renders nothing until it answers `enabled: true`;
  any failure keeps it off without console output. A signed-in customer's message takes the CSRF
  token the tab holds (`customer-api.ts`), else the page's, else a fresh session read.
- **From the answer.** `retentionDays` (customer or guest by who is signed in; 0 is worded as not
  kept), `quickPrompts` (replace the built-in chips when non-empty and are sent as the message),
  `welcomeText`, `guestsAllowed`, `preview` (a "Preview" marker in the panel header).
- **Cards.** Product rows show the seller name, the price (`Intl` money from minor units and the
  card's own currency), "From" for `priceFrom`, the regular price struck through, "including GST"
  when `taxInclusive`, and badges as the product page shows them (a seller's declaration in the
  declared style). No price when `price` is null. The `seller` card is a store row linking to
  `/s/<slug>`. Every field is validated; text is rendered as text.
- **Preview token.** Open any storefront URL with `#assistant-preview=<token>`. On load the
  gate takes it from `location.hash`, keeps it in `sessionStorage` (`sf-assistant-preview`, this
  tab only) when it has the token shape, and removes it from the address with `history.replaceState`
  (path, query and any other fragment part kept). It is sent only as the `x-assistant-preview`
  header of the storefront read and the message POST, and is dropped when the server answers
  `preview: false`. Never a query string, cookie, localStorage, log, analytics event or error text.
  The GA4 page view reports origin plus path and never the fragment.


## Cart cards in the storefront (stage 1, S1-F1; `apps/web`)

- **Cards rendered.** `cart-action` (add, set quantity, remove), `cart` (read only) and
  `basket-proposal` (`src/assistant/cart-cards.ts` checks every field; `cart-card-views.tsx` shows
  them). A bad id, mode, state or total drops the card; a bad price only drops that price. Nothing
  the model wrote is a link or a number: names are seller text rendered as text, links are built
  from ids.
- **Click, then the cart's own routes.** A card never changes the cart. The button calls
  `POST cart/items`, `PUT` or `DELETE cart/items/:lineId` through the buyer relay with the session
  and CSRF token (the same functions as the product page), then `refreshCart()` of the store reads
  the cart again, so the header and the cart page agree. A refused change says so and offers
  "Try again"; nothing is retried by itself.
- **Quantity.** A card's quantity is clamped to the chosen unit's `addable` (add) or `maxQuantity`
  (set); "Most you can add: N" shows when it was lowered; a full cart shows no button.
- **Single-store.** `otherStore` null or old never means safe: the cart on screen is checked too,
  and when it holds another store (or an unknown one) the card asks first to save those lines for
  later or remove them, and adds nothing until the buyer chooses. Multi-store never asks.
- **Basket proposal.** Edit packs, swap to another product, remove a line, choose an unsure line
  (unsure lines start unselected), then "Add all": one add per line in order, a result per line,
  "Try the rest again" repeats only the lines not added. Needs the sell unit (`variantId`) on each
  line and option; a line without one cannot be added. Totals are price x packs of the card's own
  figures; delivery and minimum orders say "shown at checkout".
- **Not built here.** "Save for later" of a whole list: the cart's saved route takes only a cart
  line id, so a list cannot be saved without adding it first. The notice `cart-sign-in` is shown
  as text.

## Tables (Mojtaba's sign-off before merge)

Migration `20261116210000_assistant_basket_proposals_setting` adds `settings.basket_proposals`
(boolean, default false; older versions read as off; the table stays insert-only).

Migration `20261019224946_assistant_conversations`. `conversations`: one owner (account, or a
32-byte guest token hash), `turns` 0 to 30, `retention_days` 0 or 30 (365 for an account only),
index on (`market_id`, `retention_days`, `last_message_at`) for the purge (the admin customer
page's assistant section, customers phase 2b, reads one account's conversation count and dates
through the buyer list's partial (`market_id`, `account_id`, `last_message_at` DESC, `id` DESC)
index; it adds no index of its own); the application role updates only `turns` and
`last_message_at`. `messages`: PK (Market, conversation,
position 1 to 60), `text_cipher`, card refs (ids only, at most 40), cascade delete with the
conversation; the application role can neither UPDATE nor DELETE them. `spend_days`: PK (Market, day), counts
never negative, one auto-off record per day; never deleted by the application role.

One `spend_days` row per Market and day is updated by every turn: watch its lock waits; split
it into slots per day if they grow.
