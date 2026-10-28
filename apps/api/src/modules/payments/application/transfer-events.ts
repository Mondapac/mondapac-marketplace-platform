import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext } from '@mondapac/shared-kernel';
import type { PaymentsDependencies } from './payments-dependencies';
import type { TransferRecord } from './ports/transfer-store';
import type { TransferSnapshot } from './ports/transfer-gateway';
import type { EventOutcome, PendingEvent } from './ports/stripe-event-inbox';
import { raiseTransferAlert, recordTransferAlert } from './transfer-alerts';
import { settleFound } from './transfer-flow';
import { TransferChanged } from '../domain/events';
import type { Id } from '@mondapac/shared-kernel';

type Applied = EventOutcome | 'retry';

/**
 * A transfer event (package 6c): `transfer.created` resolves a `sending` row (or, on an
 * `abandoned` one, is the fence breach) and `transfer.reversed` records how much of it Stripe
 * reversed (the amount only grows). The payload is never trusted: the transfer is read again from
 * Stripe and matched on the `mp_key` metadata payments put on it, and on its destination, amount
 * and currency. A transfer that matches no stored row is a security event and ends `rejected`; it
 * never creates a row.
 */
export async function applyTransferEvent(
  deps: PaymentsDependencies,
  context: CallContext,
  event: PendingEvent,
): Promise<Applied> {
  const market = context.market;
  const read = await deps.transferGateway.readTransfer(event.objectId);
  if (!read.ok) {
    if (read.error.code === 'payment.provider-unavailable') return 'retry';
    return unmatched(deps, context);
  }
  const transfer = read.value;
  if (transfer.id !== event.objectId || transfer.livemode !== false) {
    return unmatched(deps, context);
  }
  // Stripe sends every event to every endpoint: another Market's transfer is not ours to judge.
  if (transfer.marketId !== null && transfer.marketId !== market.marketId) return 'other-market';
  if (transfer.key === null || transfer.marketId === null) return unmatched(deps, context);
  const key = transfer.key;

  const stored = await deps.unitOfWork.run<Applied, { readonly code: 'conflict' }>(
    market,
    async () => {
      const row = await deps.transfers.findByKey(market, key);
      if (row === null || !matches(row, transfer)) {
        await recordTransferAlert(deps, context, 'transfer-unmatched', row?.sellerId ?? null);
        return ok('rejected');
      }
      const settled = await settleFound(deps, context, row, transfer.id, 'webhook');
      if (!settled.ok) return err({ code: 'conflict' });
      if (settled.value.kind === 'anomaly') return ok('rejected');
      let changed = settled.value.kind === 'executed' || settled.value.kind === 'breached';
      if (transfer.amountReversedMinor > row.reversedMinor) {
        const fresh = await deps.transfers.findByKey(market, key);
        if (fresh === null || fresh.state !== 'executed' || fresh.amountMinor === null) {
          return err({ code: 'conflict' });
        }
        if (transfer.amountReversedMinor > fresh.amountMinor) {
          await recordTransferAlert(deps, context, 'transfer-unmatched', fresh.sellerId);
          return ok('rejected');
        }
        const at = deps.clock.now();
        if (transfer.amountReversedMinor > fresh.reversedMinor) {
          const moved = await deps.transfers.change(
            market,
            fresh.id,
            { state: 'executed', version: fresh.version },
            { state: 'executed', reversedMinor: transfer.amountReversedMinor },
            at,
          );
          if (!moved) return err({ code: 'conflict' });
          await deps.outbox.append(context, [
            TransferChanged.record({
              aggregateId: fresh.id as Id<'TransferExecution'>,
              aggregateVersion: fresh.version + 1,
              occurredAt: at,
              payload: {
                transferExecutionId: fresh.id as Id<'TransferExecution'>,
                sellerId: fresh.sellerId as Id<'Seller'>,
                state: 'executed',
              },
            }),
          ]);
          changed = true;
        }
      }
      return ok(changed ? 'transfer-recorded' : 'ignored');
    },
  );
  return stored.ok ? stored.value : 'retry';
}

/** The transfer is the one the row sent: same destination, amount and currency. */
const matches = (row: TransferRecord, transfer: TransferSnapshot): boolean =>
  row.accountRef === transfer.destination &&
  row.amountMinor === transfer.amountMinor &&
  row.currency === transfer.currency.toUpperCase();

/** A transfer that cannot be recorded against a stored row: alerted in a unit of its own. */
async function unmatched(deps: PaymentsDependencies, context: CallContext): Promise<Applied> {
  await raiseTransferAlert(deps, context, 'transfer-unmatched', null);
  return 'rejected';
}
