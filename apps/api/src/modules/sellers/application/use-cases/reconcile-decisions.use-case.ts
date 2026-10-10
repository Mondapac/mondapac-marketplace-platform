import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { RECONCILE_AFTER, type DecisionIntent } from '../../domain/decision-intent';
import type { AccessState } from '../../domain/seller-status';
import {
  releaseDecision,
  settleDecision,
  type SettlementDependencies,
} from '../review/decision-settlement';
import type { DecisionByBasis, SellerAccessDecider } from '../ports/seller-access-decider';
import type { SellerAccessReader } from '../ports/seller-access-reader';

/** The most intents one run of the job looks at (identity's `accessDecisionsByBasis` takes 100). */
export const RECONCILE_BATCH = 100;

export interface ReconcileDecisionsOutput {
  readonly settled: number;
  readonly released: number;
  /** Intents left as they are: identity's state is not `pending` without a decision, or two decisions. */
  readonly left: number;
}

export type ReconcileDecisionsFailure = { readonly code: 'access.denied' };

export interface ReconcileDecisionsDependencies extends SettlementDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly decider: SellerAccessDecider;
  readonly accessReader: SellerAccessReader;
}

interface StaleIntent {
  readonly sellerId: Id<'Seller'>;
  readonly intent: DecisionIntent;
}

/**
 * `sellers.reconcile-decisions` (sellers design 7.3; slice 7a-decide), every minute for each
 * Market. Rule `system`. It finishes the decisions whose request died between its two units and
 * whose `identity` event has not settled them: the intents older than five minutes (well past the
 * 30-second deadline of the call) are read in a read-only unit, then `identity` is asked, in one
 * call, which of their revisions it decided (`accessDecisionsByBasis`, by `basisId`):
 *
 * - one approval or rejection: settled as the event handler would ({@link settleDecision});
 * - none, and the seller is still `pending` in `identity`: the intent is released (and the claim
 *   an approval took), naming the attempt read, so a newer attempt is never released;
 * - anything else (two decisions for one revision, a state other than `pending` without a
 *   decision): an alert is logged and the intent is left for a person (Hassan C6).
 *
 * When `identity` refuses or cannot answer, nothing is concluded: the run throws, the intents stay
 * and the next run asks again. Each settlement or release has its own unit, so one lost race (a
 * `conflict.stale` with the event handler) leaves that intent for the next run only.
 */
export class ReconcileDecisions extends UseCase<
  Record<string, never>,
  ReconcileDecisionsOutput,
  ReconcileDecisionsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.reconcile-decisions',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('ReconcileDecisions');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReconcileDecisionsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ReconcileDecisionsOutput, ReconcileDecisionsFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, files, decider, accessReader, clock } = this.deps;
    const before = clock.now().subtract(RECONCILE_AFTER);

    const read = await unitOfWork.run(
      market,
      async () => {
        const sellerIds = await files.staleDecisionIntents(market, before, RECONCILE_BATCH);
        const stale: StaleIntent[] = [];
        for (const sellerId of sellerIds) {
          const file = await files.findById(market, sellerId);
          const intent = file?.state.decisionIntent ?? null;
          if (intent !== null) stale.push({ sellerId, intent });
        }
        return ok(stale);
      },
      { readOnly: true },
    );
    if (!read.ok) throw new Error('sellers.reconcile-decisions: the read failed');
    const stale = read.value;
    if (stale.length === 0) return ok({ settled: 0, released: 0, left: 0 });

    // Throws when identity refuses or cannot answer: nothing may be concluded (Hassan C6).
    const decisions = await decider.decisionsByBasis(
      context,
      stale.map(({ sellerId, intent }) => ({ sellerId, basisId: intent.revisionId })),
    );
    const byPair = new Map<string, DecisionByBasis[]>();
    for (const decision of decisions) {
      const key = `${decision.sellerId}/${decision.basisId}`;
      byPair.set(key, [...(byPair.get(key) ?? []), decision]);
    }

    const undecided = stale.filter(
      ({ sellerId, intent }) => !byPair.has(`${sellerId}/${intent.revisionId}`),
    );
    const states: ReadonlyMap<Id<'Seller'>, AccessState> = undecided.length === 0
      ? new Map()
      : await accessReader.accessOfMany(
          context,
          undecided.map(({ sellerId }) => sellerId),
        );

    let settled = 0;
    let released = 0;
    let left = 0;
    for (const { sellerId, intent } of stale) {
      const found = byPair.get(`${sellerId}/${intent.revisionId}`) ?? [];
      const outcome = await this.reconcileOne(
        context,
        sellerId,
        intent,
        found,
        states.get(sellerId),
      );
      if (outcome === 'settled') settled += 1;
      else if (outcome === 'released') released += 1;
      else left += 1;
    }
    return ok({ settled, released, left });
  }

  private async reconcileOne(
    context: CallContext,
    sellerId: Id<'Seller'>,
    intent: DecisionIntent,
    found: readonly DecisionByBasis[],
    state: AccessState | undefined,
  ): Promise<'settled' | 'released' | 'left'> {
    const { market } = context;
    const revisionId = intent.revisionId;
    const alert = (reason: string): 'left' => {
      this.#logger.error({
        msg: 'sellers.reconcile-decisions.alert',
        reason,
        sellerId,
        revisionId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return 'left';
    };

    try {
      if (found.length > 1) return alert('several-decisions');
      const decision = found[0];
      if (decision !== undefined) {
        if (decision.kind !== 'approved' && decision.kind !== 'rejected') {
          return alert('unexpected-decision-kind');
        }
        const outcome = decision.kind;
        const result = await this.deps.unitOfWork.run(market, () =>
          settleDecision(this.deps, context, sellerId, revisionId, {
            outcome,
            decisionId: decision.decisionId,
          }),
        );
        return result.ok ? 'settled' : 'left';
      }
      if (state !== 'pending') return alert('not-pending-without-decision');
      const result = await this.deps.unitOfWork.run(market, () =>
        releaseDecision(this.deps, context, sellerId, revisionId, intent.attemptId),
      );
      return result.ok ? 'released' : 'left';
    } catch (error) {
      this.#logger.error({
        msg: 'sellers.reconcile-decisions.failed',
        error: error instanceof Error ? error.name : 'unknown',
        sellerId,
        revisionId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return 'left';
    }
  }
}
