# wallet: customer wallet, package 1 (ledger core)

Speed mode (CLAUDE.md): no G1/G2 or design document. This note only points to the owner's
decisions and records what the code does. The source of the decisions is the hand-off
`customer-wallet-package1.md` in the Project (outside the repo) and the Persian design
`wallet-design-fa.html` (sections 4, 5, 6). Owner approved the build on 2026-10-25.

## Owner decisions (binding)

- Option A only: store credit issued by the platform. No card top-up, no bank withdrawal, no
  P2P, no Stripe call in this module. A schema test refuses card or bank vocabulary in any column.
- A refund goes to the original source by default; credit is optional (package 4, not now).
- Promo credit expires after 12 months; refund credit never expires. Both are Market config
  (`wallet.promoExpiryMonths`); refund lots have no expiry.
- Promo cost is always borne by the platform (`promo_expense`); the seller's commission and
  ledger are unchanged. Cashback is promo credit (later package).
- Wallet balance cap per customer: 500.00 in the Market currency, from Market config
  `wallet.balanceCapMinor` (AU 50000), never hardcoded. A grant over the cap is refused
  (`wallet.cap-exceeded`); held credit counts toward the cap.
- Admin caps (package 2): 50.00 per issue and 500.00 per admin per day without a second approval.
  Only the config keys exist now (`wallet.adminIssueCapMinor`, `wallet.adminDailyCapMinor`).

## The switch is runtime, not config (scope change 2026-10-25)

There is no `wallet.enabled` in `config/markets/*.json`. The state of the wallet in a Market is
the row of `wallet.market_settings` (no row = `off`), set by an admin:

| state | grants and new holds | capture | release and hold expiry | promo expiry job | customer reads |
|---|---|---|---|---|---|
| `off` (default; never launched) | `wallet.disabled` | `wallet.disabled` | `wallet.disabled` | does not run | `wallet.disabled` |
| `active` | allowed | allowed | allowed | runs | allowed |
| `paused` (wind-down) | `wallet.paused` | allowed | allowed | runs | allowed |
| `frozen` (emergency) | `wallet.frozen` | `wallet.frozen` | allowed | runs | allowed |

Hard rules, each with tests:

1. No state change deletes or zeroes a balance or a lot. The switch only decides which operations
   may start; no wallet table has a DELETE grant and a trigger refuses DELETE and TRUNCATE.
2. A hold already placed is always settled: release and expiry work in every state but `off`;
   capture works in `active` and `paused`.
3. The worker job `wallet.expire-credit` (holds past `expires_at`, promo lots past `expires_at`)
   runs in every state except `off`.
4. Going back to `off` is refused once any journal exists for the Market
   (`wallet.cannot-turn-off-with-history`, also enforced by a trigger); use `paused`.

Admin endpoints (no UI in this package; the toggle page comes in package 2):

- `GET /wallet/admin/settings` needs `wallet.settings.view`.
- `PUT /wallet/admin/settings` body `{status, reasonCode}`, needs `wallet.settings.manage`
  (protected key). `reasonCode` is required for `paused` and `frozen` and refused for `off` and
  `active`; it is one of a closed list (`wind-down`, `security-incident`, `fraud-suspected`,
  `legal-hold`, `maintenance`, `owner-decision`) because audit fields hold no free text. The call
  is refused in an acting-as session, writes one audit row with before and after, and is
  idempotent (the same state again writes nothing). Both keys are protected (Platform
  Administrator only), so no default role changes in this package.

Known gap, needs an owner or identity decision: the hand-off asks for a step-up (recent
confirmation) on the PUT, "same as payout account flows". Identity has no such primitive for
admins today: `confirmSecondFactor` and `requireStepUp` serve seller-side holders only (an admin
session passes `requireStepUp`, and registering a wallet action would list it on the sellers' own
two-step policy screen). So the PUT is guarded by the protected key, the CSRF and panel-origin
checks, the acting-as refusal and the audit row, and has no extra confirmation. An admin step-up
belongs to identity and is a separate PR; wallet adds the call in `settings-flow.ts` when it exists.

## What exists in package 1

- Schema `wallet`: `accounts`, `journals` (insert-only, unique `(market_id, idempotency_key)`),
  `postings` (insert-only, deferred trigger: legs of a journal sum to zero, at least two), `lots`
  (only `remaining_minor` changes; only decreases, except a released or expired hold restores it),
  `holds` and `hold_lots` (release restores the exact lots), `balances` (CHECK >= 0, locked
  with a no-change update before every change), `market_settings`.
- Facade `WALLET_FACADE` for system callers only (no ordering wiring yet): `grantCredit`,
  `placeHold`, `captureHold`, `releaseHold`, `balanceOf`.
- Customer HTTP: `GET /wallet/me` and `GET /wallet/me/history` (own resources; reads are allowed
  in an acting-as session; nothing here can be spent over HTTP).
- Spend order: soonest-expiring lot first, promo before refund at an equal expiry; an expired lot
  is never spent. Money is integer minor units. Time comes from the injected Clock; promo expiry
  is calendar months in the Market's time zone.
- Idempotency: the same key with the same request returns the first result; the same key with
  another request answers `idempotency.key-reused`.

## Out of scope

UI, admin issuance, checkout wiring, refunds, gift codes, cashback, notifications, the `reverse`
journal use case (the kind exists in the CHECK for package 2).
