import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { JobContext, JobDefinition } from '../../../../platform/scheduler/job-registry';
import type { DeliverSecurityAlerts } from '../../application/use-cases/deliver-security-alerts.use-case';
import type { EvaluateSecurityRules } from '../../application/use-cases/evaluate-security-rules.use-case';
import type { SendSecurityDigests } from '../../application/use-cases/send-security-digests.use-case';

export const EVALUATE_RULES_JOB = 'security.evaluate-rules';
export const DELIVER_ALERTS_JOB = 'security.deliver-alerts';
export const SEND_DIGESTS_JOB = 'security.send-digests';

function log(logger: Logger, name: string, context: JobContext, report: object): void {
  logger.log({
    msg: name,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
    ...report,
  });
}

/**
 * `security.evaluate-rules`, every minute, per hosted Market: the scheduler's system context goes
 * unchanged to {@link EvaluateSecurityRules} (rule `system`). Logs only a run that opened or
 * changed an alert, or had a failing rule.
 */
export function evaluateRulesJob(evaluate: EvaluateSecurityRules): JobDefinition {
  const logger = new Logger('SecurityEvaluateRulesJob');
  return {
    name: EVALUATE_RULES_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    maxRunMs: 50_000,
    async run(context: JobContext): Promise<void> {
      const result = await evaluate.execute(context, {});
      if (!result.ok) throw new Error(`${EVALUATE_RULES_JOB} refused`);
      const { opened, updated, failedRules } = result.value;
      if (opened + updated + failedRules > 0)
        log(logger, EVALUATE_RULES_JOB, context, result.value);
    },
  };
}

/** `security.deliver-alerts`, every minute, per hosted Market ({@link DeliverSecurityAlerts}). */
export function deliverAlertsJob(deliver: DeliverSecurityAlerts): JobDefinition {
  const logger = new Logger('SecurityDeliverAlertsJob');
  return {
    name: DELIVER_ALERTS_JOB,
    every: Temporal.Duration.from({ minutes: 1 }),
    maxRunMs: 50_000,
    async run(context: JobContext): Promise<void> {
      const result = await deliver.execute(context, {});
      if (!result.ok) throw new Error(`${DELIVER_ALERTS_JOB} refused`);
      if (result.value.steps > 0) log(logger, DELIVER_ALERTS_JOB, context, result.value);
    },
  };
}

/** `security.send-digests`, hourly, per hosted Market ({@link SendSecurityDigests}). */
export function sendDigestsJob(send: SendSecurityDigests): JobDefinition {
  const logger = new Logger('SecuritySendDigestsJob');
  return {
    name: SEND_DIGESTS_JOB,
    every: Temporal.Duration.from({ hours: 1 }),
    async run(context: JobContext): Promise<void> {
      const result = await send.execute(context, {});
      if (!result.ok) throw new Error(`${SEND_DIGESTS_JOB} refused`);
      if (result.value.sent > 0) log(logger, SEND_DIGESTS_JOB, context, result.value);
    },
  };
}
