import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  OFFER_REVIEW_BACKLOG_COUNT_CODE,
  OFFER_REVIEW_BACKLOG_HOURS_CODE,
} from '../../domain/definitions';
import type { OfferQueueBacklogLimits } from '../../contracts/settings.facade';
import type { SettingsDependencies } from '../settings-dependencies';
import { readSettingValue } from '../settings-flow';

/**
 * `settings.read-offer-queue-backlog-limits`: the two limits of the Offer review queue backlog
 * alert for notifications' worker job (risk-based Offer approval, slice 8). Rule `system`: the job
 * runs as the Market's system actor. A missing row is the default; an unreadable store or an invalid stored value is
 * `settings.unavailable`, never a guess.
 */
export class ReadOfferQueueBacklogLimits extends UseCase<
  Record<string, never>,
  OfferQueueBacklogLimits,
  { readonly code: 'settings.unavailable' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.read-offer-queue-backlog-limits',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<OfferQueueBacklogLimits, { readonly code: 'settings.unavailable' }>> {
    const strict = { strict: true } as const;
    const [count, hours] = await Promise.all([
      readSettingValue(this.deps, context, OFFER_REVIEW_BACKLOG_COUNT_CODE, strict),
      readSettingValue(this.deps, context, OFFER_REVIEW_BACKLOG_HOURS_CODE, strict),
    ]);
    // An unreadable store is not the Market's choice: the alert acts on no guess (it raises and clears nothing).
    if (count === null || hours === null) return err({ code: 'settings.unavailable' });
    return ok({ count: Number(count), hours: Number(hours) });
  }
}
