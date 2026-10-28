import { err, ok, parseMinorUnits } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { auditCode, FirstOrderSettingsChanged, ShippingThresholdChanged } from '../domain/audit';
import { adminAccountId } from './caller';
import type { PromotionsFailure } from './failures';
import { activeSettings, isStillActive } from './market-switch';
import type { FirstOrderSettings, PromotionsSettings } from './ports/promotions-policy';
import type { PromotionsDependencies } from './promotions-dependencies';
import { auditMoney, spendPlatformFundingProof } from './shared';
import type { ShippingThresholdRecord } from './ports/settings.repository';

// The two admin-editable settings of phase 1: the first-order discount of the Market and the
// free-shipping threshold per delivery zone. Both are platform money, so they are admin-only, are
// refused in an acting-as session and are audited; the first-order monthly budget above the
// Market's threshold needs a fresh two-step code like any platform budget.

export interface FirstOrderView {
  readonly settings: FirstOrderSettings | null;
  /** `stored`: an admin edited it; `config`: the Market's defaults; `none`: off, nothing configured. */
  readonly source: 'stored' | 'config' | 'none';
  readonly currency: string;
}

const OFF: FirstOrderSettings = {
  enabled: false,
  kind: 'FIXED',
  percentBps: null,
  amountMinor: null,
  capMinor: null,
  minSpendMinor: 0n,
  monthlyBudgetMinor: 0n,
};

/** The first-order discount in force: the stored settings, else the Market's defaults, else none. */
export async function effectiveFirstOrder(
  deps: PromotionsDependencies,
  context: CallContext,
  settings: PromotionsSettings,
): Promise<{
  readonly settings: FirstOrderSettings | null;
  readonly source: FirstOrderView['source'];
}> {
  const stored = await deps.firstOrder.find(context.market);
  if (stored !== null) return { settings: stored, source: 'stored' };
  return settings.firstOrderDefaults === null
    ? { settings: null, source: 'none' }
    : { settings: settings.firstOrderDefaults, source: 'config' };
}

export async function viewFirstOrder(
  deps: PromotionsDependencies,
  context: CallContext,
): Promise<Result<FirstOrderView, PromotionsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  return deps.unitOfWork.run<FirstOrderView, PromotionsFailure>(
    context.market,
    async () => {
      const found = await effectiveFirstOrder(deps, context, switched.value);
      return ok({ ...found, currency: switched.value.currency });
    },
    { readOnly: true },
  );
}

interface FirstOrderInput {
  readonly enabled?: unknown;
  readonly kind?: unknown;
  readonly percentBps?: unknown;
  readonly amountMinor?: unknown;
  readonly capMinor?: unknown;
  readonly minSpendMinor?: unknown;
  readonly monthlyBudgetMinor?: unknown;
}

function parseFirstOrder(
  input: FirstOrderInput,
): Result<FirstOrderSettings, readonly { path: string; code: string }[]> {
  const issues: { path: string; code: string }[] = [];
  if (typeof input?.enabled !== 'boolean') issues.push({ path: 'enabled', code: 'value' });
  const kind = input?.kind;
  if (kind !== 'PERCENT' && kind !== 'FIXED') issues.push({ path: 'kind', code: 'value' });
  const money = (raw: unknown, path: string, min: bigint, required: boolean): bigint | null => {
    if (raw === undefined || raw === null) {
      if (required) issues.push({ path, code: 'required' });
      return null;
    }
    const parsed = parseMinorUnits(raw);
    if (!parsed.ok || parsed.value < min) {
      issues.push({ path, code: 'value' });
      return null;
    }
    return parsed.value;
  };
  let percentBps: number | null = null;
  let amountMinor: bigint | null = null;
  if (kind === 'PERCENT') {
    const bps = input?.percentBps;
    if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 1 || bps > 10000) {
      issues.push({ path: 'percentBps', code: 'value' });
    } else {
      percentBps = bps;
    }
    if (input?.amountMinor !== undefined && input.amountMinor !== null) {
      issues.push({ path: 'amountMinor', code: 'not-allowed' });
    }
  } else if (kind === 'FIXED') {
    amountMinor = money(input?.amountMinor, 'amountMinor', 1n, true);
    if (input?.percentBps !== undefined && input.percentBps !== null) {
      issues.push({ path: 'percentBps', code: 'not-allowed' });
    }
  }
  const capMinor = money(input?.capMinor, 'capMinor', 1n, false);
  const minSpendMinor = money(input?.minSpendMinor, 'minSpendMinor', 0n, true);
  const monthlyBudgetMinor = money(input?.monthlyBudgetMinor, 'monthlyBudgetMinor', 0n, true);
  if (
    issues.length > 0 ||
    typeof input.enabled !== 'boolean' ||
    (kind !== 'PERCENT' && kind !== 'FIXED')
  ) {
    return err(issues);
  }
  return ok({
    enabled: input.enabled,
    kind,
    percentBps,
    amountMinor,
    capMinor,
    minSpendMinor: minSpendMinor ?? 0n,
    monthlyBudgetMinor: monthlyBudgetMinor ?? 0n,
  });
}

const firstOrderAudit = (s: FirstOrderSettings, currency: string) => ({
  enabled: s.enabled,
  kind: auditCode(s.kind),
  percentBps: s.percentBps,
  amount: auditMoney(s.amountMinor, currency),
  cap: auditMoney(s.capMinor, currency),
  minSpend: auditMoney(s.minSpendMinor, currency),
  monthlyBudget: auditMoney(s.monthlyBudgetMinor, currency),
});

export async function setFirstOrder(
  deps: PromotionsDependencies,
  context: CallContext,
  input: FirstOrderInput,
): Promise<Result<FirstOrderView, PromotionsFailure>> {
  const adminId = adminAccountId(context);
  if (adminId === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const settings = switched.value;
  const parsed = parseFirstOrder(input);
  if (!parsed.ok) return err({ code: 'validation.failed', fields: parsed.error });
  const next = parsed.value;
  const now = deps.clock.now();

  return deps.unitOfWork.run<FirstOrderView, PromotionsFailure>(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'promotions.disabled' });
    // Read with the row locked, so two changes of the settings cannot both pass on a stale budget.
    const stored = await deps.firstOrder.findForUpdate(context.market);
    const before: { readonly settings: FirstOrderSettings | null } =
      stored !== null ? { settings: stored } : await effectiveFirstOrder(deps, context, settings);
    const was = before.settings ?? OFF;
    let proof: { sessionId: Id<'Session'>; verifiedAt: Temporal.Instant } | null = null;
    // The monthly budget is platform money: a larger one above the threshold needs a fresh code,
    // and so does switching a discount back on that carries a budget above it.
    if (
      next.monthlyBudgetMinor > settings.rules.platformBudgetStepUpMinor &&
      (next.monthlyBudgetMinor > was.monthlyBudgetMinor || (next.enabled && !was.enabled))
    ) {
      const spent = await spendPlatformFundingProof(deps, context);
      if (!spent.ok) return spent;
      proof = spent.value;
    }
    await deps.firstOrder.save(context.market, next, now, adminId);
    await deps.audit.record(
      context,
      FirstOrderSettingsChanged.entry('first-order-settings', {
        before: firstOrderAudit(was, settings.currency),
        after: {
          ...firstOrderAudit(next, settings.currency),
          stepUpSessionId: proof?.sessionId ?? null,
          stepUpVerifiedAt: proof?.verifiedAt ?? null,
        },
      }),
    );
    return ok({ settings: next, source: 'stored', currency: settings.currency });
  });
}

export interface ThresholdsView {
  readonly currency: string;
  /** The Market default, used by a zone with no threshold of its own. */
  readonly defaultThresholdMinor: bigint;
  readonly zones: readonly ShippingThresholdRecord[];
}

export async function listThresholds(
  deps: PromotionsDependencies,
  context: CallContext,
): Promise<Result<ThresholdsView, PromotionsFailure>> {
  if (adminAccountId(context) === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  return deps.unitOfWork.run<ThresholdsView, PromotionsFailure>(
    context.market,
    async () =>
      ok({
        currency: switched.value.currency,
        defaultThresholdMinor: switched.value.freeShippingThresholdMinor,
        zones: await deps.thresholds.list(context.market),
      }),
    { readOnly: true },
  );
}

const ZONE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Sets the free-shipping threshold of a zone; `thresholdMinor` null returns the zone to the Market default. */
export async function setThreshold(
  deps: PromotionsDependencies,
  context: CallContext,
  input: { readonly zoneCode?: unknown; readonly thresholdMinor?: unknown },
): Promise<
  Result<{ readonly zoneCode: string; readonly thresholdMinor: bigint | null }, PromotionsFailure>
> {
  const adminId = adminAccountId(context);
  if (adminId === null) return err({ code: 'access.denied' });
  const switched = await activeSettings(deps, context);
  if (!switched.ok) return switched;
  const fields: { path: string; code: string }[] = [];
  const zone = input?.zoneCode;
  if (typeof zone !== 'string' || !ZONE_PATTERN.test(zone))
    fields.push({ path: 'zoneCode', code: 'value' });
  let threshold: bigint | null = null;
  if (input?.thresholdMinor !== null && input?.thresholdMinor !== undefined) {
    const parsed = parseMinorUnits(input.thresholdMinor);
    if (!parsed.ok || parsed.value < 1n) fields.push({ path: 'thresholdMinor', code: 'value' });
    else threshold = parsed.value;
  } else if (input?.thresholdMinor === undefined) {
    fields.push({ path: 'thresholdMinor', code: 'required' });
  }
  if (fields.length > 0 || typeof zone !== 'string') {
    return err({ code: 'validation.failed', fields });
  }
  const currency = switched.value.currency;
  const now = deps.clock.now();

  return deps.unitOfWork.run(context.market, async () => {
    if (!(await isStillActive(deps, context))) return err({ code: 'promotions.disabled' });
    const before = await deps.thresholds.find(context.market, zone);
    if ((before?.thresholdMinor ?? null) === threshold)
      return ok({ zoneCode: zone, thresholdMinor: threshold });
    // Free shipping from a lower spend than the Market's default is platform money: a fresh code.
    let proof: { sessionId: Id<'Session'>; verifiedAt: Temporal.Instant } | null = null;
    if (threshold !== null && threshold < switched.value.freeShippingThresholdMinor) {
      const spent = await spendPlatformFundingProof(deps, context);
      if (!spent.ok) return spent;
      proof = spent.value;
    }
    const rowId = before?.id ?? deps.ids.next<'FreeShippingThreshold'>();
    if (threshold === null) await deps.thresholds.remove(context.market, zone);
    else await deps.thresholds.save(context.market, rowId, zone, threshold, now, adminId);
    await deps.audit.record(
      context,
      ShippingThresholdChanged.entry(rowId, {
        before: { threshold: auditMoney(before?.thresholdMinor ?? null, currency) },
        after: {
          threshold: auditMoney(threshold, currency),
          stepUpSessionId: proof?.sessionId ?? null,
          stepUpVerifiedAt: proof?.verifiedAt ?? null,
        },
      }),
    );
    return ok({ zoneCode: zone, thresholdMinor: threshold });
  });
}
