# ADR-0018: Identity — In-House Build, Server-Side Sessions and Authorisation Model

**Status:** Accepted — 2026-10-02 (owner decision: the owner decided the G1 questions of
the identity module and accepted this ADR on the same day; drafted by the CTO, reviewed by
the software-architect and the security-tester)
**Amends:** ADR-0003 decision 4, ADR-0004 decision 1, ADR-0008 decisions 2 and 5,
ADR-0015 decision 3
**Relates to:** ADR-0001 (tenant seam), ADR-0003 decisions 2 and 5, ADR-0004 decisions 3
and 7, ADR-0006 decisions 2 to 4, ADR-0009 decisions 6 and 8, ADR-0013, ADR-0014
decisions 1 and 5, ADR-0015 decisions 1 and 2, `docs/modules/identity/brief.md`,
`docs/spec/technical-spec.md` (§1.4, §2.1) and `PLAYBOOK-fa.md` (Phase 2)

## Context
Identity is tier A and P0: every later module relies on it for access control. "Build or
buy" was left open in Phase 0. The spec and the PLAYBOOK assume JWT with refresh tokens
and "RBAC with three roles"; at G1 the owner asked for dynamic roles in both panels in
Phase 2. The team is AI agents plus one human owner, with no human security engineer. The
owner answered the G1 questions on 2026-10-02 (brief section 7); this ADR records the
answers that cross modules.

## Decision
1. **Build in-house** (owner decision 2026-10-02). Identity is built inside the `identity`
   module from platform primitives and a small set of libraries: no auth framework and no
   managed identity service. Credential hashing, session storage and the second factor
   sit behind ports, and password hashes use a standard, portable format (argon2id is the
   candidate, confirmed at G2), so a later move to a product stays possible. The fallback
   is Keycloak per Region Stack (decision 10).
2. **Server-side sessions, not JWT** (owner decision 2026-10-02). Sign-in state is an
   opaque server-side session in PostgreSQL; only a hash of the session token is stored.
   A session belongs to one account, hence one account type and one Market. Phase 2 has
   no session or permission cache, in Redis or in process: every authenticated request
   reads both from PostgreSQL or is refused. A cache may be added later only with a
   design, reviewed by the security-tester, under which no session or permission outlives
   its revocation; it holds identifiers only, never the token (ADR-0009 decision 6). This
   amends ADR-0004 decision 1 and replaces the "JWT / refresh token" wording of the
   technical spec and the PLAYBOOK. Reasons: suspension, rejection, password changes and
   role changes must take effect by the next request; there are no third-party API
   clients yet; there are no signing keys to manage per Region Stack.
3. **Accounts and Market scope.** Customer, seller-side (Seller Owner and Staff) and admin
   accounts are separate populations with separate sign-in. Every account, admin accounts
   included, belongs to exactly one Market; this extends ADR-0003 decision 4, which names
   only customer and seller accounts. There is no cross-market admin. An email address is
   unique per Market and per population, so the same address may hold a customer account
   and a seller account (owner decision 2026-10-02). A seller-side account is not the
   seller: it is a member of one seller, identified by a seller id shared with `sellers`
   as a plain id. One membership per account is a Phase 2 rule, not part of the account's
   identity. Approval, rejection and suspension attach to the seller id. Which module
   holds that state is G2 design (decision 9), under one constraint that protects
   decision 2: the decision to allow sign-in or keep a session reads committed state in
   that request; it never waits on an asynchronous event and is never derived from one
   (ADR-0006 decisions 3 and 4).
4. **Authorisation model.**
   - It is enforced in the application layer, before the use case body runs, whatever
     the entry point. Every use case takes an `ActorContext` and a `MarketContext` and
     declares exactly one access rule: the permission keys it requires, or one of a
     closed set of named rules (anonymous; authenticated actor on its own resources;
     system). Silence is never a default: a use case without a declared rule fails CI,
     one shared mechanism (G2 design) enforces the declaration, and an error resolving
     it is a denial. `ActorContext` holds identifiers only, has anonymous and system
     kinds, and is valid only in its own Market. Controller guards only authenticate.
   - A permission never grants a resource: the use case also checks that the resource
     belongs to the actor (or the actor's seller) and Market (R6), taken from
     `ActorContext`, never from input. For a seller that is not approved, everything is
     denied unless the use case is declared available in that state (brief decision 6).
   - The permission catalogue is code. Each module declares its permissions in its
     `contracts/` and registers them at bootstrap with a registry in `platform/`;
     `platform/` imports no module; `identity` reads the catalogue only from the
     registry. Keys carry no market and no vertical. An unknown key grants nothing.
     Only `identity` reads role, assignment and membership data; other modules ask
     through `identity`'s public contract on every request and keep no read model of it.
   - Facade calls carry the caller's `ActorContext` next to `MarketContext`. Events carry
     no actor; their handlers run as the system actor. This bullet and the one above
     amend ADR-0008 decisions 2 and 5.
   - Roles are system roles, platform default roles (versioned seed data, not core logic)
     or custom roles, each in exactly one scope (platform or seller) and carrying
     `market_id` and `tenant_id`. Dynamic roles for both panels in Phase 2 are an owner
     decision of 2026-10-02. The binding rules are R1 to R12 in section 5 of the brief.
   - The later "AI as a cross-cutting capability" ADR must conform to this contract: AI
     tools call use cases, so authorisation done only in guards would be bypassed.
5. **Second factor.** Mandatory for admins from day one: no admin session exists without
   it. Optional for sellers at launch; compulsory for Seller Owners before payouts are
   enabled and before a payout-account change (Phase 5, VER-10; owner decision
   2026-10-02). Authenticator app only; no SMS for anyone.
6. **ADR-0015 decision 3 gains three trigger rows and one type.** `SubjectKeyService`
   (ADR-0009 decision 8) lands in the same change as the first migration whose data
   design declares a personal-data column: software-architect designs the port,
   backend-developer builds it, database-designer signs off the key table,
   devops-engineer owns the wrapping key, security-tester reviews. The permission
   registry lands in the same change as the first use case that declares a permission
   key. The CI check that every use case declares its access rule lands at the slice
   named in identity's approved G2 design, no later than that use case. `ActorContext`
   joins the shared-kernel types of the "platform foundations" design.
7. **Assurance.** security-tester review of every identity slice stays mandatory. An
   independent human penetration test must pass before public launch, and no real account
   is created before it passes (owner decision 2026-10-02). Its scope, set at the team's
   second check, is in the brief the owner approved: the launch-candidate build; sign-in
   and authorisation across the launch modules (token storage, expiry, revocation and
   error messages; both role editors; vertical and cross-seller escalation; invitations;
   two Markets). *(Amended by ADR-0019: plus the AI surfaces that are switched on at
   launch.)* *(Amended by ADR-0024: plus the upload of product photos and their
   public serving, the parsing of bulk Import files if Import is in the launch-candidate
   build, and attempts to bypass CERT-21 and the refusal of certification-claim words by
   calling the API directly instead of using the UI.)*
   Pass means no open Critical or High finding after retest. The price is
   not known; the quote returns to the owner. Open, not blocking this ADR, and put to the
   owner when the test is contracted: what an auth change after the tested build needs.
8. **Dependencies.** This ADR approves no new dependency. One bundled list goes to the
   owner at G2, after the spikes. The build session saw built-in `crypto.argon2` on Node
   v24.21.0, so a hashing dependency may not be needed; G2 confirms it on the ADR-0014
   minimum and against RFC 9106 test vectors.
9. **Left to G2:** cookie and CSRF mechanism; session lifetimes; the hash algorithm and
   its parameters, and whether a pepper is used and where it is kept (a pepper reduces
   portability to a product); throttle thresholds; second-factor recovery; where the
   reject and suspend reason text and the admin sign-in records are stored; the default
   role lists; the mechanism of the access-rule check; the split of access state and
   membership between `identity` and `sellers`, within the constraint of decision 3.
10. **What would change this decision.** Move to Keycloak per Region Stack, by a
    superseding ADR, if: the owner approves cross-market or global sign-in; sellers need
    enterprise SSO, or the platform must act as an OAuth/OIDC provider; the owner has not
    approved a quote for the penetration test when Phase 5 starts, or no test is
    contracted when Phase 7 starts; or two consecutive identity slices, or three in
    total, get a Critical or High finding at their first security review, counted from
    the review records in `docs/reviews/`. Move to a managed service in one case only:
    the owner decides that nobody will operate any security-critical component.

## Consequences
- Accounts, sessions and audit rows stay in the stack's PostgreSQL and inside the audited
  transaction, with personal fields in history under our subject keys. Phase 2 adds no
  runtime service; every authenticated request pays a session and permission read.
- The team owns every authentication and authorisation flaw. No vendor carries credential
  storage, and the same AI team writes and reviews the code.
- The backlog is ours: passkeys, social sign-in, breached-password checks, any SSO.
- Until the penetration test, auth code merges with the security-tester's review as the
  only security review; no human reads the code. That review reads design and diff
  against the brief and blocks on Critical or High findings; it gives no independence
  (same model and documents as the authors), no test of a running build and no memory
  between sessions. The owner chose the test, not a human reviewer per slice (brief
  section 7, decision 2). This is a recorded deviation from the PLAYBOOK's "human review
  of auth code" lines, for identity only. Public launch now depends on a test that has
  no price and no supplier yet.
- Phase 2 is larger than the PLAYBOOK's three weeks, and nobody has estimated it. At its
  end the role editor governs little: the catalogue holds almost only identity's own
  permissions until the business modules declare theirs.
- The spec and PLAYBOOK texts are corrected in a separate doc change (brief section 8).

## Alternatives considered
- Self-hosted Keycloak per Region Stack (the fallback): mature credential code, but a
  second service and a second store of personal data in every stack, outside our subject
  keys and outside the audit transaction.
- Managed service (Cognito / Auth0): account data sits with a third party; approval and
  suspension states need vendor hooks outside the repo; roles and teams are still ours.
- Auth framework inside the app (Better Auth, Passport): Better Auth brings its own user
  and session tables, against ADR-0004 decisions 3 and 4; Passport adds nothing to guards.
- JWT with refresh tokens (the spec's wording): revocation needs a server-side lookup
  anyway, plus signing keys per Region Stack, and no client needs tokens yet.
- Weighted scores, the CTO's own: build 4.5, Keycloak 3.45, managed 2.85. The prices,
  regions and licence statements in that report were not independently verified.
