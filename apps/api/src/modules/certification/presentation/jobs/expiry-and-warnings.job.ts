import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ExpireSellerCertificates } from '../../application/use-cases/expire-seller-certificates.use-case';

/** The job's name (certification design 8.6; data design 11, lock key 3131801444743177164). */
export const EXPIRY_AND_WARNINGS_JOB = 'certification.expiry-and-warnings';

/**
 * `certification.expiry-and-warnings`, every 15 minutes (design 8.6, set at G2): for each hosted
 * Market the scheduler passes the Market's system-actor context, which goes unchanged to
 * `ExpireSellerCertificates` (rule `system`). Safe to run twice and concurrently: one unit per
 * record under the root's version, one marker per warning. A refusal, a Market without a warning
 * policy or a failed zone read throws after the work that could be done, so the scheduler logs
 * that Market's run as failed (the alert on two failed runs in a row, brief s9).
 */
export function expiryAndWarningsJob(expire: ExpireSellerCertificates): JobDefinition {
  const logger = new Logger('ExpiryAndWarningsJob');
  return {
    name: EXPIRY_AND_WARNINGS_JOB,
    every: Temporal.Duration.from({ minutes: 15 }),
    maxRunMs: 300_000,
    async run(context: JobContext): Promise<void> {
      const result = await expire.execute(context, {});
      if (!result.ok) {
        throw new Error(`${EXPIRY_AND_WARNINGS_JOB} refused: ${result.error.code}`);
      }
      logger.log({
        msg: EXPIRY_AND_WARNINGS_JOB,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
        ...result.value,
      });
      if (result.value.warningsUnavailable) {
        throw new Error(`${EXPIRY_AND_WARNINGS_JOB}: the Market has no warning policy`);
      }
      if (result.value.zoneReadsFailed > 0) {
        throw new Error(`${EXPIRY_AND_WARNINGS_JOB}: the seller zone read failed`);
      }
    },
  };
}
