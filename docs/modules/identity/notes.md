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
  `wallet.settings.change` (wallet `setStatus`); then `customers.account-deletion-settings.change`
  (customers `setAccountDeletionSettings`, package 5a); wallet package 2a adds `wallet.credit.issue`
  and `wallet.credit.approve` (admin credit issuance and its maker-checker decision). Every key is also in `STEP_UP_ACTION_KEYS`
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

## Invitation acceptance lock (2026-11-07)

The closing unit of `AcceptSellerInvitation` (Seller Owner and Staff) first takes the invitation's
advisory lock `identity.lock-invitation` (lock class 1706, one lock per Market, tenant and
invitation), then runs at SERIALIZABLE as before (C11). Two acceptances of one invitation used to
read it pending side by side and sometimes ran out of retry attempts with 40001 under the parallel
database run (PR #769); now the second waits for the first's commit and refuses
(`invitation.rejected`). Its snapshot may still predate that commit (the lock is taken inside the
snapshot), so it can still read the invitation pending; its insert of the address then ends that
attempt (40001 under SERIALIZABLE) and the retry reads the invitation accepted: at most two
attempts, never a second account. Two different invitations of one seller stay covered by
SERIALIZABLE (HF5 (a)), not by this lock.

## People changes in Admin Inbox › System requests (2026-11-15)

Area `people` (on by default, high risk). Revertible changes only; creating, deleting, inviting
and revoking were out (owner decision of 15 Nov 2026; creating, inviting and the role delete are
hooked since 18 Nov, see the next section).

- **Hooked writes.** `EditPlatformRole` (kind `identity.platform-role`, subject = role id, values
  `{name, permissionKeys}`), `AssignAdminRole` (`identity.admin-roles`, subject = admin account id,
  values `{roleIds}`, one id in Phase 2) and `EnableAdminAccount` (`identity.admin-status`, values
  `{status}`) open their review in their own serializable unit after the write, always at risk
  `high`, with the body's optional `note`. Where people is reviewed, a missing note is
  `validation.failed` on `note` and the unit keeps nothing. The seller role editor is not hooked.
- **A disable opens nothing.** It is a stop (like a wallet freeze): it never waits for a note and
  its `request` is always null.
- **Reverts never widen access** (Hassan's rule of #912 and #913). A role edit reverts only when the
  keys before are a subset of the keys now (removing keys or renaming); an admin's role reverts
  only to a role whose effective keys are a subset of the current role's, and never to the
  Platform Administrator role from another; an enabling reverts (the admin is disabled again,
  every session revoked and every open challenge voided through the same write as a disable,
  under the credential lock), and restoring `active` never runs. Each refusal is `not-permitted`
  (403 `system-requests.revert-not-permitted`, the request stays open).
- **Last holder.** A narrowing revert keeps `LastHolderPolicy`: it never leaves the Market without
  an active, verified Platform Administrator (that role confers every key, the role-management and
  review keys included); a revert that would is `not-permitted`. Editing a custom role cannot touch
  the system role.
- **Sessions.** A role revert keeps sessions (permissions are read on every request, R4); a status
  revert revokes them, as a disable does.
- **The decider.** The revert runs with the reviewer's (or withdrawing author's) context in
  system-requests' decision unit, after its step-up is spent. The decider's own role-editing keys
  are not asked for: the area's review key is the authority.
- **No decision about oneself** (Hassan M1). Each reverter answers `isInterested`: the admin is the
  subject of an `identity.admin-roles` or `identity.admin-status` request, or holds the role of an
  `identity.platform-role` request now (read in the decision unit). System requests then refuses
  approve and reject with `system-requests.own-subject`; withdraw by the author is unaffected.
- **Retired keys.** A key in a role edit's value before that the catalogue no longer declares is
  dropped before the subset check (it confers nothing), so the revert still runs.
- **Audit.** `identity.role.reverted` (removed keys, renamed, `requestId`),
  `identity.account-role.reverted` and `identity.account-status.reverted`, each with `requestId`.
- **Panel hints.** `GET identity/admin/team` and `GET identity/admin/roles` carry
  `review: {reviewed, risk}` (read outside any unit).
- **Wiring.** identity imports no module (ADR-0018 decision 4), so it reaches the recorder and the
  reverter registry through the port `platform/change-review/change-review.ts`, which
  system-requests implements and re-exports from its contracts.

## Creations and the role delete in System requests (2026-11-18)

Owner decision of 18 Nov 2026 ("mixed"): a create goes live at once and is reviewed after; a
delete waits for another admin's approval. Area `people`, always high risk.

- **Create a custom platform role** (`CreatePlatformRole`, kind `identity.platform-role-creation`,
  subject = role id, values `{exists: false}` before and `{exists: true, name, permissionKeys}`
  after): the review opens in the creation's serializable unit with the body's `note`; a missing
  note keeps nothing. A reject or withdraw deletes the role only while it confers exactly the keys
  it was created with (a rename alone does not matter) and nobody holds it: held is
  `not-permitted`, other keys `changed-since`, already deleted `gone`. Audited
  `identity.role.creation-reverted` (removed keys, `requestId`), event `role-deleted.v1`.
- **Invite an admin** (`InviteAdmin`, kind `identity.admin-invitation`, subject = invitation id,
  values `{exists: false}` / `{exists: true, roleId}`; never the address): the review opens in the
  invitation's unit (the mail counters roll back with a refused note). A reject or withdraw, under
  the acceptance's invitation lock: still pending (expired or not) it is revoked
  (`identity.invitation.reverted`, `requestId`); accepted, the account it created is disabled,
  every session revoked and every challenge voided, as the enabling's revert does
  (`identity.account-status.reverted`), never the last Platform Administrator who can sign in;
  revoked meanwhile or an account no longer active is `changed-since`; purged (only a pending one
  past its expiry, or a revoked one) is `gone`. The purge keeps accepted admin invitations (Hassan
  M1 on PR #1058): the row is the only link from the request to the account it created, it holds
  ids only (the address is cleared at acceptance), and there is one per admin ever invited.
  Accepted seller-side invitations are still purged 30 days after acceptance. The invitee (the account that accepted it, or the account of the invited
  address) may not decide it (`isInterested`).
- **Delete a custom platform role** (`DeletePlatformRole`, kind `identity.platform-role-deletion`,
  approval mode): every check of the delete runs first (reach, version, grant, `role.in-use`),
  then the unit files the proposal with `{name, permissionKeys, version}` and the `note` and writes
  nothing else: `role.delete-requested` with `request`, HTTP 202. One waits per role (409
  `system-requests.already-pending`, `details.pendingNumber`). The applier is registered with
  `identity.platform-role.delete` (system-requests checks the approver holds it); its `check`
  (read-only unit) and its `apply` (in the approval's serializable unit) re-read the approver
  (active, verified, the key, can edit the role, R1 and R11), and `apply` deletes only a role still
  at the asked name, keys and version (`changed-since`) and held by nobody (`not-permitted`),
  audited `identity.role.deletion-approved` as the approver with `requestId`.
- **Invite an admin with a sensitive role** (owner decision of 18 Nov 2026, 14:06Z; kind
  `identity.admin-invitation-sensitive`, approval mode). Sensitive is the existing R3/R11
  predicate, `GrantPolicy.needsSystemRole`: the role is the system role (the Platform
  Administrator) or confers a protected key, i.e. giving it needs the system role (the same rule
  `canGrant` applies; `roleIsSensitive` in `roles/granting.ts`, `sensitive` on the role catalogue).
  Every check of the invite runs first (actor, reach, grant, `account.exists`, the mail counters,
  one pending invitation per address); then the unit files the proposal with values `{roleId,
  roleVersion}` / `{action: 'invite', roleId}` and the `note`, and stores the invitation **held**
  (`invitations.held_for_approval`): pending, with the address as every pending invitation keeps
  it, but without `identity.invitation-issued.v1`, so the mail handler never sends it and no token
  exists. Audited `identity.invitation.proposed` with `requestId`; `invitation.proposed`, HTTP 202.
  The domain refuses to dispatch, re-send or accept a held invitation, and the mail handler skips
  one; the team list shows it `awaiting-approval` with re-send denied. The address stays out of
  the request's values, the audit rows and the logs. **Approval** (applier registered with
  `InviteAdmin`'s `allOf` keys; `check` in a read-only unit, `apply` in the approval's serializable
  unit, under the acceptance's invitation lock): the approver is an active, verified admin with
  the invite key who could give the role now (`roleGrantVerdict`: R1, R3, R11), the invitation is
  still held for the same role (`changed-since` once revoked or replaced), the role is at the
  asked version (`changed-since`; deleted is `gone`), the inviter could still issue it and the
  address has no admin account yet (`not-permitted`). Then it is released (the issue event at the
  next version, so the mail and its token follow) and audited `identity.invitation.approved` as
  the approver with `requestId`. The mail counters are spent when it is asked for (one mail per
  approval). **Reject or withdraw** send nothing; the held row stays pending until the inviter
  revokes it ("Cancel invitation" on the team list, allowed on a held row; it frees the address at
  once) or, as a never-sent invitation, it passes its kind's lifetime (then a new invitation
  replaces it and the hourly purge deletes it). Releasing it lazily when a new invitation meets a
  held row whose proposal is closed (Hassan, PR #1081) needs a way to read that proposal: the
  platform port offers none (`openReview`, `areaPolicy`, `proposeChange` only), system-requests
  publishes no decision event, and identity imports no module, so it is a documented limit until
  the port gains a proposal read or a decision event. An approval later than that lifetime answers
  `gone`: invite again. The invitee (the admin account of the address, if one exists) may not
  decide it. Where people is off, the invitation is issued at once as any other.
- **Where people is off** the three routes behave as before (`request: null`, the delete at once).
- **Not reviewed:** revoking an invitation (it only narrows access), re-sending one, the first-admin
  routine (system actor), the seller role editor.
- **Labels.** A created or deleted role shows its name (to an admin who may list roles); an
  invitation shows the display name of the admin who accepted it, a pending one shows none.
- **Panel.** The role editor asks for a note on create and in the delete dialog where people is
  reviewed, and on 202 says "Sent for approval (SR-n)" and keeps the role; the invite dialog asks
  for a note (from the team list's `review`) and announces the request. For a sensitive role
  (`sensitive` of the role catalogue) where people is reviewed, the invite dialog says another
  admin must approve it and nothing is sent until then, its button reads "Send for approval", and
  the 202 announces "Sent for approval (SR-n)" only; the team list shows "Awaiting approval".
