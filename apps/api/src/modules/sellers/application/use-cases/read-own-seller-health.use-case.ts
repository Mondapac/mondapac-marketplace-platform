import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { sellerActorOf } from '../draft/draft-support';
import type { SellerHealthRequestStore } from '../ports/seller-health-request.store';
import type { SellerHealthRoster } from '../ports/seller-health-roster';
import type { SellerHealthStore } from '../ports/seller-health.store';
import { SELLER_HEALTH_REFRESH_COOLDOWN_SECONDS } from './refresh-own-seller-health.use-case';
import {
  SELLER_HEALTH_TREND_DAYS,
  cardOf,
  type SellerHealthCardView,
  type SellerHealthTrendPoint,
} from './seller-health-read.use-case';

/** What the seller's "Refresh now" button needs to know, so the page never guesses the cooldown. */
export interface OwnSellerHealthRefreshView {
  /** A recount is waiting for the job; the button shows it is on its way. */
  readonly pending: boolean;
  /** Seconds until the next click is allowed; 0 when the seller may click now. */
  readonly retryAfterSeconds: number;
}

export interface OwnSellerHealthView {
  readonly current: SellerHealthCardView | null;
  readonly trend: readonly SellerHealthTrendPoint[];
  readonly refresh: OwnSellerHealthRefreshView;
}

export type ReadOwnSellerHealthFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' };

export interface ReadOwnSellerHealthDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly healthRoster: SellerHealthRoster;
  readonly healthStore: SellerHealthStore;
  readonly healthRequests: SellerHealthRequestStore;
  readonly clock: Clock;
}

/**
 * `sellers.read-own-seller-health` (seller health, HLT-03; the seller's Performance page): the
 * acting seller's own card (latest stored score with its five metrics), the 90-day trend, and the
 * state of "Refresh now" (a request waiting, seconds left of the cooldown). Reads what the nightly
 * run stored and computes nothing. Rule `own-resources`, approved sellers only (the same as
 * "Refresh now"); the seller is the actor's and no input names one. Health only informs (R2).
 */
export class ReadOwnSellerHealth extends UseCase<
  Record<string, never>,
  OwnSellerHealthView,
  ReadOwnSellerHealthFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.read-own-seller-health',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReadOwnSellerHealthDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<OwnSellerHealthView, ReadOwnSellerHealthFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, healthRoster, healthStore, healthRequests, clock } = this.deps;
    const now = clock.now();
    const today = now.toZonedDateTimeISO('UTC').toPlainDate();
    // The newest local date on Earth is at most one day ahead of UTC.
    const last = today.add({ days: 1 });
    const first = today.subtract({ days: SELLER_HEALTH_TREND_DAYS - 1 });
    try {
      return await unitOfWork.run<OwnSellerHealthView, ReadOwnSellerHealthFailure>(
        market,
        async () => {
          if ((await healthRoster.one(market, owner.sellerId)) === null) {
            return err({ code: 'file.not-found' });
          }
          const snapshots = await healthStore.snapshots(market, owner.sellerId, first, last);
          const latest = snapshots[snapshots.length - 1];
          const mine = await healthRequests.latest(market, owner.sellerId, 'seller');
          const any = await healthRequests.latest(market, owner.sellerId);
          const elapsedSeconds =
            mine === null
              ? SELLER_HEALTH_REFRESH_COOLDOWN_SECONDS
              : Math.floor((now.epochMilliseconds - mine.requestedAt.epochMilliseconds) / 1000);
          return ok({
            current: latest === undefined ? null : cardOf(latest),
            trend: snapshots.map((snapshot) => ({
              day: snapshot.day.toString(),
              kind: snapshot.health.kind,
              score: snapshot.health.kind === 'scored' ? snapshot.health.score : null,
            })),
            refresh: {
              pending: any !== null && any.status === 'pending',
              retryAfterSeconds: Math.max(
                0,
                SELLER_HEALTH_REFRESH_COOLDOWN_SECONDS - Math.max(0, elapsedSeconds),
              ),
            },
          });
        },
        { readOnly: true },
      );
    } catch {
      return err({ code: 'sellers.unavailable' });
    }
  }
}
