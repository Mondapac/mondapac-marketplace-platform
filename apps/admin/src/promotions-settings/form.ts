import { decimalsOf, parseAmount } from '../wallet/money.ts';
import type { DiscountKind, FirstOrderSettings, Thresholds, ZoneThreshold } from './types.ts';

// The drafts of the promotions settings page and what the checks turn them into. Pure functions:
// no money is a float, a percentage is counted in whole basis points.

export interface FirstOrderDraft {
  readonly enabled: boolean;
  readonly kind: DiscountKind;
  /** A percentage as typed ("10", "12.5"). */
  readonly percent: string;
  /** A decimal amount in the Market currency, as typed. */
  readonly amount: string;
  readonly cap: string;
  readonly minSpend: string;
  readonly budget: string;
}

export interface ZoneDraft {
  readonly zoneCode: string;
  /** False: the zone uses the Market default (saved as a null threshold). */
  readonly own: boolean;
  readonly value: string;
}

export type FirstOrderField = 'percent' | 'amount' | 'cap' | 'minSpend' | 'budget';
export type FirstOrderBody = {
  readonly enabled: boolean;
  readonly kind: DiscountKind;
  readonly percentBps?: number;
  readonly amountMinor?: string;
  readonly capMinor?: string;
  readonly minSpendMinor: string;
  readonly monthlyBudgetMinor: string;
};

/** Minor units as a plain decimal string in the currency's decimals ("2500" -> "25.00"). */
export function decimalOf(minor: string, currency: string): string {
  const decimals = decimalsOf(currency) ?? 2;
  if (decimals === 0) return minor;
  const padded = minor.padStart(decimals + 1, '0');
  return `${padded.slice(0, -decimals)}.${padded.slice(-decimals)}`;
}

export function percentOf(bps: number | null): string {
  if (bps === null) return '';
  const whole = Math.floor(bps / 100);
  const rest = bps % 100;
  if (rest === 0) return String(whole);
  return `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}`;
}

/** Basis points of a typed percentage (at most two decimals, 0.01 to 100), or null. */
export function bpsOf(text: string): number | null {
  const typed = text.trim();
  if (!/^[0-9]{1,3}(\.[0-9]{1,2})?$/.test(typed)) return null;
  const [whole = '0', fraction = ''] = typed.split('.');
  const bps = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return bps >= 1 && bps <= 10000 ? bps : null;
}

/** An amount that may be zero; 'required' for nothing typed. */
function moneyOrZero(text: string, currency: string) {
  const result = parseAmount(text, currency);
  if (!result.ok && result.problem === 'zero' && /^0+(\.0+)?$/.test(text.trim())) {
    return { ok: true as const, minor: '0' };
  }
  return result;
}

export const OFF_FIRST_ORDER: FirstOrderSettings = {
  enabled: false,
  kind: 'FIXED',
  percentBps: null,
  amountMinor: null,
  capMinor: null,
  minSpendMinor: '0',
  monthlyBudgetMinor: '0',
};

export function firstOrderDraftOf(
  saved: FirstOrderSettings | null,
  currency: string,
): FirstOrderDraft {
  const value = saved ?? OFF_FIRST_ORDER;
  const money = (minor: string | null) => (minor === null ? '' : decimalOf(minor, currency));
  return {
    enabled: value.enabled,
    kind: value.kind,
    percent: percentOf(value.percentBps),
    amount: money(value.amountMinor),
    cap: money(value.capMinor),
    minSpend: money(value.minSpendMinor),
    budget: money(value.monthlyBudgetMinor),
  };
}

export type FirstOrderChecked =
  | { readonly ok: true; readonly body: FirstOrderBody }
  | { readonly ok: false; readonly invalid: readonly FirstOrderField[] };

/** What the API takes, or the fields that fail. A switched-off discount keeps its saved values valid. */
export function checkFirstOrder(draft: FirstOrderDraft, currency: string): FirstOrderChecked {
  const invalid: FirstOrderField[] = [];
  let percentBps: number | undefined;
  let amountMinor: string | undefined;
  if (draft.kind === 'PERCENT') {
    const bps = bpsOf(draft.percent);
    if (bps === null) invalid.push('percent');
    else percentBps = bps;
  } else {
    const amount = parseAmount(draft.amount, currency);
    if (!amount.ok) invalid.push('amount');
    else amountMinor = amount.minor;
  }
  let capMinor: string | undefined;
  if (draft.kind === 'PERCENT' && draft.cap.trim() !== '') {
    const cap = parseAmount(draft.cap, currency);
    if (!cap.ok) invalid.push('cap');
    else capMinor = cap.minor;
  }
  const minSpend = moneyOrZero(draft.minSpend, currency);
  if (!minSpend.ok) invalid.push('minSpend');
  const budget = moneyOrZero(draft.budget, currency);
  if (!budget.ok) invalid.push('budget');
  if (invalid.length > 0 || !minSpend.ok || !budget.ok) return { ok: false, invalid };
  return {
    ok: true,
    body: {
      enabled: draft.enabled,
      kind: draft.kind,
      ...(percentBps === undefined ? {} : { percentBps }),
      ...(amountMinor === undefined ? {} : { amountMinor }),
      ...(capMinor === undefined ? {} : { capMinor }),
      minSpendMinor: minSpend.minor,
      monthlyBudgetMinor: budget.minor,
    },
  };
}

/** The draft fields that differ from the saved values, by field key. */
export function firstOrderChanges(
  saved: FirstOrderSettings | null,
  draft: FirstOrderDraft,
  currency: string,
): readonly (keyof FirstOrderDraft)[] {
  const base = firstOrderDraftOf(saved, currency);
  const same = (a: string, b: string) => a.trim() === b.trim();
  const out: (keyof FirstOrderDraft)[] = [];
  if (draft.enabled !== base.enabled) out.push('enabled');
  if (draft.kind !== base.kind) out.push('kind');
  // The field of the kind that is not chosen is not part of the discount.
  if (draft.kind === 'PERCENT') {
    if (!same(draft.percent, base.percent)) out.push('percent');
    if (!same(draft.cap, base.cap)) out.push('cap');
  } else if (!same(draft.amount, base.amount)) out.push('amount');
  if (!same(draft.minSpend, base.minSpend)) out.push('minSpend');
  if (!same(draft.budget, base.budget)) out.push('budget');
  return out;
}

export function zoneDraftsOf(thresholds: Thresholds): readonly ZoneDraft[] {
  return thresholds.zones.map((zone: ZoneThreshold) => ({
    zoneCode: zone.zoneCode,
    own: true,
    value: decimalOf(zone.thresholdMinor, thresholds.currency),
  }));
}

export const ZONE_CODE = /^[A-Za-z0-9_-]{1,64}$/;

export type ZoneChange =
  | { readonly zoneCode: string; readonly thresholdMinor: string | null }
  | { readonly zoneCode: string; readonly invalid: true };

/**
 * The zone writes the draft needs: a new or changed threshold, or null for a zone that goes back
 * to the Market default. A zone whose typed amount does not parse comes back as invalid.
 */
export function zoneChanges(
  saved: Thresholds,
  drafts: readonly ZoneDraft[],
): readonly ZoneChange[] {
  const out: ZoneChange[] = [];
  for (const draft of drafts) {
    const was = saved.zones.find((zone) => zone.zoneCode === draft.zoneCode);
    if (!draft.own) {
      if (was !== undefined) out.push({ zoneCode: draft.zoneCode, thresholdMinor: null });
      continue;
    }
    const amount = parseAmount(draft.value, saved.currency);
    if (!amount.ok) {
      out.push({ zoneCode: draft.zoneCode, invalid: true });
      continue;
    }
    if (was === undefined || was.thresholdMinor !== amount.minor) {
      out.push({ zoneCode: draft.zoneCode, thresholdMinor: amount.minor });
    }
  }
  return out;
}
