# Buyer assistant settings (package 2)

Source: the buyer assistant plan, section 11 (owner decision 2026-10-19). Options 1 to 7 of the
plan are per-Market admin settings, not code; each default is the recommended option, and the
assistant ships **off**.

## Routes

| Route | Who | What |
|---|---|---|
| `GET /assistant/admin/settings` | admin, `assistant.settings.view` (viewer role, seed version 14) | Settings in force, `version` (0 = defaults), `apiKey: set / not-set`, the model configured per tier, options not available yet |
| `PUT /assistant/admin/settings` | admin, `assistant.settings.manage` (protected: Platform Administrator only) | `{ expectedVersion, settings }`, every field; stale version answers 409 `assistant.conflict`; same settings again change nothing |
| `GET /assistant/storefront?visitor=` | anyone, no session read | `{ enabled, guestsAllowed, replyLanguage, welcomeText }` only |

Each change is a new row of the insert-only `assistant.settings` (the application role has
SELECT and INSERT only) and one `assistant.settings.changed` audit row (versions and the switch).

## Fields and bounds

| Field | Values | Default |
|---|---|---|
| `enabled` | true / false | false |
| `audience`, `audiencePercent` | `internal` / `percent` (1 to 100) / `all` | `internal` |
| `scope` | `read-only` / `cart-suggestions` (not available yet) | `read-only` |
| `modelTier` | `fast` / `balanced` | `fast` |
| `users` | `guests-and-customers` / `customers-only` | `guests-and-customers` |
| `guestMessageLimit` | 5 to 60 per 10 minutes | 20 |
| `customerMessageLimit` | 5 to 120 per 10 minutes | 40 |
| `retention` | `none` / `30-days` / `12-months` (a guest is kept 30 days at most) | `30-days` |
| `replyLanguage` | `buyer` / `english` | `buyer` |
| `dailySpendCapUsdCents` | 100 to 100,000, at most the monthly cap | 1,000 |
| `monthlySpendCapUsdCents` | 100 to 2,000,000 | 20,000 |
| `supportHandoff` | `email-link` / `in-panel-form` (not available yet) | `email-link` |
| `welcomeText` | null, or 1 to 200 characters without control characters, bidi overrides, `<` or `>` | null (storefront default) |

The database CHECKs repeat these bounds.

## Not settings

The guardrails of plan section 5 (numbers only from server cards, certification only from
`evaluateClaim`, no mutating tool, never payment, refunds, orders, addresses, accounts, discount
codes or Cost) and the model configuration. Since package 4 that configuration is per Market,
as `MARKET=value` pairs: `ASSISTANT_MODEL_API_KEY` (a server secret; the admin read shows only
`set` / `not-set`), `ASSISTANT_MODEL_FAST` / `ASSISTANT_MODEL_BALANCED` (the provider model of
each tier) and `ASSISTANT_MODEL_PRICE_FAST` / `_BALANCED` (US dollars per million input/output
tokens, so the spend caps can be counted). Without the key, the model or the price for the chosen
tier, the storefront read answers `enabled: false` and no message reaches a model.

## Rollout

`all` shows it to every visitor; `percent` uses a stable bucket of the Market and the widget's
random `visitor` key (no key: left out); `internal` reaches no storefront visitor yet. How the
internal team tries it on the storefront (a preview route) is designed in
[conversation.md](conversation.md) and not built. The spend counters, the automatic pause at a cap
and the message limits that use these numbers are built in package 4 (conversation.md); the admin
read also answers `spend` (today, this month, conversations today, the last automatic pause).

## Admin panel

Settings > Smart assistant (`/settings/assistant`, package 3). A holder of the view key sees the
status card and a read-only summary; the Platform Administrator gets the form. The page shows
only whether the model key is set, and the model of each tier as the server reports it. Saving
sends `expectedVersion`; on a 409 the page reads the settings again and asks the admin to make
the change again. A tier whose model the server does not configure is offered disabled.
Spend today and this month (against the caps), conversations today and the last automatic
switch-off are now in the read's `spend` (package 4); wiring them into the status card is a
follow-up of the admin tab. The cost estimate per conversation is not computed by the server.
