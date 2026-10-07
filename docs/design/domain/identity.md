# Identity — G2 domain design

**Author:** Mohammad (software-architect) — 2026-10-03
**Status:** Approved at G2, 2026-10-03 (Ali, Hassan). Open: 14.5 item 3.
Reviews applied: Ali (cto, approve with changes), Hassan (security-tester, accept with changes;
his findings are cited as HF1 to HF15) and Jafar (product-designer, on `ux.md`, where it touches
this design). The owner gets a Persian summary with the questions of 14.4 only.
**Ground truth:** `docs/modules/identity/brief.md` (G1 approved 2026-10-02; sections, decisions,
rules R1 to R12 and acceptance criteria are cited as "brief s5", "decision 6", "R3", "AC 14");
ADR-0018 and ADR-0020; ADR-0003 to ADR-0006, ADR-0008, ADR-0009, ADR-0013 to ADR-0015; ADR-0021
(Node minimum 24.15; 24.20.0 since 2026-10-07), ADR-0022 (seller access, 8.4) and ADR-0023 (platform amendments), reserved
on the board and written by Ali in parallel;
`docs/design/domain/platform-foundations.md` (cited as "PF 6.2"); `docs/design/data/platform.md`;
`docs/features/` (SEL-01..07, SEL-13, CUS-01, CUS-03, ADM-05, PNL-05, IMP-10, VER-10..14, INTL-11,
EXT-04); `docs/spec/technical-spec.md` section 3.1; the code on branch `docs/identity-g2-design`
(`modules/identity/` is an empty shell; `platform/` has config, health, logging, market-config
and persistence only). Aligned on 2026-10-03 with `docs/modules/sellers/brief.md` (G1 approved;
"sellers brief"), ADR-0019, `docs/design/domain/platform-persistence-and-events.md` and Reza's
`docs/modules/identity/ux.md`; what changed is listed at the top of section 14.

## 1. Scope

A design, not an implementation: signatures appear only where the signature is the contract.

- **Decided here:** the domain model (2), state machines (3), `ActorContext` (4), authorisation
  (5), sessions and credentials (6), the second factor (7), the boundary (8), email (9), audit
  (10), personal data (11), slices (12), dependencies (13).
- **In `docs/design/domain/platform-persistence-and-events.md`** ("the platform document"):
  UnitOfWork, outbox, relay, event bus, scheduler, `APP_ROLE`, the `market_id` guard, the "model
  to owning module" rule. Here: only what `identity` needs from them, and its inputs PN1 to PN7.
- **In Mojtaba's data design** (`docs/design/data/identity.md`, written from this model):
  tables, columns, constraints, indexes, retention jobs, the key table (11; its questions: 14.3).
- **In Reza's `docs/modules/identity/ux.md`:** pages, states and copy; the table of brief s12.
- **Left open, with the reason:** the default role lists, the support address and the dependency
  list need the owner (14.4); the audit writer, seal table and sealer get their own design before
  slice 6 starts, and slices 7 onward wait for it (ADR-0015 decision 1); the final name of the
  may-sell contract and the way out of the final `rejected` state belong to the `sellers` G2
  (8.3, 3.3). Hash parameters, lifetimes and thresholds are Hassan's numbers (14.2); the split
  with `sellers` is ADR-0022 (8.4).

### 1.1 Brief slices and where they are covered
| Slice (brief s11) | Covered in |
|---|---|
| 0 Platform prerequisites | PF 7; nothing new here. Rate limiting: 6.8, 13 |
| 1 Customer registration, with the platform triggers (built as 1a to 1d, 12.1) | 2.1, 3.1, 3.2, 8.2, 11, 12.2; the platform document |
| 2 Sign-in, sign-out, sessions, revocation, throttling | 3.5, 4, 5.2, 6.1 to 6.4, 6.8, 10.2 |
| 3 Email verification | 3.2, 6.6, 6.7, 9 |
| 4 Password reset (60 minutes), password change | 3.7, 6.5, 6.6 |
| 5 Seller account, separate sign-in, status messages, limited sign-in | 2.1, 2.2, 3.3, 5.2, 6.3, 8.3 |
| 6 Audit writer, hash chain, sealer | Own design before the slice; identity's needs in 10.1 |
| 7 Admin account, first admin, admin second factor, admin sign-in | 3.6, 6.3, 7, 10 |
| 8 Admin invitation, catalogue and registry, system and default roles, assignment (built as 8a, 8b) | 3.4, 5.1, 5.3 to 5.6 |
| 9 Approve, reject, suspend, reinstate, status mail, seller created by an admin | 3.3, 3.4, 8.3, 9, 10.1 |
| 10 Role editor for both panels | 2.3, 5.4, 5.5 |
| 11 Seller team: Staff invitation, default seller roles, custom roles | 2.3, 3.4, 5.5, 5.6 |
| 12 Optional second factor for sellers | 7 |
| 13 Panel screens | Reza's document; server answers are state codes (5.2, 6.3, 8.3) |

### 1.2 Inputs I1 to I15 of the platform-foundations design
| # | Answered | Where |
|---|---|---|
| I1 `ActorContext` fields | Here | 4 |
| I2 Access-rule mechanism, CI check, slice | Here | 5.2 |
| I3 Credential, denial to HTTP status, reason codes, CSRF | Here | 5.2, 6.2 to 6.4 |
| I4, I5, I7, I14 UnitOfWork, outbox, relay, bus, scheduler, `APP_ROLE`; the `market_id` guard (equality with the unit's Market); `aggregate_version`; the "model to owning module" rule | The platform document | Needs of `identity`: 12.2; every aggregate root of 2.1 has a version |
| I6 Email uniqueness next to encryption; what a subject is | Here (decision); key table in the data design | 11 |
| I8 Audited action by an anonymous actor; sign-in records | Here; CHECK change in the data design | 10 |
| I9 Catalogue content, action vocabulary, seed validation, registry slice | Here | 5.3, 5.6, 12.2 |
| I10 Operator routines | Here | 7.4 |
| I11 Rate-limiting store and package | Needs here; package after a spike | 6.8, 13 |
| I12 API error format | Here (minimum); binding for all modules through PF 5.1 (decided by Ali, 14.1-10) | 5.2 |
| I13 Sign-in cannot call `sellers` | Here | 8.3, 8.4 |
| I15 Tokens never in the URL path; driver errors | Here | 6.6, 11.3 |

## 2. Domain model

### 2.1 Aggregates
Every aggregate root carries `marketId` and `tenantId` (ADR-0003 decision 3, R9) and an `Id` from
the injected generator. A root that is loaded, changed and saved carries a version (PF 3.6);
**`Session` and `SignInChallenge` are not versioned** (decided by Ali, A4 = M1): they change only
through single guarded statements (revocation, `lastSeenAt`, an attempt, consumption), which a
version would make lose against each other. An aggregate that is deleted and created again gets a
new id, so `(aggregateId, version)` never repeats in the outbox (M3). References between
aggregates are ids. There is no global user: an account exists in one Market and one population
(ADR-0018 decision 3).

```
Account (population: customer | seller | admin)
  |-- PasswordCredential (1)            |-- SecondFactor (0..1)  --> RecoveryCode (0..10)
  |-- Session (0..n)                    |-- OneTimeLink (0..n; one per purpose, 3.7)
  |-- SignInChallenge (0..n, minutes)   |-- RoleAssignment (0..1 in Phase 2) --> Role
  '-- SellerMembership (0..1 in Phase 2; seller population only) --> sellerId
SellerAccess (one per sellerId; identity mints the id)  --> AccessDecision (append-only, 0..n)
Role (scope: platform | seller; kind: system | default | custom; sellerId on seller custom roles)
Invitation (kind: seller-owner | staff | admin)  --> roleId, sellerId?
```

| Aggregate | Holds | Invariants it owns |
|---|---|---|
| `Account` | Population, email (as typed and normalised), display name, status, `emailVerifiedAt`, the instant of the latest sign-up (the anchor of the 7-day purge: M5), the instant of the last "you already have an account" notice, the password credential | One population for life; the email is unique per Market and population (decision 5, ADR-0018 decision 3; a database constraint, 11); a customer account never has an assignment or a membership (R2); a disabled account cannot open a session (3.1); the display name has 1 to 100 characters after trimming, with no control or bidi characters and no URL-like text (HF13) |
| `PasswordCredential` (entity of `Account`) | The hash string in PHC format, `changedAt` | Only a hash is kept; replacing it ends sessions as in 3.5 (brief s5); never loaded with list queries |
| `Session` | Token hash, account, population, `sellerId` copy, transport, `createdAt`, `lastSeenAt`, the idle timeout and the absolute expiry (both fixed at creation, because "keep me signed in" differs per session: M2), revocation. The re-confirmation instant of 8.5 joins with its mini-review | 3.5. Not versioned. An admin session is created only from a second-factor proof (AC 10, AC 22). The token is never stored (ADR-0018 decision 2) |
| `SignInChallenge` | Account, purpose (`second-factor` or `second-factor-enrolment`), token hash, attempts, expiry, the credential's `changedAt` at issue | The state between a correct password (at sign-in, or with an enrolment link) and a session or an active factor. It is never a credential and never an actor (I1). Not versioned. Single use, five attempts, five minutes; an attempt is reserved with `UPDATE … WHERE attempts < 5` before the code is checked (HF1). Void when the password or the factor changes, the account is disabled or the seller suspended (HF11) |
| `SecondFactor` | Its own id, new at every enrolment (M3); encrypted secret, state, last accepted time step, recovery-code hashes, the instant of the last HF2 lock (its event sends the alert, 6.8), a replacement secret waiting for its first code (M13) | 3.6. One per account; at most one waiting secret; a time step is accepted once (`UPDATE … WHERE last_accepted_step < $step`); a recovery code is used once |
| `OneTimeLink` | Account, purpose (`verify-email`, `reset-password`, `confirm-second-factor-reset`, `enrol-second-factor`), token hash, issue and expiry instants, `consumedAt` | 3.7. Bound to one account, one purpose and one Market; single use; at most one usable link per account and purpose (brief s5, AC 19) |
| `Invitation` | Kind, email, the display name of a `seller-owner` invitee (given at issue, `ux.md` D6), role, seller (or platform), inviter, token hash, state | 3.4, R12. Accepting creates the account with exactly the invited email (AC 29); a `seller-owner` invitation names a new seller id or one whose `SellerAccess` never had a member (HF5) |
| `Role` | Scope, kind, seed code (system and default) or name (custom), permission keys, `sellerId` for a seller custom role, seed version | Exactly one scope; every key is in that scope (R2); system and default roles are read-only to every actor (R3, R10); a seller custom role belongs to one seller (R9); a custom role's name has 1 to 80 characters with the rules of HF13 and is unique among the custom roles of its seller, or of its Market's platform scope, after trimming, NFC and lower-casing (M10) |
| `RoleAssignment` | Account, role | The role's scope matches the account's population and, for a seller role, the membership's seller (R2, R9); never for a customer; one per account in Phase 2 (2.3) |
| `SellerMembership` | Account, seller id, state (`active`, `removed`) | One active membership per account (a Phase 2 rule, ADR-0018 decision 3); removing ends the member's sessions (R4) |
| `SellerAccess` | Seller id, origin (`self` or `invitation`), state, re-apply count, the instant `seller-registered` was recorded (M4), decisions | 3.3. Reject and suspend need a reason (decision 9); the state applies to every account of the seller (brief s5) |

### 2.2 What is deliberately not an aggregate of `identity`
| Thing | Why |
|---|---|
| The seller (business) | Owned by `sellers` (brief s3). `identity` mints the seller id and keeps only access state, membership and seller-scoped roles under it (8.3) |
| The permission catalogue | Code, in each module's `contracts/`, collected by the registry (R7). `identity` stores keys on roles as plain strings and reads their meaning only from the registry |
| Role and permission lists on a session or an actor | Read on every request (R4, ADR-0018 decision 2); never copied |
| Sign-in records and throttle counters | Operational records with retention, written outside any aggregate (6.8, 10.2) |
| Customer addresses, order history, consent records | Out of scope (brief s3); consent belongs to `legal` (ADR-0020 decision 5) |
| A "user" that spans populations or Markets | Forbidden by ADR-0003 decision 4 and decision 5 of the brief |

### 2.3 Modelling choices that need a reason
| Choice | Reason | Cost |
|---|---|---|
| One `Account` type with a population discriminator, not three types | Credentials, sessions, links and the second factor behave the same; differences are policies (3.1, 6.1, 7) | Every query names the population; uniqueness is per (Market, population, email) |
| `SellerMembership` separate from `RoleAssignment` | Membership says "whose data"; the assignment says "which permissions". Ownership checks (R6) read the first only | Two rows for a seller-side account |
| One role per account in Phase 2, as a rule and not as structure | The brief speaks of "its role" (flow F6, AC 29, s12). Several roles later means removing one uniqueness rule and taking the union of keys | A member who needs two default roles needs a custom role |
| System roles are seeded rows whose keys are not stored | R3: they hold every permission of their scope by definition, so a new module's keys reach them with no edit. Rows give every role an id for events and audit (R5) | The check has one special case |
| Default roles are shared, read-only rows per Market | R9 and R10: no seller changes a platform default role; they change only by a reviewed seed change. "Duplicate as a custom role" is the way to adapt one | A seller cannot tweak a default role in place |
| A custom role with assignments cannot be deleted; pending invitations for it become unusable | R12 expects a deleted role behind an invitation; an assigned member must never be left without a role silently | The owner reassigns members first (`role.in-use`) |
| Technical limits as Market policy values: 20 custom roles per seller, 50 per Market in platform scope, 50 members per seller including open invitations | Brief s7 leaves them to G2; subscription caps (PNL-04) are out of scope | Proposals; changed in configuration |

## 3. State machines

Every transition is one use case with one read-write unit of work (plus, where attempts are
counted, the reservation unit of 6.8), and takes its time from `Clock`. A transition that is not
listed is forbidden; the most tempting ones are named.

### 3.1 Account status: `active` ⇄ `disabled`
| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| (none) → `active` | Customer or seller sign-up; acceptance of an invitation; the first-admin routine (7.4) | Subject key created (11); event; no session | CUS-01, SEL-01, AC 1, AC 22 |
| `active` → `disabled` | An admin with the matching permission disables an admin or customer account (brief s3). Guards: not the actor itself; the target holds no permission the actor lacks (R1, AC 33); not the last full-access admin of the Market (R3, AC 25) | All sessions revoked and open challenges void in the same transaction, which runs serializable (HF8); audit row; event | AC 11, AC 18 |
| `disabled` → `active` | Re-enable, same permission and guards. Not named by the brief; accepted inside G1's scope (decided by Ali, 14.1-8), so that a mistaken disable is not permanent | Audit row; event | — |

Forbidden: changing population or Market; any session, link or acceptance for a disabled
account; disabling a seller-side account by this path (Staff are removed from the team, a seller
is suspended). A never-verified account is deleted with its key by a job 7 days after its latest
sign-up (M5).

### 3.2 Email verification: `unverified` → `verified`
| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| (sign-up) → `unverified` | Sign-up of a customer or a seller | A `verify-email` link is requested (3.7); the answer is the same whether or not the address already has an account (AC 21) | Flow A1 to A3 |
| `unverified` → `unverified` | Sign-up again with the same address: name and password are replaced, the older link is void | The way to correct a mistyped address and to displace a squatter (6.7) | Flow A2 |
| `unverified` → `verified` | The link is presented with the account's password (6.7), as the variant of sign-in that carries a link (6.3), under full throttling; the link is unused, unexpired and of this account, purpose and Market, and is consumed only when the password is correct (Hassan, 14.2) | Event `identity.account-email-verified.v1`; for a Seller Owner the welcome mail and, in Phase 2, the admin notification (8.5). Sign-in then continues and normally ends in a session | AC 16, AC 19 |
| (invitation) → `verified` | Accepting an invitation creates the account verified: the link proved the mailbox | — | AC 22, AC 29 |

Forbidden: a session before verification, for every population (team decision of brief s7 for
sellers, Staff and admins; for customers too, as a Market policy value, decided by Ali in 14.1-8,
because it keeps customer sign-up free of enumeration: brief s8); `verified` → `unverified` (the
sign-in email does not change in Phase 2: brief s3); notifying an admin before verification
(AC 16).

### 3.3 Seller access: `pending`, `approved`, `rejected`, `suspended`
One `SellerAccess` per seller id; the state covers the Seller Owner and every Staff member
(brief s5). It starts `pending` when the Market policy "approval required" is on and `approved`
when it is off (SEL-03, AC 5), for a self-registration and a seller created by an admin (AC 31).

| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| `pending` → `approved` | Approve, permission `identity.seller-access.approve`. Guard: the seller has an owner account with a verified email | Decision recorded; audit; event; result mail | SEL-03, AC 4, AC 9 |
| `pending` → `rejected` | Reject, same permission, with a non-empty reason | Decision with the reason; the seller's sessions revoked; audit; event; mail with the reason to the owner | Decision 9, AC 6, AC 18 |
| `rejected` → `pending` | Re-apply by the Seller Owner: with `sellers`, its "submit again" use case calls the facade (sellers brief s4, s5). Guard: fewer than 3 re-applications since the last approval (Market policy value; both briefs leave the threshold to this G2) | Counter incremented; event. In Phase 2 the use case exists behind the facade only (8.3): there is nothing to correct before `sellers`, and no screen offers it. At the limit the seller stays `rejected` and the answer is `seller-access.reapply-limit`: the "final state" the sellers brief leaves to G2. How a seller leaves it belongs to the `sellers` G2, because re-apply has no caller in Phase 2 (decided by Ali, 14.1-8) | AC 6 |
| `approved` → `suspended` | Suspend, permission `identity.seller-access.suspend`, with a non-empty reason | Decision with the reason; the seller's sessions revoked and open challenges void (HF11); audit; event; mail with the reason to the owner | SEL-07, AC 14, AC 18 |
| `suspended` → `approved` | Reinstate, same permission | Audit; event; mail | AC 14 |

Forbidden: reject or suspend without a reason (AC 6, AC 14); `pending` → `suspended` (reject
instead); `approved` → `rejected` or `pending` (suspend instead; a later re-review of business
identity is state of `sellers`, 8.3); `rejected` → `approved` without a new application; any
transition caused by a consumed event (ADR-0018 decision 3) or by a seller-side actor other
than re-apply.

| State | Sign-in after full authentication (6.3) | Open sessions |
|---|---|---|
| `pending` | A session; every use case is denied unless it is on the allow-list of 5.2 (decision 6, AC 4) | Stay |
| `rejected` | As `pending`; the owner also reads the reason, Staff only the state (decision 9, AC 6) | Ended at the rejection, then as `pending` |
| `suspended` | No session. The owner gets the state and the reason, Staff the state only (AC 7, AC 14) | Ended, and refused on every request while suspended |
| `approved` | A session | — |

Seller-facing words (Jafar, from the `sellers` G1; `ux.md` owns them): `rejected` reads "Changes
needed" while a re-application is still possible and "Not approved" at the limit; the status read
says which (8.6 row 2). The state codes do not change.

### 3.4 Invitation: `pending` → `accepted` | `revoked` | `expired`
Kinds: `seller-owner` (an admin creates a seller, SEL-06: the `SellerAccess` and the seller id
are created with the invitation), `staff`, `admin`. Lifetime: 7 days; `admin` 72 hours (HF15).

| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| (none) → `pending` | Issue. Guards: the inviter may grant the role (R1, R3, R11: 5.5); `staff`: the actor is the Seller Owner and the seller is `approved`; `seller-owner`: the seller id is new, or its `SellerAccess` never had a member (HF5); the member limit; one pending invitation per email and scope, and one pending `seller-owner` invitation per seller (M12), either answered `invitation.already-pending`; a pending row past its expiry is replaced (M7) | Token minted at dispatch (6.6); audit; mail | R12, AC 35, AC 37 |
| `pending` → `pending` | Re-send by the inviter's side: new token, new expiry, the old token is void | Mail | Flow E2, F2 |
| `pending` → `accepted` | The invitee presents the token and sets a password. `admin` and `staff` also give a display name, under the sign-up rules of 2.1 (HF13); a `seller-owner` keeps the name the admin gave at issue (`ux.md` D6); "Sign in and join" (6.7) asks for none (Jafar). An admin also presents a code. Guards, all re-checked at this moment: not expired or revoked; the role still exists; `staff`: the seller is `approved`; the inviter is still active and could still grant the role (Hassan, 14.2); `admin` with no inviter (7.4): refused once the Market has an active Platform Administrator (HF5) | Account created `active` and `verified` with the invited email, membership and assignment in the same transaction; audit; events. `admin` (HF6: the first enrolment happens inside acceptance; `ux.md` F6): acceptance completes only with a valid code. A first request checks the token and returns a new 160-bit secret with a tag (HMAC-SHA-256 under a key derived from the stack secret of 6.8, with its own label) that binds it to the invitation and an expiry of 15 minutes (accepted by Hassan); nothing is stored. The request with the token, the password, the secret, the tag and a code creates the factor `active`, with its recovery codes shown once, in the same transaction. Leaving earlier creates nothing. No session: the invitee signs in | R12, AC 22, AC 29, AC 31, AC 37 |
| `pending` → `revoked` | Revoke by the inviter's side before acceptance | Audit | R12 |
| `pending` → `expired` | `Clock` passes the expiry; checked on use, cleaned by a job | — | AC 29 |

Forbidden: acceptance in another Market, another seller or another population (AC 29);
acceptance for an email that already has an account with an active membership (6.7); changing
the email, role or seller of an invitation (issue a new one).

### 3.5 Session: `active` → `expired` | `revoked`
| From → to | Trigger and guard | Serves |
|---|---|---|
| (none) → `active` | Only by completing sign-in (6.3), including its variant that carries a verification link: correct password, the second factor when enrolled or required, verified email, active account, seller not suspended, all re-checked in the creating unit (HF11). A new token every time | AC 4, AC 10, AC 30 |
| `active` → `expired` | Idle or absolute lifetime passed (6.1); evaluated on every request | Brief s7 |
| `active` → `revoked` | Sign-out; password change and second-factor activation (all other sessions; the current one gets a new token); password reset; second-factor reset; removal from the team; account disabled; seller rejected or suspended (all sessions of that seller) | Brief s5, AC 8, AC 14, AC 18, AC 32 |

A role or permission change revokes nothing: permissions are read on every request (R4, AC 26).
Forbidden: reviving a session; use in another Market (AC 20) or with another transport (6.2);
extending the absolute lifetime; an admin session without a second-factor proof (AC 10).

### 3.6 Second factor: `none` → `pending` → `active` → `none`
| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| `none` → `pending` | Start enrolment from a 60-minute `enrol-second-factor` link mailed to the account and presented with its password (HF6). An admin gets the link when sign-in finds no active factor, which happens only after a reset (6.3 step 5); a seller-side account requests it from "Account security". An admin's first enrolment is not this path: it happens inside its invitation's acceptance, which creates the factor `active` at once (3.4) | Secret of 160 bits generated and stored encrypted (7) | Decision 7, AC 22 |
| `pending` → `active` | A valid code from the app. Re-checks the account, membership, seller state and that the password has not changed since the challenge (HF11) | Recovery codes shown once; other sessions revoked and the current one gets a new token; open challenges void; audit | AC 11 |
| `active` → `none` | Disable by the account itself (seller side only, with a code); or reset by an authorised actor (7.3) | Sessions revoked; open challenges void; mail to the account; audit. The next enrolment starts from a link (HF6) | AC 18, AC 33 |
| `active` → `active` | Replace the device: a code or a recovery code starts it, and the new secret waits in the factor's replacement field while the old one stays active (M13); the first valid code from the new device swaps them in one guarded update. Regenerate recovery codes, with a code | Swap: the old secret is void, other sessions revoked and the current one gets a new token, open challenges void, mail, audit. A new start replaces a waiting secret; a password change, a reset or disabling clears it. Regenerating: the old codes void; audit | — |

Forbidden: an admin disabling its own factor; a code or a time step accepted twice; resetting
one's own factor through the reset path; a reset by an actor that lacks a permission the target
holds (R1, AC 33); an enrolment started with a password alone, outside invitation acceptance and the mailed link (HF6).

### 3.7 One-time link and password reset: `requested` → `issued` → `consumed` | `expired`
| From → to | Trigger and guard | Effects | Serves |
|---|---|---|---|
| (none) → `requested` | A reset request for an existing, verified, active account; a sign-up (verification); an enrolment link (3.6); an admin starting a Seller Owner's factor reset (7.3). The public answer never depends on it (AC 21) | Event; no token exists yet | SEL-05 |
| `requested` → `issued` | The mail handler mints the token, sends the mail and then stores the hash in its one unit (6.6). `issuedAt` starts the lifetime | Earlier links of the same account and purpose stop working (the hash is replaced) | AC 19 |
| `issued` → `consumed` | The token is presented before expiry (reset: exactly 60 minutes, SEL-05; enrolment: 60 minutes, HF6; verification and the owner's reset confirmation: 24 hours, HF15) | Reset: new hash, every session revoked and every open challenge void, throttle counters of the account cleared (which also lifts an HF2 lock), a "password changed" mail. Consumption is one conditional update, so two concurrent uses cannot both succeed | AC 8, AC 19 |
| `issued` → `expired` | `Clock` reaches `issuedAt` plus the lifetime | A use is refused and nothing changes | AC 8 |

Forbidden: a second use; use for the other population of the same email or in another Market
(AC 19); a reset link for an unverified or disabled account (the answer stays the same; an
unverified person signs up again, 3.2). A reset never removes or bypasses the second factor.

## 4. `ActorContext` fields (I1)

Written so that it can replace the "Open" row of PF 3.4 and the comment under the union.

```ts
type Population = 'customer' | 'seller' | 'admin'; // 'seller' = Seller Owner and Staff
interface AuthenticatedActor {
  readonly kind: 'authenticated';
  readonly marketId: MarketId; // the Market of the account and of the session
  readonly population: Population;
  readonly accountId: Id<'Account'>;
  readonly sessionId: Id<'Session'>; // an id, never the token
  readonly sellerId: Id<'Seller'> | null; // set if and only if population is 'seller'
}
```

| # | Rule |
|---|---|
| 1 | Built only by `identity`'s `Authenticator` (one file), from a valid session, through the kernel's `authenticatedActor(market, fields)`; the constructor throws when `sellerId` and `population` disagree |
| 2 | `sellerId` is the seller of the account's active membership, read from committed state when the actor is built. It is the only source of "the actor's seller" for ownership checks (ADR-0018 decision 4, R6) |
| 3 | `population` fixes the scope: `admin` → platform, `seller` → seller, `customer` → none (R2). It is not a role and grants nothing |
| 4 | Not in the context: roles, permission keys, the seller's access state, second-factor or re-confirmation status, email, name. `identity` reads them on each check (R4; PF 3.4 guarantee 3) |
| 5 | A password that was accepted while the second factor is still pending produces a `SignInChallenge`, never an actor (I1): the request stays anonymous |
| 6 | Acting-as (SEL-08) is out of Phase 2 scope. The name `actingAs` is reserved for an optional `{ accountId, sellerId }` added by that mini-review; the real admin stays the actor (PF 3.4 guarantee 5). Until then the audit writer writes no `acting_as_id` |

## 5. Authorisation

### 5.1 Verdict on section 6 of the platform-foundations design
| PF | Verdict |
|---|---|
| 6.1 declaration (`key`, `scope`, `protected`) and key pattern | **Confirmed.** Action vocabulary (I9): `view`, `create`, `edit`, `delete` are the default (ADM-05); a domain verb is allowed where one of the four would hide a separate risk, and each such verb is listed in the owning module's G2 (identity's are in 5.3). Not a closed set |
| 6.1 registry guarantees 1 to 5 | **Confirmed.** It lands in slice 8a, with the first use case that declares a key (12.2) |
| 6.2 the four rule kinds, one rule per use case, `allOf` only | **Confirmed**, with one clarification of row 1, decided by Ali (14.1-4): `anonymous` means "no authentication required", so it admits an anonymous or an authenticated actor and never the system actor. Sign-in and reset requests are called by people who may hold a session. Under an `anonymous` rule the gate passes the Market's anonymous actor to `handle`, so nothing branches on, or is audited as, a signed-in visitor (HF9) |
| 6.2 row 2 (`own-resources`) | **Confirmed.** In `identity`: own credentials, sessions, second factor and the actor's own status |
| 6.2 row 5 and 6.1 row 4 (the two checked-in lists) | **Confirmed**; the list of non-permission declarations also records the seller-state attribute of 5.2 |
| 6.3 `Authenticator` | **Changed in one place** (decided by Ali, 14.1-4): `credential` becomes `{ token: string; transport: 'cookie' \| 'bearer' } \| undefined`. The guard knows where the token came from, and a session issued for one transport is refused on the other (6.2). Everything else confirmed, including "one `credential.rejected` for every cause" |
| 6.3 `AuthorisationCheck` and row 5 | **Confirmed.** Reason codes in 5.2. Both ports are implemented in `identity/application/access/`; they are the two named exceptions to boundary rule 9, because the guard and the gate call them and they are not use cases |
| 6.4 rows 1 to 7 | **Confirmed**; the mechanism is 5.2 |
| 6.4 row 8 (slice of the CI check) | **Confirmed: slice 1c** (C1) |

### 5.2 The enforcement mechanism (I2)
A use case is a class in `modules/<m>/application/use-cases/<name>.use-case.ts` that extends the
platform base class and carries a static declaration, readable without running anything:

```ts
abstract class UseCase<Input, Output> { // platform/authz
  static readonly access: AccessDeclaration; // own property of every concrete subclass (HF4)
  execute(context: CallContext, input: Input): Promise<Result<Output, AccessDenied | …>>;
  protected abstract handle(context: CallContext, input: Input): Promise<…>;
}
type AccessDeclaration = {
  readonly name: string; // '<module>.<use-case>', unique; used in denial logs
  readonly rule: AccessRule; // PF 6.2
  // required, no default, on `own-resources` and seller-scope `permissions` rules (PF 6.4 row 6)
  readonly whenSellerNotApproved?: 'deny' | 'allow';
};
```

| Part | Design |
|---|---|
| Wrapper | `execute` is the only public entry. It calls the `UseCaseGate` of `platform/authz` and only then `handle`, which opens its own unit of work (platform document 3.4, option A). The gate, in order: reads the declaration only as an own property (`Object.hasOwn(cls, 'access')`), so a subclass never inherits its parent's rule (HF4); refuses a context that was not minted; compares the actor's Market with the `MarketContext`; decides `anonymous` and `system` itself, passing the anonymous actor to `handle` under `anonymous` (HF9); for an authenticated actor calls `AuthorisationCheck`. An exception inside the gate is a denial. Every denial is logged with the use-case name, the rule, the actor id and the correlation id |
| `AuthorisationCheck` (in `identity`, from slice 2) | Reads committed state on each call, in a read-only unit of its own and never inside the caller's (PN3): the account is active; the population matches the scope of the rule's keys (R2); for the seller population the membership is active and the seller is not `suspended`, and `pending` or `rejected` is a denial unless the declaration says `allow`; every key of the rule is held through the actor's role and known to the registry (R7) |
| Ownership | Stays inside `handle` (R6, PF 6.2 row 4): the seller and the Market come from the context; a resource of another seller or Market answers "not found", byte-identical to a real one (Hassan, 14.2) |
| Allow-list for a seller that is not approved (decision 6, AC 4, AC 6) | Declared `allow` in Phase 2: the actor's own summary and status (state code; the reason for the owner only), sign-out, change of the own password, the own second factor, re-apply. Everything else, the team page included (flow F), is `deny`. The entries sit in the checked-in list of PF 6.2 row 5, so each addition is seen in review: `sellers` adds "complete your details" and "submit for review" (sellers brief s5), `certification` its own at its gate |
| Discovery and CI check (slice 1c) | One test globs `modules/*/application/use-cases/*.use-case.ts` and fails when: a file does not export exactly one direct subclass of `UseCase` with its own valid static `access`; a use case extends another use case; a subclass of `UseCase` sits outside the glob, or a file in a `use-cases/` folder is misnamed (HF4); a name is duplicated; a key is not declared in a module's `contracts/`, or the keys of one rule are in two scopes; the seller-state attribute is missing where it is required; a non-permission rule or an `allow` is missing from the checked-in list |
| Boundary rules | Dependency-cruiser rule 9: `presentation/`, event and job handlers and the facade implementation import from `application/` only `use-cases/`, and nothing outside `application/` and `infrastructure/` imports a repository. An ESLint rule forbids overriding `execute` and calling `handle` from outside |

**Answers and HTTP status (I3, I12).** The API answers with codes, never message text (brief
s6). The minimum error body for every module is `{ statusCode, code, details? }`, where
`details` is a closed object per code (`retryAfterSeconds`; `fields: [{ path, code }]` for
validation); it extends the three answers of PF 5.1 without renaming them. Decided by Ali
(14.1-10): binding for every module through PF 5.1, with no ADR.

| Outcome | Code | HTTP |
|---|---|---|
| `Authenticator` rejects the credential; a cookie name repeated in one request (HF7); in Phase 2, any `Authorization` header (HF14) | `session.invalid` (cookie cleared) | 401 |
| Anonymous actor, rule needs authentication | `access.unauthenticated` | 401 |
| Wrong population, missing key, system-only rule | `access.denied` | 403 |
| Seller `pending` or `rejected`, use case not on the allow-list | `access.seller-not-approved` with `details.state` | 403 |
| Missing or wrong CSRF token, or a refused origin (6.4) | `request.csrf` | 403 |
| The gate, or a throttle counter, could not be evaluated | `access.unavailable`; the use case does not run and nothing is hashed (fail closed) | 503 |
| The password-hash queue is full (6.5) | `request.busy` with `retryAfterSeconds` | 503 |
| Throttled (6.8) | `request.throttled` with `retryAfterSeconds` | 429 |
| `StaleAggregateError`; `TransactionConflictError` (platform document 10, PN7: `40001` or `40P01` after three attempts, or a lock timeout `55P03` at once; a statement timeout `57014` is a 500) | `conflict.stale`; `conflict.retry` | 409 |

### 5.3 Permission catalogue of `identity`
Declared in `modules/identity/contracts/permissions.ts`. Labels are translation keys derived
from the key. P = protected (R11).

| Key | Scope | P | Allows |
|---|---|---|---|
| `identity.seller-access.view` | platform | no | See sellers awaiting a decision, their state and reason |
| `identity.seller-access.approve` | platform | no | Approve and reject (one decision; SEL-03) |
| `identity.seller-access.suspend` | platform | no | Suspend and reinstate (SEL-07) |
| `identity.seller-account.create` | platform | no | Create a seller by invitation; re-send or revoke that invitation (SEL-06) |
| `identity.seller-account.reset-second-factor` | platform | no | Start the reset of a seller-side account's second factor (7.3) |
| `identity.customer-account.view` | platform | no | Find a customer account by email; see its status |
| `identity.customer-account.disable` | platform | no | Disable and re-enable a customer account |
| `identity.admin-account.view` | platform | no | List admin accounts, their roles and open invitations |
| `identity.admin-account.invite` | platform | yes | Invite an admin; re-send or revoke |
| `identity.admin-account.disable` | platform | yes | Disable and re-enable an admin account |
| `identity.admin-account.reset-second-factor` | platform | yes | Reset another admin's second factor |
| `identity.platform-role.view` | platform | no | See roles and their permissions |
| `identity.platform-role.create`, `.edit`, `.delete` | platform | yes | The role editor of the admin panel (decision 8b) |
| `identity.platform-role.assign` | platform | yes | Change an admin's role |
| `identity.team-member.view` | seller | no | See the team, roles of members, open invitations |
| `identity.team-member.invite`, `.remove`, `.assign-role`, `.reset-second-factor` | seller | yes | Team management (PNL-05) |
| `identity.seller-role.view` | seller | no | See roles and their permissions |
| `identity.seller-role.create`, `.edit`, `.delete` | seller | yes | The role editor of the seller panel (decision 8) |

Non-default verbs: `approve`, `suspend`, `disable`, `invite`, `remove`, `assign`,
`assign-role`, `reset-second-factor`. A key for reading sign-in records is declared, as
protected, when a screen for them exists; Phase 2 only records them (10.2).

### 5.4 Where R1 to R12 are enforced
`GrantPolicy` and `LastHolderPolicy` are domain services of `identity` (5.5). "Use case" means
inside `handle`, after the gate.

| Rule | Enforcement point | Test |
|---|---|---|
| R1 | `GrantPolicy.canGrant` in every use case that creates or edits a role, assigns one or issues or accepts an invitation; `GrantPolicy.canActOn` in assign, remove, disable and reset-second-factor; "not on oneself" is a guard of the same use cases | AC 23, 33, 37 |
| R2 | `Role` invariant (keys of one scope, from the registry); `RoleAssignment` invariant (scope matches population; never a customer); the gate compares key scope with population on every check (PF 6.4 row 5) | AC 24 |
| R3 | System roles are rows without stored keys and without an edit or delete path (`Role` invariant). Granting or removing one requires that the actor holds the same role now (`GrantPolicy`); in Phase 2 the seller system role is never granted, only founded (HF5). `LastHolderPolicy` in a serialisable unit, and every writer it counts serialisable too (5.5, HF8) | AC 25, 34 |
| R4 | No session or permission cache (ADR-0018 decision 2): `AuthorisationCheck` reads the assignment and the role on every call. Removal and disabling revoke sessions in the same transaction | AC 18, 26 |
| R5 | The audit row and the event are built by the use case from an allow-list: role id, added and removed keys, account ids. `Role.name` has no path into either (10.1); a contracts test rejects free-string payload fields (PF 3.6) | AC 12, 27 |
| R6 | The seller and the Market come from `ActorContext` and `MarketContext`, never from input; repositories of seller-scoped data take the seller id as a required argument; the `market_id` guard covers the Market | AC 15, 28 |
| R7 | Boundary rules 1 and 2 of PF 8.2 (slice 0); the registry refuses malformed, foreign and duplicate keys at boot; an unknown stored key is dropped when permissions are resolved | AC 36 |
| R8 | The "model to owning module" rule; other modules get only the facade of 8.1 and keep no copy (ADR-0018 decision 4) | Boundary fixtures |
| R9 | Aggregate fields of 2.1; default roles are shared rows that no use case of a seller can change; seeds are versioned files (5.6) | AC 24 |
| R10 | A custom role's keys change only through the edit use case; nothing writes keys on a registry change. Default roles change only through the seed routine | AC 36 |
| R11 | `GrantPolicy.canGrant`: a protected key may be put in a role, or a role holding one assigned or invited, only by a holder of the system role of that scope. **Phase 2 narrowing** (brief s3, AC 35 last clause): protected keys of seller scope are not grantable at all, so only the Seller Owner manages the team | AC 35 |
| R12 | `Invitation` invariants and the acceptance guards of 3.4 | AC 29, 37 |

### 5.5 `GrantPolicy` and `LastHolderPolicy`
| Term | Definition |
|---|---|
| Effective keys of an account | All keys of its scope in the registry if its role is a system role; otherwise the role's stored keys that the registry still knows |
| `canGrant(actor, role)` | Every effective key of `role` is an effective key of the actor (R1); if any is protected, the actor holds the system role of that scope (R11); if `role` is a system role, the actor holds that same role (R3, AC 34); in seller scope, in Phase 2, `role` holds no protected key and is never the system role: a seller has one Seller Owner, its founder (brief s3; HF5) |
| `canActOn(actor, target)` | The target's effective keys are a subset of the actor's, and the target is not the actor. **Across scopes** (an admin resetting a seller-side account's second factor) the subset test has no meaning, because scopes share no keys (R2); there the platform permission alone decides, and a Seller Owner's reset still needs the owner's link confirmation (7.3). Decided by Ali (14.1-2) |
| Founding assignment | The first Seller Owner of a new seller (self-registration, or an invitation issued under `identity.seller-account.create`, SEL-06) and the first Platform Administrator of a Market (7.4) receive the system role from the creating use case. That is the creation of the scope, not a grant under R3 (decided by Ali, 14.1-2); once a holder exists, only a holder grants it, and in seller scope nobody does in Phase 2. At self-registration (slice 5) it writes no audit row; through an invitation it is audited with the acceptance. Guards: a `seller-owner` invitation names a new seller id or one that never had a member; an `admin` invitation without an inviter is refused at acceptance once an active Platform Administrator exists (HF5) |
| `LastHolderPolicy` | Before a removal, demotion or disabling: count the holders of the system role in the scope (the seller, or the Market for admins) that are active and have a verified email (R3: "can sign in"); refuse when the count would reach zero. Every use case that applies it opens its unit with `isolation: 'serializable'` (platform document 3.1 rows 6 and 7; PN5), so of two concurrent demotions one is retried and then refused. Because PostgreSQL detects conflicts only among serializable transactions, **every** use case that writes `role_assignments`, `seller_memberships.state` or `accounts.status`, inserts and deletes included (sign-up, invitation acceptance, assign, remove, disable, re-enable, erasure, the unverified purge), runs serializable too, and a test asserts each one's isolation (HF8). No row lock and no raw SQL helper is needed in Phase 2 |

### 5.6 Default roles (proposal for the owner) and their seed
The brief has no list (s3); A1 to A5 and V2 of `panels-ux-strategy.md` are assumptions, and the
seller interviews have not been held (brief s8). The Phase 2 catalogue holds only the keys of
5.3; each later module's brief decides which roles receive its keys (R10). "Later" is intent.

| Admin role | Purpose | Keys in Phase 2 | Later groups (each at its module's gate) |
|---|---|---|---|
| Platform Administrator (system) | Full control of one Market's admin panel | All platform keys, by definition | All |
| Onboarding and Compliance | Review and decide seller applications (A1) | `seller-access.view`, `.approve`, `.suspend`; `seller-account.create` | Seller files, certification review |
| Catalogue Moderator | Review products and revisions (A2) | `seller-access.view` | Catalogue approvals, category proposals |
| Operations and Support | Help sellers and customers day to day (A3) | `seller-access.view`; `customer-account.view`, `.disable`; `seller-account.reset-second-factor` | Orders, returns, messages |
| Finance | Payouts, commission, ledgers (A4) | `seller-access.view` | Payouts, commission, transactions |
| Viewer | Read-only access for oversight | Every unprotected `view` key | Every unprotected `view` key |

| Seller role | Purpose | Keys in Phase 2 | Later groups |
|---|---|---|---|
| Seller Owner (system) | The shop's owner; the only one who manages team and roles | All seller keys, by definition | All |
| Store Manager | Runs the shop day to day without owning it | `team-member.view`, `seller-role.view` | Everything except team, roles, payout account |
| Order Fulfilment | Accepts, packs and hands over orders (V2) | None yet | Orders, shipping, "out of stock" |
| Catalogue and Stock | Maintains offers, prices and stock | None yet | Offers, prices, inventory |
| Customer Service | Answers customers, handles returns | None yet | Orders (read), messages, returns |
| Bookkeeper | Reads earnings, statements and invoices | None yet | Earnings and payouts, read-only |

**Seed.** One versioned file per scope in `modules/identity/infrastructure/seed/` holds each
system and default role: a stable code, a translation key for its name, its keys. A test and
each boot fail when a seed key is unknown to the registry, in the wrong scope or protected. Roles
carry `marketId` (R9), so rows cannot come from a migration (I9): a `system` use case, run per
hosted Market at deploy and at worker start, creates missing roles and applies a newer seed to
default roles only, with an audit row per change. System roles: slice 5; default roles: 8a.

## 6. Sessions and credentials

Every number in this section is Hassan's (G2 review, 14.2) and lives in a per-population policy
object read from Market configuration, not in a literal.

### 6.1 Lifetimes
| Population | Idle timeout | Absolute lifetime | Reason |
|---|---|---|---|
| Admin | 30 minutes | 12 hours | Highest privilege; brief s7 asks for a shorter admin session. `SameSite=Strict`; never "keep me signed in" |
| Seller side, default | 12 hours | 24 hours; a cookie without `Max-Age` | A working day at the counter |
| Seller side, "keep me signed in" | 14 days | 30 days | Opt-in at sign-in, seller side only: a shop tablet that takes orders all day (V2). Decided by Ali and told to the owner (14.4) |
| Customer | 14 days | 30 days | NIST AAL1 (Hassan); revisit with the storefront |

`lastSeenAt` is written at most once a minute per session. The idle timeout and the absolute
lifetime are fixed at creation (M2). A session row, revoked or expired, is deleted by the hourly
job 30 days after its absolute expiry (M6).

### 6.2 Token, storage and the `Authenticator` credential (I3)
| Topic | Design |
|---|---|
| Token | 32 bytes from the system random source, base64url, with a short version prefix so that scanners and log filters can recognise it. It is not an `Id` (PF 3.9) |
| Stored | Only the SHA-256 of the token (ADR-0018 decision 2). The token has 256 bits of entropy, so an unkeyed fast hash is enough (accepted by Hassan, 14.2); the lookup is by hash and no code compares tokens |
| Credential | `{ token, transport }`. The platform actor guard takes the token from the session cookie (`cookie`) or from `Authorization: Bearer` (`bearer`). Phase 2 issues cookie sessions only; the guard already refuses a session presented on the other transport, and refuses any request that carries an `Authorization` header (HF14). Later, a request carrying two credentials is refused, and admin sessions are never bearer tokens |
| Per request | The `Authenticator` reads, in one Prisma call inside `identity`'s schema, in a read-only unit of its own (P 3.1 row 9; ADR-0025): the session by hash; not revoked; inside both lifetimes; same Market and transport; account active; for the seller population an active membership and a seller that is not `suspended`. Any failure is `credential.rejected` (PF 6.3 row 3). Nothing is cached. The once-a-minute `lastSeenAt` write (3.5) runs in its own short read-write unit after the gate, never in the gate's read-only unit (P 3.1 row 9) |
| Rotation | A new token at every sign-in (never one that existed before authentication) and, for the current session, at a password change and at a second-factor activation (Hassan). No periodic rotation in Phase 2 |
| Target | The session and permission reads add at most 15 ms at the 95th percentile; sign-in, sign-up and reset answer within 800 ms (dominated by the hash). The sign-in, sign-up and reset target stays proposed, because the documents give no number (brief s9). The per-request target was measured by spike 6 (2026-10-07; PostgreSQL 16, seeded volumes): every read is an index probe (0.1 to 0.2 ms in the database); session and permission reads together take 2.6 ms median and 4.1 ms p95, sequentially, in a guarded READ COMMITTED unit; under load the Node process is the limit, about 600 requests/s per process with a pool of 10, about 750/s with no `SET TRANSACTION` (P 3.1 row 6). No transaction for the gate (row 9) was measured only together with the `relationJoins` preview (about 1,490/s), which is not adopted, so its gain alone is estimated, not measured. More capacity means more API processes |

### 6.3 Sign-in sequence and outcome codes
One use case per population (rule `anonymous`), with the same steps. Confirming an email is the
same sequence with the link's token in place of the typed email (3.2, 6.7), under the same
throttling; the reservation unit finds the account through the link.

| Step | Action | Answer when it stops here |
|---|---|---|
| 1 | Generic per-origin limit (platform, before any `identity` code; 6.8) | `request.throttled` |
| 2 | **Reservation unit** (HF1): a short write unit increases every sign-in counter of 6.8 (`attempts + 1 … RETURNING`) and reads the account by Market, population and normalised email, with its hash. A counter at its threshold refuses the attempt without hashing. Counter table unreachable: fail closed | `request.throttled`; `access.unavailable` |
| 3 | Verify the password outside any unit, against a dummy hash with the current parameters when there is no account, so both paths cost the same (HF12) | `credentials.invalid`; the failure stays counted and is recorded (10.2). Hash queue full: `request.busy` |
| 4 | Email not verified, and no valid link came with the request | `email-verification-required`; no session |
| 5 | Second factor active and not locked (HF2) → a `SignInChallenge`; an admin without an active factor → an enrolment link is mailed (3.6, HF6; AC 22) | `second-factor-required`; `second-factor-enrolment-required`; a locked factor (HF2): `second-factor.locked` with `retryAfterSeconds` |
| 6 | After the factor: account disabled; a seller-side account without an active membership; seller suspended | `account.disabled`; `membership.none`; `seller-access.suspended`, with the reason for the owner only |
| 7 | Otherwise a session, created in the closing unit after it re-checks the account, membership, seller and password (HF11) | `signed-in` |

Steps 4 to 6 are the only places where a state or a reason is told, all after full
authentication (SEL-04, AC 7; accepted by Hassan with the allow-list of 5.2). An unknown email, a
wrong password, the other population (AC 3) and another Market (AC 1) are all
`credentials.invalid`. Units, in order: the reservation unit (the one write unit allowed before
slow work, platform document 3.1 row 5); the hash check outside any unit; then one read-write
unit that re-checks the account's version, writes the sign-in record and, on success, releases
the reservation (each counter minus one) and creates the session or the challenge. A refused
attempt is an `ok` outcome of its units, so the counter and the record commit (PN1). The factor
step works the same way: the challenge attempt (`UPDATE … WHERE attempts < 5`) and the
`second-factor.account` counter are reserved before the code is checked (HF1, HF2).

### 6.4 Cookie and CSRF
| Topic | Design |
|---|---|
| Cookie | `__Host-` prefix, `Secure`, `HttpOnly`, `Path=/`, no `Domain`, `SameSite=Lax`; `Strict` for admins (Hassan). The name ends with the population and the Market code, so one browser can hold a seller and an admin session and sessions of two Markets never share a name (I3). The guard reads only the cookie named for the route's population and Market; a name that appears twice in one request is `session.invalid` (HF7). The token is never in a response body for the cookie transport |
| Topology | The browser must reach the API through the host that serves the panel (the front tier of ADR-0020 decision 3 relays `Set-Cookie` unchanged). A cross-origin API would need CORS with credentials and a new review. Input to the D2 ADR (HF7): a separate host for each panel and for the storefront, so that an XSS in one panel can neither read the other's CSRF token nor use its cookie |
| CSRF token | For a cookie session every request with an unsafe method must carry `x-csrf-token`, equal to HMAC-SHA-256 of a fixed label keyed with the session token. The platform guard computes it from the cookie it already holds and compares in constant time (accepted by Hassan, 14.2): no second cookie, no stored value, no port call. The page reads it from the actor-summary answer. A page of another origin can neither read that answer nor the `HttpOnly` cookie |
| Origin checks (HF14) | Every request with an unsafe method, with or without a session, is refused (`request.csrf`) when `Sec-Fetch-Site` is present and not `same-origin`, or `Origin` is present and not on the configured list. Sign-in, sign-up and reset requests have no session to bind a token to; they also accept JSON only (PF 7 item 6) |
| Not the defence | `x-market-id` (PF 5.1), `SameSite` alone, or the JSON content type alone |

**Native client later (EXT-04; board request 10).** Nothing is built now, and none of the
three conditions conflicts with this design. (1) The session model is transport-neutral: a
session is an opaque server-side token, the cookie is one transport, and the `Authenticator`
takes `{ token, transport }`. A native client would receive the token in the sign-in answer and
send it as a bearer header: one sign-in variant and one branch of the guard, with no change to
the session model or to ADR-0018 decision 2. Lifetimes are per transport and population, so a
longer app session needs no refresh-token scheme. (2) The CSRF check applies only when the
credential arrived in a cookie; a bearer request is exempt because no browser attaches that
header by itself, and the origin check of anonymous requests applies only when the origin
headers are present. A session is bound to its transport, so a cookie session cannot be replayed
as a bearer token. (3) One session row is one sign-in on one device, and revocation is per row;
"list my sessions" and "revoke this session" need no new data but are not in Phase 2 (decided by
Ali, 14.1-9). A device label would be personal data and is left to that later design. Hassan
accepted this paragraph with HF14: until then the `Authorization` header is refused (6.2).

### 6.5 Password hashing and rules
| Topic | Design |
|---|---|
| Port | `PasswordHasher` in `identity/application/ports`: `hash(plain)` returns a PHC string; `verify(plain, stored)` returns match and "needs re-hash". One adapter: argon2id through Node's built-in `crypto.argon2`; the PHC encoding is a small function of ours |
| Evidence | On Node 24.9.0, run alone in a scratch folder with `engine-strict` off: the RFC 9106 test vectors for argon2id, argon2i and argon2d match, and no experimental warning is printed. Hassan's run on 24.21: the vectors pass, and 64 MiB with t=3 takes 170 ms. Decided by Ali (14.1-13): the minimum becomes 24.15.0 through ADR-0021; the vectors are re-run there, and if `crypto.argon2` is not stable on 24.15 the fallback package of 13 is used. **Note, 2026-10-07 (spike 1):** it is "Release candidate" on 24.15.0 and stable from 24.19.0; Ali decided to raise the minimum to 24.20.0 (ADR-0021 decision 3), which also carries two fixes to it, so no package is used |
| Parameters (Hassan) | argon2id, 64 MiB, t=3, p=1, a 16-byte salt and a 32-byte tag: above OWASP's floor (19 MiB, t=2) and RFC 9106's 64 MiB option. Target median when deployed: 100 to 300 ms; if slower, lower t, never below the floor. Hashing runs on the libuv pool, so at most two hashes run at once per process, with a queue of 16, then `request.busy` (503); sign-in reserves its counters before hashing (6.3). A hash with older parameters is replaced at the next successful sign-in |
| Pepper | None (Hassan). If a second secret is ever wanted, the PHC string is encrypted under a stack key rather than keying argon2 with it: decrypting restores a portable hash (ADR-0018 decisions 1 and 9) |
| Rules (Hassan) | 15 to 128 code points after Unicode NFKC (NIST SP 800-63B-4); the raw input at most 1024 bytes; no composition rules, no forced rotation; refused when equal to the email or the name, or found on a checked-in list of at least 100,000 common passwords; never truncated, logged or echoed. A breached-password service is backlog (ADR-0018, consequences) |
| Change | Needs the current password in the same request, and a code when a second factor is active; other sessions end and the current one is rotated (AC 32) |

### 6.6 One-time tokens
| Topic | Design |
|---|---|
| Shape | Links and invitations use the token shape and storage of sessions: random, only the hash stored, bound to one account (or invitation), one purpose and one Market (brief s5) |
| Minted at dispatch | The request commits a row without a token and an event. The mail handler in the worker reads what it needs, mints the token, sends the mail outside any unit and then stores the hash in its one unit (PN2; 9). The raw token is never in a table, an outbox row, an event or a log (AC 12). The public answer does not wait for mail, so it takes the same time for a known and an unknown address. If the unit fails after the send, the retry sends a new mail and the first link never works |
| In the link | The token sits in the URL fragment of a panel page; the page posts it in a JSON body. It is in no request line, proxy log or `Referer` (I15) |
| Lifetimes | Reset 60 minutes (SEL-05, fixed); enrolment link 60 minutes (HF6); verification 24 hours; the owner's second-factor reset confirmation 24 hours (HF15); invitation 7 days, admin invitation 72 hours (HF15) |

### 6.7 Enumeration, and registration with someone else's email
| Case | Behaviour |
|---|---|
| Sign-up, reset request, "send the verification again" | One answer whether or not the address has an account (AC 21). Only the mail differs: an address with a verified account receives "you already have a … account" and no link, at most once in 24 hours per account. Sign-up hashes the password before any read, so every branch costs one hash and one write unit, which at least counts the mail (HF12) |
| Staff invitation to an address that already has a seller-side account | The inviter sees "sent"; the address gets an explanation. An account whose membership was removed can accept by signing in ("Sign in and join": no name is asked, the account keeps its own); one with an active membership cannot (one team per account in Phase 2, brief s3) |
| Squatting (brief s7, "pre-registration") | Someone registers a victim's address with their own password and waits for the victim to click the link. Options: |

| Option | For | Against |
|---|---|---|
| A. The link alone verifies | Fewest steps | A click on an unrequested mail activates an account whose password the attacker knows |
| B (decided; accepted by Hassan, 14.2). The link verifies only with the account's password, typed on the page; a correct password there also completes sign-in (Reza's proposal, 8.6), under full throttling, and the link is consumed only then | The victim cannot complete it; the attacker has no mailbox. With "sign-up again replaces name and password" (3.2) and the 7-day purge, the real owner is never locked out. The new user types the password once, not twice | One more field on the verification page |

### 6.8 Throttling and rate limiting (I11)
Thresholds are Hassan's. Counters live in an `identity` table, in PostgreSQL because the
decision must survive a restart and be the same on every instance (ADR-0004 decision 1 keeps
Redis away from truth), keyed by HMAC-SHA-256 under a stack secret of 32 random bytes, required
at boot and never logged (Hassan, H4), also for unknown addresses.

| Counter | Counts | Threshold |
|---|---|---|
| `sign-in.account-origin` | Failed sign-ins per (Market, population, normalised email) and origin | 5 in 15 minutes, then refused for 15 minutes with the wait announced (AC 13) |
| `sign-in.account` | The same, all origins | 20 in 60 minutes. Blocks password sign-in only; a reset stays available and clears it (AC 13) |
| `sign-in.origin` (HF3) | Failed sign-ins per origin, any address | 30 in 15 minutes, then refused for 15 minutes |
| Challenge attempts | On the challenge | 5, then the challenge is void |
| `second-factor.account` (HF2) | Failed codes and recovery codes per account, across challenges | 10 in 24 hours: the factor step is refused for 24 hours or until a password reset, and the account is mailed |
| `mail.account`, `mail.origin` | Reset, verification re-send, sign-up, enrolment link, invitation mail | 3 per hour per account; 10 per hour per origin |
| Generic, per origin | Every request: the platform rate limiter of slice 0, before any `identity` code; package and store after spike 3 (13). One instance may count in memory; a second needs a shared store | 20 per minute on anonymous `identity` routes, 300 per minute elsewhere |

| Rule | Design |
|---|---|
| Reserve before verifying (HF1) | A short write unit increases every counter that applies (`attempts + 1 … RETURNING`) and refuses at the threshold without hashing; the unit after the check releases the reservation on success. N parallel requests therefore get no more guesses than the threshold. Challenges: `UPDATE … WHERE attempts < 5` before the code is checked |
| Fail closed | If the counter table cannot be reached, the attempt is refused (`access.unavailable`) and nothing is hashed |
| Origin | The client address once the trust-proxy setting of PF 7 item 6 is fixed: the IPv4 address, or the IPv6 /64 (HF3) |
| Per Market | Every counter, origin counters included, is kept per Market (decided by Ali, A6); the generic limiter is the cross-Market control |
| Windows | Fixed windows with a block instant (M11); no row per attempt |
| Uniform | A throttled attempt answers alike for an unknown address |

## 7. Second factor

| # | Topic | Design |
|---|---|---|
| 7.1 | Mechanism | Authenticator app only (decision 7): TOTP per RFC 6238 with Hassan's parameters, which every common app accepts: SHA-1, 6 digits, 30 seconds, one step of tolerance each way, a 160-bit secret. A step is accepted only through `UPDATE … WHERE last_accepted_step < $step`, so a code works once even under concurrency. Built on `node:crypto` behind a port `SecondFactorVerifier`: the RFC 6238 and RFC 4226 vectors pass on Node 24.9.0 and 24.21 with HMAC alone, so no package is needed; re-run on 24.15 (ADR-0021). Enrolment gives an `otpauth://` URI and the same secret as text; drawing the QR code is the panel's job, never a remote service (13) |
| 7.2 | Who | Mandatory for admins: a session is built only from a second-factor proof; an admin enrols inside its invitation's acceptance (3.4) and, after a reset, again from a mailed link (3.6, HF6), and can do nothing else without a factor (AC 10, AC 22). Optional for the seller side at launch (AC 30); the facade exposes the status so that payouts can require it from a Seller Owner in Phase 5 (decision 7, VER-10). Customers: none |
| 7.3 | Recovery and reset | Ten single-use recovery codes of 10 Crockford base32 characters, shown once, stored as `SubjectKeyService.hmac` under the account's key (Hassan, H2). A person with neither device nor codes needs a reset: the factor returns to `none`, the sessions end, the account is mailed, an audit row is written, and the next enrolment starts from a mailed link (HF6). Who may reset is the table below |
| 7.4 | Operator routines (I10) | Two commands of the `api` image, run by the operator with a named Market; each gets its `MarketContext` from the factory and runs a use case with the `system` rule. `first-admin`: refused when the Market already has an admin account; creates an `admin` invitation (72 hours) for the given email with the Platform Administrator role, so there is never a default password (AC 22); its acceptance is refused once the Market has an active Platform Administrator (HF5). `reset-admin-second-factor`: the break-glass of 7.3. Both write an audit row, so neither can run before slice 6 |
| 7.5 | Secret | 20 random bytes, encrypted with `SubjectKeyService` under the account's key (label `identity.second-factor.secret`), decrypted only inside the verifier; never in an event, a log or an audit row. A replacement's new secret is encrypted the same way and waits beside the active one until its first valid code (M13). Destroying the account's key destroys both |

| Reset target | Who may reset | Extra control |
|---|---|---|
| Staff member | The Seller Owner (`identity.team-member.reset-second-factor`) | R1 |
| Seller Owner | An admin with `identity.seller-account.reset-second-factor` starts it, after support's written identity check (owner question 2, 14.4); it takes effect only when the owner confirms through a 24-hour link sent to the account's email (HF15) | Support cannot be talked into a takeover alone; R1 across scopes (5.5) |
| Admin | Another admin with the protected key (R11), subject to R1 | The target must enrol again, from a mailed link (HF6), before any session |
| The last Platform Administrator | The operator routine of 7.4 | Audit row with the system actor |

## 8. Boundary

`identity` imports no other module (R7; boundary rule 2 with an empty allow-list). It needs
from `platform/`: `MarketContextFactory` and `MarketRegistry`, `Clock`, `IdGenerator`, the
UnitOfWork and outbox, the audit writer, `SubjectKeyService`, the registry and gate of
`platform/authz`, the scheduler, and the mail transport of `platform/mail/` (9). It consumes no
other module's event in Phase 2; it subscribes to its own for mail (9; decided by Ali, 14.1-6).

### 8.1 Public facade (`contracts/identity.facade.ts`)
Every method takes a `CallContext` first and is a thin call of one use case, so the gate runs
(PF 6.4 row 2). Answers hold ids and codes; the one method that returns a name and an email says
so, and no caller may put them in an event, a log or an audit row.

| Method | Returns | Access rule | Slice |
|---|---|---|---|
| `describeActor(ctx)` | Account id, population, seller id, role id, effective permission keys, seller access state, whether a second factor is active | `own-resources`, allowed when not approved | 2; keys from 8a |
| `membershipOf(ctx, accountId)` | Seller id and role id, or none | `own-resources`, for oneself only, in slice 5; the variant for other accounts, under `identity.team-member.view`, waits for 8a, which brings the registry (decided by Ali; ADR-0018 decision 6) | 5; 8a |
| `sellerAccessOf(ctx, sellerIds)` | Per seller id, the state code and the instant of the last change; never a reason; an unknown id is absent, which the caller reads as "may not sell" | `anonymous` for request actors and `system` for handlers (two use cases behind one method), because the may-sell contract of 8.3 is asked during a customer's request. Not exposed over HTTP | 5 |
| `sellerAccountSummaries(ctx, sellerIds)` | Per seller: state, instant of the last change, owner account id, the owner's display name and sign-in email (the sellers list, SEL-14, needs them without a join: sellers brief s7) | `identity.seller-access.view` | With `sellers` |
| `hasRecentConfirmation(ctx, within)` | Whether this session re-confirmed its password (and factor) within the duration | `own-resources` | Mini-review before `sellers` slice 10 (8.5) |
| `secondFactorStatusOf(ctx, accountId)` | `none` or `active` | `system` or `own-resources` | 12 |
| `approveSellerAccess(ctx, sellerId, basisId?)`, `rejectSellerAccess(…, reason, basisId?)` | The new state or a refusal code. `basisId` is an id that means nothing to `identity`; it is stored on the decision and published (8.4) | `identity.seller-access.approve` | 9 |
| `autoApproveSellerAccess(ctx, sellerId)` | As above; refused unless the Market policy "approval required" is off, and called only when every `sellers` check passes (8.4, point 5) | `system` | With `sellers` |
| `reapplySellerAccess(ctx, sellerId)` | The new state, or `seller-access.reapply-limit` | `own-resources` of the Seller Owner, allowed when not approved | 9 |
| `notifyAccessReviewers(ctx, sellerId)` | Nothing | `system` | With `sellers` |

"Who is this request from?" is the `ActorContext`; "may this actor do X?" is the gate. Other
modules never ask for role or membership tables (R8). Named and not built: the contact point of
an account (first needed by `sellers`, which must notify the sign-in address about a change of
business identity: sellers brief s5) and minting the token of a requested link (6.6).

**ADR-0019 (AI) check.** Nothing new is asked. An AI tool is a facade method that carries the
caller's `CallContext` unchanged to a wrapped use case (R3): the gate of 5.2, with no new rule,
actor kind or scope; a seller actor's seller comes from `ActorContext.sellerId` (4). `identity`
publishes no AI tool, no credential, session or token reaches a model, and model output never
reaches `AuthorisationCheck` (R2). Acting-as means "AI off" (R3), so `actingAs` joins
`ActorContext` with SEL-08 (4; decided by Ali, 14.1-14).

### 8.2 Events published
`<module>.<subject>-<past participle>.v<N>` (ADR-0006 decision 1); payloads hold ids, codes and
permission keys only; no actor (ADR-0018 decision 4).

| Type | Aggregate | Payload |
|---|---|---|
| `identity.customer-account-registered.v1` | account | `accountId` |
| `identity.seller-registered.v1` | seller-access | `sellerId`, `ownerAccountId` or null, `origin` (`self` or `invitation`), `accessState`. Published at the owner's email verification for a self-registration (the `SellerAccess` records it, which is its version step) and at creation for an invitation, so no consumer sees a seller that the 7-day purge may still delete |
| `identity.account-email-verified.v1` | account | `accountId`, `population` |
| `identity.account-disabled.v1`, `identity.account-enabled.v1` | account | `accountId`, `population` |
| `identity.seller-access-approved.v1`, `-rejected.v1`, `-suspended.v1`, `-reinstated.v1`, `-reapplied.v1` | seller-access | `sellerId`, `decisionId` (absent for re-apply) |
| `identity.seller-member-added.v1`, `identity.seller-member-removed.v1` | seller-membership | `sellerId`, `accountId`, `roleId` (added only) |
| `identity.account-role-changed.v1` | role-assignment | `accountId`, `scope`, `sellerId` or null, `previousRoleId`, `roleId` |
| `identity.role-created.v1`, `identity.role-updated.v1`, `identity.role-deleted.v1` | role | `roleId`, `scope`, `sellerId` or null, `addedKeys`, `removedKeys` (R5) |
| `identity.one-time-link-requested.v1` | one-time-link | `linkId`, `accountId`, `purpose` |
| `identity.invitation-issued.v1` (also at a re-send), `-accepted.v1`, `-revoked.v1` | invitation | `invitationId`, `kind`, `sellerId` or null; `accountId` on accepted |
| `identity.account-password-changed.v1`, `identity.second-factor-changed.v1`, `identity.sign-up-repeated.v1` | account, second-factor | `accountId`; a `cause` or `change` code (`change` includes `locked`, which sends the HF2 alert) |

Each is declared with `defineEvent` from the closed payload vocabulary of the platform document
(5.3, PN6), one event per version step. Later consumers: `sellers` and `inventory` (SEL-10) for
`seller-registered`; `identity`'s own mail handlers for the events that cause a mail (9).

### 8.3 The split with `sellers` (I13; ADR-0018 decision 9)
| Question | Answer |
|---|---|
| Who mints the seller id | `identity`, when the `SellerAccess` is created (self-registration, or creation by an admin). `sellers` creates its record under the same id when it consumes `identity.seller-registered.v1`; until then a facade read of `sellers` answers "no profile yet" |
| Who owns the access state | `identity`: the four states of 3.3, the decisions and their reasons. It is the only state the sign-in decision and the gate read, in the same request, from `identity`'s committed data (ADR-0018 decision 3) |
| Who owns membership and seller-scoped roles | `identity` (R8) |
| What `sellers` owns | The business: profile; the business identifier, its register lookup and its uniqueness among approved and suspended sellers; each submission (an immutable snapshot) and its review; re-review after a change of business identity (sellers brief s5). None of it is read at sign-in |
| How the state changes once `sellers` exists | Only through `identity`'s use cases, called synchronously through the facade; never from an event. `sellers` checks its own preconditions first and then calls |
| "May this seller sell right now?" | **One contract, in the `sellers` facade** (final name at the sellers G2; ADR-0022). It answers yes only if `identity.sellerAccessOf` is `approved` **and** `sellers`' own conditions hold; it fails closed. `catalog`, `cart`, `ordering` and the storefront ask `sellers` only. `identity` cannot own it: it would need `sellers`' state (R7) |
| Two enforcement points | Actions by the seller's own accounts: the gate (state from `identity`, every request). Actions by others on the seller's offers: the may-sell contract. The second can only narrow the first |

### 8.4 ADR-0022 "Seller access state and the may-sell contract"
It crosses `identity`, `sellers`, `catalog`, `cart` and `ordering`; ADR-0018 decision 9 left it
to G2 and the sellers brief (s11) waits for it. Decided by Ali (14.1-1): Ali writes it now, in its
own PR; Mohammad and Hassan review; it is accepted with the G2 approval. Its points, as Ali
outlined them:

| # | Decision |
|---|---|
| 1 | `identity` mints the seller id. It owns the access state, each decision and its reason, the decision mails, membership and seller roles (the sellers brief assumes this: its s3 and s4) |
| 2 | The access state changes only through a synchronous `identity` use case, never from an event. No other module stores a copy; the sellers list reads it through `sellerAccountSummaries` |
| 3 | Sign-in and the gate read only `identity`'s committed state |
| 4 | Once `sellers` has its review, approve and reject go through it: it checks its file (a current submission exists; the business identifier is not held by another approved or suspended seller), locks that submission, then calls the facade with the submission id as `basisId`. `identity` stores the id on the decision and publishes it; `sellers` closes the submission when it consumes the event. `identity`'s own approve and reject endpoints are removed in that slice; suspend and reinstate stay in `identity` (SEL-07) |
| 5 | When approval is not required, `autoApproveSellerAccess` (called by a `sellers` handler as the system actor) runs only when every check passes: the register answers "active", no mismatch is flagged, the identifier is free (sellers brief s5). Otherwise the seller stays `pending` for a person. The change to AC 5 is that slice's mini-review |
| 6 | One "may this seller sell" contract, in the `sellers` facade: `identity` says `approved` **and** `sellers`' own conditions hold. It fails closed and can only narrow. Catalogue, cart and ordering ask only `sellers` |
| 7 | Rejected alternative: a precondition port that `sellers` implements behind `identity`'s approve endpoint. One entry point, but a business check behind an `identity` use case, and a Phase 2 stand-in ("always satisfied") that fails open |

ADR-0022 point 6 answers for a set of seller ids in one call; `sellerAccessOf` takes a set too
(8.1), so the contract makes one `identity` call per request and ADR-0008 decision 5 needs no note.

### 8.5 Other requests of the sellers brief (its s7 and s11; board request 8)
| Request | Answer |
|---|---|
| Approve only with a "current submission" (mini-review 1) | Not an `identity` rule: `identity` does not know submissions. It is the precondition of 8.4 (4), and it replaces the Phase 2 behaviour (approve on name and email) when the entry moves. `identity` keeps its own guard (owner exists, email verified) |
| "Approval required" off: register result and unique identifier first | 8.4 (5). From that slice the initial state is `pending` in both settings and the automatic approval follows the checks. This changes AC 5 ("approved without admin action" at registration): a mini-review of the identity brief (ADR-0013 decision 4) |
| Re-confirm identity before `sellers` slice 10 (mini-review 2) | Designed here: the session records when its holder last re-entered the password, and the code when a factor is active; `hasRecentConfirmation` reads it. Built by that mini-review, because the identity brief (s3) gives the capability to Phase 5 with VER-10. "Only the Seller Owner may ask" is, in this design, a protected seller-scope permission under the narrowing of 5.4, not a fifth rule kind (decided by Ali, 14.1-3). Moving re-confirmation from Phase 5 to Phase 3 is one of the three later mini-reviews (14.1-12) |
| The moment "notify the admin" (mini-review 3) | Phase 2: when the Seller Owner's email is verified and the state is `pending` (flow A4, AC 16), from slice 9, where reviewers first exist (12.1); the handler is separate from verification. With `sellers`: after a submission; `sellers`' handler calls `notifyAccessReviewers`, `identity` resolves the recipients (active admins holding `identity.seller-access.approve`) and sends; the Phase 2 trigger is switched off in the same mini-review |
| ADR "Market settings editable by an admin" | `identity` only names it. It reads "approval required", "email verification required" and the policy values of 3 and 6 through one port, `IdentityMarketPolicy`, whose Phase 2 adapter reads Market configuration as code (brief s3). Constraints for that ADR: the store is platform infrastructure, not `sellers` (R7); a read is synchronous and sees a committed change at once; every change is audited. Effective dating (VER-09) and telling senior admins are that ADR's questions |
| Landing of a seller that is not approved | One route, Reza's S1 "Your seller account" (`ux.md` F5; the title stays): after sign-in, inside the limited shell, a status banner, the reason (owner only) and a steps card. The panel offers only routes whose use cases are on the allow-list of 5.2 and sends any other route to S1 (Jafar). A step is {owning module, title key, state, optional route}, with the states Done, To do, Waiting and Needs attention; `identity` supplies its three steps and their dates (8.6 row 4). A step with a route opens its own page in the limited shell and returns to S1; S1 holds no inline form, so `sellers` and later `certification` own their step pages, and the `sellers` states become banner variants (sellers brief s7). A suspended seller has no session: state and reason appear on the Auth template (brief s12). The page decides from the actor summary, never from a guess |

### 8.6 What the panel needs from the API (answers to `ux.md` 7.2)
| # | Request | Answer |
|---|---|---|
| 1 | Names for unnamed codes; password policy readable before submit | **Accept.** `sign-up.accepted`, `password-reset.accepted`, `verification-resend.accepted`; `link.rejected` and `invitation.rejected` (one answer for every cause); `password.rejected` with `details.rule` (`length`, `common`, `contains-identity`); `password.current-incorrect`; `second-factor.code-rejected`, `second-factor.challenge-ended`; `role.in-use`, `role.read-only`, `role.limit`, `role.not-grantable`; `member.limit`, `member.last-holder`, `member.self`, `member.outranks-actor`; `seller-access.reason-required`, `seller-access.wrong-state`, `seller-access.reapply-limit`; `validation.failed`. Added at review: `request.busy` (6.5), `role.name-taken` (M10), `second-factor-enrolment.accepted` (the enrolment link was sent, 3.6), `second-factor.locked` with `retryAfterSeconds` (6.3 step 5), `invitation.already-pending` (3.4) and `validation.failed` with `details.rule` `characters` (HF13). The names match Jafar's change 3. An anonymous read returns the password rules of a population and the invitation lifetimes by kind (`ux.md` 7.2) |
| 2 | Display name, email and role name after sign-in; reason and its date on S1 and A10 | **Accept.** The HTTP actor summary adds them to the facade's ids and codes; the status read returns the reason (owner only) and the instant of the decision. The status read also says whether a re-application is still possible, so the panel shows "Changes needed" or "Not approved" (Jafar). Responses to the person entitled to see them may hold personal data; events, logs and audit rows may not |
| 3 | No second typing of the password after confirming an email | **Accept, as proposed:** confirming is the sign-in sequence with the link's token (6.3), so a correct password ends in a session unless a later step stops it. Accepted by Hassan, under full throttling, the link consumed only on success (14.2) |
| 4 | Dates of the finished steps on S1 | **Accept:** account creation, email confirmation, last decision |
| 5 | Invitation preview for a valid token | **Accept:** an `anonymous` use case, token in the body: kind, invited email, role name, whether the address already has an account and, for a Staff invitation only, the inviter's display name. Any invalid token: `invitation.rejected` |
| 6 | Allowed actions per row with denial codes; a grantable flag per permission | **Accept.** List reads return, per row and action, `allowed` and a denial code, computed by the `GrantPolicy` and `LastHolderPolicy` of 5.5; the catalogue read returns `grantable` per key. They are hints: every command checks again |
| 7 | Role limits, "Duplicate", action vocabulary | Limits: 2.3. "Duplicate" is the create use case with the keys of the source role; no new use case. Vocabulary: not closed (5.1) |
| 8 | P1 list, search, a pending reset | **Accept:** sellers whose owner confirmed the email, and open seller invitations; filter by state; search by exact email only (11.2); a row shows "reset awaiting the owner" with its expiry |
| 9 | Session expiry for an idle warning | **Changed:** the summary returns the idle timeout as a duration and the absolute expiry as an instant; the panel counts idle time from its own last request. A read of "time left" would itself count as activity. Accepted by Hassan, provided the panels make no timer-driven calls |
| 10 | `account.disabled`, `membership.none`, re-enabling | **Decided by Ali** (14.1-8): inside G1's scope; the screens keep them |
| 11 | P1 after Phase 3 | Yes: approve and reject move to the `sellers` review page (8.4); suspend, reinstate, seller invitations and the owner-confirmed reset stay `identity`'s |
| 12 | One list of owner questions | **Accept:** 14.4 |
| 13 | Second round (`ux.md` 7.2): more codes, lifetimes by kind, the re-apply limit, admin acceptance with the A8 code | Items 1 and 3: **accepted**, in row 1. Item 4: row 2. Item 2: **accepted** in 3.4 (HF6) |

## 9. Email in Phase 2

| Topic | Design |
|---|---|
| Transport port | `MailTransport.send(message)` in `platform/mail/`: address, subject and body already rendered; no templates, no business rules. Phase 2 adapter: the local mail catcher, over HTTP or SMTP after spike 4. Decided by Ali (14.1-5): `platform/mail/`, port and adapter only, with an inline note on ADR-0008 decision 2 in ADR-0023; `sellers` will need the same transport before `notifications` exists (Phase 6) |
| Sender in `identity` | Handlers subscribed to `identity`'s own events (link requested, invitation issued, email verified, the access decisions, password and second-factor changes, repeated sign-up), in the worker, as the system actor. Order (PN2): a read-only unit loads the account and decrypts what is needed; the token is minted and the mail rendered and sent outside any unit; then `runOnce` stores the token hash and the inbox row. Mail is therefore at least once: a crash between send and record repeats the mail, with a new token |
| Consequence, and the alternative | This is the first subscription, so the delivery side of the platform document (its 6.4) is built in slice 3, not with `sellers`. Alternative: a mail-request table in `identity` read by a scheduled job, which needs only the scheduler but builds a second retry mechanism that is thrown away in Phase 6. Decided by Ali (14.1-6): the subscription; `notifications` will subscribe to the same events |
| Translation keys (INTL-11) | `identity.mail.<template>.subject` and `.body`, in locale files of the module with named placeholders; no ICU library in Phase 2 (no plural is needed). Locale: the Market's default locale. Lifetimes are written as durations ("valid for 60 minutes"), so no zone is needed (ADR-0005 decision 3) |
| Templates | Verify email; welcome (seller); notify reviewers; approved; rejected and suspended (with the reason, to the owner only); reinstated; password reset; password changed; second factor changed or reset, and the owner's reset confirmation; the enrolment link (HF6); the alert after ten failed codes (HF2); the three invitations; "you already have an account". Each names the account type (decision 5, AC 3). Display names and role names are escaped in every mail (HF13) |
| Link targets | A port `LinkTargets(market, population, purpose)` backed by configuration per Region Stack, because the storefront does not exist and hosts are not decided (brief s6) |

## 10. Audit and sign-in records (I8)

| # | Record | Design |
|---|---|---|
| 10.1 | `platform.audit_log` | One row per successful action of AC 11 and AC 27, in the transaction of the change, through the audit writer (slice 6). Actions are named `identity.<subject>.<verb>`, for example `identity.seller-access.rejected`, `identity.role.updated`, `identity.invitation.accepted`. `before` and `after` are allow-listed ids, state codes and permission keys; never an email, a name, a role name or a reason (R5, VER-13). The reason text lives in the `AccessDecision` of `identity`, encrypted (11.3); the row holds the decision id |
| 10.1 | Anonymous audited actions | Three audited actions have no account yet or no session: accepting an invitation (an admin's with its factor), activating a factor from an enrolment link, and the owner confirming a reset by link. They need the actor type `ANONYMOUS` (no actor id; the target names the account or the invitation), added to the CHECK in slice 6, before the writer's first row (accepted by Ali, A3). The founding assignment at self-registration writes no row (5.5) |
| 10.2 | Sign-in records, an `identity` table | Every sign-in attempt of every population: Market, population, account id or null, outcome code, instant, origin address, session id, correlation id; never the typed email. It has retention (90 days, with the full address: Hassan, H3) and a purge job, which an immutable table cannot have, and it carries the origin, which the audit log must not (brief s9) |
| 10.2 | Admin sign-ins | In addition, a **successful** admin sign-in writes one audit row (`identity.admin-session.opened`): bounded volume, no personal data, and tamper-evident where it matters most (AC 11; accepted by Hassan) |

## 11. Personal data (I6)

**11.1 Fields.** Personal: email, display name, invitation email, origin address in sign-in
records, the reject or suspend reason and custom role names (free text). Secret: the password
hash, the second-factor secret, token hashes, recovery-code hashes. Display names and custom
role names refuse control characters, bidi characters and URL-like text, and are escaped in
mail (HF13).

**11.2 Email uniqueness and lookup.** `SubjectKeyService` cannot search (PF 4 row 4).

| Option | For | Against |
|---|---|---|
| A (decided). Email and name as plain live columns; unique on (Market, population, normalised email) | A database constraint gives ADR-0018 decision 3 directly; exact search for support; one read per sign-in; ADR-0009 decision 6 binds history, and live rows can be overwritten at erasure | A database dump shows addresses; protection is disk encryption and grants |
| B. Encrypt both; add a lookup hash under a stack-level key, unique per (Market, population) | A dump without keys shows no address | A second key system with its own rotation; one unwrap per row with no key cache (PF 4 row 9), so a team list or a mail run costs a key operation per person; no partial search |

A, accepted by Hassan (H1: with encrypted disks and backups); B is a later migration if the
penetration test or a legal review asks for it.
Normalised means trimmed, NFC and lower-cased; no provider-specific rewriting.

**11.3 Encrypted with `SubjectKeyService`:** the second-factor secret and the `AccessDecision`
reason. **Subjects:** an account id (a person) and a seller id (seller-level text may predate an
owner). The key is created with the account or the seller in the same unit (PF 4 row 8), from
slice 1d on. An invitation is not a subject: under option A its email is a plain live column,
deleted with the invitation (under B it would reserve the invitee's account id). Repositories
turn a unique violation into a domain error; no driver detail is logged (I15; platform document
12.3). Erasure and the unverified purge are a hard delete of the account row (decided by Ali, A2,
under Hassan's H5): only they use the application role's `DELETE` on accounts, and in Phase 2
only the purge job deletes accounts.

## 12. Slices

### 12.1 Order, relative size and security gates
The order of brief s11 is confirmed with the changes marked **Δ**, decided by Ali (14.1-7). One
slice is one branch and one PR (rule 13), so slice 1 is built as 1a to 1d and slice 8 as 8a and
8b. Sizes are relative and for the backend: S = one use case on existing mechanisms; M = a few
use cases or one new aggregate; L = a new security-relevant mechanism; XL = several. The last
column is what Hassan checks at that slice's review (HF numbers, 14.2), on top of the security
review every slice of this module gets.

| # | Slice | Size | Reason, and changes | Hassan checks |
|---|---|---|---|---|
| 0 | Platform prerequisites | L | Seven PRs, designed in PF 7 | — |
| 1a | UnitOfWork, `market_id` guard, model map and ownership check | L | **Δ** Tested on `AuditLog` (platform document PA8) | HF10 |
| 1b | Events, outbox writer, `identity.outbox`, relay, bus port, scheduler, `APP_ROLE` | L | **Δ** `identity.outbox` lands here, not with the first account (M9, decided by Ali) | — |
| 1c | `SubjectKeyService`, `ActorContext` and `CallContext`, the gate with its CI check and rule 9 | L | **Δ** | HF4, HF9 |
| 1d | Customer registration: the first account | M | **Δ** Bagher checks the ADR-0015 decision 3 triggers here ("in the same change" reads "no later than, never after": ADR-0023). The dependency list is approved before it merges (14.4) | HF12; the parameters of 6.5 |
| 2 | Sign-in, sign-out, sessions, throttling | L | `Authenticator`, actor and CSRF guards, throttle and sign-in tables; the first slice the penetration test will aim at | HF1, HF3, HF7, HF11, HF14; a timing test |
| 3 | Email verification | L | One-time links, mail transport and handlers; **Δ** the first subscription, so the delivery side of the event bus lands here (9); purge job | HF15 |
| 4 | Password reset and change | M | Reuses slice 3 | — |
| 5 | Seller account and limited sign-in | L | `SellerAccess`, membership, outcome codes, the allow-list. **Δ** the role and assignment model with the two system roles seeded lands here, so the Seller Owner holds a real role from the first seller; `membershipOf` for oneself only (8.1); the reviewer mail moves to slice 9, where reviewers first exist | — |
| 6 | Audit writer, hash chain, sealer | L | Own design, not written yet; slices 7 onward wait for it | — |
| 7 | Admin account, first admin, second factor, admin sign-in | L | TOTP, challenge, recovery codes, operator routine, the enrolment link. The `Invitation` aggregate (kind `admin`, acceptance with enrolment) lands here because the first admin is invited | HF2, HF6 |
| 8a | Registry, catalogue, default roles, assignment | L | **Δ** split from 8. `GrantPolicy`, `LastHolderPolicy`, the permission path of `AuthorisationCheck`; `membershipOf` for other accounts | HF5, HF8 |
| 8b | Admin invitation, disabling accounts, admin second-factor reset | M | **Δ** Uses 8a | — |
| 9 | Approve, reject, suspend, reinstate, seller by invitation | L | Decisions with encrypted reasons, the decision mails and the reviewer mail, re-apply behind the facade | HF13 |
| 10 | Role editor (both scopes) | M | Three use cases on 8a | — |
| 11 | Seller team | M | Staff invitation and acceptance, role change, removal | HF5, HF8 |
| 12 | Optional second factor for the seller side | S | Reuses slice 7; adds the owner-confirmed reset | — |
| 13 | Panel screens | XL | Sized by the frontend track; blocked on D1, D2 and F0; parallel from slice 5 | — |

**Estimate for the owner** (Ali, 2026-10-03). Identity is 17 backend steps: slices 0 to 12, with
slice 1 in four parts and slice 8 in two. That is about 25 pull requests. Nine of them carry
identity's database migrations (slices 1b, 1c, 1d, 2, 3, 5, 6, 7 and 9: data design 8.1), which
must merge one at a time, and every one needs a security review. The panel screens come on top of
that. The riskiest steps are slice 2 (sign-in and sessions), slices 8a and 10 (permissions and
the role editor), and slice 6, which is not designed yet and blocks everything from slice 7 on.
The PLAYBOOK's three weeks is not realistic; with no measured speed for code slices yet there is
no date: Javad sets one from the real pace once slices 0 and 1 have merged.

**Penetration test, Hassan's additions:** parallel guessing and IPv6 address rotation; forged
forwarded headers; TOTP guessing across challenges; timing-based account enumeration; cookie
tossing; tokens used across populations, Markets and transports; adding an owner to an existing
shop; races on the last role holder; second-factor resets obtained through support.

### 12.2 Platform triggers (ADR-0015 decision 3) and their slice
| Trigger | Slice |
|---|---|
| UnitOfWork; `market_id` guard; "model to owning module" rule | 1a |
| `DomainEvent`; outbox, relay, the publish side of the event bus, scheduler runner, `APP_ROLE` | 1b |
| `SubjectKeyService`; `ActorContext` (anonymous, system), `CallContext`; `UseCase` base class, `UseCaseGate`, the CI check, boundary rule 9, the checked-in lists | 1c |
| Generic rate limiting | After the owner approves 13; before slice 1d's endpoint merges |
| `Authenticator`, `AuthorisationCheck`, the actor guard, the CSRF check, `authenticatedActor` | 2 |
| `MailTransport`; the delivery side of the event bus: `platform.event_delivery`, dispatcher, back-off, dead letter, `identity.inbox`, `runOnce` (first subscription; platform document 6.4) | 3 |
| Jobs (PN4), each deleting only what is already invalid and safe to run twice: `identity.purge-expired` (sessions, challenges, links, invitations, throttle counters, sign-in records past retention), hourly, slice 2; `identity.purge-unverified-accounts`, daily, slice 3 | 2, 3 |
| Audit writer, seal table, sealer; `ANONYMOUS` in the actor CHECK | 6 |
| Permission registry | 8a |
| Redis client | Not triggered by `identity`; only if the generic limiter needs a shared store |

### 12.3 Spikes still needed (run, not merged)
| # | Spike | Status |
|---|---|---|
| 1 | Built-in argon2 | **Done 2026-10-07.** Node's docs mark `crypto.argon2` "Release candidate" on 24.15.0 and stable from 24.19.0 (#63924); 24.20.0 fixes its validation errors (#64852) and a FIPS bypass (#64776). Decided by Ali: the minimum becomes 24.20.0 (ADR-0021 decision 3), no package. Our PHC strings (argon2id, m=65536, t=3, p=1, 16-byte salt, 32-byte tag) and those of the reference argon2-cffi 25.1.0 verify each other, wrong passwords refused. 4-core container: one hash about 200 to 300 ms on 24.21 (about 400 ms on 24.15); 20 requests with at most two at once: p50 1.05 s, p95 2.1 s on 24.21, event loop responsive. Parameters and the queue of 16 unchanged; the hasher slice tests that the 17th waiting request gets `request.busy`, and the median is re-measured on the deployed hardware. Before: RFC 9106 vectors (argon2id, argon2i, argon2d) pass on 24.9.0 (this design), 24.21 (Hassan) and the ADR-0021 minimum 24.15.0, with no experimental warning (ADR-0021 evidence, 2026-10-03). Left: the API's documented stability index on 24.15, with the fallback package if it is not stable (6.5); PHC strings checked against a reference implementation; the pool under load with at most two hashes at once |
| 2 | TOTP on `node:crypto` | RFC 6238 SHA-1 vectors pass on 24.9.0, 24.21 and 24.15.0 (ADR-0021 evidence, 2026-10-03). Left: enrolment with three common apps (URI and base32). **2026-10-07:** our `otpauth://totp/` URI (issuer and label percent-encoded, 160-bit secret in unpadded base32, SHA1, 6 digits, 30 s) is parsed by the reference pyotp, which derives the same key and the same codes at -30, 0 and +30 s. Scanning with three real apps needs a phone: done with the owner in slice 7 |
| 3 | Rate-limiter package under NestJS 12, ES modules and the Jest flag; its store | **Done 2026-10-07** on 24.15 and 24.21 under `--experimental-vm-modules`: `@nestjs/throttler` 6.7.1 (peer range includes NestJS 12) as a global guard answers 429 after the limit, keyed by the socket address (a forged `X-Forwarded-For` changes nothing); its default answer text must be replaced by our fixed code. `rate-limiter-flexible` 11.2.1: memory store, and a PostgreSQL store that needs no Redis. Both MIT or ISC, no dependencies, no install script |
| 4 | Mail catcher: HTTP send interface of the pinned image, or SMTP | **Done 2026-10-07** with Mailpit v1.27.11 (what the `v1.27` tag points to): `POST /api/v1/send` (JSON from, to, subject, text, HTML, headers) accepts a mail through `fetch`, and tests read it back through `/api/v1/messages`. No SMTP client is needed. The deployed provider's transport is chosen with the first environment |
| 5 | `__Host-` cookie through the front tier on local `http`, Safari included | Open; needs D2 (separate hosts, HF7) |
| 6 | Cost of the two per-request reads; single-use consumption, the attempt reservation (HF1) and a serialisable retry through Prisma under the guard | **Done 2026-10-07** (Hossein; closed by Mojtaba): all five checks passed; results in data design 3.4, 3.5, 3.9, 5.1, 8.4, 9 and 10, report in the shared folder `phase-2/spikes/spike6/`. Decisions from it: the market guard needs a top-level `marketId` beside a compound selector and strict equality inside it (Mohammad, Hassan; P 4.1); the retry classifier reads the SQLSTATE in two places (P 3.1 row 7); read-only units open no transaction and READ COMMITTED is checked at boot (Ali, ADR-0025; Hassan's conditions); `lock_timeout` 3 s and a 2 s pool bound (Kazem; P PK1, 3.1 row 8); no named prepared statements (data platform.md 10.9); PM6 mandatory |

## 13. Dependencies (the one list for the owner, ADR-0018 decision 8)

| Need | Node 24 standard library (minimum 24.20.0 since 2026-10-07, ADR-0021)? | Candidates and criteria | Recommendation |
|---|---|---|---|
| Password hashing | Yes: `crypto.argon2` (spike 1) | Fallbacks if the spike fails: `@node-rs/argon2`, `argon2`, `hash-wasm`; criteria: no install script (ADR-0014 decision 5), PHC output, maintained | **No package (final, 2026-10-07):** the minimum is 24.20.0, where it is stable (spike 1) |
| TOTP, base32, recovery codes | Yes: HMAC and random bytes (spike 2) | `otplib` | **No package** |
| Session and link tokens, CSRF token | Yes: random bytes, SHA-256, HMAC, constant-time compare | — | **No package** |
| Cookie reading and writing | Yes, with the installed HTTP adapter: a strict reader for our own cookie names; `Set-Cookie` through the response | `cookie-parser` | **No package** |
| Sign-in throttling | Yes: counters in PostgreSQL (6.8) | — | **No package** |
| Generic rate limiting per origin | No | `@nestjs/throttler`, `rate-limiter-flexible`; criteria: works under NestJS 12 and the test setup, memory and shared stores, no install script | **One package, named after spike 3**; a Redis client only with a second API instance |
| Sending mail | Partly: `fetch` covers an HTTP interface | `nodemailer` if only SMTP is available | **None if spike 4 passes; otherwise `nodemailer`** |
| Mail templates | Yes: named placeholders | An ICU formatter, with `notifications` | **No package in Phase 2** |
| Common-password list | A checked-in data file, not a package; its licence is checked | — | **Data file** |
| QR code at enrolment | No (browser side) | Chosen by the frontend track with D1, drawn in the browser, never by a remote service (Hassan); text entry of the secret always works | **Frontend list, not this one** |
| Key service client for the deployed `KeyWrapper` | No | Named when a deployed environment exists (PF 10) | **Later; Kazem** |

At most a rate limiter goes to the owner, plus an SMTP client or a password-hashing package only
if spike 4 or spike 1 fails. Never (Hassan): an authentication framework, `jsonwebtoken`, a
package with an install script, or a remote QR or CAPTCHA service. The list is sent once, after
spikes 1, 3 and 4, and is approved before slice 1d merges (14.4).

## 14. Review record and open points

Reviewed on 2026-10-03 by Ali, Hassan and Jafar. Their decisions are recorded here and applied in
sections 1 to 13; only 14.5 item 3 is open. ADR numbers are the board's (header). PA1 to PA8 are recorded
in the platform document, 16 (a). Of Ali's A1 to A8 on the data design (its 11.1), this design
carries A2 (11.3), A3 (10.1), A4 (2.1) and A6 (6.8).

### 14.0 Alignment (2026-10-03): what was decided where the G2 documents disagreed
| # | Point | Decision, and where it now stands |
|---|---|---|
| 1 | Who opens the unit of work | The use-case body (platform document 3.4, option A). A use case opens at most one read-write unit; a read-only unit may come first when slow work needs stored data. Where attempts are counted, one short reservation unit may also come first (HF1). The platform document's 3.1 row 5 and PN2 say the same; here 3, 5.2, 6.3, 9 |
| 2 | A refusal that must persist (a failed sign-in) | An `ok` outcome of the unit, turned into the error after the commit (PN1); here 6.3 |
| 3 | Mail "in one step" | Removed. Read, send outside any unit, then record with `runOnce`: mail is at least once (3.7, 6.6, 9) |
| 4 | The consume side of the event bus | `identity` subscribes to its own events for mail, which is the first subscription: the delivery table, dispatcher, inbox and dead letter are built in slice 3. The platform document's 6.5, PA1, PM3 and PM4 now say so |
| 5 | "Lock anchors" for the last-holder rules | Dropped. Those use cases, and every writer they count, run `serializable` (PN5, HF8); no raw SQL helper in Phase 2 (5.5) |
| 6 | Events | The names of 8.2, declared with `defineEvent`; a `mail-requested` event was replaced by domain events. One event per version step, hence the notice instant on `Account` (2.1) |
| 7 | Jobs and slices | Two jobs, named in 12.2 and in the platform document's section 7; slice 1 is built as 1a to 1d in both (PA8) |
| 8 | The sellers brief (now on `main`) | 8.3 to 8.5 corrected: the submission id as `basisId`; uniqueness of the business identifier is `sellers`' check; `sellerAccountSummaries`; re-confirmation is built by its mini-review. No way leads from `rejected` to `approved` without a new application; the way out of the final `rejected` state belongs to the `sellers` G2 (14.1-8) |
| 9 | `ux.md` and ADR-0019 | 8.6 answers Reza; confirming an email completes sign-in. ADR-0019 needs nothing new (8.1) |

### 14.1 Decided by Ali 2026-10-03
| # | Point | Decided by Ali 2026-10-03 |
|---|---|---|
| 1 | The ADR of 8.4; approve and reject entered through `sellers` from Phase 3 | Accept. ADR-0022, written now in its own PR; Mohammad and Hassan review; accepted with the G2 approval. The facade route: the precondition port fails open (8.4) |
| 2 | R1 across scopes, and the founding assignment next to R3 (5.5) | Accept both readings. Across scopes the platform permission decides, and a Seller Owner's reset still needs the owner's link confirmation (7.3). A founding assignment is not a grant; at self-registration (slice 5) it writes no audit row (10.1) |
| 3 | The Phase 2 narrowing of R11, also used for `sellers`' "Seller Owner only" (5.4, 8.5) | Accept: it is G1's "only the Seller Owner manages the team"; no new rule kind |
| 4 | `anonymous` admits authenticated actors; the credential names its transport (5.1) | Accept; the system actor never satisfies `anonymous`. Mohammad writes it back to PF 6.2 row 1 and 6.3 (15.1) |
| 5 | `MailTransport` in `platform/mail/` (9) | Accept: port and adapter only, no templates; an inline note on ADR-0008 decision 2, in ADR-0023 |
| 6 | `identity` subscribes to its own events; the delivery side lands in slice 3 (9) | Accept: "consumes none" (brief s6) means other modules' events. Hadi adds a change-log row (15.2) |
| 7 | The slice changes of 12.1 | Accept. Slice 1 is built as 1a to 1d, one branch and one PR each, so rule 13 holds; ADR-0015's "same change" reads "no later than, never after" (ADR-0023); `identity.outbox` lands in 1b |
| 8 | What the brief does not name (3.1, 3.2, 3.3, 6.3, 6.7, 7, 9) | Accept everything except "allow another application", which moves to the `sellers` G2 because re-apply has no caller in Phase 2 (3.3). The rest is inside G1's scope (below) |
| 9 | "List and revoke my sessions" (6.4) | Not in Phase 2 |
| 10 | The error body of 5.2 for every module (I12) | Accept; binding through PF 5.1, with no ADR |
| 11 | The three G1 wordings: R9 "in seller scope", R10, R12 "approved seller" for Staff only | Confirmed: they follow G1's intent (AC 31) |
| 12 | Three mini-reviews of the identity brief in the `sellers` slices (8.4, 8.5) | Accept; Hadi puts them on the board (15.2) |
| 13 | ADR-0014's minimum, Node 24.9, where `pnpm install` fails under `engine-strict` | Raised to 24.15, the lowest version the lockfile installs under `engine-strict`: ADR-0021 amends ADR-0014 decision 1, and `engines` and `CLAUDE.md` change in the same PR. The argon2 and TOTP vectors are re-run on 24.15; if `crypto.argon2` is not stable there, the fallback package is used (6.5, 12.3). **2026-10-07:** it is not stable on 24.15; the minimum is raised to 24.20.0 instead (ADR-0021 decision 3, Ali), no package |
| 14 | ADR-0019 R3: an acting-as session switches AI off | Nothing now; `actingAs` joins `ActorContext` with SEL-08 (4) |

**Scope (Ali).** Nothing from G1 is dropped and every owner answer is honoured. Re-enabling a
disabled account, the emails E12 to E15 and screen A11 of `ux.md`, customers confirming their
email before their first session, and `identity` subscribing to its own events fall inside what
G1 left to G2. This G2 (Ali and Hassan) is their mini-review; Hadi records them in one change-log
row (15.2), and the owner is informed, not asked.

### 14.2 Decided by Hassan 2026-10-03
G2 is recorded only once his findings 1 to 8 and `ux.md` F6 are in the documents; they are. Every
number in 6 and 7 is his. Where each stands (12.1 names the slice where he checks it): HF1 6.3,
6.8; HF2 6.8, 7, 9; HF3 6.8; HF4 5.2; HF5 3.4, 5.5, 7.4; HF6 3.4, 3.6, 6.3, 7; HF7 5.2, 6.4; HF8 3.1,
5.5; HF9 5.1, 5.2; HF11 3.5, 3.6, 6.3; HF12 6.3, 6.7; HF13 2.1, 9, 11.1; HF14 6.2, 6.4; HF15 3.4,
6.6. HF10 is the platform document's 4; HF1 and HF8 read the same there (3.1 rows 5 and 6).

**His answers, now decided.** H1 to H8 of the data design: plain email and name columns, with
encrypted disks and backups (11.2); recovery codes under `SubjectKeyService.hmac` (7.3); the full
origin address for 90 days (10.2); a throttle secret of 32 random bytes, required at boot and never
logged (6.8); `DELETE` on accounts for the purge and erasure only (11.3); H6 yes, with the grants
tested; H7 and H8 yes. Accepted from the earlier list: unkeyed SHA-256 for token hashes; the
derived CSRF token with a constant-time compare; confirming an email with the password, which
completes sign-in under full throttling and consumes the link only on success; the codes told after
full authentication, and the allow-list of 5.2; re-checking at acceptance that the inviter is still
active and could still grant the role; the invitation preview; the admin sign-in audit row; the
native-client paragraph, with HF14. AC 18: the revocation coverage is complete. The expiry warning
(8.6 row 9): accepted, provided the panels make no timer-driven calls. `ux.md` 7.3: confirmed, with
a not-found answer byte-identical to a real one (5.2) and a written support check before an owner's
reset (7.3). Dependencies: only the rate limiter, and maybe SMTP (13). Penetration-test additions:
12.1. At the final check he decided 14.5 items 1 and 2 and accepted the 15-minute tag of 3.4.

### 14.3 Answers to Mojtaba (data design 11.3 and 11.4)
| # | Answer |
|---|---|
| M1 | Confirmed (Ali, A4): `Session` and `SignInChallenge` carry no version (2.1). The other tables listed change by single guarded statements or through their root, whose version rises |
| M2 | Yes: the idle timeout and the absolute expiry are stored, both fixed at creation (2.1, 6.1) |
| M3 | Yes: `SecondFactor` has its own id, new at every enrolment; any aggregate deleted and created again gets a new id (2.1) |
| M4 | Confirmed: `origin` and the instant `seller-registered` was recorded are fields of `SellerAccess` (2.1, 8.2) |
| M5 | Yes: a repeated sign-up restarts the 7 days. The anchor is the instant of the latest sign-up, a field of its own, not `created_at` (2.1, 3.1) |
| M6 | Confirmed: the row is deleted 30 days after its absolute expiry (6.1) |
| M7 | Yes: a new `seller-owner` invitation may name that seller id, because its `SellerAccess` never had a member (3.4, HF5). Replacing an expired pending row and erasing the address are confirmed |
| M8 | No decision row: "allow another application" is not in Phase 2 (14.1-8). One reused link row per account and purpose is confirmed (2.1) |
| M9 | `identity.outbox` lands in slice 1b (decided by Ali; 12.1) |
| M10 | Confirmed: display names of 1 to 100 characters, role names of 1 to 80. A custom role's name is unique within its seller, or within its Market's platform scope, after trimming, NFC and lower-casing, so it needs a constraint; a clash answers `role.name-taken` (2.1, 8.6) |
| M11 | Confirmed: fixed windows with a block instant (6.8) |
| M12 | Accepted: one pending `seller-owner` invitation per seller, answered `invitation.already-pending` (3.4) |
| M13 | Accepted as recommended: a nullable `pending_secret_ciphertext` on `second_factors`, added with the table in slice 7 (3.6, 7.5) |

### 14.4 The owner list (Ali's final; one list with `ux.md` 7.4)
**Owner decisions, 2026-10-03:** question 1, the ready-made roles of 5.6 are approved as a
starting set; question 2, yes, one support email address per Market, read by a named person, with a
written identity check before a shop owner's second factor is reset (the address and the person
are set before the first real account). Question 3 comes after spikes 1, 3 and 4.

| # | Question, in plain words | Team recommendation |
|---|---|---|
| 1 | Are these ready-made roles, six for admins and six for shop staff, the right start? (5.6) | Approve them as a starting set. Changing them later is a cheap, reviewed change, and the seller interviews have not been held yet |
| 2 | One support email address per Market, with a written identity check before a shop owner's second factor is reset? (7.3; `ux.md` 7.4) | Yes, with a named person who reads it. Without it a shop owner who lost their phone has no way back in. Needed before the first real account |
| 3 | The dependency list (13), sent once, after spikes 1, 3 and 4 | Approve. It holds at most a rate limiter, plus an email or password-hashing package only if a spike fails. It must be approved before slice 1d merges |

Told, not asked: "keep me signed in" for sellers only, opt-in, at most 30 days, with Hassan's
numbers (6.1; brief s7 leaves it to the team); the rejection and suspension wording, option (a) of
Jafar and Hadi, which the owner sees in the screenshots (3.3); customers confirm their email before
their first sign-in (3.2); three re-applications (3.3); the estimate of 12.1.

### 14.5 Still open
| # | Point | Status |
|---|---|---|
| 1 | A seller-side account's first, optional enrolment (`ux.md` 7.3 item 1) | Decided by Hassan 2026-10-03: it starts from the mailed link (E16), like every enrolment outside an admin's invitation acceptance, because from Phase 5 the Seller Owner's factor proves a payout-account change (VER-10). 3.6 stands |
| 2 | PH2 to PH4 of the platform document | Decided by Hassan 2026-10-03 (platform document 16 b). PH4 is due before the first deployed environment: separate api and worker database roles (Kazem, Mojtaba) |
| 3 | As in section 1: the audit writer's design before slice 6; the may-sell contract's final name, the way out of the final `rejected` state and the approve entry, at the `sellers` G2; the owner list (14.4) | **Open:** Ali; the `sellers` G2; the owner |
| 4 | This revision | Approved at G2, 2026-10-03 (Ali, Hassan) |

## 15. Follow-up changes

The review edited this document, `docs/design/domain/platform-persistence-and-events.md` and, at
the final pass, `docs/design/domain/platform-foundations.md` (15.1); `ux.md` is Reza's.

| File | Change | When, by whom |
|---|---|---|
| `docs/design/domain/platform-foundations.md` | The text of 15.1 | **Done** 2026-10-03; Mohammad |
| ADR-0021, ADR-0022, ADR-0023 | 14.1 items 13 and 1; the notes on ADR-0004 decision 5 (naming the reservation unit of HF1 too), ADR-0006 decisions 4 and 7, ADR-0008 decision 2 and ADR-0015 decision 3 | Ali, in parallel; accepted with the G2 approval |
| `docs/design/data/identity.md`; `docs/design/data/platform.md` | **Done** (ca63d97, 819331c): 3.10 creates an admin's factor `active` at acceptance (3.4) and adds `pending_secret_ciphertext` (M13). Left: a display name on `seller-owner` invitations, kept until acceptance (3.4, Jafar). In platform.md, 10.2 and 10.5 amended on its open branch before it merges (A1); `ANONYMOUS` in the actor CHECK before the writer's first row (A3) | Mojtaba, after this revision |
| `docs/modules/identity/ux.md` | 8.2 cites ADR-0022 for the may-sell ADR; 7.3 item 1 is decided by Hassan (14.5) | **Done** (05d337d); Reza |
| `docs/modules/identity/brief.md` | The G2 row of the approvals table; the change-log rows of 15.2; the section 12 table from `ux.md` section 4 (Reza fills it, Jafar approves) | With the G2 approval; Hadi |
| `docs/modules/README.md`, the board | G2 status; the ADR numbers; the board items of 15.2; requests 8 and 10 answered; the cookie topology and separate hosts (6.4, HF7) to the frontend track and the D2 ADR | Orchestrator |
| `config/markets/*.json`, `test/fixtures/markets/ZZ.json`, the Market configuration schema | The identity policy section (approval required, email verification, lifetimes, limits) | Slices 1d and 5; Hossein |

### 15.1 Text changes for `platform-foundations.md` (Ali, 14.1-4 and 14.1-13; HF9; done 2026-10-03)
| Where | Replace | With |
|---|---|---|
| Status, in the header | Kept as it is (coordinator) | A dated line under it: "Section 6 and 3.4 written back from identity's approved G2 design, 2026-10-03." |
| 3.4, the comment in the code block | `` // AuthenticatedActor: fields at identity G2; always has `marketId` and an account id `` | The `Population` type and the `AuthenticatedActor` interface of section 4 of this design, verbatim |
| 3.4, the row "Open" | The whole row | A row "6": "Decided at identity G2 (I1): `kind: 'authenticated'`, `marketId`, `population` (`customer`, `seller` or `admin`), `accountId`, `sessionId` (an id, never the token) and `sellerId` (set if and only if the population is `seller`, from the active membership). Roles, permissions, seller state and second-factor status never travel in it; `actingAs` is reserved for SEL-08. Its rules: identity design section 4." |
| 6, the status line | "**Status: proposed to identity G2; binding once G2 approves.** The signatures are provisional." | "**Status: approved at identity G2, 2026-10-03, with the changes of `docs/design/domain/identity.md` 5.1 (6.2 row 1, 6.3).** The mechanism is identity design 5.2." |
| 6.2 row 1 | "The system actor satisfies only `system`; the anonymous actor satisfies only `anonymous`." | "The system actor satisfies only `system`. `anonymous` means "no authentication required": it admits the anonymous actor and an authenticated one, never the system actor, and `platform/authz` passes the Market's anonymous actor to the use case, so nothing branches on, or is audited as, a signed-in visitor (identity G2)." |
| 6.3, `Authenticator` | `credential: string \| undefined,` | `credential: { token: string; transport: 'cookie' \| 'bearer' } \| undefined,` |
| 6.3 row 5 | "The reason codes, and what `credential` is, are G2 (I3)" | "The reason codes are those of identity design 5.2. `credential` names its transport, the session cookie (`cookie`) or `Authorization: Bearer` (`bearer`); a session issued for one transport is refused on the other, and Phase 2 refuses every `Authorization` header (identity design 6.2)" |
| 4 row 12 | "final at G2 with test vectors on Node 24.9.0" | "final at G2 with test vectors on the minimum Node version" |
| 7 item 1 | "passing on Node 24.9.0" | "passing on the minimum Node version" |
| 10, first sentence | "(the ADR-0014 minimum)" | "(then the ADR-0014 minimum)", and after that paragraph: "Note, 2026-10-03: ADR-0021 raises the minimum Node version to 24.15. The runs at 24.9.0 in this document had `engine-strict` off, because `pnpm install` fails there under it; what depends on the version is re-run on 24.15 (identity design 12.3)." |

### 15.2 For Hadi: change-log rows of the identity brief, and board items
| Kind | Item | Source; by when |
|---|---|---|
| Change log | Added inside G1's scope, with this G2 (Ali, Hassan) as the mini-review and the owner informed: re-enabling a disabled account; emails E12 to E15 and screen A11; customers confirm their email before their first session; `identity` subscribes to its own events to send mail (s6 "consumes none" means other modules' events) | Ali's scope note (14.1) |
| Change log | Email E16: set up the second factor again, from a 60-minute link | Hassan's finding 6 |
| Change log | SEL-01's "repeat password" is dropped: one password field with show and hide | Jafar's answer 4 (`ux.md` 7.5) |
| Board | Mini-review: approve and reject enter through `sellers`, and AC 5 changes (automatic approval only after `sellers`' checks; 8.4 points 4 and 5) | 14.1-12; with the `sellers` slice that adds its review |
| Board | Mini-review: re-confirmation moves from Phase 5 to Phase 3 (8.5) | 14.1-12; before `sellers` slice 10 |
| Board | Mini-review: the reviewer notification follows a submission, not the email confirmation (8.5) | 14.1-12; with the `sellers` submission slice |
| Board | Mini-review "find and deactivate a customer": the use case and its permissions exist, the screen does not (`ux.md` 1.3) | Jafar's answer 5; before the first real customer |
