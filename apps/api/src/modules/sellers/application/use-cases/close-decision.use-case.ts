import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { settleDecision, type SettlementDependencies } from '../review/decision-settlement';

/** One delivery of `identity.seller-access-approved.v1` or `-rejected.v1` (design 7.3, 7.5). */
export interface CloseDecisionInput {
  readonly delivery: EventDelivery;
  readonly outcome: 'approved' | 'rejected';
  readonly sellerId: Id;
  readonly decisionId: Id;
  /** Revision N; absent on a decision `sellers` did not ask for (Phase 2, an operator command). */
  readonly basisId: Id | null | undefined;
}

export type CloseDecisionOutput =
  | { readonly code: 'close-decision.settled' }
  | { readonly code: 'close-decision.no-basis' }
  | { readonly code: 'close-decision.unknown-revision' }
  | { readonly code: 'close-decision.already-handled' };

export type CloseDecisionFailure = { readonly code: 'access.denied' };

export interface CloseDecisionDependencies extends SettlementDependencies {
  readonly unitOfWork: UnitOfWork;
}

/**
 * The handler `sellers.close-decision` (sellers design 7.3, 7.5; slice 7a-decide). Rule `system`,
 * from the subscriptions on `identity`'s decision events. It settles revision N (the event's
 * `basisId`) as `identity` decided it, in the inbox unit of the delivery, with the same
 * {@link settleDecision} as the reviewer's own request, so whichever runs first records the
 * decision and the other changes nothing. It is what finishes a decision whose request died or
 * timed out between `identity`'s answer and its own second unit. An event without a `basisId`, or
 * naming a revision this Market does not hold, is marked handled and changes nothing. A lost race
 * (`conflict.stale`) throws, so the delivery is retried.
 */
export class CloseDecision extends UseCase<
  CloseDecisionInput,
  CloseDecisionOutput,
  CloseDecisionFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.close-decision',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('CloseDecision');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CloseDecisionDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CloseDecisionInput,
  ): Promise<Result<CloseDecisionOutput, CloseDecisionFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const output = await this.run(context, input);
    this.#logger.log({
      msg: `sellers.${output.code}`,
      outcome: input.outcome,
      sellerId: input.sellerId,
      revisionId: input.basisId ?? null,
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }

  private async run(context: CallContext, input: CloseDecisionInput): Promise<CloseDecisionOutput> {
    const { market } = context;
    const seller = parseId<'Seller'>(input.sellerId);
    const basis =
      input.basisId === null || input.basisId === undefined
        ? null
        : parseId<'BusinessFileRevision'>(input.basisId);
    const decision = parseId<'AccessDecision'>(input.decisionId);
    const handled = await this.deps.unitOfWork.runOnce<CloseDecisionOutput, { code: string }>(
      market,
      input.delivery,
      async () => {
        if (basis === null || !seller.ok || !basis.ok || !decision.ok) {
          return ok({ code: 'close-decision.no-basis' });
        }
        const settled = await settleDecision(this.deps, context, seller.value, basis.value, {
          outcome: input.outcome,
          decisionId: decision.value,
        });
        if (settled.ok) return ok({ code: 'close-decision.settled' });
        if (settled.error.code === 'file.not-found') {
          return ok({ code: 'close-decision.unknown-revision' });
        }
        return err(settled.error);
      },
    );
    if (!handled.ok) throw new Error(`sellers.close-decision: ${handled.error.code}`);
    return handled.value.handled ? handled.value.value : { code: 'close-decision.already-handled' };
  }
}
