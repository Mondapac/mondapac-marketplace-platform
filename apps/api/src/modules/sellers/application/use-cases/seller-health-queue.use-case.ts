import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import type { SellerHealthMetric } from '../../domain/seller-health';
import type { SellerHealthStore } from '../ports/seller-health.store';
import type { SellerListRepository } from '../ports/seller-list.repository';
import { SELLER_LIST_HEALTH_DAYS } from './list.use-case';

/** One seller of the "Needs a look" queue. */
export interface SellerHealthQueueItem {
  readonly sellerId: Id<'Seller'>;
  readonly storeName: string | null;
  /** The held slug, else the draft's. */
  readonly slug: string | null;
  readonly day: string;
  readonly score: number;
  /** The metric that set the score: where to look first. */
  readonly lowestMetric: SellerHealthMetric;
}

export interface SellerHealthQueue {
  /** Worst score first, ties by seller id. */
  readonly items: readonly SellerHealthQueueItem[];
  /** True when more sellers were unhealthy than the queue holds. */
  readonly truncated: boolean;
}

export type SellerHealthQueueFailure =
  { readonly code: 'access.denied' } | { readonly code: 'sellers.unavailable' };

export interface SellerHealthQueueDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly healthStore: SellerHealthStore;
  readonly list: SellerListRepository;
  readonly clock: Clock;
}

/**
 * `sellers.seller-health-queue` (seller health package 5c): the admin's "Needs a look" queue,
 * the sellers whose newest stored health is `unhealthy`, worst first, with the store name and the
 * metric that set the score. Unhealthy only informs: this reads and lists, and no automatic
 * action follows from it (owner decision). Rule `permissions [sellers.seller.view]`. A seller
 * counts while it has a snapshot of the last three days (the nightly run recounts three), so a
 * seller the run no longer measures leaves the queue instead of staying on it. One read-only unit
 * on `sellers`' tables; a failure is `sellers.unavailable`.
 */
export class SellerHealthQueueRead extends UseCase<
  Record<string, never>,
  SellerHealthQueue,
  SellerHealthQueueFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-health-queue',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerHealthQueueDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<SellerHealthQueue, SellerHealthQueueFailure>> {
    const { market } = context;
    const today = this.deps.clock.now().toZonedDateTimeISO('UTC').toPlainDate();
    // The newest local date on Earth is at most one day ahead of UTC.
    const last = today.add({ days: 1 });
    const first = today.subtract({ days: SELLER_LIST_HEALTH_DAYS - 1 });
    try {
      return await this.deps.unitOfWork.run<SellerHealthQueue, SellerHealthQueueFailure>(
        market,
        async () => {
          const found = await this.deps.healthStore.unhealthy(market, first, last);
          if (found.sellers.length === 0) return ok({ items: [], truncated: false });
          const files = await this.deps.list.all(market, {
            kind: null,
            outsideArea: false,
            openAreaCodes: [],
            areaCode: null,
            onlyIds: found.sellers.map((seller) => seller.sellerId),
            after: null,
            take: found.sellers.length,
          });
          const byId = new Map(files.map((file) => [file.sellerId, file]));
          const items = found.sellers.flatMap((seller): SellerHealthQueueItem[] => {
            const file = byId.get(seller.sellerId);
            // A snapshot of a seller with no file in this Market cannot exist (foreign key).
            if (file === undefined || seller.score === null || seller.lowestMetric === null) {
              return [];
            }
            return [
              {
                sellerId: seller.sellerId,
                storeName: file.storeName,
                slug: file.heldSlug ?? file.draftSlug,
                day: seller.day.toString(),
                score: seller.score,
                lowestMetric: seller.lowestMetric,
              },
            ];
          });
          return ok({ items, truncated: found.truncated });
        },
        { readOnly: true },
      );
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
