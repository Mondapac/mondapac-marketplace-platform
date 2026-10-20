# legal: build notes (speed mode)

The records the platform keeps for the law. `legal` owns the consent record (ADR-0020 decision
5). The owner approved the personalization plan on 2026-10-18 (decision 3: express opt-in,
one-click unsubscribe, sender identified, Spam Act 2003); under speed mode there is no separate
G1/G2 brief. Package 1b of that plan includes customers package 4 (consent record).

## Package 1b: marketing email consent and one-click unsubscribe

- Tables `legal.marketing_consents` (the current consent per Market, account and channel; one
  row, changed in place) and `legal.marketing_consent_changes` (every change with its source and
  time; insert-only, the proof of consent). Channel `email` only; sources `sign-up`, `account`,
  `unsubscribe-link` (CHECKs). No foreign key to `identity`.
- Express opt-in: no row, or `granted` false, means no marketing. Only a real change is recorded.
- Routes `customers/me/email-preferences` (customer sessions only, CSRF on the write,
  `no-store`): GET, and PUT `{ marketing, source? }` with `source` `sign-up` (the storefront sends
  the unticked sign-up box here right after sign-up, so `identity` stays free of `legal`) or
  `account` (default). Use cases `legal.view-email-preferences` and `legal.set-email-preferences`
  are `own-resources`; no permission key.
- Facade `LEGAL_FACADE`: `marketingEmailConsentOf` (rule `system`) and
  `withdrawMarketingEmailByLink` (rule `anonymous`, withdraw only; notifications calls it after it
  verified the link's signature). Not over HTTP itself.
- notifications: `sendMarketingMail` is the one path for every marketing mail. It asks `legal`
  right before the send, skips a customer without consent, and adds a footer with the sender
  name, the support address and the unsubscribe page link, plus `List-Unsubscribe` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (RFC 8058). A Market without
  `notifications.unsubscribePage` and `notifications.oneClickUnsubscribeUrl`, or without a support
  address, sends no marketing mail. Its first sender is package 1c (abandoned cart,
  docs/modules/notifications/cart-reminders.md).
- Route `notifications/unsubscribe/:market?token=` (public, Market from the path because a mail
  client cannot send `x-market-id`): GET checks the link and changes nothing (link scanners), POST
  unsubscribes with any body. The token is `u1.<account id>.<HMAC-SHA-256>` under a key derived
  from the notifications stack secret, bound to the Market, with no expiry (it can only
  withdraw). The query string is never logged.
- No email address, token or consent value reaches a log, an event or an error.

## Before the first real marketing send

- The deployed notifications stack secret (the local stand-in refuses production; K1, Kazem).
- The footer's sender identification: add the business name, ABN and postal address once the
  owner gives them; today it names the Market's mail sender and support address.
- Account deletion (customers package 5) deletes the account's consent rows with the account; the
  history may be kept as the proof of consent for as long as the law asks (decide then).

## Review follow-ups (PR #407: Hassan GO, Mojtaba approved)

- Before package 1c (first sender): the footer's business name, ABN and postal address (Spam Act
  s17); the real mail transport carries the two `List-Unsubscribe` headers under DKIM; the
  storefront unsubscribe page sends `Referrer-Policy: no-referrer` and posts same-origin through
  its proxy (add an HTTP test with the storefront's `Origin` and `Sec-Fetch-Site` then).
- `source: sign-up` is what the client says. Later: accept it only shortly after sign-up (or let
  identity record it), and store the version of the consent wording shown with each change.
- Customers package 5 (account deletion): a migration granting DELETE on `marketing_consents` and a
  retention decision for `marketing_consent_changes` (keep as proof for a set period, or
  pseudonymise). Physical model doc `docs/design/data/legal.md` (Mojtaba).
- Consider a boundary rule so only notifications calls `withdrawMarketingEmailByLink`.
