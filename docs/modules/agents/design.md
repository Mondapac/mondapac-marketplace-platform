# agents: G2 domain design

Author: Mohammad (software-architect), 2026-11-06. Inputs: `docs/modules/agents/brief.md` (G1 approved; owner answers Q1-Q13), ADR-0045 (Accepted), ADR-0006, ADR-0007, ADR-0008, ADR-0018, ADR-0022. Tier A. Module path: `apps/api/src/modules/agents/{domain,application,infrastructure,presentation,contracts}`. The physical schema (columns, constraints, indexes, migrations) belongs to database-designer. This document names aggregates and invariants only.

**Status:** G2 approved by the owner on 2026-11-06, after cto and security-tester review (section 9).

## 1. Aggregates and invariants

Every record carries `market_id` and `tenant_id`. Instants are stored in UTC. Money is `{amount: bigint minor units, currency}`.

**AgentProfile** (root): `agentId`, `accountId` (identity, id only), `displayName`, `timeZone` (IANA), `taxIdentifier {scheme, value} | null` (the scheme comes from Market config; AU is ABN, Q7), `createdBy`, `createdAt`.

- Exactly one profile per `accountId`. The account's population must be `agent` and its Market must match the profile's Market (checked through the identity facade at creation).
- The profile holds no access state. `active` and `disabled` belong to identity (ADR-0045 d5) and are read live on every request.
- No bank or payout data, ever (brief section 3).

**ReferralCode** (part of AgentProfile): `code` (at least 40 random bits, base32, uppercase), `issuedAt`.

- Unique per Market. One active code per agent. Regenerating the code voids the old one; the old value is never reused.
- The code is not a secret, so it is stored in plain text. It links a shop only through an admin approval of the seller.

**AgentRate** (append-only records per agent): `rateRecordId`, `agentId`, `basis` (`net-sales` | `commission-share` | `gross`, Q1), `rateBps` (integer), `effectiveFrom` (= recordedAt, from the injected Clock), `setBy`, `reason`.

- Must satisfy `0 < rateBps <= cap(basis)`. The cap comes from Market config `agents.rate-cap-bps.<basis>` (Q11). A missing cap refuses the change (fail closed). No backdating and no future dating.
- The rate in force at instant T is the record with the greatest `effectiveFrom <= T`. An agent without a rate earns nothing, and the case is logged as `agents.earning.no-rate`.

**ShopLink** (history per seller): `linkId`, `sellerId`, `agentId`, `validFrom`, `validTo | null`, `source` (`referral-code` | `admin`), `startReason`, `endReason` (`unlinked` | `moved` | `agent-disabled`), `actorId`.

- A seller's intervals never overlap, so at most one agent is linked at any instant (Q8). database-designer enforces this with an exclusion or partial unique constraint, as defence in depth.
- Agent and seller must share the Market.
- Rows are closed, never deleted or edited. A move closes the old row and opens the new one in one unit, both at the same instant.
- Lookup "linked at T" means `validFrom <= T < coalesce(validTo, +inf)`.

**UnmatchedReferral**: `sellerId`, `enteredCode`, `seenAt`, `resolvedAt | null`. This is the admin's list of codes that did not match an agent (brief flow 2).

**AgentEarning** (one per seller order; unique on `sellerOrderId`): `earningId`, `agentId`, `sellerId`, `orderId`, `sellerOrderId`, `placedAt`, `deliveredAt`, `finalAt`, `rateRecordId`, `basis`, `rateBps`, `basisAmount: Money`, `earning: Money`, `nettedRefundIds[]`.

- Immutable once written. `basis` and `rateBps` are copied from the rate record (the frozen snapshot, as in COM-04).
- `earning = floor(basisAmount × rateBps / 10000)`.
- `currency` is the seller order's currency.

**AgentEarningReversal** (one per refund; unique on `refundId`): `reversalId`, `earningId`, `refundId`, `seq`, `refundedBasis: Money`, `reversed: Money`, `cumRefundedBasis`, `cumReversed`, `isRemainder`, `recordedAt`.

- `reversed = floor(earning × refundedBasis / basisAmount)`.
- If the cumulative `refundedBasis` reaches `basisAmount`, then `reversed = earning − sum(previous reversals)` and `isRemainder = true`.
- The sum of reversals is always `<= earning`, so the net per order is never negative. Cumulative `refundedBasis` is capped at `basisAmount`.

**Issue** (root): `issueId`, `agentId`, `sellerId`, `title`, `description`, `severity` (`low` | `medium` | `high`), `status`, `closeReason` (`confirmed` | `withdrawn` | null), `raisedBy`, `commentCount`, `version`, timestamps.

- When raised, the seller must be linked to that agent at that moment.
- The issue stays visible to its agent after an unlink or move, because ownership is `issue.agentId`, but it becomes read-only for that agent (no comment, no mark fixed). Issue lists filtered by shop are always scoped to the caller's own `agentId`.

**IssueComment** (child of Issue, append-only): `commentId`, `issueId`, `seq`, `authorType` (`admin` | `agent`), `authorAccountId`, `body` (plain text; length limit from config), `createdAt`.

- No edit and no delete. No comment on a `closed` issue.

### Issue state machine (AGT-08)

| From                         | To                | Trigger                             | Actor                  |
| ---------------------------- | ----------------- | ----------------------------------- | ---------------------- |
| (new)                        | `open`            | RaiseIssue                          | admin `agents.manage`  |
| `open`                       | `agent_responded` | the agent's first comment           | agent-self             |
| `open`, `agent_responded`    | `resolved`        | MarkIssueResolved                   | agent-self             |
| `resolved`                   | `closed`          | CloseIssue with `closeReason = confirmed` | admin `agents.manage`  |
| `resolved`                   | `open`            | ReopenIssue (reason required)       | admin `agents.manage`  |
| `open`, `agent_responded`    | `closed`          | CloseIssue with `closeReason = withdrawn` (required), audited | admin `agents.manage` |

Everything else is forbidden:

- An agent cannot close or reopen.
- An admin cannot mark an issue resolved.
- `closed` is terminal.
- `open` or `agent_responded` → `closed` only as `withdrawn`, with a reason (cto, open question 4).

Comments in other states do not change the status. Every comment and every transition bumps `version`, which is checked with optimistic concurrency; a comment also bumps `commentCount` and takes `seq = commentCount + 1` (D1).

## 2. Earnings flow (AGT-05)

1. **The delivered event arrives.** `ordering.seller-order-delivered.v1 {orderId, sellerOrderId, sellerId, source}` lands in the agents inbox (ADR-0006). The inbox key is the event id. The unique `sellerOrderId` on AgentEarning is a second guard, so redelivery writes nothing.
2. **Read the order facts.** The handler calls `ordering.sellerOrderEarningFacts(system, sellerOrderId)`, which returns `placedAt`, `deliveredAt`, `currency`, `goodsNetExTax` (after discounts and succeeded refunds), `goodsGrossIncTax` (same, tax-inclusive per the Market TaxStrategy, shipping excluded) and `includedRefundIds`. Shipping and GST are never in the net basis (COM-05).
3. **Look up the link.** Find the ShopLink with `linkedAt(sellerId, placedAt)`. If there is none, ack and stop. A disabled agent gets no link after it was disabled, because DisableAgent ends its links (Q12).
4. **Freeze the rate.** Take the AgentRate in force at `placedAt` and copy its `basis` and `rateBps`.
5. **Compute the basis.**
   - `net-sales`: `goodsNetExTax`.
   - `gross`: `goodsGrossIncTax`.
   - `commission-share`: `commissionPayouts.sellerOrderCommission(system, sellerOrderId)`, which returns the commission excluding commission GST, net of recorded reversals, with `includedRefundIds`. A `not-recorded-yet` answer throws, so the inbox retries.
6. **Round down.** `earning = floor(basis × rateBps / 10000)`. A zero earning is still written, for audit.
7. **Set `finalAt`.** It is the seller order's eligibility anchor from `commissionPayouts.eligibilityAnchorOf(system, sellerOrderId)`: delivery plus the seller hold, 7 days by default (Q5). If no anchor exists, the inbox retries with backoff up to the Market retry limit, then parks the event for an admin; it never loops. "Final" is derived at read time (`now >= finalAt`), with no job. A refund after `finalAt` still writes a reversal (accrual only; AGT-11 settles later).
8. **Write once.** The earning and an outbox `agents.earning-recorded.v1` are written in one unit of work.

**Refund flow.** `ordering.refund-succeeded.v1 {orderId, sellerOrderId, refundId}` arrives through the inbox.

- If the `refundId` is in `nettedRefundIds`, ack with no row (a refund before delivery is already netted in step 2).
- If there is no AgentEarning and a link existed at `placedAt`, throw so the inbox retries (bounded, as in step 7). Ack with no row only when no earning will ever be written (no link at `placedAt`, or the seller order will never be delivered).
- For commission-share, every id in ordering's `includedRefundIds` must appear in commission's `includedRefundIds` or be reported as `nothing-to-post`; otherwise treat it as `not-recorded-yet` and retry (security-tester G2, High).
- Otherwise read `refundedBasis`:
  - `net-sales` and `gross`: `ordering.refundEarningFacts(system, refundId)`, which returns `goodsNetExTax` and `goodsGrossIncTax` refunded.
  - `commission-share`: `commissionPayouts.refundCommission(system, refundId)`, which returns the reversed commission excluding GST; `not-recorded-yet` means retry.
- Apply the reversal formula and the last-refund remainder rule (section 1). Write it in one unit with the `refundId` unique key.

Event name: the code publishes `ordering.refund-succeeded.v1`. That is the name agents uses. The `ordering.md` design doc entry `order-line-refunded` must be corrected in a docs PR by the ordering owner.

## 3. Facades needed

| Module             | Method                                                                                                                         | Status                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| identity           | `issueAgentInvitation(ctx, {email, displayName})` returns `{accountId, invitationId, handoverCode}` (shown once; ADR-0045 d2) | MISSING (identity)                                                                                         |
| identity           | `revokeAgentInvitation(ctx, invitationId)`, `reissueAgentInvitation(ctx, accountId)`                                           | MISSING (identity)                                                                                         |
| identity           | `disableAgentAccount(ctx, accountId)` (revokes sessions and voids invitations in one serializable unit, d5), `enableAgentAccount` | MISSING (identity)                                                                                      |
| identity           | `agentAccessOf(ctx, accountIds[])` returns `active` / `disabled` / `invited`, read live                                        | MISSING (identity)                                                                                         |
| identity           | `contactEmailOf(ctx, {kind:'agent', accountId})`                                                                               | EXISTS; needs an `agent` variant of `ContactEmailTarget`                                                   |
| identity           | `requireStepUp(ctx, actionKey)` (admin audience)                                                                               | EXISTS                                                                                                     |
| identity           | admin use case ResetAgentSecondFactor (key `identity.agent-account.reset-second-factor`, step-up, `canActOn`)                                  | MISSING (identity owns the second factor)                                                                  |
| identity           | event `identity.seller-access-approved.v1 {sellerId, decisionId, basisId}`                                                     | EXISTS                                                                                                     |
| sellers            | `referralCodeEnteredOf(ctx, sellerId)` returns `string \| null` (system)                                                       | MISSING (sellers; also a scope change in its application form, logged in the sellers brief change log)     |
| sellers            | `sellerSummaries(ctx, ids)` (store name)                                                                                       | EXISTS (check that the `system` and `agent-self` callers are allowed)                                       |
| identity           | `sellerAccessOf` (shop status for the agent portal)                                                                            | EXISTS (check the system rule)                                                                             |
| ordering           | `sellerOrderEarningFacts(ctx, sellerOrderId)`, rule `system`                                                                   | MISSING (ordering)                                                                                         |
| ordering           | `refundEarningFacts(ctx, refundId)`, rule `system`                                                                             | MISSING (ordering)                                                                                         |
| ordering           | `sellerMonthlySales(ctx, [{sellerId, windows[]}] <= 500 sellers, <= 12 windows each)` takes `[from, to)` UTC instants per seller, which agents intersects with that seller's link intervals and that agents computes in the agent's own time zone (ADR-0005), not month labels; returns net sales and order count, counters only (ADR-0045 d10)     | MISSING (ordering)                                                                                         |
| commission-payouts | `sellerOrderCommission(ctx, sellerOrderId)`, `refundCommission(ctx, refundId)`, rule `system`                                  | MISSING (commission-payouts); the current facade is only what ordering calls                                |
| commission-payouts | `eligibilityAnchorOf(ctx, sellerOrderId)`, rule `system`                                                                       | MISSING (commission-payouts)                                                                               |
| notifications      | subscribers for `agents.issue-*` events; an `agent` recipient kind for in-app notices; an agent notices route                  | MISSING (notifications); today only seller and admin notices exist                                         |

**agents is the policy point** (cto, G2): after its `agent-self` and link-interval checks, it calls the `sellers` and `ordering` read facades as `system`, passing only the linked `sellerIds`; those facades return counters only. Reason: ADR-0045 d6 means an agent actor is refused by every permission rule.

**agents publishes `AgentsFacade`** (in `contracts/`):

- `issueNotice(ctx, issueId)` (system): agent `accountId`, `sellerId` and title, for notifications.
- `linkedAgentNameOf(ctx, sellerId)`: the seller panel, Q13.

## 4. Events

Payloads hold ids only. Market and tenant travel in the envelope.

- **Published** (all through the outbox):
  - `agents.issue-raised.v1 {issueId, agentId, sellerId}`
  - `agents.issue-commented.v1 {issueId, commentId, authorType}`
  - `agents.issue-status-changed.v1 {issueId, from, to}`
  - `agents.earning-recorded.v1 {earningId, agentId, sellerOrderId}`
- **Consumed** (all through the inbox, as the system actor):
  - `identity.seller-access-approved.v1 {sellerId, decisionId, basisId}`
  - `ordering.seller-order-delivered.v1 {orderId, sellerOrderId, sellerId, source}`
  - `ordering.refund-succeeded.v1 {orderId, sellerOrderId, refundId}`
- **LinkByReferralOnApproval**:
  - Read `referralCodeEnteredOf`.
  - Match only an active code (`voided_at IS NULL`) of an agent that `agentAccessOf` reports `active`; otherwise write an UnmatchedReferral.
  - If the code matches such an agent of the same Market and the seller has no link history at all, open a link with `validFrom` = the envelope's `occurredAt` and `source = referral-code`.
  - If the code does not match, write an UnmatchedReferral.
  - A seller that already has history is left alone, so a re-approval never relinks.

## 5. Use cases and access rules

Every use case takes ActorContext and MarketContext (ADR-0018). Every write by an admin goes to the Audit Log in the same unit of work.

- **`agents.manage`**:
  - CreateAgent (profile, referral code, first rate, identity invitation) (step-up)
  - ReissueInvitation (step-up), RevokeInvitation
  - DisableAgent (step-up): end all active links (`agent-disabled`), then `identity.disableAgentAccount`; idempotent, retry-safe
  - EnableAgent (step-up)
  - SetAgentRate (step-up)
  - RegenerateReferralCode (step-up)
  - LinkShop, UnlinkShop, MoveShop (reason required; step-up)
  - ResolveUnmatchedReferral (step-up when it links a shop)
  - RaiseIssue, AdminCommentOnIssue, CloseIssue, ReopenIssue
- **`agents.read`**: ListAgents, GetAgent (with live access state), GetAgentEarnings (per seller and month, in the agent's zone), ListShopLinkHistory, ListUnmatchedReferrals, ListIssues, GetIssue, PollIssueComments.
- **`identity.agent-account.reset-second-factor`**: ResetAgentSecondFactor. This lives in identity, with step-up and `canActOn`, and opens no session.
- **`agent-self`** (an active agent; resource `agentId` = the session's agent, else `not-found`):
  - GetMyProfile (referral code), UpdateMyProfile (time zone, tax id via the Market validator; a tax id change is audited with the agent as actor)
  - MyDashboard, MyShops (name, status, monthly totals clipped to the agent's own link intervals), MyEarnings
  - ListMyIssues, GetMyIssue, CommentOnMyIssue, MarkIssueResolved, PollIssueComments
- **system**: LinkByReferralOnApproval, RecordEarningOnDelivery, ReverseEarningOnRefund, `AgentsFacade.issueNotice`.
- **`agents.linked-agent.view`** (seller scope, not protected; identity's seed maps it to Seller Owner and Store Manager): the seller panel's `linkedAgentNameOf` (Q13).
- **Policy point:** `agent-self` use cases call the `sellers` and `ordering` read facades as `system` with only the agent's linked `sellerIds` (see section 3).
- **Live updates**: the panel servers poll `PollIssueComments(after=seq)`. Server-side per-actor rate limits apply to PollIssueComments, CommentOnMyIssue and AdminCommentOnIssue (Market config), not only in the BFF.
- **Comment bodies** are stored and rendered as plain text: no HTML, no markdown, no auto-linking.

## 6. Where each brief section 5 hard rule is enforced

| Rule                                                                           | Layer and file area                                                                                                                         |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Rate frozen at order placement; later changes never touch recorded earnings    | `domain/agent-earning.ts` copies `basis` and `rateBps`; the aggregate has no update method; `domain/agent-rate.ts` resolves the rate at `placedAt` |
| Earning only if linked at `placedAt`                                           | `domain/shop-link-history.ts` `linkedAt(T)`, called by `application/record-earning-on-delivery`                                              |
| Earning after delivery; refunds reverse it; never negative                     | `domain/agent-earning.ts` `reverse()` with the remainder and cap; delivery and refund handlers in `application/`                             |
| Three basis definitions                                                        | `domain/earning-basis.ts` (pure selection); the amounts come from ordering and commission-payouts facades; no tax maths in agents           |
| Money is minor units plus currency                                             | shared kernel `Money`; currency taken from the seller order, never defaulted                                                               |
| Rate in integer basis points                                                   | `domain/agent-rate.ts` value object (integer, `> 0`, `<= cap`) plus a DB check                                                             |
| `floor` rounding                                                               | one function in `domain/earning-math.ts`; property tests on AU and ZZ                                                                       |
| Reversal and last-remainder rule                                               | `domain/agent-earning.ts`; unique `refundId`                                                                                                |
| `market_id` / `tenant_id`; agent and shop in the same Market                   | MarketContext repositories in `infrastructure/`; same-Market check in `domain/shop-link-history.ts`                                          |
| Agent sees only its own shops; never customer personal data                    | `agent-self` check in every `application/agent-self/*` use case; facades return counters only                                               |
| Second factor mandatory                                                        | identity sign-in and session creation (ADR-0045 d3), not in agents                                                                          |
| One-time code, expiry, only the hash stored                                    | identity invitation mechanism (ADR-0045 d2)                                                                                                 |
| Only `agents.manage` sets rates, links and closes; all audited                 | `application/` access declarations plus the audit port in the same unit                                                                    |
| security-tester review | mandatory for the identity agent facades and for ResetAgentSecondFactor |
| No country `if`                                                                | caps, hold, tax-id scheme and lengths all from Market config; the two-Market fixture suite                                                  |

## 7. Open questions for cto

1. **Commission basis when the platform bears the refund loss.** commission-payouts then posts no reversal (`nothing-to-post`).
   - Option A: the agent's commission-share earning follows the commission actually reversed, so here nothing is reversed.
   - Option B: always reverse in proportion to the goods refunded.
   - Recommendation: A, the agent shares what MondaPac keeps. Needs an owner nod because the brief says "proportional".
   - **Owner decision 2026-11-06: A.** The agent's commission-share earning follows the commission actually reversed.
2. **"Gross" basis wording.** Is "gross" the tax-inclusive goods amount after discounts (what the buyer paid for goods), or before discounts? Recommendation: after discounts, in line with net-sales. **Owner decision 2026-11-06: after discounts.**
3. **Hold source.**
   - Option A: reuse commission-payouts' eligibility anchor (carrier vs seller-click hold).
   - Option B: a separate Market config `agents.earnings.hold-days`.
   - Recommendation: A, one hold for both, no drift.
   - **cto decision 2026-11-06: A.** `commission_payouts.eligibility_anchors` already freezes `eligibleAt` and `holdDaysApplied` per seller order and is never updated, so one hold serves both and cannot drift.
4. **Closing an unresolved issue.** May an admin close an issue that is not `resolved` (for example a withdrawn issue)? The design forbids it for now.
   - **cto decision 2026-11-06: allowed as `withdrawn`** with a required reason and an audit entry (state machine above); logged in the brief change log because AGT-08 changes.
5. **Access rule for Q13.** Which seller-side permission guards `linkedAgentNameOf` (an existing seller profile view key, or a new `agents.linked-agent.view`)?
   - **cto decision 2026-11-06: new key `agents.linked-agent.view`** (seller scope, not protected), seeded by identity to Seller Owner and Store Manager. `definePermission` only allows a module's own prefix.
6. **Permission key ownership.** The draft declared `agents.reset-second-factor` in `agents/contracts/permissions.ts` but checked by an identity use case. Is that cross-module key ownership acceptable, or should identity declare it?
   - **cto decision 2026-11-06: identity declares `identity.agent-account.reset-second-factor`**, like the existing seller and admin reset keys; importing a key from agents would make the modules depend on each other (ADR-0008). ADR-0045 d3 updated in its PR.
7. **Dashboard target.** ADR-0045 d10 reads monthly totals from `ordering.sellerMonthlySales`. Can that meet "< 1 s for 500 shops × 12 months"? If not, the alternative is an agents-owned projection from its own ledger, which needs an ADR-0045 amendment.
   - **cto decision 2026-11-06: keep ADR-0045 d10, no projection.** `seller_orders` has no `placed_at` index, so ordering's PR ships one set-based query, an index approved by database-designer, and a test of 500 shops × 12 months, p95 under 1 s, on both Markets. Only if that test fails is the amendment written.
8. **Delivery order of the four missing facade sets.** Missing facade sets (ordering, commission-payouts, sellers, notifications) must land before AGT-02, AGT-05 and AGT-08. cto to schedule them with each module's owner; each is a scope change to log in that module's brief.
   - **cto decision 2026-11-06, one PR each, each logged in that module's brief change log:** (1) identity: invitations, disable/enable, `agentAccessOf`, the `agent` contact-email variant, the reset use case (security-tester review); (2) sellers: `referralCodeEnteredOf` and the application-form field; (3) ordering, alongside (4): the two earning-facts reads, `sellerMonthlySales` with its index, and the docs fix renaming the event to `refund-succeeded`; (4) commission-payouts: `sellerOrderCommission`, `refundCommission`, `eligibilityAnchorOf`; (5) notifications: the `agent` recipient kind and subscribers, after agents merges `AgentsFacade.issueNotice`.

## 8. Resolutions from the data review (database-designer, `data.md` section 6)

- **D1, comment polling cursor:** accepted. Each comment takes a per-issue `seq` (`issues.comment_count + 1`) in the same unit of work, so the Issue aggregate is updated on every comment, not only on status changes. Polling uses `after=seq`.
- **D2, two refunds at once:** accepted. Each reversal takes a unique per-earning `seq`; the cap and remainder checks make the database refuse a second remainder. No row lock on earnings (they have no UPDATE grant); a refused insert retries through the inbox.
- **D3, close reasons:** `closeReason` is `confirmed` for a normal close of a `resolved` issue and `withdrawn` (reason text required) for `open` or `agent_responded`.
- **D4, which month a reversal counts in:** **owner decision 2026-11-06: the refund's month.** A reversal is reported in the month of its own `recordedAt`, in the agent's time zone; past months never change. The dashboard and the AGT-10 statement sum earnings by `placedAt` month and reversals by their own month.
- **`issue_status_changes`:** accepted as part of the Issue aggregate (history of every transition with actor and reason).


## 9. G2 reviews

- 2026-11-06, Ali (cto): open questions 3 to 8 decided; final review wording fixes applied.
- 2026-11-06, Hassan (security-tester): one High (refund lost on the commission-share basis when it arrives before the earning) and five Medium, three Low findings; all applied in sections 1, 2, 3, 4 and 5 and in `ux.md` section 1 and 4. Re-review: blocker cleared; two Low wording fixes in `ux.md` section 1 applied (already-set-up shows the expired banner; steps 1–2 checked only in the browser).
