import { money } from '@mondapac/shared-kernel';
import type { CallContext, Money, Result } from '@mondapac/shared-kernel';
import type { ConsumedStepUp, StepUpRefusal } from '../../../platform/authz';
import { PROMOTIONS_PLATFORM_FUNDING_STEP_UP } from '../contracts/step-up';
import { auditCode } from '../domain/audit';
import type { PromotionRecord } from '../domain/promotion';
import type { PromotionsFailure } from './failures';
import { LockContendedError } from './ports/promotion.repository';
import type { PromotionsDependencies } from './promotions-dependencies';

/** identity's refusal of the step-up, as a promotions use case answers it; anything else stays closed. */
export function stepUpFailure(refusal: StepUpRefusal): PromotionsFailure {
  if (
    refusal.code === 'second-factor.required' ||
    refusal.code === 'second-factor.enrolment-required'
  ) {
    return { code: refusal.code, actionKey: refusal.actionKey };
  }
  return { code: refusal.code === 'access.unavailable' ? 'access.unavailable' : 'access.denied' };
}

/**
 * Spends the admin's fresh proof for platform funding, in the caller's open read-write unit, right
 * before the change it allows. On any refusal the caller returns the failure, so its unit commits
 * nothing (the proof is spent only with the change).
 */
export async function spendPlatformFundingProof(
  deps: PromotionsDependencies,
  context: CallContext,
): Promise<Result<ConsumedStepUp, PromotionsFailure>> {
  const spent = await deps.stepUp.consume(context, PROMOTIONS_PLATFORM_FUNDING_STEP_UP);
  if (!spent.ok) return { ok: false, error: stepUpFailure(spent.error) };
  return { ok: true, value: spent.value };
}

/**
 * Reads under a row lock. A lock that cannot be taken is `promotions.invalid-state` (409), not an
 * error: the row moved under the reader, so the caller reads again.
 */
export async function locked<T>(read: () => Promise<T>): Promise<Result<T, PromotionsFailure>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (error instanceof LockContendedError) {
      return { ok: false, error: { code: 'promotions.invalid-state' } };
    }
    throw error;
  }
}

/** The money of an audit row: only an amount above zero is a Money there. */
export const auditMoney = (amount: bigint | null, currency: string): Money | null =>
  amount === null || amount <= 0n ? null : money(amount, currency);

/** The terms of a promotion as an audit row states them (never its name or code). */
export function auditTerms(record: PromotionRecord) {
  return {
    type: auditCode(record.type),
    status: auditCode(record.status),
    funding: auditCode(record.funding),
    platformSplitBps: record.platformSplitBps,
    ownerSellerId: record.ownerSellerId,
    combinable: record.combinable,
    hasCode: record.code !== null,
    startsAt: record.startsAt,
    endsAt: record.endsAt,
    testMode: record.testMode,
    specialCampaign: record.specialCampaign,
    rewardKind: auditCode(record.reward.kind),
    rewardBps: record.reward.kind === 'PERCENT' ? record.reward.bps : null,
    rewardAmount:
      record.reward.kind === 'FIXED' ? auditMoney(record.reward.amount, record.currency) : null,
    budget: auditMoney(record.budgetMinor, record.currency),
  };
}
