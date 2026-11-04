import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import type { MetricResult } from '../../domain/seller-health';
import type { SellerFileRepository } from '../ports/seller-file.repository';
import type { SellerHealthSnapshot, SellerHealthStore } from '../ports/seller-health.store';

/** How many days of snapshots the trend and the current card are read from. */
export const SELLER_HEALTH_TREND_DAYS = 90;

export interface SellerHealthReadInput {
  readonly sellerId: string;
}

/** The score as the card shows it; `null` fields mean New or no data. */
export interface SellerHealthCardView {
  readonly day: string;
  readonly kind: 'scored' | 'new' | 'no-data';
  readonly band: 'healthy' | 'at-risk' | 'unhealthy' | null;
  readonly score: number | null;
  readonly lowestMetric: string | null;
  readonly formulaVersion: string;
  readonly computedAt: string;
  /** Orders in the long window: the New label compares it with the Market minimum. */
  readonly orders: number;
  readonly metrics: readonly MetricResult[];
}

export interface SellerHealthTrendPoint {
  readonly day: string;
  readonly kind: 'scored' | 'new' | 'no-data';
  readonly score: number | null;
}

export interface SellerHealthView {
  readonly sellerId: string;
  /** The latest snapshot, or `null` when no night has measured the seller yet. */
  readonly current: SellerHealthCardView | null;
  /** Oldest first, one point per measured day of the last 90 days. */
  readonly trend: readonly SellerHealthTrendPoint[];
}

export type SellerHealthReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' };

export interface SellerHealthReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly files: SellerFileRepository;
  readonly healthStore: SellerHealthStore;
  readonly clock: Clock;
}

export function cardOf(snapshot: SellerHealthSnapshot): SellerHealthCardView {
  const { health } = snapshot;
  const scored = health.kind === 'scored';
  return {
    day: snapshot.day.toString(),
    kind: health.kind,
    band: scored ? health.band : null,
    score: scored ? health.score : null,
    lowestMetric: scored ? health.lowestMetric : null,
    formulaVersion: health.formulaVersion,
    computedAt: snapshot.computedAt.toString(),
    orders: snapshot.inputs.orders,
    metrics: health.metrics,
  };
}

/**
 * `sellers.seller-health-read` (seller health package 5): the admin's card for one seller: the
 * latest stored score with its five metrics, and the 90-day trend. It reads what the nightly run
 * stored and computes nothing. Rule `permissions [sellers.seller.view]`, the same key as the
 * seller page. The seller must belong to the context's Market (`file.not-found` otherwise, the
 * same answer as for an id that never existed). A seller that no night has measured yet answers
 * `current: null` with an empty trend.
 */
export class SellerHealthRead extends UseCase<
  SellerHealthReadInput,
  SellerHealthView,
  SellerHealthReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.seller-health-read',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SellerHealthReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerHealthReadInput,
  ): Promise<Result<SellerHealthView, SellerHealthReadFailure>> {
    const parsed = typeof input?.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    if (parsed === null || !parsed.ok) return err({ code: 'file.not-found' });
    const sellerId = parsed.value;
    const { market } = context;
    const today = this.deps.clock.now().toZonedDateTimeISO('UTC').toPlainDate();
    // The newest local date on Earth is at most one day ahead of UTC.
    const last = today.add({ days: 1 });
    const first = today.subtract({ days: SELLER_HEALTH_TREND_DAYS - 1 });
    try {
      return await this.deps.unitOfWork.run<SellerHealthView, SellerHealthReadFailure>(
        market,
        async () => {
          if ((await this.deps.files.findById(market, sellerId)) === null) {
            return err({ code: 'file.not-found' });
          }
          const snapshots = await this.deps.healthStore.snapshots(market, sellerId, first, last);
          const latest = snapshots[snapshots.length - 1];
          return ok({
            sellerId,
            current: latest === undefined ? null : cardOf(latest),
            trend: snapshots.map((snapshot) => ({
              day: snapshot.day.toString(),
              kind: snapshot.health.kind,
              score: snapshot.health.kind === 'scored' ? snapshot.health.score : null,
            })),
          });
        },
        { readOnly: true },
      );
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
