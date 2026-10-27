import type { Id, MarketContext } from '@mondapac/shared-kernel';
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
}

export class MemoryHolds implements PayoutHoldRepository {
  readonly rows = new Map<string, PayoutHoldRecord>();
  insertIfAbsent(market: MarketContext, hold: PayoutHoldRecord) {
    const clash = [...this.rows.entries()].some(
      ([k, row]) =>
        k.startsWith(`${market.marketId}:`) &&
        row.reason === hold.reason &&
        row.sourceRef === hold.sourceRef,
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
  listForSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    options: { readonly activeOnly: boolean; readonly limit: number },
  ) {
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(([k, row]) => k.startsWith(`${market.marketId}:`) && row.sellerId === sellerId)
        .map(([, row]) => row)
        .filter((row) => !options.activeOnly || row.releasedAt === null)
        .slice(0, options.limit),
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
  };
}
