# identity: build notes (speed mode)

Short notes on identity behaviour added under speed mode (no new G1/G2 documents). The approved
design stays in `brief.md` and `docs/design/`; this file records what changed since.

## Admin step-up (issue #491, 2026-10-25)

A platform admin gives a fresh second-factor proof before a registered sensitive admin action.
It follows the seller step-up (seller OTP policy, 2026-10-16) and reuses its parts.

- **Catalogue.** A step-up action declares `audience: 'admin'` (`StepUpActionDeclaration` in
  `platform/authz/step-up-registry.ts`; omitted means a seller action). Boot refuses an admin
  action that is not `locked` (and so required): there is no per-shop or per-admin rule, the
  platform floor is always "required". Admin actions are never listed on, set through, or proven
  on the seller step-up routes (`step-up.action-unknown` there). First admin action:
  `wallet.settings.change` (wallet `setStatus`); wallet package 2a adds `wallet.credit.issue` and
  `wallet.credit.approve` (admin credit issuance and its maker-checker decision). Every key is also in `STEP_UP_ACTION_KEYS`
  (`domain/step-up.ts`), the closed list of the audit rows.
- **Rule.** `RequireStepUp` (the guard's `StepUpCheck` and `IdentityFacade.requireStepUp`): for
  an admin action, an admin session needs a proof of this session for this action from the last
  `STEP_UP_PROOF_MINUTES` (5), made with the account's current active factor
  (`proofCovers` in `domain/step-up.ts`); without one `second-factor.required` with the action
  key, without an active factor `second-factor.enrolment-required`. Any other caller of an admin
  action, and an acting-as session for any action, is `access.denied`; an unregistered key stays
  `access.unavailable`. Seller actions behave as before.
- **Verify.** `POST identity/admin/step-up/verify {actionKey, code}` (`VerifyAdminStepUp`): admin
  session cookie, CSRF token and admin panel origin, rate limit `anonymous-identity`, JSON only
  with a closed body. The code (app or recovery code) is checked and spent by the same
  `SignedInFactorStep` as every signed-in admin code, so it counts on the account's
  `second-factor.account` counter, the one admin sign-in uses: wrong step-up codes lock the factor
  for sign-in too (`second-factor.locked`, 429). On success the proof row is written in the same
  unit and `identity.admin-step-up.verified` is audited (target: the account; after: session id
  and action key; never the code). A wrong code is audited `identity.admin-step-up.refused`
  (`cause` `invalid`, or `locked` for the code that reached the limit) in the unit that counts it;
  the lock-out bounds these rows. A refused guarded request (`second-factor.required`) writes no
  audit row: it is a read-only check with no bound but the HTTP rate limit, and the catalogue's
  one refusal pattern (`pricing.offer-write.refused`) needs a per-actor throttle table to stay
  bounded; the log line records it.
- **Single use.** An admin proof serves one change (Hassan L1, L2): the guarded use case spends
  it through the platform port `STEP_UP_CONSUMER` (`StepUpProofConsumer`, implemented by
  `AdminStepUpConsumer`) inside its own read-write unit, right before the change. The consumer
  opens no unit and passes no gate (like `AuditWriter`), checks the actor, the action, the active
  factor and the proof again, deletes the proof row and answers when it was verified; a
  refusal makes the caller's unit commit nothing. Two units with one proof are serialised on its
  row and exactly one gets it. Seller proofs keep their five-minute window.
- **Storage.** The existing `identity.step_up_proofs` table (keyed by Market, session and action;
  rows go with their session) holds admin proofs as well: no migration.
- **Guard.** `@RequiresStepUp('<key>')` covers admin routes unchanged; the guard asks
  `RequireStepUp` (read-only), which picks the rule by the action's audience. The guarded use
  case spends the proof itself before its change (ADR-0018), as wallet `setStatus` does.
- **Acting-as.** Refused by RequireStepUp, VerifyAdminStepUp, the consumer and wallet
  `setStatus`. Over HTTP today an actor carrying the marker is not one identity minted, so the
  actor guard answers `401 session.invalid` before any of them (tested).

## `customerAccountOf` (wallet review S1, 2026-10-26)

`IdentityFacade.customerAccountOf(context, accountId)` (use case `identity.customer-account-of`):
whether an id names an active customer account of `context.market`, for an admin flow that writes
to a customer's records (the wallet's admin credit). It answers `{accountId}` or `null`, ids only,
never a name or an address. An unknown or malformed id, a seller or admin account, another
Market's account and a disabled account are `null`, alike. Rule `own-resources`, denied while the
seller is not approved; the use case answers only a platform admin that is not acting as a seller
(otherwise `access.denied`); the calling use case has passed its own permission gate. One
read-only unit reading the status only (`AccountRepository.customerStatus`: no credential, so a
customer without a password is answered, and no address); a failed read is `access.unavailable`, so the caller fails closed. Not exposed
over HTTP.
