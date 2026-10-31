import { createHash } from 'node:crypto';
import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Id,
  MarketContext,
  Money,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { ConsumedStepUp, StepUpProofConsumer, StepUpRefusal } from '../../src/platform/authz';
import type { BatchCodeCrypto } from '../../src/modules/promotions/application/ports/batch-code-crypto';
import type {
  BatchCodeCount,
  BatchCodeRecord,
  BatchCodeRepository,
} from '../../src/modules/promotions/application/ports/batch-code.repository';
import type {
  CreditRepository,
  ReferralCodeRecord,
  ReferralRepository,
} from '../../src/modules/promotions/application/ports/credit.repository';
import type {
  CustomerOrderHistory,
  Known,
  StoreFollows,
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
import { LockContendedError } from '../../src/modules/promotions/application/ports/promotion.repository';
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
  grant(
    _context: CallContext,
    request: {
      readonly accountId: Id<'Account'>;
      readonly amount: Money;
      readonly orderId: Id<'Order'> | null;
      readonly idempotencyKey: string;
    },
  ): Promise<Result<{ readonly journalId: string }, WalletCreditFailure>> {
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

/** Credits in memory: unique per kind and source and per idempotency key, like the table. */
export class MemoryCredits implements CreditRepository {
  readonly rows = new Map<Id<'PromotionCredit'>, CreditRecord>();
  insert(_market: MarketContext, record: CreditRecord) {
    const clash = [...this.rows.values()].some(
      (r) =>
        (r.kind === record.kind && r.sourceId === record.sourceId) ||
        r.idempotencyKey === record.idempotencyKey,
    );
    if (clash) return Promise.resolve('duplicate' as const);
    this.rows.set(record.id, record);
    return Promise.resolve('inserted' as const);
  }
  findBySource(_market: MarketContext, kind: CreditKind, sourceId: string) {
    return Promise.resolve(
      [...this.rows.values()].find((r) => r.kind === kind && r.sourceId === sourceId) ?? null,
    );
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
            (r.status === 'PENDING' || r.status === 'GRANTED' || r.status === 'RECORDED'),
        )
        .reduce((sum, r) => sum + r.amountMinor, 0n),
    );
  }
  listForPromotion(_market: MarketContext, promotionId: Id<'Promotion'>, limit: number) {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((r) => r.promotionId === promotionId)
        .sort((a, b) => b.createdAt.epochMilliseconds - a.createdAt.epochMilliseconds)
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
  ) {
    return Promise.resolve(
      [...this.rows.values()].filter(
        (r) =>
          r.referrerAccountId === referrerAccountId &&
          r.promotionId === promotionId &&
          r.status === status,
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
export function phase3Fakes() {
  return {
    orderHistory: new FakeCustomerOrderHistory(),
    storeFollows: new FakeStoreFollows(),
    orderFacts: new FakeOrderFacts(),
    referralSignals: new FakeReferralSignals(),
    walletCredit: new FakeWalletCredit(),
    credits: new MemoryCredits(),
    referrals: new MemoryReferrals(),
  };
}
