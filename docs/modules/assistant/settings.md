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
codes or Cost) and the model API key. The key is `ASSISTANT_MODEL_API_KEY`, a server secret; the
provider model of each tier is `ASSISTANT_MODEL_FAST` / `ASSISTANT_MODEL_BALANCED`. Without the
key, or without a model for the chosen tier, the storefront read answers `enabled: false`.

## Rollout

`all` shows it to every visitor; `percent` uses a stable bucket of the Market and the widget's
random `visitor` key (no key: left out); `internal` reaches no storefront visitor yet. How the
internal team tries it on the storefront (a preview route) is decided with the chat endpoint
(package 4). The spend counters, the automatic switch-off at a cap and the rate limits that use
these numbers are built in package 4.

## Admin panel

Settings > Smart assistant (`/settings/assistant`, package 3). A holder of the view key sees the
status card and a read-only summary; the Platform Administrator gets the form. The page shows
only whether the model key is set, and the model of each tier as the server reports it. Saving
sends `expectedVersion`; on a 409 the page reads the settings again and asks the admin to make
the change again. Spend today and this month show "measured once buyers can chat" until the
package 4 counters exist.
