import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AccessDecision, AccessReasonInvalid } from '../../domain/access-decision';
import {
  SellerAccessApprovedAudit,
  SellerAccessRejectedAudit,
  SellerAccessReinstatedAudit,
  SellerAccessSuspendedAudit,
} from '../../domain/audit';
import {
  SellerAccess,
  type SellerAccessDecisionVerb,
  type SellerAccessStateCode,
  type SellerAccessWrongState,
} from '../../domain/seller-access';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccessDecisionRepository } from '../ports/access-decision.repository';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';
import type { SessionRepository } from '../ports/session.repository';
import type { SignInChallengeRepository } from '../ports/sign-in-challenge.repository';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import { readSellerPeople } from './seller-owner';

/** The four decisions an admin takes on a seller's access (identity design 3.3). */
export type SellerAccessVerb = SellerAccessDecisionVerb;

/** Why a decision on a found seller is refused before its reason is read (3.3). */
export type SellerAccessVerdictRefusal =
  SellerAccessWrongState | { readonly code: 'seller-access.owner-unverified' };

/**
 * The checks of a decision on a registered seller that do not depend on its input (identity
 * design 3.3; slices 9 and 9b): approve on a `pending` seller needs an owner with a verified
 * email (`seller-access.owner-unverified`, checked before the state, so a seller in another
 * state answers wrong-state), then the state the decision starts from (the domain's table). The
 * command runs it after its key and before the transition; the admin seller list's hints run it
 * after the same key, so a hint and the command cannot differ. The reason is not part of it.
 */
export function sellerAccessVerdict(
  verb: SellerAccessVerb,
  state: SellerAccessStateCode,
  ownerVerified: boolean,
): Result<void, SellerAccessVerdictRefusal> {
  if (verb === 'approve' && state === 'pending' && !ownerVerified) {
    return err({ code: 'seller-access.owner-unverified' });
  }
  if (!SellerAccess.decisionAllowedFrom(state, verb)) {
    return err({ code: 'seller-access.wrong-state' });
  }
  return ok(undefined);
}

/** The seller decided on and, for reject and suspend, the reason; `basisId` per 8.4. */
export interface SellerAccessDecisionInput {
  readonly sellerId: Id<'Seller'>;
  /** Required, non-empty, for reject and suspend (decision 9); ignored otherwise. */
  readonly reason?: unknown;
  /** `sellers`' submission id (ADR-0022 decision 4); approve and reject only; null in Phase 2. */
  readonly basisId?: Id | null;
}

export interface SellerAccessDecided {
  readonly code:
    | 'seller-access.approved'
    | 'seller-access.rejected'
    | 'seller-access.suspended'
    | 'seller-access.reinstated';
  readonly sellerId: Id<'Seller'>;
  readonly state: SellerAccessStateCode;
  readonly decisionId: Id<'AccessDecision'>;
  /** Sessions of the seller's accounts ended by a rejection or a suspension (0 otherwise). */
  readonly revokedSessions: number;
}

export type SellerAccessDecisionFailure =
  /** No registered seller with this id in the Market: "not found", as a missing one (5.2). */
  | { readonly code: 'seller.unknown' }
  | SellerAccessWrongState
  | AccessReasonInvalid
  /** Approve only: the seller has no owner account with a verified email (3.3 guard). */
  | { readonly code: 'seller-access.owner-unverified' }
  | { readonly code: 'access.denied' };

export interface SellerAccessDecisionDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerAccess: SellerAccessRepository;
  readonly decisions: AccessDecisionRepository;
  readonly accounts: AccountRepository;
  readonly memberships: SellerMembershipRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly sessions: SessionRepository;
  readonly challenges: SignInChallengeRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const logger = new Logger('SellerAccessDecision');

const DECIDED: Readonly<Record<SellerAccessVerb, SellerAccessDecided['code']>> = {
  approve: 'seller-access.approved',
  reject: 'seller-access.rejected',
  suspend: 'seller-access.suspended',
  reinstate: 'seller-access.reinstated',
};

/**
 * Approve, reject, suspend and reinstate a seller's access (identity design 3.3, 10.1; SEL-03,
 * SEL-07, decision 9, AC 4, AC 6, AC 9, AC 14, AC 18; slice 9), the one routine of the four use
 * cases, each with its permission (`identity.seller-access.approve` for approve and reject,
 * `.suspend` for suspend and reinstate). One read-write unit at READ COMMITTED: it writes
 * `seller_access`, `access_decisions` and `sessions`, none of the tables C11 runs serializable.
 *
 * 1. The seller access row's lock first (`lockForSession`, item H): the lock a seller sign-in's
 *    closing unit takes before it reads the state, so a sign-in racing a suspension either
 *    commits its session first, and the session is revoked here, or reads `suspended` and
 *    refuses. No row: `seller.unknown`.
 * 2. The actor, read in this unit (`readActingGrants`; Mohammad C1, Hassan I1 on PR #187): still
 *    an active, verified admin holding the rule's key, else `access.denied`.
 * 3. The seller: registered in this Market, else `seller.unknown`, the answer of a missing one
 *    (an unregistered self-registration is not a seller yet, 8.2). Approve only: its owner is an
 *    account with a verified email (3.3 guard), else `seller-access.owner-unverified`.
 * 4. The transition, in the domain (`SellerAccess`): the state, then the reason. It answers the
 *    `AccessDecision`, stored with its reason sealed under the seller's key. A rejection or a
 *    suspension then revokes every session of the seller's accounts and voids every open
 *    challenge of its active members (HF11). Event and audit row: ids and state codes only, the
 *    decision's id in place of the reason (10.1, R5).
 */
export async function decideSellerAccess(
  deps: SellerAccessDecisionDependencies,
  context: CallContext,
  input: SellerAccessDecisionInput,
  verb: SellerAccessVerb,
  ruleKey: string,
): Promise<Result<SellerAccessDecided, SellerAccessDecisionFailure>> {
  const { market, actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
  const sellerId = input.sellerId;
  const result = await deps.unitOfWork.run(
    market,
    async (): Promise<Result<SellerAccessDecided, SellerAccessDecisionFailure>> => {
      const now = deps.clock.now();
      const locked = await deps.sellerAccess.lockForSession(market, sellerId);
      // C1: the actor is still an active admin holding the rule's key, read in this unit.
      const reading = await readActingGrants(deps, market, self, [], [ruleKey]);
      if (reading === null) return err({ code: 'access.denied' });
      const access = locked ? await deps.sellerAccess.findById(market, sellerId) : null;
      if (access === null || !access.isRegistered) return err({ code: 'seller.unknown' });
      const before = access.state.state;

      let ownerVerified = true;
      if (verb === 'approve' && before === 'pending') {
        const { owner } = await readSellerPeople(deps, market, sellerId);
        ownerVerified = owner !== null && owner.isEmailVerified;
      }
      // The input-free checks, shared with the admin seller list's hints (slice 9b).
      const verdict = sellerAccessVerdict(verb, before, ownerVerified);
      if (!verdict.ok) return verdict;
      const decided = transition(access, verb, {
        decisionId: deps.ids.next<'AccessDecision'>(),
        decidedBy: actor.accountId,
        now,
        basisId: input.basisId ?? null,
        reason: input.reason,
      });
      if (!decided.ok) return decided;
      const decision = decided.value;
      await deps.sellerAccess.save(market, access);
      await deps.decisions.add(market, decision);

      let revokedSessions = 0;
      if (verb === 'reject' || verb === 'suspend') {
        revokedSessions = await deps.sessions.revokeAllOfSeller(
          market,
          sellerId,
          verb === 'reject' ? 'seller-rejected' : 'seller-suspended',
          now,
        );
        // HF11: no open sign-in of the seller's accounts can complete after the decision.
        for (const accountId of await deps.memberships.activeMembersOf(market, sellerId)) {
          await deps.challenges.voidAllOf(market, accountId);
        }
      }
      await deps.outbox.append(context, access.pendingEvents);
      await deps.audit.record(context, auditEntry(verb, access, before, decision, revokedSessions));
      return ok({
        code: DECIDED[verb],
        sellerId,
        state: access.state.state,
        decisionId: decision.state.id,
        revokedSessions,
      });
    },
  );
  logger.log({
    msg: `identity.${verb}-seller-access`,
    outcome: result.ok ? result.value.code : result.error.code,
    sellerId,
    ...(result.ok
      ? { decisionId: result.value.decisionId, revokedSessions: result.value.revokedSessions }
      : {}),
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  return result;
}

function transition(
  access: SellerAccess,
  verb: SellerAccessVerb,
  input: {
    readonly decisionId: Id<'AccessDecision'>;
    readonly decidedBy: Id<'Account'>;
    readonly now: ReturnType<Clock['now']>;
    readonly basisId: Id | null;
    readonly reason: unknown;
  },
): Result<AccessDecision, SellerAccessWrongState | AccessReasonInvalid> {
  const { decisionId, decidedBy, now, basisId, reason } = input;
  switch (verb) {
    case 'approve':
      return access.approve({ decisionId, decidedBy, now, basisId });
    case 'reject':
      return access.reject({ decisionId, decidedBy, now, basisId, reason });
    case 'suspend':
      return access.suspend({ decisionId, decidedBy, now, reason });
    case 'reinstate':
      return access.reinstate({ decisionId, decidedBy, now });
  }
}

function auditEntry(
  verb: SellerAccessVerb,
  access: SellerAccess,
  before: SellerAccessStateCode,
  decision: AccessDecision,
  revokedSessions: number,
) {
  const target = access.state.sellerId;
  const state = access.state.state;
  const decisionId = decision.state.id;
  switch (verb) {
    case 'approve':
      return SellerAccessApprovedAudit.entry(target, {
        before: { state: before },
        after: { state, decisionId, basisId: decision.state.basisId },
      });
    case 'reject':
      return SellerAccessRejectedAudit.entry(target, {
        before: { state: before },
        after: { state, decisionId, basisId: decision.state.basisId },
      });
    case 'suspend':
      return SellerAccessSuspendedAudit.entry(target, {
        before: { state: before },
        after: { state, decisionId, revokedSessions },
      });
    case 'reinstate':
      return SellerAccessReinstatedAudit.entry(target, {
        before: { state: before },
        after: { state, decisionId },
      });
  }
}
