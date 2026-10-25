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
  `wallet.settings.change` (wallet `setStatus`). Every key is also in `STEP_UP_ACTION_KEYS`
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
  and action key; never the code).
- **Storage.** The existing `identity.step_up_proofs` table (keyed by Market, session and action;
  rows go with their session) holds admin proofs as well: no migration.
- **Guard.** `@RequiresStepUp('<key>')` covers admin routes unchanged; the guard asks
  `RequireStepUp`, which picks the rule by the action's audience. The guarded use case should ask
  `IdentityFacade.requireStepUp` again before its change (ADR-0018), as wallet `setStatus` does.
