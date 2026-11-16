# Buyer assistant conversation (package 4)

Source: the buyer assistant plan (sections 4 to 8 and 11), ADR-0019, the settings of
[settings.md](settings.md). Backend only; the storefront widget is package 5.

## Route

`POST /assistant/conversations/:id/messages`, body `{ text, visitor? }` (closed: any other field
is 400). `id` is a canonical UUID v7 the widget generates for a new conversation and repeats for
the next messages; the conversation is the subject of its own encryption key.

| Caller | Use case (rule) | Who owns the conversation |
|---|---|---|
| Signed-in customer (session cookie and CSRF token) | `assistant.send-message` (`own-resources`) | the account of the session |
| Anyone else | `assistant.send-guest-message` (`anonymous`) | the assistant's own guest cookie `__Host-assistant-guest-<Market>` (30 days, HttpOnly, Secure, SameSite=Lax; the store keeps only the SHA-256 of the token) |

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
  builds the link for), `support` (the public support email).
- Notices: `see-cards` (a price, stock, delivery or minimum-order sentence was dropped),
  `see-certification` (a certification sentence was dropped), `tool-failed`, `unavailable` (the
  model failed or timed out: a support card comes with it), `refused`, `cart-actions-not-ready`,
  `support-form-not-ready`.

## What the model gets and does

- One model entry point (`platform/ai`, `ModelGateway`); only the files on the boundary rule's
  allow-list import it, and no provider SDK is imported anywhere (plain HTTPS to the Messages
  API). Provider failures are logged with the Market, tier and failure kind only.
- Instructions version `buyer-assistant-2`; the last 12 messages; read-only tools that call the
  `search`, `catalog` and `notifications` facades with the buyer's own `CallContext`:
  `search_products`, `list_bestsellers`, `list_specials`, `list_categories`, `show_page`,
  `support_contact`. `suggest_cart_change` and `open_support_form` answer "not ready yet".
- The model sees names and short texts only, never a price or stock figure. Its reply is checked
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

## Limits, spend and storage

- Message limits per 10 minutes from the settings: per account, or per client origin plus per
  guest token, counted in `platform.rate_limit_counters` (class `assistant-message`, keyed HMAC).
- Spend: each call is priced from the Market's configured token price and counted in
  `assistant.spend_days` (Market calendar day). At the daily or monthly cap the Market answers
  `assistant.paused` until the next day or month; the first pause of a day is recorded (admin
  read `spend.lastAutoOff`) and logged as a warning. A bell notice to admins waits for
  notifications package 3.
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

Buyer text is the masked text that was stored, decrypted per conversation only to build these
rows; no account, guest or conversation id leaves the module. Only conversations that keep text
appear (a conversation with retention `none` leaves its spend day only). The route is
`no-store` and the text is never logged.

Each assistant message now stores `notices` (the fixed notice codes of the reply, at most 8) and
`empty_search`, written with the message, to feed the unanswered rows.

### Tables (Mojtaba's sign-off before merge)

Migration `20261116010000_assistant_feedback`. `feedback`: PK (Market, conversation, position),
FK to `messages` on the same three columns with `ON DELETE CASCADE`; CHECKs: rating `up|down`,
reason only with `down` and one of three values, `updated_at >= created_at`; the application role
can SELECT and INSERT, and UPDATE only `rating`, `reason` and `updated_at`; no DELETE (the cascade
needs none). `messages` gains `notices VARCHAR(32)[]` and `empty_search`; two partial indexes
on (`market_id`, `created_at`) for assistant rows: all of them (the range reads) and the flagged
ones only (the unanswered read).

## Preview for `internal` (designed, not built)

`internal` reaches no storefront visitor. Proposed: an admin with `assistant.settings.manage`
opens the storefront with a short-lived signed preview token issued by an admin route; the
storefront sends it with each message and the use case treats that visitor as in the rollout.
`?visitor=` stays a rollout aid, never a control.

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
