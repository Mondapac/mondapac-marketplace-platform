import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { CategoryProposalCancelledAudit } from '../../domain/audit';
import { CategoryProposalCancelled } from '../../domain/events';
import type { ShelfWriteDependencies } from '../seller-categories/seller-category-shared';

/** One delivery of `sellers.category-proposals-revoked.v1`, as the subscription maps it. */
export interface CancelPendingProposalsInput {
  readonly delivery: EventDelivery;
  readonly sellerId: Id<'Seller'>;
}

export type CancelPendingProposalsOutput =
  | { readonly code: 'catalog.category-proposals-cancelled'; readonly count: number }
  | { readonly code: 'catalog.category-proposals.already-handled' };

/**
 * The handler `catalog.cancel-pending-proposals` (categories C9a; CAT-51, AC 35; catalog design
 * 4.7). Rule `system`, from the subscription on `sellers.category-proposals-revoked.v1`; the Market
 * is the envelope's, the seller the payload's. In one unit opened through the inbox's `runOnce`,
 * every pending proposal of the seller becomes `cancelled` with reason `permission-revoked`, each
 * with an audit row and `catalog.category-proposal-cancelled.v1`. A repeat delivery stops at the
 * inbox; a proposal decided meanwhile is left as it is. Shelves already approved stay.
 */
export class CancelPendingProposals extends UseCase<
  CancelPendingProposalsInput,
  CancelPendingProposalsOutput,
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.cancel-pending-proposals',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('CancelPendingProposals');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ShelfWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CancelPendingProposalsInput,
  ): Promise<Result<CancelPendingProposalsOutput, { readonly code: 'access.denied' }>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { deps } = this;
    const { sellerId } = input;
    const handled = await deps.unitOfWork.runOnce(market, input.delivery, async () => {
      await deps.shelves.lockSeller(market, sellerId);
      const now = deps.clock.now();
      const cancelled = await deps.shelves.cancelPendingOfSeller(
        market,
        sellerId,
        'permission-revoked',
        now,
      );
      for (const proposal of cancelled) {
        await deps.audit.record(
          context,
          CategoryProposalCancelledAudit.entry(proposal.id, {
            after: { sellerId, reasonCode: 'permission-revoked' },
          }),
        );
      }
      if (cancelled.length > 0) {
        await deps.outbox.append(
          context,
          cancelled.map((proposal) =>
            CategoryProposalCancelled.record({
              aggregateId: proposal.id,
              aggregateVersion: proposal.version,
              occurredAt: now,
              payload: { proposalId: proposal.id, sellerId, reasonCode: 'permission-revoked' },
            }),
          ),
        );
      }
      return ok(cancelled.length);
    });
    if (!handled.ok) throw new Error('cancel-pending-proposals: the unit failed');
    const output: CancelPendingProposalsOutput = handled.value.handled
      ? { code: 'catalog.category-proposals-cancelled', count: handled.value.value }
      : { code: 'catalog.category-proposals.already-handled' };
    this.#logger.log({
      msg: output.code,
      ...(handled.value.handled ? { count: handled.value.value } : {}),
      eventId: input.delivery.eventId,
      attempt: input.delivery.attempt,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok(output);
  }
}
