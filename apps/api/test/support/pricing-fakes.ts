import { encodeAuditFields, encodePayload, Temporal } from '@mondapac/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  PendingEvent,
  Result,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import type { OutboxWriter } from '../../src/platform/events/outbox-writer';
import type { UnitOfWork, UnitOfWorkOptions } from '../../src/platform/unit-of-work/unit-of-work';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import type {
  OfferSellUnitsSource,
  PricedOfferView,
} from '../../src/modules/pricing/application/ports/offer-sell-units';
import type {
  AddPriceSeriesOutcome,
  PendingHoldCursor,
  PendingHoldView,
  PriceSeriesKey,
  PriceSeriesRepository,
} from '../../src/modules/pricing/application/ports/price-series.repository';
import type {
  RetiredOfferTombstone,
  RetiredVariantTombstone,
  RetirementTombstoneRepository,
} from '../../src/modules/pricing/application/ports/retirement-tombstone.repository';
import type {
  RefusalAdmission,
  WriteRefusalThrottleRepository,
} from '../../src/modules/pricing/application/ports/write-refusal-throttle.repository';
import { assertSerializableUnit } from '../../src/modules/pricing/application/serializable-unit';
import { PRICING_AUDIT_ACTIONS } from '../../src/modules/pricing/domain/audit';
import { PRICING_EVENTS } from '../../src/modules/pricing/domain/events';
import { PriceSeries } from '../../src/modules/pricing/domain/price-series';
import type {
  PriceSeriesState,
  RegularPriceRecord,
} from '../../src/modules/pricing/domain/price-series';
import { fakeRunOnce } from './fake-run-once';

// In-memory stand-ins for pricing's application tests (no database). PostgreSQL behaviour
// (isolation, rollback, locks) is covered by test/db/pricing-*.db-spec.ts. The fakes keep what
// the use case relies on: optimistic versions, the tombstone check and the serializable guard of
// `add`, the refusal counters' semantics, and the catalogue shape of every audit row and event.

const NO_KEYS = { isKnownPermissionKey: () => false };

/** Every unit the use case opened, with its options; units that end in err roll back nothing. */
export class FakeUnitOfWork implements UnitOfWork {
  readonly units: { readonly market: string; readonly options: UnitOfWorkOptions }[] = [];
  run<T, E>(
    market: MarketContext,
    work: () => Promise<Result<T, E>>,
    options: UnitOfWorkOptions = {},
  ): Promise<Result<T, E>> {
    this.units.push({ market: market.marketId, options });
    return work();
  }
  /** The inbox: `(Market, event, subscriber)` of every event handled. */
  readonly handled = new Set<string>();
  readonly onceUnits: { readonly market: string; readonly options: UnitOfWorkOptions }[] = [];
  runOnce: UnitOfWork['runOnce'] = (market, delivery, work, options = {}) => {
    this.onceUnits.push({ market: market.marketId, options });
    return fakeRunOnce(this.handled)(market, delivery, work);
  };
}

/** The tombstone tables, shared with the series fake that reads them on `add`. */
export class InMemoryTombstones implements RetirementTombstoneRepository {
  constructor(private readonly series: InMemoryPriceSeries) {}
  readonly offers: { market: string; offerId: string; causeEventId: string }[] = [];
  readonly variants: {
    market: string;
    productId: string;
    variantId: string;
    causeEventId: string;
  }[] = [];

  recordRetiredOffer(market: MarketContext, tombstone: RetiredOfferTombstone): Promise<boolean> {
    const key = `${market.marketId}|${tombstone.offerId}`;
    if (this.series.retiredOffers.has(key)) return Promise.resolve(false);
    this.series.retiredOffers.add(key);
    this.offers.push({
      market: market.marketId,
      offerId: tombstone.offerId,
      causeEventId: tombstone.causeEventId,
    });
    return Promise.resolve(true);
  }

  recordRetiredVariant(
    market: MarketContext,
    tombstone: RetiredVariantTombstone,
  ): Promise<boolean> {
    const key = `${market.marketId}|${tombstone.productId}|${tombstone.variantId}`;
    if (this.series.retiredVariants.has(key)) return Promise.resolve(false);
    this.series.retiredVariants.add(key);
    this.variants.push({
      market: market.marketId,
      productId: tombstone.productId,
      variantId: tombstone.variantId,
      causeEventId: tombstone.causeEventId,
    });
    return Promise.resolve(true);
  }
}

function holdView(state: PriceSeriesState, record: RegularPriceRecord): PendingHoldView[] {
  if (
    record.status !== 'PENDING_REVIEW' ||
    record.anchor === null ||
    record.heldDirection === null
  ) {
    return [];
  }
  return [
    {
      recordId: record.id,
      seriesId: state.id,
      offerId: state.offerId,
      variantId: state.variantId,
      sellerId: state.sellerId,
      amount: record.amount,
      anchorRecordId: record.anchor.recordId,
      anchorAmount: record.anchor.amount,
      direction: record.heldDirection,
      submittedAt: record.submittedAt,
    },
  ];
}

const keyOf = (market: MarketContext, key: PriceSeriesKey) =>
  `${market.marketId}|${key.offerId}|${key.variantId}`;

export class InMemoryPriceSeries implements PriceSeriesRepository {
  readonly rows = new Map<string, PriceSeriesState>();
  readonly retiredOffers = new Set<string>();
  readonly retiredVariants = new Set<string>();
  saves = 0;

  retireOffer(market: MarketContext, offerId: Id<'Offer'>): void {
    this.retiredOffers.add(`${market.marketId}|${offerId}`);
  }

  retireVariant(market: MarketContext, productId: Id<'Product'>, variantId: Id<'Variant'>): void {
    this.retiredVariants.add(`${market.marketId}|${productId}|${variantId}`);
  }

  stored(market: MarketContext, key: PriceSeriesKey): PriceSeriesState | null {
    return this.rows.get(keyOf(market, key)) ?? null;
  }

  findByKey(market: MarketContext, key: PriceSeriesKey): Promise<PriceSeries | null> {
    const state = this.rows.get(keyOf(market, key));
    return Promise.resolve(state === undefined ? null : PriceSeries.restore(state));
  }

  findByOffer(market: MarketContext, offerId: Id<'Offer'>): Promise<readonly PriceSeries[]> {
    return Promise.resolve(
      this.inMarket(market)
        .filter((state) => state.offerId === offerId)
        .map((state) => PriceSeries.restore(state)),
    );
  }

  findByProductVariant(
    market: MarketContext,
    productId: Id<'Product'>,
    variantId: Id<'Variant'>,
  ): Promise<readonly PriceSeries[]> {
    return Promise.resolve(
      this.inMarket(market)
        .filter((state) => state.productId === productId && state.variantId === variantId)
        .map((state) => PriceSeries.restore(state)),
    );
  }

  findByRecordId(
    market: MarketContext,
    recordId: Id<'RegularPriceRecord'>,
  ): Promise<PriceSeries | null> {
    const state = this.inMarket(market).find((s) => s.regular.some((r) => r.id === recordId));
    return Promise.resolve(state === undefined ? null : PriceSeries.restore(state));
  }

  listPendingHolds(
    market: MarketContext,
    after: PendingHoldCursor | null,
    limit: number,
  ): Promise<readonly PendingHoldView[]> {
    const views = this.inMarket(market)
      .flatMap((state) => state.regular.flatMap((r) => holdView(state, r)))
      .sort(
        (a, b) =>
          a.submittedAt.epochMilliseconds - b.submittedAt.epochMilliseconds ||
          (a.recordId < b.recordId ? -1 : 1),
      )
      .filter(
        (view) =>
          after === null ||
          view.submittedAt.epochMilliseconds > after.submittedAt.epochMilliseconds ||
          (view.submittedAt.epochMilliseconds === after.submittedAt.epochMilliseconds &&
            view.recordId > after.id),
      );
    return Promise.resolve(views.slice(0, limit));
  }

  findPendingHold(
    market: MarketContext,
    recordId: Id<'RegularPriceRecord'>,
  ): Promise<PendingHoldView | null> {
    const view = this.inMarket(market)
      .flatMap((state) => state.regular.flatMap((r) => holdView(state, r)))
      .find((v) => v.recordId === recordId);
    return Promise.resolve(view ?? null);
  }

  private inMarket(market: MarketContext): PriceSeriesState[] {
    return [...this.rows.entries()]
      .filter(([key]) => key.startsWith(`${market.marketId}|`))
      .map(([, state]) => state);
  }

  add(market: MarketContext, series: PriceSeries): Promise<AddPriceSeriesOutcome> {
    assertSerializableUnit('PriceSeriesRepository.add');
    const { state } = series;
    if (
      this.retiredOffers.has(`${market.marketId}|${state.offerId}`) ||
      this.retiredVariants.has(`${market.marketId}|${state.productId}|${state.variantId}`)
    ) {
      return Promise.resolve('key-retired');
    }
    const key = keyOf(market, state);
    if (this.rows.has(key)) throw new StaleAggregateError('price-series', state.id);
    this.rows.set(key, state);
    series.markStored();
    return Promise.resolve('added');
  }

  save(market: MarketContext, series: PriceSeries): Promise<void> {
    const key = keyOf(market, series.state);
    const current = this.rows.get(key);
    if (current === undefined || current.version !== series.persistedVersion) {
      throw new StaleAggregateError('price-series', series.state.id);
    }
    this.saves += 1;
    this.rows.set(key, series.state);
    series.markStored();
    return Promise.resolve();
  }
}

/** The semantics of pricing-data 3.8 and `admitRefusal` (actor first, then the pair, refund). */
export class InMemoryRefusalThrottles implements WriteRefusalThrottleRepository {
  readonly actors = new Map<string, { start: number; recorded: number; suppressed: number }>();
  readonly pairs = new Map<string, number>();
  /** The order rows were touched in, for the lock-order test. */
  readonly touched: string[] = [];

  admitRefusal(
    market: MarketContext,
    actor: Id<'Account'>,
    offer: Id<'Offer'>,
    now: Temporal.Instant,
    windowMs: number,
    cap: number,
  ): Promise<RefusalAdmission> {
    const at = now.epochMilliseconds;
    const actorKey = `${market.marketId}|${actor}`;
    this.touched.push('actor');
    const row = this.actors.get(actorKey);
    if (row === undefined || row.start <= at - windowMs) {
      this.actors.set(actorKey, { start: at, recorded: 1, suppressed: 0 });
    } else if (row.recorded < cap) {
      row.recorded += 1;
    } else if (row.suppressed === 0) {
      row.suppressed = 1;
      return Promise.resolve({
        kind: 'summarise',
        windowStartedAt: Temporal.Instant.fromEpochMilliseconds(row.start),
      });
    } else {
      row.suppressed += 1;
      return Promise.resolve({ kind: 'none' });
    }
    this.touched.push('offer');
    const pairKey = `${actorKey}|${offer}`;
    const started = this.pairs.get(pairKey);
    if (started === undefined || started <= at - windowMs) {
      this.pairs.set(pairKey, at);
      return Promise.resolve({ kind: 'record' });
    }
    this.actors.get(actorKey)!.recorded -= 1;
    return Promise.resolve({ kind: 'none' });
  }

  purgeActorWindowsStartedBefore(market: MarketContext, before: Temporal.Instant): Promise<number> {
    this.touched.push('purge-actor');
    return Promise.resolve(this.purge(this.actors, market, before, (row) => row.start));
  }

  purgeOfferWindowsStartedBefore(market: MarketContext, before: Temporal.Instant): Promise<number> {
    this.touched.push('purge-offer');
    return Promise.resolve(this.purge(this.pairs, market, before, (start) => start));
  }

  private purge<V>(
    map: Map<string, V>,
    market: MarketContext,
    before: Temporal.Instant,
    startOf: (value: V) => number,
  ): number {
    let count = 0;
    for (const [key, value] of map) {
      if (key.startsWith(`${market.marketId}|`) && startOf(value) < before.epochMilliseconds) {
        map.delete(key);
        count += 1;
      }
    }
    return count;
  }
}

/** Collects audit rows, each checked against its catalogue definition as the writer does (W4). */
export class RecordingAuditWriter implements AuditWriter {
  readonly rows: (AuditEntry & { readonly actorKind: string; readonly market: string })[] = [];
  record(context: CallContext, entry: AuditEntry): Promise<void> {
    const definition = PRICING_AUDIT_ACTIONS.find((d) => d.action === entry.action);
    if (definition === undefined) throw new Error(`audit: unknown action ${entry.action}`);
    if (!definition.actors.includes(context.actor.kind))
      throw new Error('audit: actor not allowed');
    if (definition.targetType !== entry.targetType) throw new Error('audit: target type');
    if (definition.after !== null) {
      const checked = encodeAuditFields(definition.after, entry.after, NO_KEYS);
      if (!checked.ok) throw new Error(`audit: ${JSON.stringify(checked.error)}`);
    }
    this.rows.push({ ...entry, actorKind: context.actor.kind, market: context.market.marketId });
    return Promise.resolve();
  }
}

/** Collects events, each checked against its catalogue definition as the outbox writer does. */
export class RecordingOutbox implements OutboxWriter {
  readonly events: PendingEvent[] = [];
  append(_context: CallContext, events: readonly PendingEvent[]): Promise<void> {
    for (const event of events) {
      const definition = PRICING_EVENTS.find((d) => d.type === event.type);
      if (definition === undefined) throw new Error(`outbox: unknown type ${event.type}`);
      const checked = encodePayload(definition.fields, event.payload, NO_KEYS);
      if (!checked.ok) throw new Error(`outbox: ${JSON.stringify(checked.error)}`);
      this.events.push(event);
    }
    return Promise.resolve();
  }
}

/** catalog's `offerSellUnits` as a map the test fills; `fail` makes it throw. */
export class FakeOfferSellUnits implements OfferSellUnitsSource {
  readonly offers = new Map<string, PricedOfferView>();
  readonly calls: (readonly string[])[] = [];
  fail: Error | null = null;

  put(
    market: MarketContext,
    offerId: Id<'Offer'>,
    view: Omit<PricedOfferView, 'priceableVariantIds'> & {
      readonly priceableVariantIds: readonly Id<'Variant'>[];
    },
  ): void {
    this.offers.set(`${market.marketId}|${offerId}`, {
      ...view,
      priceableVariantIds: new Set(view.priceableVariantIds),
    });
  }

  sellUnitsOf(
    context: CallContext,
    offerIds: readonly Id<'Offer'>[],
  ): Promise<ReadonlyMap<Id<'Offer'>, PricedOfferView>> {
    this.calls.push([...offerIds]);
    if (this.fail !== null) return Promise.reject(this.fail);
    const found = new Map<Id<'Offer'>, PricedOfferView>();
    for (const id of offerIds) {
      const view = this.offers.get(`${context.market.marketId}|${id}`);
      if (view !== undefined) found.set(id, view);
    }
    return Promise.resolve(found);
  }
}
