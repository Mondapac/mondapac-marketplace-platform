import { createHash } from 'node:crypto';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Money, Result } from '@mondapac/shared-kernel';
import type { ConsumedStepUp, StepUpProofConsumer, StepUpRefusal } from '../../src/platform/authz';
import type { BatchCodeCrypto } from '../../src/modules/promotions/application/ports/batch-code-crypto';
import type {
  BatchCodeCount,
  BatchCodeRecord,
  BatchCodeRepository,
} from '../../src/modules/promotions/application/ports/batch-code.repository';
import type {
  CreditCursor,
  CreditRepository,
  ReferralCodeRecord,
  ReferralRepository,
} from '../../src/modules/promotions/application/ports/credit.repository';
import type {
  CustomerOrderHistory,
  Known,
  StoreFollows,
  CustomerGroupMembership,
  ExclusiveCustomers,
} from '../../src/modules/promotions/application/ports/customer-facts';
import type {
  DeliveredOrderFacts,
  DeliveredSellerOrderFacts,
} from '../../src/modules/promotions/application/ports/order-facts';
import type {
  ReferralSignals,
  ReferralVerdict,
} from '../../src/modules/promotions/application/ports/referral-signals';
import type {
  WalletCredit,
  WalletCreditFailure,
} from '../../src/modules/promotions/application/ports/wallet-credit';
import type {
  CreditKind,
  CreditRecord,
  ReferralRecord,
  ReferralRejectReason,
  ReferralStatus,
} from '../../src/modules/promotions/domain/credit';
import type { FlashSales } from '../../src/modules/promotions/application/ports/flash-sales';
import type {
  MarketSettingRecord,
  MarketSettingRepository,
} from '../../src/modules/promotions/application/ports/market-setting.repository';
import type {
  OptInRecord,
  OptInRepository,
} from '../../src/modules/promotions/application/ports/opt-in.repository';
import type { PriceHistory } from '../../src/modules/promotions/application/ports/price-history';
import type { SellerCatalogue } from '../../src/modules/promotions/application/ports/seller-catalogue';
import type { SellerCommission } from '../../src/modules/promotions/application/ports/seller-commission';
import { LockContendedError } from '../../src/modules/promotions/application/ports/promotion.repository';
import type {
  CriterionCounts,
  LiveScope,
  PromotionFilter,
  PromotionRepository,
  PromotionSearch,
  StatusCriterion,
  UsageRecord,
} from '../../src/modules/promotions/application/ports/promotion.repository';
import type { FirstOrderSettings } from '../../src/modules/promotions/application/ports/promotions-policy';
import type {
  ReviewEntry,
  ReviewQueueRepository,
} from '../../src/modules/promotions/application/ports/review-queue.repository';
import type { PayoutAnchors } from '../../src/modules/promotions/application/ports/payout-anchors';
import type { SellerCashbackLedger } from '../../src/modules/promotions/application/ports/seller-cashback-ledger';
import type { SellerActivity } from '../../src/modules/promotions/application/ports/seller-activity';
import type {
  FirstOrderSettingsRepository,
  ShippingThresholdRecord,
  ShippingThresholdRepository,
} from '../../src/modules/promotions/application/ports/settings.repository';
import { displayStatusOf } from '../../src/modules/promotions/domain/display-status';
import {
  RedemptionTakenError,
  type RedemptionRepository,
  type UsageDelta,
} from '../../src/modules/promotions/application/ports/redemption.repository';
import type {
  RedemptionRecord,
  ReleaseReason,
} from '../../src/modules/promotions/domain/redemption';
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
  /** Set to make the row lock give up, as the database one does under heavy contention. */
  contended = false;
  findForUpdate(_market: MarketContext, id: Id<'Promotion'>) {
    if (this.contended) return Promise.reject(new LockContendedError('promotions.promotion'));
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
  private matches(
    search: PromotionSearch,
    now: Temporal.Instant,
    criterion: StatusCriterion | null,
  ) {
    return (r: PromotionRecord) => {
      const text = search.text?.toLowerCase() ?? null;
      if (
        text !== null &&
        !r.name.toLowerCase().includes(text) &&
        !(r.code ?? '').startsWith(text.toUpperCase())
      ) {
        return false;
      }
      if (search.types.length > 0 && !search.types.includes(r.type)) return false;
      if (search.owner === 'PLATFORM' && r.ownerSellerId !== null) return false;
      if (search.owner === 'SELLER' && r.ownerSellerId === null) return false;
      if (search.funding !== null && r.funding !== search.funding) return false;
      if (criterion === null) return true;
      if (criterion === 'NEEDS_REVIEW') return search.reviewPromotionIds.includes(r.id);
      const shown = displayStatusOf(
        {
          type: r.type,
          status: r.status,
          startsAt: r.startsAt,
          endsAt: r.endsAt,
          budgetMinor: r.budgetMinor,
          spentMinor: this.usage.get(r.id)?.spentMinor ?? 0n,
        },
        now,
      );
      return (
        shown === criterion ||
        (search.hideBudget && criterion === 'ACTIVE' && shown === 'BUDGET_USED_UP')
      );
    };
  }
  search(_market: MarketContext, search: PromotionSearch, now: Temporal.Instant) {
    const key = (r: PromotionRecord): number | string =>
      search.sort === 'STARTS'
        ? r.startsAt.epochMilliseconds
        : search.sort === 'ENDS'
          ? (r.endsAt?.epochMilliseconds ?? Number.MAX_SAFE_INTEGER)
          : search.sort === 'NAME'
            ? r.name
            : search.sort === 'USES'
              ? (this.usage.get(r.id)?.usesCount ?? 0)
              : r.createdAt.epochMilliseconds;
    const sign = search.descending ? -1 : 1;
    const all = [...this.records.values()]
      .filter(this.matches(search, now, search.criterion))
      .sort((a, b) => {
        const x = key(a);
        const y = key(b);
        return (x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * sign;
      });
    return Promise.resolve({
      records: all.slice(search.offset, search.offset + search.limit),
      total: all.length,
    });
  }
  countByCriterion(_market: MarketContext, search: PromotionSearch, now: Temporal.Instant) {
    const counts = new Map<StatusCriterion | 'ALL', number>();
    const all = [...this.records.values()];
    counts.set('ALL', all.filter(this.matches(search, now, null)).length);
    for (const criterion of [
      'ACTIVE',
      'SCHEDULED',
      'PAUSED',
      'NEEDS_REVIEW',
      'ENDED',
      'PENDING_APPROVAL',
      'REJECTED',
      'BUDGET_USED_UP',
    ] as const) {
      counts.set(criterion, all.filter(this.matches(search, now, criterion)).length);
    }
    return Promise.resolve(counts as CriterionCounts);
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
  listOpenCampaigns(
    _market: MarketContext,
    now: Temporal.Instant,
    sellerId: Id<'Seller'>,
    promotionId?: Id<'Promotion'>,
  ) {
    return Promise.resolve(
      [...this.records.values()]
        .filter(
          (r) =>
            (promotionId === undefined || r.id === promotionId) &&
            r.type === 'CO_FUNDED_CAMPAIGN' &&
            r.funding === 'CO_FUNDED' &&
            r.status === 'ACTIVE' &&
            (r.endsAt === null || r.endsAt.epochMilliseconds > now.epochMilliseconds) &&
            (r.sellerIds.length === 0 || r.sellerIds.includes(sellerId)),
        )
        .sort(
          (a, b) =>
            a.startsAt.epochMilliseconds - b.startsAt.epochMilliseconds ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        ),
    );
  }
  listLiveOfTypes(
    _market: MarketContext,
    now: Temporal.Instant,
    types: readonly PromotionRecord['type'][],
  ) {
    return Promise.resolve(
      [...this.records.values()]
        .filter(
          (r) =>
            types.includes(r.type) &&
            r.status === 'ACTIVE' &&
            r.startsAt.epochMilliseconds <= now.epochMilliseconds &&
            (r.endsAt === null || r.endsAt.epochMilliseconds > now.epochMilliseconds),
        )
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    );
  }
  existingCodes(_market: MarketContext, codes: readonly string[]) {
    const wanted = new Set(codes);
    return Promise.resolve(
      new Set(
        [...this.records.values()].flatMap((r) =>
          r.code !== null && wanted.has(r.code) ? [r.code] : [],
        ),
      ) as ReadonlySet<string>,
    );
  }
  countGroupSegmentUses(_market: MarketContext, groupId: string, now: Temporal.Instant) {
    return Promise.resolve(
      [...this.records.values()].filter(
        (r) =>
          r.segmentKind === 'MANUAL_GROUP' &&
          r.segmentGroupId === groupId &&
          (r.status === 'ACTIVE' || r.status === 'PENDING_APPROVAL' || r.status === 'PAUSED') &&
          (r.endsAt === null || r.endsAt.epochMilliseconds > now.epochMilliseconds),
      ).length,
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
  listOf(_market: MarketContext, promotionId: Id<'Promotion'>) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.promotionId === promotionId)
        .sort((a, b) => a.optedInAt.epochMilliseconds - b.optedInAt.epochMilliseconds),
    );
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
  openSummary() {
    const open = [...this.entries.values()].filter((e) => e.status === 'OPEN');
    return Promise.resolve({ count: open.length, promotionIds: open.map((e) => e.promotionId) });
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
  contended = false;
  findForUpdate() {
    if (this.contended) return Promise.reject(new LockContendedError('promotions.first-order'));
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

export class FakeSellerCommission implements SellerCommission {
  /** Null = unreadable. */
  rate: number | null = 1500;
  /** The provisional tax taken out of a tax-inclusive amount, basis points. */
  taxBps = 1000;
  readonly asked: { amount: bigint; taxInclusive: boolean }[] = [];
  commissionOn(_context: CallContext, amount: bigint, taxInclusive: boolean) {
    this.asked.push({ amount, taxInclusive });
    if (this.rate === null) return Promise.resolve(null);
    const half = (n: bigint, d: bigint) => (n * 2n + d) / (d * 2n);
    const base = taxInclusive ? half(amount * 10000n, 10000n + BigInt(this.taxBps)) : amount;
    return Promise.resolve({
      rateBps: this.rate,
      commissionBase: base,
      commission: half(base * BigInt(this.rate), 10000n),
    });
  }
}

/** A seller's catalogue: the products it sells and the sell units it owns. */
export class FakeSellerCatalogue implements SellerCatalogue {
  /** Null = unknown. */
  sells: ReadonlySet<Id<'Product'>> | null = new Set();
  owns = true;
  sellsProducts() {
    return Promise.resolve(this.sells);
  }
  ownsSellUnit() {
    return Promise.resolve(this.owns);
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

/** The generated single-use codes in memory: unique per Market by hash, never deleted. */
export class MemoryBatchCodes implements BatchCodeRepository {
  readonly rows = new Map<
    string,
    { promotionId: Id<'Promotion'>; batchId: Id<'PromotionBatch'>; usedAt: Temporal.Instant | null }
  >();
  find(_market: MarketContext, codeHash: string) {
    const row = this.rows.get(codeHash);
    const record: BatchCodeRecord | null =
      row === undefined ? null : { promotionId: row.promotionId, usedAt: row.usedAt };
    return Promise.resolve(record);
  }
  existing(_market: MarketContext, hashes: readonly string[]) {
    return Promise.resolve(new Set(hashes.filter((hash) => this.rows.has(hash))));
  }
  insertMany(
    _market: MarketContext,
    promotionId: Id<'Promotion'>,
    batchId: Id<'PromotionBatch'>,
    hashes: readonly string[],
  ) {
    for (const hash of hashes) {
      if (this.rows.has(hash)) throw new Error('unique violation: promotion_batch_codes');
      this.rows.set(hash, { promotionId, batchId, usedAt: null });
    }
    return Promise.resolve();
  }
  count(_market: MarketContext, promotionId: Id<'Promotion'>) {
    const mine = [...this.rows.values()].filter((row) => row.promotionId === promotionId);
    const count: BatchCodeCount = {
      total: mine.length,
      used: mine.filter((row) => row.usedAt !== null).length,
    };
    return Promise.resolve(count);
  }
  /** What package T2 does when an order redeems a code. */
  markUsed(hash: string, at: Temporal.Instant) {
    const row = this.rows.get(hash);
    if (row === undefined) throw new Error('no such code');
    this.rows.set(hash, { ...row, usedAt: at });
  }
}

/**
 * A repeatable code source: the n-th code is the n-th string over the alphabet in base-N counting
 * (so a test can name the codes it expects), or the next of `script` first. The hash is the real
 * SHA-256.
 */
export class FakeBatchCodeCrypto implements BatchCodeCrypto {
  /** False: the pepper is missing, as in a deployment without PROMOTIONS_CODE_PEPPER. */
  available = true;
  /** Codes handed out first, in order, before the counter takes over. */
  script: string[] = [];
  private counter = 0;
  readonly requests: { alphabet: string; length: number }[] = [];
  generate(alphabet: string, length: number): string {
    this.requests.push({ alphabet, length });
    const scripted = this.script.shift();
    if (scripted !== undefined) return scripted;
    let n = ++this.counter;
    let code = '';
    for (let i = 0; i < length; i++) {
      code = alphabet[n % alphabet.length]! + code;
      n = Math.floor(n / alphabet.length);
    }
    return code;
  }
  hash(code: string): string {
    return createHash('sha256').update(code, 'utf8').digest('hex');
  }
  referralCode(subject: string, alphabet: string, length: number): string {
    const digest = createHash('sha256').update(`referral-code|${subject}`, 'utf8').digest();
    let n = BigInt(`0x${digest.toString('hex')}`);
    const base = BigInt(alphabet.length);
    let code = '';
    for (let i = 0; i < length; i++) {
      code += alphabet[Number(n % base)];
      n /= base;
    }
    return code;
  }
  referralHash(code: string): string {
    return createHash('sha256').update(`referral-hash|${code}`, 'utf8').digest('hex');
  }
}

/**
 * The redemptions of orders (package T2), in memory. Linked to a {@link MemoryPromotions} (its usage
 * rows) and a {@link MemoryBatchCodes} when a test gives them; otherwise the counters and codes are
 * not kept. Locks are no-ops (one test runs one call at a time).
 */
export class MemoryRedemptions implements RedemptionRepository {
  readonly rows: RedemptionRecord[] = [];
  readonly claims = new Map<string, string>();
  /** The rows of the discounts, without the orders' head rows. */
  get discounts(): RedemptionRecord[] {
    return this.rows.filter((row) => row.kind !== 'ORDER');
  }
  marketLocked = 0;
  constructor(
    private readonly promotions?: MemoryPromotions,
    private readonly codes?: MemoryBatchCodes,
  ) {}
  forOrder(_market: MarketContext, orderId: Id<'Order'>) {
    return Promise.resolve(this.rows.filter((row) => row.orderId === orderId));
  }
  insertMany(_market: MarketContext, records: readonly RedemptionRecord[]) {
    for (const record of records) {
      if (
        this.rows.some(
          (row) => row.orderId === record.orderId && row.promotionKey === record.promotionKey,
        )
      ) {
        throw new RedemptionTakenError();
      }
    }
    this.rows.push(...records);
    return Promise.resolve();
  }
  markReleased(
    market: MarketContext,
    orderId: Id<'Order'>,
    id: string,
    reason: ReleaseReason,
    at: Temporal.Instant,
  ) {
    if (this.rows.some((row) => row.orderId === orderId && row.promotionKey === 'order')) {
      return Promise.resolve();
    }
    this.rows.push({
      id,
      orderId,
      promotionKey: 'order',
      promotionId: null,
      kind: 'ORDER',
      customerAccountId: null,
      codeHash: null,
      currency: null,
      amount: 0n,
      sellerShare: 0n,
      platformShare: 0n,
      units: null,
      budgetMonth: null,
      status: 'RELEASED',
      releaseReason: reason,
      reservedAt: at,
      confirmedAt: null,
      releasedAt: at,
    });
    return Promise.resolve();
  }
  customerFirstOrders(_market: MarketContext, customerAccountId: Id<'Account'>) {
    return Promise.resolve(
      this.live().filter(
        (row) => row.kind === 'FIRST_ORDER' && row.customerAccountId === customerAccountId,
      ).length,
    );
  }
  confirm(_market: MarketContext, orderId: Id<'Order'>, at: Temporal.Instant) {
    let moved = 0;
    this.rows.forEach((row, index) => {
      if (row.orderId === orderId && row.status === 'RESERVED') {
        this.rows[index] = { ...row, status: 'CONFIRMED', confirmedAt: at };
        moved += 1;
      }
    });
    return Promise.resolve(moved);
  }
  release(
    _market: MarketContext,
    orderId: Id<'Order'>,
    reason: ReleaseReason,
    at: Temporal.Instant,
    includeConfirmed: boolean,
  ) {
    const released: RedemptionRecord[] = [];
    this.rows.forEach((row, index) => {
      const holds = row.status === 'RESERVED' || (includeConfirmed && row.status === 'CONFIRMED');
      if (row.orderId === orderId && holds) {
        released.push(row);
        this.rows[index] = { ...row, status: 'RELEASED', releaseReason: reason, releasedAt: at };
      }
    });
    return Promise.resolve(released);
  }
  lockUsage() {
    return Promise.resolve();
  }
  lockMarket() {
    this.marketLocked += 1;
    return Promise.resolve(true);
  }
  addUsage(_market: MarketContext, deltas: readonly UsageDelta[]) {
    if (this.promotions === undefined) return Promise.resolve();
    for (const delta of deltas) {
      const usage = this.promotions.usage.get(delta.promotionId);
      if (usage === undefined) throw new Error('promotions.usage row missing');
      const next = {
        usesCount: usage.usesCount + delta.uses,
        spentMinor: usage.spentMinor + delta.spent,
        sellerShareMinor: usage.sellerShareMinor + delta.sellerShare,
        platformShareMinor: usage.platformShareMinor + delta.platformShare,
      };
      if (next.usesCount < 0 || next.spentMinor < 0n) throw new Error('usage below zero');
      this.promotions.usage.set(delta.promotionId, next);
    }
    return Promise.resolve();
  }
  private live() {
    return this.rows.filter((row) => row.status !== 'RELEASED');
  }
  customerUses(
    _market: MarketContext,
    customerAccountId: Id<'Account'>,
    promotionIds: readonly Id<'Promotion'>[],
  ) {
    const uses = new Map<Id<'Promotion'>, number>();
    for (const row of this.live()) {
      if (row.customerAccountId !== customerAccountId || row.promotionId === null) continue;
      const id = row.promotionId as Id<'Promotion'>;
      if (!promotionIds.includes(id)) continue;
      uses.set(id, (uses.get(id) ?? 0) + 1);
    }
    return Promise.resolve(uses as ReadonlyMap<Id<'Promotion'>, number>);
  }
  unitsSold(_market: MarketContext, promotionIds: readonly Id<'Promotion'>[]) {
    const sold = new Map<Id<'Promotion'>, number>(promotionIds.map((id) => [id, 0]));
    for (const row of this.live()) {
      const id = row.promotionId as Id<'Promotion'> | null;
      if (id !== null && sold.has(id) && row.units !== null)
        sold.set(id, sold.get(id)! + row.units);
    }
    return Promise.resolve(sold as ReadonlyMap<Id<'Promotion'>, number>);
  }
  firstOrderSpent(_market: MarketContext, budgetMonth: string) {
    return Promise.resolve(
      this.live()
        .filter((row) => row.kind === 'FIRST_ORDER' && row.budgetMonth === budgetMonth)
        .reduce((sum, row) => sum + row.amount, 0n),
    );
  }
  claimCode(_market: MarketContext, codeHash: string, orderId: Id<'Order'>, at: Temporal.Instant) {
    const holder = this.claims.get(codeHash);
    if (holder !== undefined) return Promise.resolve(holder === orderId);
    this.claims.set(codeHash, orderId);
    if (this.codes?.rows.has(codeHash)) this.codes.markUsed(codeHash, at);
    return Promise.resolve(true);
  }
  unclaimCode(_market: MarketContext, codeHash: string, orderId: Id<'Order'>) {
    if (this.claims.get(codeHash) === orderId) {
      this.claims.delete(codeHash);
      const row = this.codes?.rows.get(codeHash);
      if (row !== undefined) this.codes!.rows.set(codeHash, { ...row, usedAt: null });
    }
    return Promise.resolve();
  }
  staleReservations(
    _market: MarketContext,
    before: Temporal.Instant,
    limit: number,
    after: Id<'Order'> | null,
  ) {
    const ids = [
      ...new Set(
        this.rows
          .filter(
            (row) =>
              row.status === 'RESERVED' && Temporal.Instant.compare(row.reservedAt, before) < 0,
          )
          .map((row) => row.orderId as Id<'Order'>),
      ),
    ]
      .filter((id) => after === null || id > after)
      .sort();
    return Promise.resolve(ids.slice(0, limit));
  }
}

/** The units-sold counter of flash sales: unknown (null) until a test says otherwise. */
export class FakeFlashSales implements FlashSales {
  sold: Map<Id<'Promotion'>, number> | null = null;
  soldUnits() {
    return Promise.resolve(this.sold as ReadonlyMap<Id<'Promotion'>, number> | null);
  }
}

// ---------------------------------------------------------------------------------------------
// Phase 3: facts of other modules, the wallet, credits and referrals.
// ---------------------------------------------------------------------------------------------

/** When customers last ordered: unknown until a test says otherwise (the real adapter's answer). */
export class FakeCustomerOrderHistory implements CustomerOrderHistory {
  readonly lastOrder = new Map<Id<'Account'>, Temporal.Instant | null>();
  /** True: every read fails (unknown). */
  broken = false;
  /** Throws instead of answering. */
  throws = false;
  reads = 0;
  lastOrderAt(_context: CallContext, accountId: Id<'Account'>) {
    this.reads += 1;
    if (this.throws) return Promise.reject(new Error('orders unreachable'));
    if (this.broken || !this.lastOrder.has(accountId)) {
      return Promise.resolve({ known: false } as Known<Temporal.Instant | null>);
    }
    return Promise.resolve({
      known: true,
      value: this.lastOrder.get(accountId)!,
    } as Known<Temporal.Instant | null>);
  }
}

/** Which sellers a customer follows: unknown until a test says otherwise. */
/** Manual customer groups as the quote reads them: unknown unless a test puts the customer in. */
/** Whose exclusive customer each account is; `broken` answers unknown, `throws` rejects. */
export class FakeExclusiveCustomers implements ExclusiveCustomers {
  readonly sellers = new Map<string, Id<'Seller'>>();
  broken = false;
  throws = false;
  reads = 0;
  exclusiveSellerOf(_context: CallContext, accountId: Id<'Account'>) {
    this.reads += 1;
    if (this.throws) return Promise.reject(new Error('customers unreachable'));
    if (this.broken) return Promise.resolve({ known: false } as Known<Id<'Seller'> | null>);
    return Promise.resolve({
      known: true,
      value: this.sellers.get(accountId) ?? null,
    } as Known<Id<'Seller'> | null>);
  }
}

export class FakeGroupMembership implements CustomerGroupMembership {
  readonly members = new Map<string, Set<Id<'Account'>>>();
  broken = false;
  throws = false;
  reads = 0;
  isMember(_context: CallContext, groupId: string, accountId: Id<'Account'>) {
    this.reads += 1;
    if (this.throws) return Promise.reject(new Error('customers unreachable'));
    if (this.broken) return Promise.resolve({ known: false } as Known<boolean>);
    return Promise.resolve({
      known: true,
      value: this.members.get(groupId)?.has(accountId) ?? false,
    } as Known<boolean>);
  }
}

export class FakeStoreFollows implements StoreFollows {
  readonly follows = new Map<Id<'Account'>, Id<'Seller'>[]>();
  broken = false;
  throws = false;
  reads = 0;
  followedAmong(
    _context: CallContext,
    accountId: Id<'Account'>,
    sellerIds: readonly Id<'Seller'>[],
  ) {
    this.reads += 1;
    if (this.throws) return Promise.reject(new Error('follows unreachable'));
    const followed = this.follows.get(accountId);
    if (this.broken || followed === undefined) {
      return Promise.resolve({ known: false } as Known<readonly Id<'Seller'>[]>);
    }
    return Promise.resolve({
      known: true,
      value: sellerIds.filter((s) => followed.includes(s)),
    } as Known<readonly Id<'Seller'>[]>);
  }
}

/** The facts of delivered seller orders, by seller order id; unknown for any other. */
export class FakeOrderFacts implements DeliveredOrderFacts {
  readonly orders = new Map<string, DeliveredSellerOrderFacts>();
  reads = 0;
  add(facts: DeliveredSellerOrderFacts): void {
    this.orders.set(facts.sellerOrderId, facts);
  }
  read(_context: CallContext, request: { readonly sellerOrderId: Id<'SellerOrder'> }) {
    this.reads += 1;
    const facts = this.orders.get(request.sellerOrderId);
    const answer: Known<DeliveredSellerOrderFacts> =
      facts === undefined ? { known: false } : { known: true, value: facts };
    return Promise.resolve(answer);
  }
}

/** The payout release of each seller order; by default every seller order is released already. */
export class FakePayoutAnchors implements PayoutAnchors {
  readonly anchors = new Map<string, { sellerId: Id<'Seller'>; eligibleAt: Temporal.Instant }>();
  /** Seller orders a payout hold covers now, and those a chargeback took. */
  readonly held = new Set<string>();
  readonly disputesLost = new Set<string>();
  /** The release of a seller order with no anchor of its own (null: unknown, so a retry). */
  fallback: Temporal.Instant | null = Temporal.Instant.from('2000-01-01T00:00:00Z');
  broken = false;
  reads = 0;
  anchorOf(_context: CallContext, sellerOrderId: Id<'SellerOrder'>) {
    this.reads += 1;
    const own = this.anchors.get(sellerOrderId);
    const seller = this.sellerOf(sellerOrderId);
    const value =
      own ??
      (this.fallback === null || seller === undefined
        ? null
        : { sellerId: seller, eligibleAt: this.fallback });
    if (this.broken || value === null) return Promise.resolve({ known: false } as const);
    return Promise.resolve({
      known: true as const,
      value: {
        ...value,
        onHold: this.held.has(sellerOrderId),
        disputeLost: this.disputesLost.has(sellerOrderId),
      },
    });
  }
  /** Who sells a seller order with no anchor of its own (the order facts' seller, by default). */
  sellerOf: (sellerOrderId: Id<'SellerOrder'>) => Id<'Seller'> | undefined = () => undefined;
}

/** The seller ledger: one entry per credit, as the real one answers a repeat as already recorded. */
export class FakeSellerCashbackLedger implements SellerCashbackLedger {
  readonly entries: Parameters<SellerCashbackLedger['record']>[1][] = [];
  /** Refuse every call while set (the ledger down or refusing). */
  fails = false;
  calls = 0;
  record(_context: CallContext, cashback: Parameters<SellerCashbackLedger['record']>[1]) {
    this.calls += 1;
    if (this.fails) return Promise.resolve(false);
    if (!this.entries.some((e) => e.creditId === cashback.creditId)) this.entries.push(cashback);
    return Promise.resolve(true);
  }
}

export class FakeReferralSignals implements ReferralSignals {
  verdict: ReferralVerdict = 'clear';
  calls = 0;
  compare() {
    this.calls += 1;
    return Promise.resolve(this.verdict);
  }
}

/** The wallet: one journal per idempotency key, as the real one answers a repeat with the first result. */
export class FakeWalletCredit implements WalletCredit {
  readonly grants: {
    readonly accountId: Id<'Account'>;
    readonly amount: Money;
    readonly orderId: Id<'Order'> | null;
    readonly idempotencyKey: string;
  }[] = [];
  readonly journals = new Map<string, string>();
  /** The failure to answer next (once), or for every call while `always` is set. */
  failure: WalletCreditFailure | null = null;
  always = false;
  /** Decides per request (before `failure`): a failure to answer, or null to go on. */
  failWhen: ((request: { readonly idempotencyKey: string }) => WalletCreditFailure | null) | null =
    null;
  /** Every call, including the refused ones. */
  calls = 0;
  grant(
    _context: CallContext,
    request: {
      readonly accountId: Id<'Account'>;
      readonly amount: Money;
      readonly orderId: Id<'Order'> | null;
      readonly idempotencyKey: string;
    },
  ): Promise<Result<{ readonly journalId: string }, WalletCreditFailure>> {
    this.calls += 1;
    const scripted = this.failWhen?.(request) ?? null;
    if (scripted !== null) return Promise.resolve(err(scripted));
    if (this.failure !== null) {
      const failure = this.failure;
      if (!this.always) this.failure = null;
      return Promise.resolve(err(failure));
    }
    let journal = this.journals.get(request.idempotencyKey);
    if (journal === undefined) {
      journal = `01990000-0000-7000-8000-${(0xa00000 + this.journals.size + 1).toString(16).padStart(12, '0')}`;
      this.journals.set(request.idempotencyKey, journal);
      this.grants.push(request);
    }
    return Promise.resolve({ ok: true, value: { journalId: journal } } as const);
  }
}

/**
 * Credits in memory: unique per kind and source and per idempotency key, like the table; the real
 * credits and the RECORDED notes each have their own slots (the partial unique indexes).
 */
export class MemoryCredits implements CreditRepository {
  readonly rows = new Map<Id<'PromotionCredit'>, CreditRecord>();
  insert(_market: MarketContext, record: CreditRecord) {
    const recorded = record.status === 'RECORDED';
    const clash = [...this.rows.values()].some(
      (r) =>
        (r.status === 'RECORDED') === recorded &&
        ((r.kind === record.kind && r.sourceId === record.sourceId) ||
          r.idempotencyKey === record.idempotencyKey),
    );
    if (clash) return Promise.resolve('duplicate' as const);
    this.rows.set(record.id, record);
    return Promise.resolve('inserted' as const);
  }
  findBySource(_market: MarketContext, kind: CreditKind, sourceId: string) {
    const found = [...this.rows.values()].filter((r) => r.kind === kind && r.sourceId === sourceId);
    return Promise.resolve(found.find((r) => r.status !== 'RECORDED') ?? found[0] ?? null);
  }
  settle(
    _market: MarketContext,
    id: Id<'PromotionCredit'>,
    result:
      | { readonly status: 'GRANTED'; readonly walletJournalId: string }
      | { readonly status: 'FAILED'; readonly failureCode: string },
    at: Temporal.Instant,
  ) {
    const row = this.rows.get(id);
    if (row === undefined || row.status !== 'PENDING') return Promise.resolve(false);
    this.rows.set(id, {
      ...row,
      status: result.status,
      walletJournalId: result.status === 'GRANTED' ? result.walletJournalId : null,
      failureCode: result.status === 'FAILED' ? result.failureCode : null,
      settledAt: at,
    });
    return Promise.resolve(true);
  }
  listDue(
    _market: MarketContext,
    now: Temporal.Instant,
    stalledBefore: Temporal.Instant,
    limit: number,
  ) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (r) =>
            r.status === 'PENDING' &&
            r.kind === 'CASHBACK' &&
            (r.grantAfter === null
              ? r.createdAt.epochMilliseconds <= stalledBefore.epochMilliseconds
              : r.grantAfter.epochMilliseconds <= now.epochMilliseconds),
        )
        .sort(
          (a, b) =>
            a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        )
        .slice(0, limit),
    );
  }
  fixAmount(_market: MarketContext, id: Id<'PromotionCredit'>, amountMinor: bigint) {
    const row = this.rows.get(id);
    if (
      row === undefined ||
      row.status !== 'PENDING' ||
      row.grantAfter === null ||
      amountMinor > row.amountMinor ||
      amountMinor < 1n
    ) {
      return Promise.resolve(false);
    }
    this.rows.set(id, { ...row, amountMinor, grantAfter: null });
    return Promise.resolve(true);
  }
  postpone(_market: MarketContext, id: Id<'PromotionCredit'>, until: Temporal.Instant) {
    const row = this.rows.get(id);
    if (
      row === undefined ||
      row.status !== 'PENDING' ||
      row.grantAfter === null ||
      row.grantAfter.epochMilliseconds >= until.epochMilliseconds
    ) {
      return Promise.resolve(false);
    }
    this.rows.set(id, { ...row, grantAfter: until });
    return Promise.resolve(true);
  }
  reservedTotal(_market: MarketContext, promotionId: Id<'Promotion'>) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (r) =>
            r.promotionId === promotionId && (r.status === 'PENDING' || r.status === 'GRANTED'),
        )
        .reduce((sum, r) => sum + r.amountMinor, 0n),
    );
  }
  countLive(_market: MarketContext, promotionId: Id<'Promotion'>, recipient?: Id<'Account'>) {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (r) =>
          r.promotionId === promotionId &&
          (r.status === 'PENDING' || r.status === 'GRANTED') &&
          (recipient === undefined || r.recipientAccountId === recipient),
      ).length,
    );
  }
  creditedForOrder(_market: MarketContext, orderId: Id<'Order'>, kind: CreditKind) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter(
          (r) =>
            r.orderId === orderId &&
            r.kind === kind &&
            (r.status === 'PENDING' || r.status === 'GRANTED'),
        )
        .reduce((sum, r) => sum + r.amountMinor, 0n),
    );
  }
  listForPromotion(
    _market: MarketContext,
    promotionId: Id<'Promotion'>,
    limit: number,
    after?: CreditCursor,
  ) {
    const newestFirst = (a: CreditRecord, b: CreditRecord) =>
      b.createdAt.epochMilliseconds - a.createdAt.epochMilliseconds ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.promotionId === promotionId)
        .sort(newestFirst)
        .filter(
          (r) =>
            after === undefined ||
            r.createdAt.epochMilliseconds < after.createdAt.epochMilliseconds ||
            (r.createdAt.epochMilliseconds === after.createdAt.epochMilliseconds &&
              r.id < after.id),
        )
        .slice(0, limit),
    );
  }
  listForRecipient(
    _market: MarketContext,
    recipient: Id<'Account'>,
    limit: number,
    after?: CreditCursor,
  ) {
    const newestFirst = (a: CreditRecord, b: CreditRecord) =>
      b.createdAt.epochMilliseconds - a.createdAt.epochMilliseconds ||
      (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.recipientAccountId === recipient)
        .sort(newestFirst)
        .filter(
          (r) =>
            after === undefined ||
            r.createdAt.epochMilliseconds < after.createdAt.epochMilliseconds ||
            (r.createdAt.epochMilliseconds === after.createdAt.epochMilliseconds &&
              r.id < after.id),
        )
        .slice(0, limit),
    );
  }
}

/** Referral codes and referrals in memory: one code per customer, one referral per new customer. */
export class MemoryReferrals implements ReferralRepository {
  readonly codes = new Map<Id<'Account'>, ReferralCodeRecord>();
  readonly rows = new Map<Id<'Referral'>, ReferralRecord>();
  findCode(_market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(this.codes.get(accountId) ?? null);
  }
  findCodeByHash(_market: MarketContext, codeHash: string) {
    return Promise.resolve([...this.codes.values()].find((c) => c.codeHash === codeHash) ?? null);
  }
  insertCode(_market: MarketContext, record: ReferralCodeRecord) {
    if (
      this.codes.has(record.accountId) ||
      [...this.codes.values()].some((c) => c.codeHash === record.codeHash)
    ) {
      return Promise.resolve('duplicate' as const);
    }
    this.codes.set(record.accountId, record);
    return Promise.resolve('inserted' as const);
  }
  findQualifiedBySellerOrder(_market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    return Promise.resolve(
      [...this.rows.values()].find(
        (r) => r.status === 'QUALIFIED' && r.qualifyingSellerOrderId === sellerOrderId,
      ) ?? null,
    );
  }
  findByReferee(_market: MarketContext, refereeAccountId: Id<'Account'>) {
    return Promise.resolve(
      [...this.rows.values()].find((r) => r.refereeAccountId === refereeAccountId) ?? null,
    );
  }
  insert(_market: MarketContext, record: ReferralRecord) {
    if ([...this.rows.values()].some((r) => r.refereeAccountId === record.refereeAccountId)) {
      return Promise.resolve('duplicate' as const);
    }
    this.rows.set(record.id, record);
    return Promise.resolve('inserted' as const);
  }
  decide(
    _market: MarketContext,
    id: Id<'Referral'>,
    decision:
      | {
          readonly status: 'QUALIFIED';
          readonly orderId: Id<'Order'>;
          readonly sellerOrderId: Id<'SellerOrder'>;
        }
      | { readonly status: 'REJECTED'; readonly reason: ReferralRejectReason }
      | { readonly status: 'EXPIRED' },
    at: Temporal.Instant,
  ) {
    const row = this.rows.get(id);
    if (row === undefined || row.status !== 'PENDING') return Promise.resolve(false);
    this.rows.set(id, {
      ...row,
      status: decision.status,
      rejectReason: decision.status === 'REJECTED' ? decision.reason : null,
      qualifyingOrderId: decision.status === 'QUALIFIED' ? decision.orderId : null,
      qualifyingSellerOrderId: decision.status === 'QUALIFIED' ? decision.sellerOrderId : null,
      decidedAt: at,
    });
    return Promise.resolve(true);
  }
  countByReferrer(
    _market: MarketContext,
    referrerAccountId: Id<'Account'>,
    promotionId: Id<'Promotion'>,
    status: ReferralStatus,
    notExpiredAt?: Temporal.Instant,
  ) {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (r) =>
          r.referrerAccountId === referrerAccountId &&
          r.promotionId === promotionId &&
          r.status === status &&
          (notExpiredAt === undefined ||
            r.expiresAt.epochMilliseconds > notExpiredAt.epochMilliseconds),
      ).length,
    );
  }
  countByPromotion(_market: MarketContext, promotionId: Id<'Promotion'>, status: ReferralStatus) {
    return Promise.resolve(
      [...this.rows.values()].filter((r) => r.promotionId === promotionId && r.status === status)
        .length,
    );
  }
  listByReferrer(_market: MarketContext, referrerAccountId: Id<'Account'>, limit: number) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.referrerAccountId === referrerAccountId)
        .sort((a, b) => b.createdAt.epochMilliseconds - a.createdAt.epochMilliseconds)
        .slice(0, limit),
    );
  }
}

/** The phase 3 dependencies, fresh: spread into a deps object. */
/** An audit reader with no rows and an identity that names nobody: the default of a spec that does not read the activity. */
const NO_ACTIVITY = {
  auditTrail: {
    history: () => Promise.resolve(ok([])),
    historyOf: () => Promise.resolve(ok([])),
  },
  actors: { labelsOf: () => Promise.resolve(new Map()) },
};

export function phase3Fakes() {
  const orderFacts = new FakeOrderFacts();
  const payoutAnchors = new FakePayoutAnchors();
  payoutAnchors.sellerOf = (sellerOrderId) => orderFacts.orders.get(sellerOrderId)?.sellerId;
  return {
    ...NO_ACTIVITY,
    orderHistory: new FakeCustomerOrderHistory(),
    storeFollows: new FakeStoreFollows(),
    groupMembership: new FakeGroupMembership(),
    exclusiveCustomers: new FakeExclusiveCustomers(),
    orderFacts,
    payoutAnchors,
    referralSignals: new FakeReferralSignals(),
    walletCredit: new FakeWalletCredit(),
    sellerCashbackLedger: new FakeSellerCashbackLedger(),
    credits: new MemoryCredits(),
    referrals: new MemoryReferrals(),
    redemptions: new MemoryRedemptions(),
  };
}
