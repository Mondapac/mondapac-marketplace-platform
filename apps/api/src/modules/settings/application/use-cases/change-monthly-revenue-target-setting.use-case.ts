import { err, parseMinorUnits } from '@mondapac/shared-kernel';
import type { CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SETTINGS_MONTHLY_REVENUE_TARGET_MANAGE } from '../../contracts/permissions';
import { MONTHLY_REVENUE_TARGET_CODE, targetValue } from '../../domain/definitions';
import type { SettingsDependencies } from '../settings-dependencies';
import {
  changeSetting,
  type FieldIssue,
  type SettingChangeView,
  type SettingsFailure,
} from '../settings-flow';

/** The most digits of a target (inside a BIGINT, below 2^53). */
const MAX_TARGET_DIGITS = 15;

interface Input {
  /** `{ amount: "<minor units>", currency }`, or null to clear the target. */
  readonly target?: unknown;
  readonly expectedVersion?: unknown;
  /** The note for the reviewer (System requests); needed only where the area is reviewed. */
  readonly note?: unknown;
}

/** The Market's currency (Market configuration): a target is always in it. */
export interface MarketCurrency {
  currencyOf(market: MarketContext): string;
}

/**
 * `settings.change-monthly-revenue-target-setting`: an admin sets or clears the Market's monthly
 * revenue target, under its own manage key, from the version they saw. The amount is minor units
 * above zero, at most 15 digits, in the Market's own currency (never assumed; another currency is
 * `validation.failed` on `target.currency`). Refused in acting-as, audited with the target before
 * and after, idempotent, and a stale version is a conflict (the shared settings flow).
 */
export class ChangeMonthlyRevenueTargetSetting extends UseCase<
  Input,
  SettingChangeView,
  SettingsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'settings.change-monthly-revenue-target-setting',
    rule: { kind: 'permissions', allOf: [SETTINGS_MONTHLY_REVENUE_TARGET_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SettingsDependencies,
    private readonly markets: MarketCurrency,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<SettingChangeView, SettingsFailure>> {
    const target = input?.target;
    let value: string;
    if (target === null) {
      value = targetValue(null);
    } else if (typeof target !== 'object' || target === undefined || Array.isArray(target)) {
      return Promise.resolve(
        err({ code: 'validation.failed', fields: [{ path: 'target', code: 'type' }] }),
      );
    } else {
      const { amount, currency } = target as { amount?: unknown; currency?: unknown };
      const fields: FieldIssue[] = [];
      const parsed = parseMinorUnits(amount, MAX_TARGET_DIGITS);
      if (!parsed.ok || parsed.value <= 0n) fields.push({ path: 'target.amount', code: 'value' });
      if (currency !== this.markets.currencyOf(context.market)) {
        fields.push({ path: 'target.currency', code: 'value' });
      }
      const extra = Object.keys(target).filter((key) => key !== 'amount' && key !== 'currency');
      if (extra.length > 0) fields.push({ path: 'target', code: 'unknown-field' });
      if (fields.length > 0 || !parsed.ok) {
        return Promise.resolve(err({ code: 'validation.failed', fields }));
      }
      value = targetValue({ amount: parsed.value, currency: currency as string });
    }
    return changeSetting(this.deps, context, MONTHLY_REVENUE_TARGET_CODE, {
      code: MONTHLY_REVENUE_TARGET_CODE,
      value,
      expectedVersion: input?.expectedVersion,
      note: input?.note,
    });
  }
}
