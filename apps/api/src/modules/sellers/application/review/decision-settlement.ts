import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import { decidedByIdentity } from '../../domain/business-file-revision';
import type { AdminFlagRepository } from '../ports/admin-flag.repository';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';
import type { IdentifierClaimRepository } from '../ports/identifier-claim.repository';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { ShopSlugRepository } from '../ports/shop-slug.repository';

// The second step of a decision (sellers design 3.2, 7.3, 7.5; slice 7a-decide). Three callers
// settle a decision: the reviewer's own request after `identity` answered, the handler of
// `identity`'s decision event (`sellers.close-decision`), and the reconciliation job
// (`sellers.reconcile-decisions`). Each runs these functions **inside** its own read-write unit
// (a plain unit, or the inbox unit of `runOnce`), so the work is the same whichever comes first,
// and every write is guarded so the second to arrive changes nothing:
//
// - the revision's status moves only `WHERE status = 'pending'`;
// - the file's version is compare-and-set, so two settlements of one file serialise on its row;
// - the intent ends only when it names the settled revision.

export interface SettlementDependencies {
  readonly files: SellerFileRepository;
  readonly revisions: BusinessFileRevisionRepository;
  readonly claims: IdentifierClaimRepository;
  readonly flags: AdminFlagRepository;
  readonly slugs: ShopSlugRepository;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** What `identity` decided on revision N. */
export interface IdentityDecision {
  readonly outcome: 'approved' | 'rejected';
  readonly decisionId: Id<'AccessDecision'>;
}

/**
 * What a settlement did: the revision was decided now, it already was (or is no longer pending),
 * or the intent was released after a refusal. `file.not-found` and `conflict.stale` roll the unit
 * back; the caller retries (a delivery, the next run of the job) or reports the decision in flight.
 */
export type Settled =
  'approved' | 'rejected' | 'released' | 'already-settled' | 'claim-conflict-flagged';

export type SettlementFailure =
  { readonly code: 'file.not-found' } | { readonly code: 'conflict.stale' };

const logger = new Logger('SellersDecisionSettlement');

/**
 * Settles revision N as `identity` decided it (unit 2 of 7.3 on success; the event handler; the
 * job after it found the decision by `basisId`). For an approval: the identifier claim is taken
 * again if it was released (Hassan M3). If another seller holds it meanwhile, both sellers are
 * flagged for an admin (`identifier-claim-conflict`) and an operational alert is logged, and the
 * approval is still recorded, because `identity` has already approved; then revision N becomes
 * `approved`, the pointer and the public store name move in the same unit (data design 22, open
 * point 2), and the held slug becomes public (Hassan M6). For a rejection: revision N becomes
 * `rejected`. A revision that is no longer pending changes nothing but an intent naming it.
 */
export async function settleDecision(
  deps: SettlementDependencies,
  context: CallContext,
  sellerId: Id<'Seller'>,
  revisionId: Id<'BusinessFileRevision'>,
  decision: IdentityDecision,
): Promise<Result<Settled, SettlementFailure>> {
  const { market } = context;
  const { files, revisions, claims, flags, slugs, ids, clock } = deps;
  const file = await files.findById(market, sellerId);
  if (file === null) return err({ code: 'file.not-found' });
  const revision = await revisions.findById(market, sellerId, revisionId);
  if (revision === null) return err({ code: 'file.not-found' });
  const now = clock.now();

  if (revision.status !== 'pending') {
    if (revision.status !== decision.outcome) {
      // identity decided on a revision `sellers` no longer holds pending (a withdrawal after the
      // job released the intent, say): nothing to move here; the admin list shows the file.
      logger.error({
        msg: 'sellers.decision-orphaned',
        outcome: decision.outcome,
        sellerId,
        revisionId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    if (file.state.decisionIntent?.revisionId !== revisionId) return ok('already-settled');
    file.closeDecision(revisionId, now);
    if (!(await files.recordDecision(market, file, null))) return err({ code: 'conflict.stale' });
    return ok('already-settled');
  }

  const decided = decidedByIdentity(revision, decision.outcome, decision.decisionId, now);
  if (!decided.ok) throw new Error('settle-decision: a pending onboarding revision was expected');

  let flagged = false;
  if (decision.outcome === 'approved' && revision.identifierIndex !== null) {
    const claim = await claims.take(market, {
      sellerId,
      revisionId,
      index: revision.identifierIndex,
      now,
    });
    if (claim === 'held-by-other') {
      const holder = await claims.holderOf(market, revision.identifierIndex);
      for (const flaggedSeller of [sellerId, ...(holder === null ? [] : [holder])]) {
        await flags.raise(market, {
          id: ids.next(),
          sellerId: flaggedSeller,
          code: 'identifier-claim-conflict',
          now,
        });
      }
      flagged = true;
      logger.error({
        msg: 'sellers.identifier-claim-conflict',
        sellerId,
        revisionId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
  }

  if (!(await revisions.saveDecision(market, decided.value))) {
    return err({ code: 'conflict.stale' });
  }
  if (decision.outcome === 'approved') {
    const storeName = file.state.draft.storeName;
    // The draft is frozen while its revision is pending and the intent locks it, so the draft's
    // store name is the revision's; a submitted revision always has one.
    if (storeName === null) throw new Error('settle-decision: a submitted file has a store name');
    const recorded = file.recordApproval(revisionId, now);
    if (!recorded.ok) throw new Error('settle-decision: an onboarding file approved twice');
    if (
      !(await files.recordDecision(market, file, { revisionId, publicStoreName: storeName.name }))
    ) {
      return err({ code: 'conflict.stale' });
    }
    await slugs.markPublic(market, sellerId);
    return ok(flagged ? 'claim-conflict-flagged' : 'approved');
  }
  file.closeDecision(revisionId, now);
  if (!(await files.recordDecision(market, file, null))) return err({ code: 'conflict.stale' });
  return ok('rejected');
}

/**
 * Releases an intent after `identity` refused (unit 2 of 7.3, refusal) or, in the job, after
 * `identity` holds no decision for revision N and the seller is still `pending`: the claim the
 * approval took is released and the intent ends; revision N stays `pending` for a person. Only
 * the intent named by `attemptId` is released when one is given (the request's own); the job
 * passes null and releases whatever intent names revision N. Answers `already-settled` when no
 * such intent exists any more.
 */
export async function releaseDecision(
  deps: Pick<SettlementDependencies, 'files' | 'claims' | 'clock'>,
  context: CallContext,
  sellerId: Id<'Seller'>,
  revisionId: Id<'BusinessFileRevision'>,
  attemptId: Id<'DecisionAttempt'> | null,
): Promise<Result<Settled, SettlementFailure>> {
  const { market } = context;
  const file = await deps.files.findById(market, sellerId);
  if (file === null) return err({ code: 'file.not-found' });
  const intent = file.state.decisionIntent;
  if (
    intent === null ||
    intent.revisionId !== revisionId ||
    (attemptId !== null && intent.attemptId !== attemptId)
  ) {
    return ok('already-settled');
  }
  // The file is not approved (an approved file has no onboarding intent), so the claim of this
  // revision is the one this approval took.
  if (intent.kind === 'approve-requested' && !file.state.hasApprovedRevision) {
    await deps.claims.release(market, sellerId, revisionId);
  }
  file.closeDecision(revisionId, deps.clock.now());
  if (!(await deps.files.recordDecision(market, file, null))) {
    return err({ code: 'conflict.stale' });
  }
  return ok('released');
}
