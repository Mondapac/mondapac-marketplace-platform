import { encodePayload } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Id,
  MarketContext,
  PendingEvent as OutboxEvent,
} from '@mondapac/shared-kernel';
import type {
  DisputeSource,
  OrderPaymentAnswer,
  OrderPaymentLookup,
  ProviderDispute,
} from '../../src/modules/commission-payouts/application/ports/dispute-source';
import type {
  DisputePage,
  DisputeRepository,
  SellerOrderRef,
} from '../../src/modules/commission-payouts/application/ports/dispute.repository';
import type { LedgerRepository } from '../../src/modules/commission-payouts/application/ports/ledger.repository';
import type { SellerNames } from '../../src/modules/commission-payouts/application/ports/seller-names';
import type {
  DisputeBucket,
  DisputeCase,
  DisputeDecision,
} from '../../src/modules/commission-payouts/domain/dispute';
import { COMMISSION_PAYOUTS_EVENTS } from '../../src/modules/commission-payouts/domain/events';
import type { LedgerEntry } from '../../src/modules/commission-payouts/domain/ledger';
import type { OutboxWriter } from '../../src/platform/events/outbox-writer';
import type { SecurityEventInput } from '../../src/platform/security-events/security-event-catalogue';
import type { SecurityEvents } from '../../src/platform/security-events/security-events';

// In-memory stand-ins for the package 8b ports, keyed by Market like the real tables. The seller
// orders of an order come from the ledger fake, as they do from the ledger table.

const scoped = (market: MarketContext, id: string) => `${market.marketId}:${id}`;

/** A ledger keyed by Market, insert-only with the real unique key (NULLS NOT DISTINCT). */
export class MarketLedger implements LedgerRepository {
  readonly rows = new Map<string, LedgerEntry[]>();
  private of(market: MarketContext): LedgerEntry[] {
    let rows = this.rows.get(market.marketId);
    if (rows === undefined) {
      rows = [];
      this.rows.set(market.marketId, rows);
    }
    return rows;
  }
  all(market: MarketContext): readonly LedgerEntry[] {
    return this.of(market);
  }
  hasSellerOrder(market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    return Promise.resolve(this.of(market).some((r) => r.sellerOrderId === sellerOrderId));
  }
  sellerOfSellerOrder(market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    return Promise.resolve(
      this.of(market).find((r) => r.sellerOrderId === sellerOrderId)?.sellerId ?? null,
    );
  }
  listSellerOrder(market: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    return Promise.resolve(this.of(market).filter((r) => r.sellerOrderId === sellerOrderId));
  }
  append(market: MarketContext, entries: readonly LedgerEntry[]) {
    let count = 0;
    for (const entry of entries) {
      const clash = this.of(market).some(
        (r) =>
          r.sellerOrderId === entry.sellerOrderId &&
          r.kind === entry.kind &&
          r.orderLineId === entry.orderLineId &&
          r.sourceId === entry.sourceId,
      );
      if (!clash) {
        this.of(market).push(entry);
        count += 1;
      }
    }
    return Promise.resolve(count);
  }
  list(): Promise<readonly LedgerEntry[]> {
    return Promise.resolve([]);
  }
  sums() {
    return Promise.resolve([]);
  }
}

export class MemoryDisputes implements DisputeRepository {
  readonly cases = new Map<string, DisputeCase>();
  readonly decisions: { market: string; decision: DisputeDecision }[] = [];
  constructor(private readonly ledger: MarketLedger) {}

  find(market: MarketContext, disputeId: Id<'Dispute'>) {
    return Promise.resolve(this.cases.get(scoped(market, disputeId)) ?? null);
  }
  insert(market: MarketContext, dispute: DisputeCase) {
    if (this.cases.has(scoped(market, dispute.disputeId))) return Promise.resolve(false);
    this.cases.set(scoped(market, dispute.disputeId), dispute);
    return Promise.resolve(true);
  }
  refresh(market: MarketContext, next: DisputeCase) {
    const stored = this.cases.get(scoped(market, next.disputeId));
    if (stored === undefined || stored.lastSyncedVersion > next.lastSyncedVersion) {
      return Promise.resolve(false);
    }
    this.cases.set(scoped(market, next.disputeId), next);
    return Promise.resolve(true);
  }
  setBucket(
    market: MarketContext,
    disputeId: Id<'Dispute'>,
    bucket: DisputeBucket,
    now: DisputeCase['updatedAt'],
  ) {
    const stored = this.cases.get(scoped(market, disputeId));
    if (stored !== undefined) {
      this.cases.set(scoped(market, disputeId), { ...stored, bucket, updatedAt: now });
    }
    return Promise.resolve();
  }
  list(market: MarketContext, page: DisputePage) {
    const mine = [...this.cases.entries()]
      .filter(([k]) => k.startsWith(`${market.marketId}:`))
      .map(([, c]) => c)
      .filter((c) => page.bucket === null || c.bucket === page.bucket)
      .sort(
        (a, b) =>
          b.openedAt.epochMilliseconds - a.openedAt.epochMilliseconds ||
          b.disputeId.localeCompare(a.disputeId),
      )
      .filter(
        (c) =>
          page.after === null ||
          c.openedAt.epochMilliseconds < page.after.openedAt.epochMilliseconds ||
          (c.openedAt.epochMilliseconds === page.after.openedAt.epochMilliseconds &&
            c.disputeId < page.after.disputeId),
      );
    return Promise.resolve(mine.slice(0, page.limit));
  }
  counts(market: MarketContext) {
    const counts = new Map<DisputeBucket, number>();
    for (const [k, c] of this.cases.entries()) {
      if (k.startsWith(`${market.marketId}:`))
        counts.set(c.bucket, (counts.get(c.bucket) ?? 0) + 1);
    }
    return Promise.resolve(counts as ReadonlyMap<DisputeBucket, number>);
  }
  findMany(market: MarketContext, disputeIds: readonly Id<'Dispute'>[]) {
    return Promise.resolve(disputeIds.flatMap((id) => this.cases.get(scoped(market, id)) ?? []));
  }
  sellerOrdersOfOrder(market: MarketContext, orderId: Id<'Order'>) {
    return this.sellerOrdersOfOrders(market, [orderId]);
  }
  sellerOrdersOfOrders(market: MarketContext, orderIds: readonly Id<'Order'>[]) {
    const seen = new Set<string>();
    const refs: SellerOrderRef[] = [];
    for (const row of this.ledger.all(market)) {
      if (orderIds.includes(row.orderId) && !seen.has(row.sellerOrderId)) {
        seen.add(row.sellerOrderId);
        refs.push({
          sellerOrderId: row.sellerOrderId,
          sellerId: row.sellerId,
          orderId: row.orderId,
        });
      }
    }
    return Promise.resolve(refs);
  }
  decisionsOf(market: MarketContext, disputeId: Id<'Dispute'>) {
    return Promise.resolve(
      this.decisions
        .filter((d) => d.market === market.marketId && d.decision.disputeId === disputeId)
        .map((d) => d.decision),
    );
  }
  decisionsForSeller(market: MarketContext, sellerId: Id<'Seller'>) {
    return Promise.resolve(
      this.decisions
        .filter((d) => d.market === market.marketId && d.decision.sellerId === sellerId)
        .map((d) => d.decision),
    );
  }
  lockForDecision(market: MarketContext, disputeId: Parameters<DisputeRepository['find']>[1]) {
    // Units run one at a time in the fakes: there is nothing to wait for.
    return Promise.resolve(this.cases.has(scoped(market, disputeId)));
  }
  insertDecision(market: MarketContext, decision: DisputeDecision) {
    // The two partial unique indexes: one first decision, one reversal, per seller order.
    const clash = this.decisions.some(
      (d) =>
        d.market === market.marketId &&
        d.decision.disputeId === decision.disputeId &&
        d.decision.sellerOrderId === decision.sellerOrderId &&
        (d.decision.supersedes === null) === (decision.supersedes === null),
    );
    if (clash) return Promise.resolve(false);
    this.decisions.push({ market: market.marketId, decision });
    return Promise.resolve(true);
  }
}

/** The disputes payments would answer, set by the test; a missing one is unknown. */
export class FakeDisputeSource implements DisputeSource {
  readonly disputes = new Map<string, ProviderDispute>();
  unavailable = false;
  read(_context: CallContext, disputeId: string) {
    if (this.unavailable) return Promise.resolve('unavailable' as const);
    return Promise.resolve(this.disputes.get(disputeId) ?? null);
  }
}

export class FakeOrderLookup implements OrderPaymentLookup {
  readonly intents = new Map<string, string | null>();
  unavailable = false;
  paymentIntentOf(
    _context: CallContext,
    orderId: string,
  ): Promise<OrderPaymentAnswer | 'unavailable'> {
    if (this.unavailable) return Promise.resolve('unavailable');
    if (!this.intents.has(orderId)) return Promise.resolve({ known: false });
    return Promise.resolve({ known: true, paymentIntentId: this.intents.get(orderId) ?? null });
  }
}

export class FakeSellerNames implements SellerNames {
  readonly names = new Map<string, string>();
  unavailable = false;
  storeNames(_context: CallContext, sellerIds: readonly Id<'Seller'>[]) {
    if (this.unavailable) return Promise.resolve('unavailable' as const);
    return Promise.resolve(
      new Map(sellerIds.map((id) => [id, this.names.get(id) ?? null] as const)),
    );
  }
}

export class RecordingCpOutbox implements OutboxWriter {
  readonly events: OutboxEvent[] = [];
  append(_context: CallContext, events: readonly OutboxEvent[]): Promise<void> {
    for (const event of events) {
      const definition = COMMISSION_PAYOUTS_EVENTS.find((d) => d.type === event.type);
      if (definition === undefined) throw new Error(`outbox: unknown type ${event.type}`);
      const checked = encodePayload(definition.fields, event.payload, {
        isKnownPermissionKey: () => false,
      });
      if (!checked.ok) throw new Error(`outbox: ${JSON.stringify(checked.error)}`);
      this.events.push(event);
    }
    return Promise.resolve();
  }
}

export class RecordingSecurityEvents implements SecurityEvents {
  readonly events: SecurityEventInput[] = [];
  record(_context: CallContext, event: SecurityEventInput): Promise<void> {
    this.events.push(event);
    return Promise.resolve();
  }
}
