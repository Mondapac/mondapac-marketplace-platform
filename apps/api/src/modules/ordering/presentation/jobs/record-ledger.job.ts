import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { RecordLedger } from '../../application/use-cases/record-ledger.use-case';

export const RECORD_LEDGER_JOB = 'ordering.record-ledger';

/**
 * `ordering.record-ledger`, every 10 seconds: for each hosted Market, the scheduler's system-actor
 * context goes unchanged to `RecordLedger` (rule `system`). Safe to run twice and concurrently:
 * commission-payouts writes a seller order once and a seller order is marked once. A seller order
 * the ledger refuses is logged and tried again next run.
 */
export function recordLedgerJob(record: RecordLedger): JobDefinition {
  const logger = new Logger('RecordLedgerJob');
  return {
    name: RECORD_LEDGER_JOB,
    every: Temporal.Duration.from({ seconds: 10 }),
    async run(context: JobContext): Promise<void> {
      const result = await record.execute(context, {});
      if (!result.ok) throw new Error(`${RECORD_LEDGER_JOB} refused: ${result.error.code}`);
      const fields = { marketId: context.market.marketId, correlationId: context.correlationId };
      for (const problem of result.value.failed) {
        logger.error({ msg: `${RECORD_LEDGER_JOB}.failed`, ...fields, ...problem });
      }
      for (const problem of result.value.stuck) {
        logger.error({ msg: 'ordering.ledger.stuck', ...fields, ...problem });
      }
      if (result.value.recorded > 0) {
        logger.log({ msg: RECORD_LEDGER_JOB, ...fields, recorded: result.value.recorded });
      }
    },
  };
}
