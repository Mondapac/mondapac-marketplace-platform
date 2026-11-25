import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Money, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import { SETTINGS_MONTHLY_REVENUE_TARGET_VIEW } from '../../contracts/permissions';
import { MONTHLY_REVENUE_TARGET_CODE, targetOf } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';

const logger = new Logger('ReadMonthlyRevenueTarget');

/**
 * `settings.read-monthly-revenue-target`: the Market's monthly revenue target for another module
 * through the settings facade (reporting's month-end forecast). The setting's view key. Null while
 * none is set. Unlike the panel settings an unreadable store has no safe value to answer: it is
 * `access.unavailable`, so the dashboard shows the section's error, never "no target".
 */
export class ReadMonthlyRevenueTarget extends UseCase<
  Record<string, never>,
  Money | null,
  AccessDenied
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.read-monthly-revenue-target',
    rule: { kind: 'permissions', allOf: [SETTINGS_MONTHLY_REVENUE_TARGET_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<Money | null, AccessDenied>> {
    try {
      const read = await this.deps.unitOfWork.run(
        context.market,
        async () => ok(await this.deps.settings.find(context.market, MONTHLY_REVENUE_TARGET_CODE)),
        { readOnly: true },
      );
      if (!read.ok) return err({ code: 'access.unavailable' });
      return ok(read.value === null ? null : targetOf(read.value.value));
    } catch {
      // The class is enough: a store error can carry connection details.
      logger.warn({
        msg: 'settings.monthly-revenue-target.read-failed',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.unavailable' });
    }
  }
}
