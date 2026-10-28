import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { ConsumedStepUp, StepUpProofConsumer, StepUpRefusal } from '../../src/platform/authz';
import type {
  MarketSettingRecord,
  MarketSettingRepository,
} from '../../src/modules/promotions/application/ports/market-setting.repository';
import type {
  OptInRecord,
  OptInRepository,
} from '../../src/modules/promotions/application/ports/opt-in.repository';
import type { PriceHistory } from '../../src/modules/promotions/application/ports/price-history';
import type {
  LiveScope,
  PromotionFilter,
  PromotionRepository,
  UsageRecord,
} from '../../src/modules/promotions/application/ports/promotion.repository';
import type { FirstOrderSettings } from '../../src/modules/promotions/application/ports/promotions-policy';
import type {
  ReviewEntry,
  ReviewQueueRepository,
} from '../../src/modules/promotions/application/ports/review-queue.repository';
import type { SellerActivity } from '../../src/modules/promotions/application/ports/seller-activity';
import type {
  FirstOrderSettingsRepository,
  ShippingThresholdRecord,
  ShippingThresholdRepository,
} from '../../src/modules/promotions/application/ports/settings.repository';
import type { PromotionRecord } from '../../src/modules/promotions/domain/promotion';

// The promotions tables in memory, with the rules the tables enforce: a Market-unique code, one
// open review per promotion, a zeroed usage row beside every promotion. One instance per Market
// under test, so no key carries the Market.

export class MemoryPromotions implements PromotionRepository {
  readonly records = new Map<Id<'Promotion'>, PromotionRecord>();
  readonly usage = new Map<Id<'Promotion'>, UsageRecord>();
  /** The promotions read with the row lock, in order. */
  readonly locked: Id<'Promotion'>[] = [];
  /** The scope of the last `listLive`. */
  lastScope: LiveScope | null = null;

  insert(_market: MarketContext, record: PromotionRecord) {
    if (
      record.code !== null &&
      [...this.records.values()].some((other) => other.code === record.code)
    ) {
      return Promise.resolve('duplicate-code' as const);
    }
    this.records.set(record.id, record);
    this.usage.set(record.id, {
      usesCount: 0,
      spentMinor: 0n,
      sellerShareMinor: 0n,
      platformShareMinor: 0n,
    });
    return Promise.resolve('inserted' as const);
  }
  update(_market: MarketContext, record: PromotionRecord) {
    this.records.set(record.id, record);
    return Promise.resolve();
  }
  find(_market: MarketContext, id: Id<'Promotion'>) {
    return Promise.resolve(this.records.get(id) ?? null);
  }
  findForUpdate(_market: MarketContext, id: Id<'Promotion'>) {
    this.locked.push(id);
    return Promise.resolve(this.records.get(id) ?? null);
  }
  findMany(_market: MarketContext, ids: readonly Id<'Promotion'>[]) {
    return Promise.resolve(ids.flatMap((id) => this.records.get(id) ?? []));
  }
  list(_market: MarketContext, filter: PromotionFilter) {
    return Promise.resolve(
      [...this.records.values()]
        .filter((r) => filter.status === undefined || r.status === filter.status)
        .filter(
          (r) => filter.ownerSellerId === undefined || r.ownerSellerId === filter.ownerSellerId,
        )
        .sort((a, b) => b.createdAt.epochMilliseconds - a.createdAt.epochMilliseconds)
        .slice(0, filter.limit),
    );
  }
  listLive(_market: MarketContext, now: Temporal.Instant, scope: LiveScope) {
    this.lastScope = scope;
    return Promise.resolve(
      [...this.records.values()].filter(
        (r) =>
          r.status === 'ACTIVE' &&
          r.startsAt.epochMilliseconds <= now.epochMilliseconds &&
          (r.endsAt === null || r.endsAt.epochMilliseconds > now.epochMilliseconds) &&
          (r.ownerSellerId === null || scope.sellerIds.includes(r.ownerSellerId)) &&
          (r.productIds.length === 0 || r.productIds.some((p) => scope.productIds.includes(p))),
      ),
    );
  }
  countCounting(_market: MarketContext, sellerId: Id<'Seller'>, now: Temporal.Instant) {
    return Promise.resolve(
      [...this.records.values()].filter(
        (r) =>
          r.ownerSellerId === sellerId &&
          (r.status === 'ACTIVE' || r.status === 'PENDING_APPROVAL') &&
          (r.endsAt === null || r.endsAt.epochMilliseconds > now.epochMilliseconds),
      ).length,
    );
  }
  usageOf(_market: MarketContext, ids: readonly Id<'Promotion'>[]) {
    return Promise.resolve(
      new Map(
        ids.flatMap((id) => (this.usage.has(id) ? [[id, this.usage.get(id)!] as const] : [])),
      ),
    );
  }
}

export class MemoryOptIns implements OptInRepository {
  readonly rows = new Map<string, OptInRecord>();
  private key = (p: Id<'Promotion'>, s: Id<'Seller'>) => `${p}:${s}`;
  find(_market: MarketContext, promotionId: Id<'Promotion'>, sellerId: Id<'Seller'>) {
    return Promise.resolve(this.rows.get(this.key(promotionId, sellerId)) ?? null);
  }
  optIn(
    _market: MarketContext,
    promotionId: Id<'Promotion'>,
    sellerId: Id<'Seller'>,
    at: Temporal.Instant,
  ) {
    this.rows.set(this.key(promotionId, sellerId), {
      promotionId,
      sellerId,
      optedInAt: at,
      withdrawnAt: null,
    });
    return Promise.resolve();
  }
  withdraw(
    _market: MarketContext,
    promotionId: Id<'Promotion'>,
    sellerId: Id<'Seller'>,
    at: Temporal.Instant,
  ) {
    const row = this.rows.get(this.key(promotionId, sellerId));
    if (row) this.rows.set(this.key(promotionId, sellerId), { ...row, withdrawnAt: at });
    return Promise.resolve();
  }
  withdrawAll(_market: MarketContext, promotionId: Id<'Promotion'>, at: Temporal.Instant) {
    const sellers: Id<'Seller'>[] = [];
    for (const [key, row] of this.rows) {
      if (row.promotionId !== promotionId || row.withdrawnAt !== null) continue;
      this.rows.set(key, { ...row, withdrawnAt: at });
      sellers.push(row.sellerId);
    }
    return Promise.resolve(sellers.sort() as readonly Id<'Seller'>[]);
  }
  liveSellers(_market: MarketContext, promotionIds: readonly Id<'Promotion'>[]) {
    const map = new Map<Id<'Promotion'>, Id<'Seller'>[]>();
    for (const row of this.rows.values()) {
      if (row.withdrawnAt !== null || !promotionIds.includes(row.promotionId)) continue;
      map.set(row.promotionId, [...(map.get(row.promotionId) ?? []), row.sellerId]);
    }
    return Promise.resolve(map as ReadonlyMap<Id<'Promotion'>, readonly Id<'Seller'>[]>);
  }
}

export class MemoryReviewQueue implements ReviewQueueRepository {
  readonly entries = new Map<Id<'PromotionReview'>, ReviewEntry>();
  open(_market: MarketContext, entry: ReviewEntry) {
    const open = [...this.entries.values()].find(
      (e) => e.promotionId === entry.promotionId && e.status === 'OPEN',
    );
    // One open entry per promotion: a second one moves the first to the new reason and time.
    if (open) {
      this.entries.set(open.id, { ...open, reason: entry.reason, openedAt: entry.openedAt });
    } else {
      this.entries.set(entry.id, entry);
    }
    return Promise.resolve();
  }
  find(_market: MarketContext, id: Id<'PromotionReview'>) {
    return Promise.resolve(this.entries.get(id) ?? null);
  }
  listOpen(_market: MarketContext, limit: number) {
    return Promise.resolve(
      [...this.entries.values()]
        .filter((e) => e.status === 'OPEN')
        .sort((a, b) => a.openedAt.epochMilliseconds - b.openedAt.epochMilliseconds)
        .slice(0, limit),
    );
  }
  decide(
    _market: MarketContext,
    id: Id<'PromotionReview'>,
    status: 'APPROVED' | 'REJECTED',
    at: Temporal.Instant,
  ) {
    const entry = this.entries.get(id);
    if (entry) this.entries.set(id, { ...entry, status, decidedAt: at });
    return Promise.resolve();
  }
}

export class MemoryPromotionsSetting implements MarketSettingRepository {
  row: MarketSettingRecord | null = null;
  find() {
    return Promise.resolve(this.row);
  }
  save(_market: MarketContext, record: MarketSettingRecord) {
    this.row = record;
    return Promise.resolve();
  }
}

export class MemoryFirstOrder implements FirstOrderSettingsRepository {
  row: FirstOrderSettings | null = null;
  find() {
    return Promise.resolve(this.row);
  }
  findForUpdate() {
    return Promise.resolve(this.row);
  }
  save(_market: MarketContext, settings: FirstOrderSettings) {
    this.row = settings;
    return Promise.resolve();
  }
}

export class MemoryThresholds implements ShippingThresholdRepository {
  readonly rows = new Map<string, ShippingThresholdRecord>();
  list() {
    return Promise.resolve([...this.rows.values()]);
  }
  find(_market: MarketContext, zoneCode: string) {
    return Promise.resolve(this.rows.get(zoneCode) ?? null);
  }
  save(
    _market: MarketContext,
    newId: Id<'FreeShippingThreshold'>,
    zoneCode: string,
    thresholdMinor: bigint,
  ) {
    const existing = this.rows.get(zoneCode);
    this.rows.set(zoneCode, { id: existing?.id ?? newId, zoneCode, thresholdMinor });
    return Promise.resolve();
  }
  remove(_market: MarketContext, zoneCode: string) {
    this.rows.delete(zoneCode);
    return Promise.resolve();
  }
}

export class FakeSellerActivity implements SellerActivity {
  readonly since = new Map<Id<'Seller'>, Temporal.Instant>();
  activeSince(_context: CallContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(this.since.get(sellerId) ?? null);
  }
}

export class FakePriceHistory implements PriceHistory {
  days: number | null = null;
  daysSoldAtPrice() {
    return Promise.resolve(this.days);
  }
}

/** Spends a proof once: refuses with `second-factor.required` until `fresh` is set. */
export class FakeStepUp implements StepUpProofConsumer {
  fresh = false;
  readonly spent: string[] = [];
  constructor(private readonly now: () => Temporal.Instant) {}
  consume(_context: CallContext, actionKey: string) {
    if (!this.fresh) {
      const refusal: StepUpRefusal = { code: 'second-factor.required', actionKey };
      return Promise.resolve({ ok: false as const, error: refusal });
    }
    this.fresh = false;
    this.spent.push(actionKey);
    const value: ConsumedStepUp = {
      sessionId: '01990000-0000-7000-8000-000000000061' as Id<'Session'>,
      verifiedAt: this.now(),
    };
    return Promise.resolve(ok(value));
  }
}
