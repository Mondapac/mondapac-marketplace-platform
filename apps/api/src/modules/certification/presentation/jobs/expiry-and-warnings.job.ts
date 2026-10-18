import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ExpireProductCertificates } from '../../application/use-cases/expire-product-certificates.use-case';
import type { ExpireSellerCertificates } from '../../application/use-cases/expire-seller-certificates.use-case';

/** The job's name (certification design 8.6; data design 11, lock key 3131801444743177164). */
export const EXPIRY_AND_WARNINGS_JOB = 'certification.expiry-and-warnings';

/**
 * `certification.expiry-and-warnings`, every 15 minutes (design 8.6, set at G2): for each hosted
 * Market the scheduler passes the Market's system-actor context, which goes unchanged to
 * `ExpireSellerCertificates` and then to `ExpireProductCertificates` (slice 15: manufacturer
 * certificates in the Market zone), both rule `system`. The second runs even when the first
 * failed. Safe to run twice and concurrently: one unit per record under the root's version, one
 * marker per warning. A refusal, a record that failed, a failed zone read or an unusable Market
 * zone throws after the work that could be done, so the scheduler logs that Market's run as
 * failed (the alert on two failed runs in a row, brief s9).
 */
export function expiryAndWarningsJob(
  expireSellers: ExpireSellerCertificates,
  expireProducts: ExpireProductCertificates,
): JobDefinition {
  const logger = new Logger('ExpiryAndWarningsJob');
  return {
    name: EXPIRY_AND_WARNINGS_JOB,
    every: Temporal.Duration.from({ minutes: 15 }),
    maxRunMs: 300_000,
    async run(context: JobContext): Promise<void> {
      const problems: string[] = [];
      const sellers = await expireSellers.execute(context, {});
      if (!sellers.ok) {
        problems.push(`refused: ${sellers.error.code}`);
      } else {
        logger.log({
          msg: EXPIRY_AND_WARNINGS_JOB,
          part: 'seller',
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          ...sellers.value,
        });
        if (sellers.value.failed > 0) problems.push(`${sellers.value.failed} record(s) failed`);
        if (sellers.value.zoneReadsFailed > 0) problems.push('the seller zone read failed');
      }
      const products = await expireProducts.execute(context, {});
      if (!products.ok) {
        problems.push(`manufacturer part refused: ${products.error.code}`);
      } else {
        logger.log({
          msg: EXPIRY_AND_WARNINGS_JOB,
          part: 'manufacturer',
          marketId: context.market.marketId,
          correlationId: context.correlationId,
          ...products.value,
        });
        if (products.value.failed > 0) {
          problems.push(`${products.value.failed} manufacturer record(s) failed`);
        }
        if (products.value.marketZoneMissing) problems.push('the Market zone is not usable');
      }
      if (problems.length > 0) {
        throw new Error(`${EXPIRY_AND_WARNINGS_JOB}: ${problems.join('; ')}`);
      }
    },
  };
}
