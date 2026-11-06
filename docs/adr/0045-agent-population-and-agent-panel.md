# ADR-0045: Agent Population and Agent Panel

**Status:** Proposed — 2026-11-06. Needed before the first `agents` PR. The `agents` G1 was
approved by the project owner on 2026-11-06 as an explicit exception to speed mode
(`docs/modules/agents/brief.md`, approvals table). Acceptance needs Ali (cto) and Hassan
(security-tester), because it adds a sign-in population.
**Amends:** ADR-0018 decision 3 (adds a fourth population), decision 4 (adds the named rule
`agent-self`) and decision 5 (second factor for agents); ADR-0034 decision 1 and its
per-population `allowedOrigins` (adds `apps/agent`); ADR-0008 decision 1 (the layout note added by
ADR-0034)
**Extends:** ADR-0003 decision 4, as ADR-0018 decision 3 did
**Relates to:** ADR-0005, ADR-0006, ADR-0007, ADR-0019, ADR-0022, ADR-0037

## Context
The owner wants agents (marketers) who introduce shops to MondaPac and earn a percentage of each
linked shop's sales. An agent signs in to a portal of their own, sees the shops they introduced,
their sales and earnings, and answers issues the admin raises about those shops. The owner asked
that each agent set up the portal with a verification code sent by the master admin (owner
request 2026-11-06; brief AGT-01). ADR-0018 decision 3 names the populations (customer,
seller-side, admin), so a brief cannot add one. ADR-0034 lists two panel apps, and its relay,
cookies and `allowedOrigins` are kept per population. An agent is none of the existing
populations: not a seller member (an agent acts across many sellers and owns none), not an admin
(an agent must never reach admin routes or permissions), and not a customer.

## Decision
1. **A fourth population, `agent`.** Agent accounts are a separate population with separate
   sign-in, under the rules of ADR-0018 decision 3: one Market per account, no cross-market
   agent, email unique per Market and per population. The value `agent` joins
   `identity.accounts.population` and its check constraint. The audit actor type is `AGENT`.
2. **Onboarding by invitation only, with a handover code.** There is no self sign-up. An admin
   with `agents.manage` creates the agent through the `agents` module, which asks `identity` to
   issue an invitation on the existing one-time mechanism (single use, revocable, reissued by
   the admin; lifetime 72 hours from Market configuration, as for admin invitations; brief Q9).
   - **Acceptance needs both** the emailed link token **and** a handover code that the admin
     gives the agent directly. Neither alone accepts the invitation, so neither a mailbox
     compromise nor the inviting admin alone can take the account.
   - The handover code has at least 40 random bits (base32), only its HMAC is stored, it is
     bound to its invitation, and it is void after 5 failed attempts.
   - Acceptance sets the password and enrols the second factor in the same step (the admin
     invitation pattern, identity design 3.4 HF6) and opens no session.
   - Issuing the invitation, revealing the code to the admin and accepting it are audited with
     the inviter's account id.
   - Issuing an invitation to an email that already has an agent account or a pending
     invitation answers `invitation.already-pending` to the admin only.
3. **Second factor is mandatory.** No agent session exists without the second factor
   (authenticator app only), as for admins. The `second-factor.account` throttle and the sign-in
   counters of identity design 6.8 cover the agent population. Resetting an agent's second
   factor needs a new platform permission, `agents.reset-second-factor`, with step-up and
   `canActOn`; a reset never opens a session.
4. **Sessions.** Agent sessions follow the admin policy (identity design 6.1): idle 30 minutes,
   absolute 12 hours (Market configuration `identity.sessions.agent`), cookie
   `__Host-session-agent-<MARKET>` with `SameSite=Strict`, never "keep me signed in", and a
   session created only from a second-factor proof. Agent sign-in does the same work for an
   unknown email (identity design 6.3).
5. **Access state.** Agent access state (`active`, `disabled`) is owned by `identity`. Sign-in
   and every request read the committed state, never an event (ADR-0018 decision 3, as in
   ADR-0022). Disabling an agent revokes its sessions and voids its open invitations in the same
   serializable unit of work.
6. **Authorization.** An agent session carries no `seller_id` and no platform role. Agent routes
   use the named non-permission rule `agent-self`: the actor is an active agent and the resource
   belongs to that agent, checked in the application layer.
   - `AuthorisationCheck` denies every permission-keyed rule for an `agent` actor, and
     `agent-self` denies every actor that is not an agent. Start-up fails if an `agent` route
     declares a permission rule. Agent accounts never hold permission keys, so no role editor
     lists them.
   - An agent–seller link grants no seller membership, no seller permission and no input to
     may-sell (ADR-0022).
   - Agent routes publish no AI tools (ADR-0019).
   - A contract test calls every agent route with admin, seller and customer sessions, and
     every admin and seller route with an agent session; all are refused.
7. **Panel `apps/agent`.** A third thin Next.js app on the ADR-0034 pattern:
   - its own host (`agent.localhost`, port 3003 locally; `agent.<market host>` elsewhere);
   - `__Host-` cookies with no `Domain`;
   - the panel server as the BFF, relaying an allowlist of `agent` routes only;
   - its own CSP;
   - its own ADR-0037 `keyId` (`agent`), with network entries separate from the `panel` entries;
   - `pnpm dev:agent` (the CLAUDE.md Commands section changes in its own PR);
   - the same deployment gates as the other panels.
8. **Routes and origins.** API routes for agents are marked `@RoutePopulation('agent')`. The API
   keeps a fourth `allowedOrigins` list, `agent`, disjoint by host name from `admin`, `seller` and
   `customer`. Unsafe agent requests also require `Origin` and `Sec-Fetch-Site: same-origin`, as
   admin and seller routes do.
9. **Boundaries.** `pnpm boundaries` and `scripts/check-panel-boundaries.mjs` gain `apps/agent`
   with the same rules as the other two apps (it imports neither API code nor another app), and
   the relay allowlist check covers the `agent` population.
10. **Data the agent never sees.** No customer personal data reaches an agent route. The `agents`
    module reads only totals from `ordering` through its facade (brief section 6, owner answer
    Q6). Agent earnings are an accrual ledger in `agents`. Real payouts (AGT-11) touch
    `commission-payouts` and `payments`, are out of scope here, and need their own decision and
    a security-tester review.

## Consequences
- `identity` gains a population value, an invitation purpose with a handover code, a session
  variant and a permission key. Each is a migration and use-case change that security-tester
  reviews before merge.
- Every population-keyed list (relay allowlists, `allowedOrigins`, session reads, audit actor
  types, rate limits, cookie names) gets an `agent` entry. A missing entry fails closed.
- One more host per Market; the wildcard certificate of ADR-0034 already covers it.
- The design system gains an agent template later (rule 12 is paused by speed mode).

## Alternatives considered
- **Agents as admin accounts with a narrow role.** Rejected: an agent would sign in on the admin
  host, and an error in a role would open admin routes. ADR-0034 separates hosts for exactly
  this reason.
- **Agents as seller members.** Rejected: an agent works across many sellers and owns none;
  seller membership and access state attach to one seller id (ADR-0022).
- **Agent pages inside `apps/seller`.** Rejected: a shared host would let an XSS in one portal
  read the other's session context.
- **Code-only acceptance (no emailed link).** Rejected by Hassan: the inviting admin alone could
  then take the account.

## Review
- 2026-11-06, Ali (cto): accept with changes; all ten changes applied above.
- 2026-11-06, Hassan (security-tester): two High findings (undefined handover code, missing
  session policy) and five Medium or Low; all applied above (decisions 1 to 8). Acceptance waits
  for Hassan to confirm the fixes and for Ali to accept.
