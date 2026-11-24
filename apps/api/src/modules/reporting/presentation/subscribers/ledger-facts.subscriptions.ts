import {
  subscription,
  type RegisteredSubscription,
} from '../../../../platform/events/event-subscriptions';
import { LedgerRecorded } from '../../../commission-payouts';
import type { RecordLedgerFacts } from '../../application/use-cases/record-ledger-facts.use-case';

/** The subscriber's name: also the `handler` of `reporting.inbox`. */
export const REPORT_LEDGER_RECORDED_SUBSCRIBER = 'reporting.ledger-recorded';

/**
 * Reporting's subscription to the seller ledger (dashboards v2, phase 1, PR 4). An entry adapter
 * only: the seller order the posting names and the Market's system-actor context go unchanged to
 * `RecordLedgerFacts`, which reads the rows again from commission-payouts. A refusal throws, so the
 * delivery is retried and, after its last attempt, dead-lettered with an alert.
 */
export function ledgerFactsSubscriptions(record: RecordLedgerFacts): RegisteredSubscription[] {
  return [
    subscription({
      name: REPORT_LEDGER_RECORDED_SUBSCRIBER,
      event: LedgerRecorded,
      handle: async (event, delivery, context) => {
        const result = await record.execute(context, {
          delivery,
          sellerOrderId: event.payload.sellerOrderId,
        });
        if (!result.ok) {
          throw new Error(`${REPORT_LEDGER_RECORDED_SUBSCRIBER} refused: ${result.error.code}`);
        }
      },
    }),
  ];
}
