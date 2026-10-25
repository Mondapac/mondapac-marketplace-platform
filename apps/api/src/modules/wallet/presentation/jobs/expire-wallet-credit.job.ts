import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { ExpireWalletCredit } from '../../application/use-cases/expire-wallet-credit.use-case';

export const EXPIRE_WALLET_CREDIT_JOB = 'wallet.expire-credit';

/**
 * `wallet.expire-credit`, every minute: for each hosted Market, the scheduler's system-actor
 * context goes unchanged to `ExpireWalletCredit` (rule `system`). It releases holds past their
 * expiry and moves expired promo lots to breakage income, in every wallet state except off. Safe to
 * run twice and concurrently: each item is one unit under the wallet's balance lock.
 */
export function expireWalletCreditJob(expire: ExpireWalletCredit): JobDefinition {
  const logger = new Logger('ExpireWalletCreditJob');
  return {
    name: EXPIRE_WALLET_CREDIT_JOB,
    every: Temporal.Duration.from({ seconds: 60 }),
    async run(context: JobContext): Promise<void> {
      const result = await expire.execute(context, {});
      if (!result.ok) throw new Error(`${EXPIRE_WALLET_CREDIT_JOB} refused: ${result.error.code}`);
      const fields = { marketId: context.market.marketId, correlationId: context.correlationId };
      for (const id of result.value.failed) {
        logger.error({ msg: `${EXPIRE_WALLET_CREDIT_JOB}.failed`, ...fields, id });
      }
      if (result.value.expiredHolds + result.value.expiredLots > 0) {
        logger.log({
          msg: EXPIRE_WALLET_CREDIT_JOB,
          ...fields,
          expiredHolds: result.value.expiredHolds,
          expiredLots: result.value.expiredLots,
        });
      }
    },
  };
}
