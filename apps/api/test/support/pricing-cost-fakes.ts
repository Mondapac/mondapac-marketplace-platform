import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  AddCostSeriesOutcome,
  CostSeriesRepository,
} from '../../src/modules/pricing/application/ports/cost-series.repository';
import { assertSerializableUnit } from '../../src/modules/pricing/application/serializable-unit';
import {
  CostSeries,
  type CostSeriesState,
} from '../../src/modules/pricing/domain/cost/cost-series';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';

/**
 * The Cost store in memory (pricing-data 3.7): one stored state per (Market, Offer, Variant) and
 * every appended record, so a test can count the rows a write produced. `add` refuses outside a
 * serializable unit, as the Prisma repository does, and reads the shared tombstone keys.
 */
export class InMemoryCostSeries implements CostSeriesRepository {
  readonly #byKey = new Map<string, Omit<CostSeriesState, 'appended'>>();
  readonly records: { market: string; seriesId: string; cleared: boolean }[] = [];
  readonly retiredOffers = new Set<string>();

  #key(market: MarketContext, offerId: string, variantId: string): string {
    return `${market.marketId}|${offerId}|${variantId}`;
  }

  stored(
    market: MarketContext,
    offerId: Id<'Offer'>,
    variantId: Id<'Variant'>,
  ): Omit<CostSeriesState, 'appended'> | null {
    return this.#byKey.get(this.#key(market, offerId, variantId)) ?? null;
  }

  /** Puts a stored series under another seller (Hassan L3 cases). */
  putStored(market: MarketContext, state: Omit<CostSeriesState, 'appended'>): void {
    this.#byKey.set(this.#key(market, state.offerId, state.variantId), state);
  }

  findByKey(
    market: MarketContext,
    key: { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> },
  ): Promise<CostSeries | null> {
    const state = this.#byKey.get(this.#key(market, key.offerId, key.variantId));
    return Promise.resolve(state === undefined ? null : CostSeries.restore(state));
  }

  findByOffer(market: MarketContext, offerId: Id<'Offer'>): Promise<readonly CostSeries[]> {
    return Promise.resolve(
      [...this.#byKey.values()]
        .filter((state) => state.marketId === market.marketId && state.offerId === offerId)
        .map((state) => CostSeries.restore(state)),
    );
  }

  add(market: MarketContext, series: CostSeries): Promise<AddCostSeriesOutcome> {
    assertSerializableUnit('CostSeriesRepository.add');
    const { state } = series;
    if (this.retiredOffers.has(`${market.marketId}|${state.offerId}`)) {
      return Promise.resolve('key-retired');
    }
    const key = this.#key(market, state.offerId, state.variantId);
    if (this.#byKey.has(key)) throw new StaleAggregateError('cost-series', state.id);
    this.#store(market, series);
    return Promise.resolve('added');
  }

  save(market: MarketContext, series: CostSeries): Promise<void> {
    const key = this.#key(market, series.state.offerId, series.state.variantId);
    const current = this.#byKey.get(key);
    if (current === undefined) throw new Error('save: never stored');
    if (current.version !== series.storedState?.version) {
      throw new StaleAggregateError('cost-series', series.state.id);
    }
    this.#store(market, series);
    return Promise.resolve();
  }

  #store(market: MarketContext, series: CostSeries): void {
    const appended = series.state.appended;
    if (appended !== null) {
      this.records.push({
        market: market.marketId,
        seriesId: series.state.id,
        cleared: appended.amount === null,
      });
    }
    series.markStored();
    const state = series.state;
    const stored: Omit<CostSeriesState, 'appended'> = {
      id: state.id,
      marketId: state.marketId,
      offerId: state.offerId,
      variantId: state.variantId,
      productId: state.productId,
      sellerId: state.sellerId,
      currency: state.currency,
      retiredAt: state.retiredAt,
      retireCause: state.retireCause,
      version: state.version,
      createdAt: state.createdAt,
      latest: state.latest,
    };
    this.#byKey.set(this.#key(market, stored.offerId, stored.variantId), stored);
  }
}
