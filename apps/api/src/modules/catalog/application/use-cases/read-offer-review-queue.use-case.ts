import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  OfferReviewQueueFailure,
  OfferReviewQueueSnapshot,
} from '../../contracts/catalog-work-queue.facade';
import type { CatalogWorkQueueCountReader } from '../ports/work-queue-count.reader';

export interface ReadOfferReviewQueueDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly counts: CatalogWorkQueueCountReader;
}

/**
 * `catalog.read-offer-review-queue` (risk-based Offer approval, slice 8): the Offers waiting for
 * their first-publication review, as one count and the submission time of the oldest, for the
 * queue backlog alert that notifications raises. Rule `system`: the alert runs as the Market's
 * system actor in a worker job, so the dashboard's admin-only count does not apply. It reads the
 * same indexed aggregate as that count and returns no row, id or seller. One read-only unit; a
 * store fault is `access.unavailable`.
 */
export class ReadOfferReviewQueue extends UseCase<
  { readonly now: Temporal.Instant },
  OfferReviewQueueSnapshot,
  OfferReviewQueueFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.read-offer-review-queue',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReadOfferReviewQueueDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly now: Temporal.Instant },
  ): Promise<Result<OfferReviewQueueSnapshot, OfferReviewQueueFailure>> {
    try {
      return await this.deps.unitOfWork.run(
        context.market,
        async () => {
          const queue = await this.deps.counts.pendingOffers(context.market, input.now, input.now);
          return ok({ count: queue.count, oldestAt: queue.oldestAt });
        },
        { readOnly: true },
      );
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
}
