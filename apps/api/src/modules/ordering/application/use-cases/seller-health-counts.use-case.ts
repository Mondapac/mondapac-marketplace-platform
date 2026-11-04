import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { SellerOrderHealthCount, SellerOrderHealthCountsFailure } from '../../contracts';
import { bucketSellerHealth } from '../../domain/seller-health-counts';
import type { OrderingDependencies } from '../checkout-flow';

interface Input {
  readonly sellerId?: unknown;
  readonly windows?: unknown;
}

/** The most windows one call may ask for (a few local days). */
export const SELLER_HEALTH_MAX_WINDOWS = 8;

/** The most seller orders of one seller read for the windows; past it the read fails. */
export const SELLER_HEALTH_ROW_LIMIT = 20_000;

const instantOf = (value: unknown): Temporal.Instant | null => {
  if (typeof value !== 'string') return null;
  try {
    return Temporal.Instant.from(value);
  } catch {
    return null;
  }
};

/**
 * `ordering.seller-health-counts`: the seller health feed (rule `system`): for each window the
 * seller orders paid, the ones marked ready that carry a promise, and the ones marked ready after
 * their ready-by time, in one read. The windows are instants the caller worked out in the
 * seller's own zone (ADR-0005). Counters only: no customer, address or amount. The nightly health
 * job of `sellers` calls it through the ordering facade.
 */
export class SellerHealthCountsQuery extends UseCase<
  Input,
  readonly SellerOrderHealthCount[],
  SellerOrderHealthCountsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'ordering.seller-health-counts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OrderingDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<readonly SellerOrderHealthCount[], SellerOrderHealthCountsFailure>> {
    const sellerId = typeof input?.sellerId === 'string' ? parseId<'Seller'>(input.sellerId) : null;
    const raw = input?.windows;
    if (
      sellerId === null ||
      !sellerId.ok ||
      !Array.isArray(raw) ||
      raw.length === 0 ||
      raw.length > SELLER_HEALTH_MAX_WINDOWS
    ) {
      return err({ code: 'validation.failed' });
    }
    const windows: { from: Temporal.Instant; to: Temporal.Instant }[] = [];
    for (const entry of raw as unknown[]) {
      const w = (entry ?? {}) as { from?: unknown; to?: unknown };
      const from = instantOf(w.from);
      const to = instantOf(w.to);
      if (from === null || to === null || Temporal.Instant.compare(from, to) >= 0) {
        return err({ code: 'validation.failed' });
      }
      windows.push({ from, to });
    }
    const first = windows.reduce(
      (a, w) => (Temporal.Instant.compare(w.from, a) < 0 ? w.from : a),
      windows[0]!.from,
    );
    const last = windows.reduce(
      (a, w) => (Temporal.Instant.compare(w.to, a) > 0 ? w.to : a),
      windows[0]!.to,
    );
    return this.deps.unitOfWork.run<
      readonly SellerOrderHealthCount[],
      SellerOrderHealthCountsFailure
    >(
      context.market,
      async () =>
        ok(
          bucketSellerHealth(
            await this.deps.orders.sellerHealthRows(
              context.market,
              sellerId.value,
              first,
              last,
              SELLER_HEALTH_ROW_LIMIT,
            ),
            windows,
          ),
        ),
      { readOnly: true },
    );
  }
}
