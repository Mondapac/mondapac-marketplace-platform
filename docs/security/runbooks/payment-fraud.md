# Runbook: payment fraud

Part of [incident-response.md](../incident-response.md).

## Trigger and signals

- Stripe Radar `radar.early_fraud_warning` or `charge.dispute.created` (these events are not listened to yet; listening is planned in SOC package 4. Fallback: check the Stripe dashboard for fraud warnings and disputes daily).
- A burst of refunds, or refunds the actor cannot explain.
- Wallet top-ups followed by quick spending (card testing, stolen cards).
- Payout-account (seller bank details) changed on several sellers within one hour.
- Stripe Connect account changes the seller did not make.

## Severity

S2 for a fraud warning or suspect orders. S1 for payout accounts of several sellers changed within one hour, or fraud running at scale. S1 incident commander: Ali. Business decision: john.

## Automatic actions

| Action | Status |
| --- | --- |
| Hold suspicious orders, Radar rules | Radar rules are configured at Stripe (provider side). In-app hold is planned in SOC package 3 and 4 |
| Lock account, end sessions, block IP (T5) | Planned in SOC package 3 |

## Human steps

1. Acknowledge. Identify what is happening: stolen cards, refund abuse, wallet abuse or payout-account change.
2. Stolen cards or card testing: in the Stripe dashboard, review the payments and block the cards or customers through Radar rules; do not fulfil flagged orders (hold at the seller order). Disable the customer account (`POST /identity/admin/customers/:accountId/disable`).
3. Refund abuse: refunds are an admin permission `ordering.order.refund` and are behind the Market switch `tax.refundCredit.enabled` in `config/markets/<MARKET>.json` (off by default; config as code, changed by pull request and redeploy). If an admin account is behind it, run [admin-account-takeover.md](admin-account-takeover.md).
4. Wallet abuse: set the wallet to paused or frozen with `PUT /wallet/admin/settings` (needs the wallet admin permission). Balances are never deleted or zeroed by the switch. `off` is refused once a Market has history.
5. Payout-account change: in the Stripe dashboard review the Connect accounts of the affected sellers; check what changed with the admin connected-accounts view (`GET /payments/admin/connected-accounts` and `/:sellerId`); contact the sellers by their known channel (not the one in the change); pause payouts at Stripe if unsure; disable the seller accounts used for the change.
6. Decide on stopping all payments. Only Ali (CTO) or john may order it. The in-app payment kill switch, planned in SOC package 3, will be behind OTP. The fallback below has no OTP, so Ali or john does it themselves or gives the order in writing in the incident log first. Fallback today: at Stripe, disable or roll the API key (this stops checkout and refunds; coordinate, it also fails legitimate orders) or take the checkout offline at the host. Record who ordered it, why, and the time.
7. Contact Stripe support for large events; follow their dispute process. Keep order, delivery and communication evidence per dispute.
8. If personal data was exposed, start [customer-data-breach.md](customer-data-breach.md).

Every emergency action writes an audit event with actor, reason and target (app switches are audited; provider steps go in the incident log with the same fields).

## Verification

1. Fraudulent orders held or refunded as decided; no new suspicious payments for 24 hours.
2. Payout accounts match the sellers' confirmed details.
3. Dispute list reviewed; evidence submitted before each deadline.
4. Switches that were turned off are turned on again only by the person who ordered them off, with a note.

## Close-out

Postmortem. Actions: rules for refund bursts and payout-account changes (package 1 and 2), Stripe fraud events into security events (package 4), OTP on payout-account changes.
