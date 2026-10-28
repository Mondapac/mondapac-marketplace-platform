import { ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import type { ConsumedStepUp, StepUpProofConsumer } from '../../src/platform/authz';
import { RecordingCpOutbox } from './commission-payouts-dispute-fakes';
import type {
  CursorUpdate,
  PayoutCursor,
  PayoutCursorRepository,
} from '../../src/modules/commission-payouts/application/ports/payout-cursor.repository';
import type { HoldReason } from '../../src/modules/commission-payouts/domain/payout-hold';
import type {
  EligibilityAnchor,
  EligibilityAnchorRepository,
} from '../../src/modules/commission-payouts/application/ports/eligibility-anchor.repository';
import type {
  PayoutHoldRecord,
  PayoutHoldRepository,
} from '../../src/modules/commission-payouts/application/ports/payout-hold.repository';
import type {
  PayoutTermsOverrideRecord,
  PayoutTermsRepository,
} from '../../src/modules/commission-payouts/application/ports/payout-terms.repository';
import type { PayoutTermsPolicy } from '../../src/modules/commission-payouts/application/ports/payout-terms-policy';
import { PayoutTermsResolver } from '../../src/modules/commission-payouts/application/payout-terms-resolver';

// In-memory stand-ins for the package 6b stores, keyed by Market like the real tables (a fake that
// ignored the Market could never show a cross-Market leak). Real behaviour is covered by the
// database tests in test/db.

const key = (market: MarketContext, id: string) => `${market.marketId}:${id}`;

export class MemoryTermsOverrides implements PayoutTermsRepository {
  readonly rows = new Map<string, PayoutTermsOverrideRecord>();
  find(market: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(this.rows.get(key(market, sellerId)) ?? null);
  }
  insert(market: MarketContext, record: PayoutTermsOverrideRecord) {
    if (this.rows.has(key(market, record.sellerId))) return Promise.resolve(false);
    this.rows.set(key(market, record.sellerId), record);
    return Promise.resolve(true);
  }
  replace(market: MarketContext, record: PayoutTermsOverrideRecord, expectedVersion: number) {
    const stored = this.rows.get(key(market, record.sellerId));
    if (stored === undefined || stored.version !== expectedVersion) return Promise.resolve(false);
    this.rows.set(key(market, record.sellerId), record);
    return Promise.resolve(true);
  }
  remove(market: MarketContext, sellerId: Id<'Seller'>, expectedVersion: number) {
    const stored = this.rows.get(key(market, sellerId));
    if (stored === undefined || stored.version !== expectedVersion) return Promise.resolve(false);
    this.rows.delete(key(market, sellerId));
    return Promise.resolve(true);
  }
}

export class MemoryAnchors implements EligibilityAnchorRepository {
  readonly rows = new Map<string, EligibilityAnchor>();
  insertIfAbsent(market: MarketContext, anchor: EligibilityAnchor) {
    if (this.rows.has(key(market, anchor.sellerOrderId))) return Promise.resolve(false);
    this.rows.set(key(market, anchor.sellerOrderId), anchor);
    return Promise.resolve(true);
  }
  find(market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    return Promise.resolve(this.rows.get(key(market, sellerOrderId)) ?? null);
  }
  findMany(market: MarketContext, sellerOrderIds: readonly Id<'SellerOrder'>[]) {
    return Promise.resolve(
      sellerOrderIds.flatMap((id) => {
        const anchor = this.rows.get(key(market, id));
        return anchor === undefined ? [] : [anchor];
      }),
    );
  }
}

/** The payout schedule cursors, keyed by Market. `lock` counts as the row lock (a version bump). */
export class MemoryCursors implements PayoutCursorRepository {
  readonly rows = new Map<string, PayoutCursor>();
  locks = 0;
  ensure(market: MarketContext, sellerId: Id<'Seller'>, now: Temporal.Instant) {
    if (!this.rows.has(key(market, sellerId))) {
      this.rows.set(key(market, sellerId), {
        sellerId,
        lastSlotAt: now,
        nextSlotAt: null,
        zone: null,
        blockReason: null,
        evaluatedAt: null,
        updatedAt: now,
        version: 1,
      });
    }
    return Promise.resolve();
  }
  lock(market: MarketContext, sellerId: Id<'Seller'>) {
    const row = this.rows.get(key(market, sellerId));
    if (row === undefined) return Promise.resolve(null);
    this.locks += 1;
    const locked = { ...row, version: row.version + 1 };
    this.rows.set(key(market, sellerId), locked);
    return Promise.resolve(locked);
  }
  find(market: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(this.rows.get(key(market, sellerId)) ?? null);
  }
  save(market: MarketContext, sellerId: Id<'Seller'>, update: CursorUpdate, now: Temporal.Instant) {
    const row = this.rows.get(key(market, sellerId));
    if (row === undefined) return Promise.resolve();
    this.rows.set(key(market, sellerId), { ...row, ...update, updatedAt: now });
    return Promise.resolve();
  }
  listDue(market: MarketContext, now: Temporal.Instant, staleBefore: Temporal.Instant, limit: number) {
    const due = [...this.rows.entries()]
      .filter(([k]) => k.startsWith(`${market.marketId}:`))
      .map(([, row]) => row)
      .filter((row) =>
        row.nextSlotAt !== null
          ? row.nextSlotAt.epochMilliseconds <= now.epochMilliseconds
          : row.evaluatedAt === null ||
            row.evaluatedAt.epochMilliseconds < staleBefore.epochMilliseconds,
      );
    return Promise.resolve(due.slice(0, limit));
  }
  invalidate(market: MarketContext, sellerId: Id<'Seller'>, now: Temporal.Instant) {
    const row = this.rows.get(key(market, sellerId));
    if (row !== undefined) {
      this.rows.set(key(market, sellerId), {
        ...row,
        nextSlotAt: null,
        evaluatedAt: null,
        updatedAt: now,
        version: row.version + 1,
      });
    }
    return Promise.resolve();
  }
}

/** Spends any proof (the tests of the other rules do not care about the step-up). */
export class AllowingStepUp implements StepUpProofConsumer {
  readonly spent: string[] = [];
  consume(_context: CallContext, actionKey: string) {
    this.spent.push(actionKey);
    const value: ConsumedStepUp = {
      sessionId: '01990000-0000-7000-8000-000000000061' as Id<'Session'>,
      verifiedAt: Temporal.Instant.fromEpochMilliseconds(0),
    };
    return Promise.resolve(ok(value));
  }
}

export class MemoryHolds implements PayoutHoldRepository {
  readonly rows = new Map<string, PayoutHoldRecord>();
  insertIfAbsent(market: MarketContext, hold: PayoutHoldRecord) {
    // The partial unique index: one system hold per reason, source and scope (admin holds have
    // their own id as source and are not keyed).
    const clash =
      hold.origin === 'system' &&
      [...this.rows.entries()].some(
        ([k, row]) =>
          k.startsWith(`${market.marketId}:`) &&
          row.origin === 'system' &&
          row.reason === hold.reason &&
          row.sourceRef === hold.sourceRef &&
          row.sellerId === hold.sellerId &&
          row.sellerOrderId === hold.sellerOrderId,
      );
    if (clash) return Promise.resolve(false);
    this.rows.set(key(market, hold.id), hold);
    return Promise.resolve(true);
  }
  find(market: MarketContext, holdId: Id<'PayoutHold'>) {
    return Promise.resolve(this.rows.get(key(market, holdId)) ?? null);
  }
  release(
    market: MarketContext,
    holdId: Id<'PayoutHold'>,
    release: Parameters<PayoutHoldRepository['release']>[2],
  ) {
    const hold = this.rows.get(key(market, holdId));
    if (hold === undefined || hold.releasedAt !== null) return Promise.resolve(false);
    this.rows.set(key(market, holdId), {
      ...hold,
      releasedAt: release.releasedAt,
      releasedBy: release.releasedBy,
      releaseReason: release.reason,
    });
    return Promise.resolve(true);
  }
  listBySource(market: MarketContext, reason: HoldReason, sourceRef: string) {
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(
          ([k, row]) =>
            k.startsWith(`${market.marketId}:`) &&
            row.reason === reason &&
            row.sourceRef === sourceRef,
        )
        .map(([, row]) => row),
    );
  }
  releaseBySource(
    market: MarketContext,
    reason: HoldReason,
    sourceRef: string,
    release: Parameters<PayoutHoldRepository['releaseBySource']>[3],
  ) {
    const released: PayoutHoldRecord[] = [];
    for (const [k, row] of this.rows.entries()) {
      if (
        k.startsWith(`${market.marketId}:`) &&
        row.reason === reason &&
        row.sourceRef === sourceRef &&
        row.releasedAt === null
      ) {
        const next = {
          ...row,
          releasedAt: release.releasedAt,
          releasedBy: release.releasedBy,
          releaseReason: release.reason,
        };
        this.rows.set(k, next);
        released.push(next);
      }
    }
    return Promise.resolve(released);
  }
  countForSellerOrder(market: MarketContext, sellerOrderId: Id<'SellerOrder'>, reason: HoldReason) {
    return Promise.resolve(
      [...this.rows.entries()].filter(
        ([k, row]) =>
          k.startsWith(`${market.marketId}:`) &&
          row.reason === reason &&
          row.sellerOrderId === sellerOrderId,
      ).length,
    );
  }
  listForSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    options: { readonly activeOnly: boolean; readonly limit: number },
  ) {
    const mine = [...this.rows.entries()]
      .filter(([k, row]) => k.startsWith(`${market.marketId}:`) && row.sellerId === sellerId)
      .map(([, row]) => row);
    // Every active hold, then the released ones up to the limit (like the SQL).
    const active = mine.filter((row) => row.releasedAt === null);
    return Promise.resolve(
      options.activeOnly
        ? active
        : [...active, ...mine.filter((row) => row.releasedAt !== null).slice(0, options.limit)],
    );
  }
}

/** The package 6b dependencies on in-memory stores and the given Market policy. */
export function payoutStores(policy: PayoutTermsPolicy) {
  const termsOverrides = new MemoryTermsOverrides();
  return {
    termsOverrides,
    terms: new PayoutTermsResolver(policy, termsOverrides),
    anchors: new MemoryAnchors(),
    holds: new MemoryHolds(),
    cursors: new MemoryCursors(),
    outbox: new RecordingCpOutbox(),
    stepUp: new AllowingStepUp(),
  };
}
