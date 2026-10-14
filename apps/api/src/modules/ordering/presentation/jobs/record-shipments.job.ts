import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { RecordShipments } from '../../application/use-cases/record-shipments.use-case';

export const RECORD_SHIPMENTS_JOB = 'ordering.record-shipments';

/**
 * `ordering.record-shipments`, every 10 seconds: for each hosted Market, the scheduler's
 * system-actor context goes unchanged to `RecordShipments` (rule `system`). Safe to run twice and
 * concurrently: inventory's `recordShipment` is keyed by the order line and a seller order is
 * marked once. A seller order inventory refuses is logged and tried again next run.
 */
export function recordShipmentsJob(record: RecordShipments): JobDefinition {
  const logger = new Logger('RecordShipmentsJob');
  return {
    name: RECORD_SHIPMENTS_JOB,
    every: Temporal.Duration.from({ seconds: 10 }),
    async run(context: JobContext): Promise<void> {
      const result = await record.execute(context, {});
      if (!result.ok) throw new Error(`${RECORD_SHIPMENTS_JOB} refused: ${result.error.code}`);
      const fields = { marketId: context.market.marketId, correlationId: context.correlationId };
      for (const problem of result.value.failed) {
        logger.error({ msg: `${RECORD_SHIPMENTS_JOB}.failed`, ...fields, ...problem });
      }
      if (result.value.recorded > 0) {
        logger.log({ msg: RECORD_SHIPMENTS_JOB, ...fields, recorded: result.value.recorded });
      }
    },
  };
}
