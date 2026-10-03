# ADR-0022: Seller Access State and the May-Sell Contract

**Status:** Accepted — 2026-10-03, with the identity G2 approval (CTO), after review
by Mohammad (software-architect) and Hassan (security-tester). No owner decision is changed:
AC 5 of the identity brief changes only through the mini-review named in decision 5.
**Relates to:** ADR-0004 decision 5, ADR-0006 decisions 3 and 4, ADR-0008 decision 5,
ADR-0010, ADR-0013 decision 4, ADR-0018 decisions 3, 4 and 9 (this ADR records the split
that decision 9 left to G2; no text of ADR-0018 changes), ADR-0019 (R2), ADR-0023,
`docs/design/domain/identity.md` (sections 3.3 and 8), `docs/modules/sellers/brief.md`
(section 11), `docs/modules/identity/brief.md` (R7, R8, AC 5)

## Context
ADR-0018 decision 3 attaches approval, rejection and suspension to the seller id and
requires that the decision to allow sign-in or keep a session reads committed state in that
request, never an event; decision 9 leaves to identity's G2 which module holds that state.
The `sellers` brief (G1 approved 2026-10-03) gives `sellers` the business file of a seller
and, in its section 11, waits for this split and for one answer to "may this seller sell
right now?" before its own G2. `catalog`, `cart` and `ordering` will all ask that question.
`identity` imports no business module (identity brief R7). This ADR records the decisions;
the design is in sections 3.3 and 8 of `docs/design/domain/identity.md`.

## Decision
1. **`identity` mints the seller id and owns the access state.** The id is minted when the
   `SellerAccess` is created (self-registration or creation by an admin); `sellers` creates
   its record under the same id when it consumes `identity.seller-registered.v1`. `identity`
   owns the four states (`pending`, `approved`, `rejected`, `suspended`), each decision and
   its reason, the decision mails, membership and seller-scoped roles (R8). `sellers` owns
   the business: profile, business identifier and its uniqueness, the register lookup, each
   submission and its review, and re-review after a change of business identity. Sign-in
   reads none of it.
2. **The state changes only through a synchronous `identity` use case, never from an
   event.** `identity` never changes it in a handler of a consumed event. A caller in
   another module, even one running in its own event handler, calls the facade, and the
   `identity` use case applies its own guards and access rule. No other module stores a
   copy of the state (table, read model or cache); the sellers list reads it through the
   facade.
3. **Sign-in and the gate read only `identity`'s committed state**, in the request
   (ADR-0018 decision 3). They never ask `sellers`.
4. **Approve and reject go through `sellers` once it has its review.** In the slice that
   brings the `sellers` review, `sellers` checks its file (a current submission exists; the
   business identifier is not held by another approved or suspended seller), then calls
   `identity`'s approve or reject with the submission id as `basisId`. `identity` stores
   that id on the decision without interpreting it and publishes it; `sellers` closes the
   submission when it consumes the decision event. `identity`'s own approve and reject
   endpoints are removed in that slice; suspend and reinstate stay in `identity` (SEL-07).
   Re-application takes the same path: `sellers`' "submit again" calls `identity`'s
   re-apply use case. Until that slice the Phase 2 behaviour stands: an admin decides in
   `identity` on name and email.
5. **Automatic approval only when every check passes.** When the Market policy "approval
   required" is off, `autoApproveSellerAccess` is called by a `sellers` handler as the
   system actor, and only when every `sellers` check passes: the register answers "active",
   no mismatch is flagged, the identifier is free (sellers brief section 5). Otherwise the
   seller stays `pending` for a person, so from that slice the initial state is `pending` in
   both settings. This changes AC 5 of the identity brief ("approved without admin
   action"); that change is the slice's mini-review (ADR-0013 decision 4).
6. **One "may this seller sell" contract, in the `sellers` facade.** It answers yes only if
   `identity` says `approved` **and** `sellers`' own conditions hold. It fails closed: a
   missing `sellers` record or an error is a no. `sellers`' conditions can only turn a yes
   into a no, never the reverse. `catalog`, `cart`, `ordering` and the storefront ask only
   `sellers`, never `identity`. It answers for a set of seller ids in one call, so a cart or
   a listing asks once per request, not in a loop (ADR-0008 decision 5). Its final name and
   its conditions are set at the `sellers` G2. The two enforcement points: actions by the
   seller's own accounts meet the gate (state from `identity`, every request); actions by
   others on the seller's offers meet this contract.
7. **Rejected: the precondition port** (see Alternatives considered).

## Consequences
- The `sellers` G2 starts from a fixed split, and `identity` never learns what a
  submission is.
- Every buy-side check pays a synchronous read through two facades; there is no cache. A
  cached answer would let a suspended seller sell until it expires, so a cache needs its own
  design with security-tester review.
- Failing closed puts safety before availability: when `identity` or `sellers` cannot
  answer, nothing from that seller can be bought. After an extraction the contract becomes
  a remote call under the same rule.
- `autoApproveSellerAccess` and the `sellers` entry to approve and reject are not built
  until the `sellers` G2 enforces in CI that only `modules/sellers/` can reach them (a
  separate contract file that only `sellers` may import), with security-tester review. A
  required `basisId` alone is not enough.
- `sellers` updates its file and `identity` records the decision in separate transactions
  (ADR-0004 decision 5). The `sellers` G2 designs what happens when the call is refused or
  the process stops between the two; the `basisId` in the decision event lets `sellers`
  reconcile.
- Automatic approval is a rule-based automation, so no model output may feed it (ADR-0019
  R2).
- The identity brief gets three mini-reviews with the `sellers` slices: the approve entry
  and AC 5 (decisions 4 and 5), re-confirmation, and the reviewer notification. Only the
  first comes from this ADR.

## Alternatives considered
- **A precondition port** that `sellers` implements behind `identity`'s approve endpoint:
  one entry point, but a business check runs behind an `identity` use case, and Phase 2
  needs a stand-in ("always satisfied") that fails open.
- **`sellers` owns the access state:** sign-in would need `sellers`' data, against R7 and
  ADR-0018 decision 3.
- **A copy of the state built from `identity`'s events**, in `sellers` or in each buying
  module: between a suspension and its delivery the copy still says yes, and two sources
  must be kept in step.
- **The may-sell contract in `identity`:** it would need `sellers`' state, against R7.
