import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { RecordRefundLedger } from '../../application/use-cases/record-refund-ledger.use-case';

export const RECORD_REFUND_LEDGER_JOB = 'ordering.record-refund-ledger';

/**
 * `ordering.record-refund-ledger`, every 10 seconds: for each hosted Market, the scheduler's
 * system-actor context goes unchanged to `RecordRefundLedger` (rule `system`). Safe to run twice
 * and concurrently: commission-payouts writes a refund once and a refund is marked once. A refund
 * the ledger refuses is logged and tried again next run; ids, counts and codes only.
 */
export function recordRefundLedgerJob(record: RecordRefundLedger): JobDefinition {
  const logger = new Logger('RecordRefundLedgerJob');
  return {
    name: RECORD_REFUND_LEDGER_JOB,
    every: Temporal.Duration.from({ seconds: 10 }),
    async run(context: JobContext): Promise<void> {
      const result = await record.execute(context, {});
      if (!result.ok) throw new Error(`${RECORD_REFUND_LEDGER_JOB} refused: ${result.error.code}`);
      const fields = { marketId: context.market.marketId, correlationId: context.correlationId };
      for (const problem of result.value.failed) {
        logger.error({ msg: `${RECORD_REFUND_LEDGER_JOB}.failed`, ...fields, ...problem });
      }
      for (const problem of result.value.stuck) {
        logger.error({ msg: 'ordering.refund-ledger.stuck', ...fields, ...problem });
      }
      if (result.value.recorded > 0) {
        logger.log({ msg: RECORD_REFUND_LEDGER_JOB, ...fields, recorded: result.value.recorded });
      }
    },
  };
}
