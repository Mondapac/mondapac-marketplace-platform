# Buyer assistant settings (package 2)

Source: the buyer assistant plan, section 11 (owner decision 2026-10-19). Options 1 to 7 of the
plan are per-Market admin settings, not code; each default is the recommended option, and the
assistant ships **off**.

## Routes

| Route                                                                     | Who                                                                         | What                                                                                                                             |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `GET /assistant/admin/settings`                                           | admin, `assistant.settings.view` (viewer role, seed version 14)             | Settings in force, `version` (0 = defaults), `apiKey: set / not-set`, options not available yet                                  |
| `PUT /assistant/admin/settings`                                           | admin, `assistant.settings.manage` (protected: Platform Administrator only) | `{ expectedVersion, settings }`, every field and no other (`modelTier` is refused since AI Gateway G4d1, `dailySpendCapUsdCents` and `monthlySpendCapUsdCents` since G4d2); stale version answers 409 `assistant.conflict`; same settings again change nothing |
| `GET /assistant/storefront?visitor=&lang=` (header `x-assistant-preview`) | anyone, no session read                                                     | `{ enabled, guestsAllowed, replyLanguage, welcomeText, retentionDays, quickPrompts, preview }` only                              |
| `POST /assistant/admin/preview-token`                                     | admin session, CSRF, `assistant.settings.manage`                            | `{ token, expiresAt }` (conversation.md)                                                                                         |

Each change is a new row of the insert-only `assistant.settings` (the application role has
SELECT and INSERT only) and one `assistant.settings.changed` audit row (versions and the switch).

## Fields and bounds

| Field                         | Values                                                                              | Default                   |
| ----------------------------- | ----------------------------------------------------------------------------------- | ------------------------- |
| `enabled`                     | true / false                                                                        | false                     |
| `audience`, `audiencePercent` | `internal` / `percent` (1 to 100) / `all`                                           | `internal`                |
| `scope`                       | `read-only` / `cart-suggestions` (cart cards, stage 1 S1-B1)                        | `read-only`               |
| `users`                       | `guests-and-customers` / `customers-only`                                           | `guests-and-customers`    |
| `guestMessageLimit`           | 5 to 60 per 10 minutes                                                              | 20                        |
| `customerMessageLimit`        | 5 to 120 per 10 minutes                                                             | 40                        |
| `retention`                   | `none` / `30-days` / `12-months` (a guest is kept 30 days at most)                  | `30-days`                 |
| `replyLanguage`               | `buyer` / `english`                                                                 | `buyer`                   |
| `supportHandoff`              | `email-link` / `in-panel-form` (not available yet)                                  | `email-link`              |
| `basketProposals`             | true / false: the assistant may plan a typed or pasted list into a basket card      | false                     |
| `welcomeText`                 | null, or 1 to 200 characters without control characters, bidi overrides, `<` or `>` | null (storefront default) |

The database CHECKs repeat these bounds.

`basketProposals` is required like every field: a PUT without it answers 400 (a breaking change for
any client but the admin panel, which carries it; its switch comes with S1-F2).

## Spend caps (AI Gateway G4d2)

The chat's daily and monthly spend caps are no longer assistant settings: they are the AI Gateway
caps `ai-cap-buyer-chat-day` and `ai-cap-buyer-chat-month` (US micro-dollars or `none`, defaults
10 000 000 and 200 000 000, the former US$10 and US$200; Settings › AI Gateway, Limits), checked
by the gateway when it reserves each call (docs/design/domain/platform-ai.md section 7). A PUT
that still sends `dailySpendCapUsdCents` or `monthlySpendCapUsdCents` answers 400 `unknown-field`.
Migration `20261126030000_ai_gateway_buyer_chat_caps` copied each Market's latest values (cents x
10 000) where they differed from the defaults. The two columns stay until a migration drops them
(FE-20261126-ai-gateway-drop-assistant-cap-columns): a new row carries the previous row's values
forward (the former defaults on a Market's first row) and nothing reads them. The audit row of a
change no longer names the caps (the fields stay optional in the catalogue for the older rows);
a cap change is audited by settings as `settings.ai-cap.changed`.

## Switching on needs a two-step code (AI Gateway G4d3)

`PUT /assistant/admin/settings` that moves `enabled` from false to true spends the admin's fresh
two-step proof for `assistant.settings.resume` (an admin step-up action assistant registers,
locked on) in the save's unit, after the version check: without it the answer is 403
`second-factor.required` with `details.actionKey` and nothing is saved. Switching off and every
other change need none. The admin panel asks for the code in place and repeats the save. On top of
this switch the gateway has its own per-Market switch of the buyer chat
(`ai-capability-assistant-buyer-chat`, docs/design/domain/platform-ai.md, Built in G4d3).

## Not settings

The guardrails of plan section 5 (numbers only from server cards, certification only from
`evaluateClaim`, no mutating tool, never payment, refunds, orders, addresses, accounts, discount
codes or Cost) and the model configuration. Since package 4 that configuration is per Market,
as `MARKET=value` pairs: `ASSISTANT_MODEL_API_KEY` (a server secret; the admin read shows only
`set` / `not-set`). Which models the chat uses is the Market's list for the `chat` task type in
the AI Gateway settings (`ai-models-chat`, AI Gateway G4b). The model tier (`modelTier`, and the
variables `ASSISTANT_MODEL_FAST` / `ASSISTANT_MODEL_BALANCED`) went in AI Gateway G4d1: a PUT that
still sends `modelTier` answers 400 `unknown-field`, and a variable still set is ignored and named
in one `ai.config.removed` warning at boot. The `model_tier` column stays until a migration drops
it (FE-20261125-ai-gateway-drop-assistant-model-tier); a new row writes `fast` there and nothing
reads it. Since AI Gateway G3 prices come from the route catalogue (the `ASSISTANT_MODEL_PRICE_*`
variables are ignored), and a model is used only through a usable route (ADR-0052: verified row,
region of the Market, key, evaluation pass; docs/design/domain/platform-ai.md section 6). Without
a chat list, or without a usable route of it, the storefront read answers `enabled: false` and no
message reaches a model.

## Rollout

`all` shows it to every visitor; `percent` uses a stable bucket of the Market and the widget's
random `visitor` key (no key: left out); `internal` reaches only a browser with a valid internal
preview token ([conversation.md](conversation.md), "Preview for internal"). The spend counters,
the automatic pause at a cap and the message limits that use these numbers are built in package 4 (conversation.md); the admin
read also answers `spend` (today, this month, conversations today, the last automatic pause).

## Admin panel

Settings > Smart assistant (`/settings/assistant`, package 3). A holder of the view key sees the
status card and a read-only summary; the Platform Administrator gets the form. The page shows
only whether the model key is set (no model tier picker since AI Gateway G4d1). Saving sends
`expectedVersion`; on a 409 the page reads the settings again and asks the admin to make the
change again.
Spend today and this month, conversations today and the last automatic switch-off are in the
read's `spend` (package 4) and on the status card; since AI Gateway G4d2 the page has no cap
inputs and the card shows the spend without a cap (the caps are on the AI Gateway page, G5). The cost estimate per conversation is not computed by the server.

## Storefront extras (stage 0, B4)

- `preview` is true when the browser sent a valid internal preview token (conversation.md,
  "Preview for internal"); `internal` then reaches that browser.
- `retentionDays` is `{ customer, guest }`: how many days a new conversation is kept (0: not
  kept; a guest 30 at most), so the widget can say so before the first message. The read takes no
  session, so it gives both. `null` while the assistant is off for the visitor.
- `quickPrompts` are fixed button texts from `config/locales/<locale>/assistant.json`
  (`assistant.quick-prompt.1` to `.6`, read in order up to the first gap), never model output and
  never a setting. `lang` (a BCP 47 tag) picks a locale the Market supports, by exact tag or by
  language, when it has prompts; anything else gets the Market's default locale. The API refuses
  to start when a hosted Market's default locale has no prompt or one is over 80 characters.
  Empty while off.
