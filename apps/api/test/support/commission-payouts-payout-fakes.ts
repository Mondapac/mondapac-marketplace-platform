import type { CallContext, Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { LedgerRepository } from '../../src/modules/commission-payouts/application/ports/ledger.repository';
import type {
  AbandonAnswer,
  InstructAnswer,
  PaymentsPayouts,
  PayoutPolicy,
  PayoutPrerequisites,
  SellerPayoutAccess,
  SellerZone,
  TransferLookup,
} from '../../src/modules/commission-payouts/application/ports/payout-gateways';
import type {
  PayoutPage,
  PayoutRepository,
  PayoutWithItems,
  SellerPayoutPosition,
} from '../../src/modules/commission-payouts/application/ports/payout.repository';
import {
  canTransition,
  COUNTED_STATES,
  FREEING_STATES,
  LIVE_STATES,
  type Payout,
  type PayoutItem,
  type PayoutState,
} from '../../src/modules/commission-payouts/domain/payout';

// In-memory stand-ins for the package 6d stores and gateways. Like the real tables they are keyed
// by Market, refuse a second live payout per seller and a transition the state machine does not
// have (the database does both), and `change` is a compare-and-set on state and version.

const key = (market: MarketContext, id: string) => `${market.marketId}:${id}`;
const inMarket = (market: MarketContext, k: string) => k.startsWith(`${market.marketId}:`);

export class MemoryPayouts implements PayoutRepository {
  readonly rows = new Map<string, Payout>();
  readonly itemRows = new Map<string, readonly PayoutItem[]>();
  /** Counts `change` calls that lost the compare-and-set. */
  lostChanges = 0;

  insert(market: MarketContext, payout: Payout, items: readonly PayoutItem[]) {
    if (
      LIVE_STATES.includes(payout.state) &&
      [...this.rows.entries()].some(
        ([k, row]) =>
          inMarket(market, k) &&
          row.sellerId === payout.sellerId &&
          LIVE_STATES.includes(row.state),
      )
    ) {
      throw new Error('payouts: one live payout per seller');
    }
    if (items.reduce((sum, item) => sum + item.amount, 0n) !== payout.gross) {
      throw new Error('payouts: the items must add up to the gross');
    }
    this.rows.set(key(market, payout.id), payout);
    this.itemRows.set(key(market, payout.id), items);
    return Promise.resolve();
  }
  find(market: MarketContext, id: Id<'Payout'>) {
    return Promise.resolve(this.rows.get(key(market, id)) ?? null);
  }
  findWithItems(market: MarketContext, id: Id<'Payout'>): Promise<PayoutWithItems | null> {
    const payout = this.rows.get(key(market, id));
    if (payout === undefined) return Promise.resolve(null);
    return Promise.resolve({ payout, items: this.itemRows.get(key(market, id)) ?? [] });
  }
  findByTransferExecution(market: MarketContext, transferExecutionId: string) {
    return Promise.resolve(
      [...this.rows.entries()].find(
        ([k, row]) => inMarket(market, k) && row.transferExecutionId === transferExecutionId,
      )?.[1] ?? null,
    );
  }
  findLive(market: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(
      [...this.rows.entries()].find(
        ([k, row]) =>
          inMarket(market, k) && row.sellerId === sellerId && LIVE_STATES.includes(row.state),
      )?.[1] ?? null,
    );
  }
  change(market: MarketContext, before: Payout, after: Payout) {
    const stored = this.rows.get(key(market, before.id));
    if (
      stored === undefined ||
      stored.state !== before.state ||
      stored.version !== before.version
    ) {
      this.lostChanges += 1;
      return Promise.resolve(false);
    }
    if (after.state !== before.state && !canTransition(before.state, after.state)) {
      throw new Error(`payouts: ${before.state} -> ${after.state} is refused by the guard trigger`);
    }
    this.rows.set(key(market, before.id), after);
    return Promise.resolve(true);
  }
  position(market: MarketContext, sellerId: Id<'Seller'>): Promise<SellerPayoutPosition> {
    const itemAmounts = new Map<Id<'SellerOrder'>, bigint>();
    const takenAmounts = new Map<Id<'SellerOrder'>, bigint>();
    let nettedTotal = 0n;
    let hasPaid = false;
    for (const [k, payout] of this.rows.entries()) {
      if (!inMarket(market, k) || payout.sellerId !== sellerId) continue;
      if (payout.state === 'paid') hasPaid = true;
      const counted = COUNTED_STATES.includes(payout.state);
      if (counted) nettedTotal += payout.netted;
      if (FREEING_STATES.includes(payout.state)) continue;
      for (const item of this.itemRows.get(k) ?? []) {
        itemAmounts.set(item.sellerOrderId, item.amount);
        if (counted) takenAmounts.set(item.sellerOrderId, item.amount);
      }
    }
    return Promise.resolve({ itemAmounts, takenAmounts, nettedTotal, hasPaid });
  }
  listByState(market: MarketContext, states: readonly PayoutState[], limit: number) {
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(([k, row]) => inMarket(market, k) && states.includes(row.state))
        .map(([, row]) => row)
        .sort(
          (a, b) =>
            a.stateChangedAt.epochMilliseconds - b.stateChangedAt.epochMilliseconds ||
            a.id.localeCompare(b.id),
        )
        .slice(0, limit),
    );
  }
  list(market: MarketContext, filter: { readonly state: PayoutState | null }, page: PayoutPage) {
    return Promise.resolve(
      this.newestFirst(
        [...this.rows.entries()]
          .filter(([k, row]) => inMarket(market, k) && (filter.state ?? row.state) === row.state)
          .map(([, row]) => row),
        page,
      ),
    );
  }
  listForSeller(
    market: MarketContext,
    sellerId: Id<'Seller'>,
    hidden: readonly PayoutState[],
    page: PayoutPage,
  ) {
    return Promise.resolve(
      this.newestFirst(
        [...this.rows.entries()]
          .filter(
            ([k, row]) =>
              inMarket(market, k) && row.sellerId === sellerId && !hidden.includes(row.state),
          )
          .map(([, row]) => row),
        page,
      ),
    );
  }
  sumTransferredSince(market: MarketContext, since: Temporal.Instant) {
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(
          ([k, row]) =>
            inMarket(market, k) &&
            (row.state === 'instructed' || row.state === 'paid') &&
            row.instructingAt !== null &&
            row.instructingAt.epochMilliseconds >= since.epochMilliseconds,
        )
        .reduce((sum, [, row]) => sum + row.transfer, 0n),
    );
  }

  private newestFirst(rows: Payout[], page: PayoutPage): Payout[] {
    return rows
      .filter(
        (row) =>
          page.after === null ||
          row.createdAt.epochMilliseconds < page.after.createdAt.epochMilliseconds ||
          (row.createdAt.epochMilliseconds === page.after.createdAt.epochMilliseconds &&
            row.id < page.after.id),
      )
      .sort(
        (a, b) =>
          b.createdAt.epochMilliseconds - a.createdAt.epochMilliseconds || b.id.localeCompare(a.id),
      )
      .slice(0, page.limit);
  }
}

/** What each seller order is worth, set by the test; the only ledger method the run reads. */
export class NetLedger {
  readonly nets = new Map<string, { sellerId: Id<'Seller'>; net: bigint }>();
  set(sellerId: Id<'Seller'>, sellerOrderId: Id<'SellerOrder'>, net: bigint) {
    this.nets.set(sellerOrderId, { sellerId, net });
  }
  asRepository(): LedgerRepository {
    return {
      netBySellerOrder: (_m: MarketContext, sellerId: Id<'Seller'>) =>
        Promise.resolve(
          [...this.nets.entries()]
            .filter(([, row]) => row.sellerId === sellerId)
            .map(([sellerOrderId, row]) => ({
              sellerOrderId: sellerOrderId as Id<'SellerOrder'>,
              net: row.net,
            }))
            .sort((a, b) => a.sellerOrderId.localeCompare(b.sellerOrderId)),
        ),
    } as unknown as LedgerRepository;
  }
}

export class ScriptedAccess implements SellerPayoutAccess {
  readonly zonesBySeller = new Map<string, SellerZone>();
  readonly eligibleSellers = new Set<string>();
  unavailable = false;
  eligibleCalls = 0;
  /** Runs at the start of each `eligible` call with its number: a test moves the world meanwhile. */
  onEligible: ((call: number) => void) | null = null;
  zones(_context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    if (this.unavailable) return Promise.resolve('unavailable' as const);
    const out = new Map<Id<'Seller'>, SellerZone>();
    for (const id of sellerIds) {
      const zone = this.zonesBySeller.get(id);
      if (zone !== undefined) out.set(id, zone);
    }
    return Promise.resolve(out);
  }
  eligible(_context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    this.eligibleCalls += 1;
    this.onEligible?.(this.eligibleCalls);
    if (this.unavailable) return Promise.resolve('unavailable' as const);
    return Promise.resolve(new Map(sellerIds.map((id) => [id, this.eligibleSellers.has(id)])));
  }
}

export class ScriptedPrerequisites implements PayoutPrerequisites {
  answer: 'ok' | 'second-factor-required' | 'unavailable' = 'ok';
  check() {
    return Promise.resolve(this.answer);
  }
}

export interface InstructCall {
  readonly instructionKey: string;
  readonly sellerId: Id<'Seller'>;
  readonly amountMinor: bigint;
  readonly currency: string;
}

/** payments as the payout code sees it: ready accounts, a scripted answer to each call, a log. */
export class ScriptedPayments implements PaymentsPayouts {
  readonly ready = new Set<string>();
  readonly instructed: InstructCall[] = [];
  readonly abandoned: string[] = [];
  readonly transfers = new Map<string, TransferLookup>();
  unavailable = false;
  instructAnswer: InstructAnswer | 'unavailable' = { kind: 'accepted', transferExecutionId: '' };
  abandonAnswer: AbandonAnswer | 'unavailable' = { kind: 'abandoned' };
  lookupUnavailable = false;

  readiness(_context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    if (this.unavailable) return Promise.resolve('unavailable' as const);
    return Promise.resolve(new Map(sellerIds.map((id) => [id, this.ready.has(id)])));
  }
  instruct(
    _context: CallContext,
    request: InstructCall & { readonly reference: string },
  ): Promise<InstructAnswer | 'unavailable'> {
    this.instructed.push({
      instructionKey: request.instructionKey,
      sellerId: request.sellerId,
      amountMinor: request.amountMinor,
      currency: request.currency,
    });
    return Promise.resolve(this.instructAnswer);
  }
  lookup(_context: CallContext, instructionKeys: readonly string[]) {
    if (this.lookupUnavailable) return Promise.resolve('unavailable' as const);
    return Promise.resolve(
      instructionKeys.map(
        (instructionKey): TransferLookup =>
          this.transfers.get(instructionKey) ?? {
            instructionKey,
            state: 'none',
            transferExecutionId: null,
          },
      ),
    );
  }
  abandon(_context: CallContext, instructionKey: string) {
    this.abandoned.push(instructionKey);
    return Promise.resolve(this.abandonAnswer);
  }
}

export class FixedPayoutPolicy implements PayoutPolicy {
  constructor(
    private readonly zones: Readonly<Record<string, string>>,
    private readonly currencies: Readonly<Record<string, string>>,
    readonly maxTransferMinor = 500_000n,
    readonly dailyAlertMinor = 2_000_000n,
    readonly sendLeaseSeconds = 60,
  ) {}
  limits(market: MarketContext) {
    return {
      maxTransferMinor: this.maxTransferMinor,
      dailyAlertMinor: this.dailyAlertMinor,
      currency: this.currencies[market.marketId]!,
      sendLeaseSeconds: this.sendLeaseSeconds,
    };
  }
  marketTimeZone(market: MarketContext) {
    return this.zones[market.marketId]!;
  }
}
