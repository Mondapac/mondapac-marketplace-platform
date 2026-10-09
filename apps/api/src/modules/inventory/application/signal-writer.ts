import type {
  CallContext,
  IdGenerator,
  Id,
  MarketContext,
  Temporal,
} from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import { recomputeSignal, type Availability } from '../domain/stock';
import type { AvailabilitySignalRepository } from './ports/availability-signal.repository';

export interface SignalWriteInput {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly sellerId: Id<'Seller'>;
  readonly next: Availability;
  readonly now: Temporal.Instant;
}

/**
 * Recomputes one sell unit's availability signal under the unit's stock lock (design 5.3): when
 * the status or `onlyLeft` differs from the stored signal, writes the signal and appends its
 * events. Shared by every unit that changes a sell unit's sellable.
 */
export async function writeSignal(
  deps: {
    readonly signals: AvailabilitySignalRepository;
    readonly outbox: OutboxWriter;
    readonly ids: IdGenerator;
  },
  context: CallContext,
  market: MarketContext,
  input: SignalWriteInput,
): Promise<void> {
  const { signals, outbox, ids } = deps;
  const { offerId, variantId, sellerId, next, now } = input;
  const stored = await signals.find(market, offerId, variantId);
  const change = recomputeSignal({
    stored,
    newId: ids.next<'AvailabilitySignal'>(),
    offerId,
    variantId,
    sellerId,
    next,
    now,
  });
  if (change.kind !== 'changed') return;
  if (change.created) {
    await signals.insert(market, {
      id: change.events[0]!.aggregateId as Id<'AvailabilitySignal'>,
      offerId,
      variantId,
      sellerId,
      status: change.next.status,
      onlyLeft: change.next.onlyLeft,
      changedAt: now,
      version: change.version,
    });
  } else {
    const updated = await signals.update(market, stored!.id, stored!.version, {
      status: change.next.status,
      onlyLeft: change.next.onlyLeft,
      changedAt: now,
      version: change.version,
    });
    // Under the sell unit's lock nothing else writes the signal: a miss is a bug.
    if (updated === 'stale') {
      throw new Error('inventory: the availability signal moved under its lock');
    }
  }
  await outbox.append(context, change.events);
}
