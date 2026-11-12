// Answers of the admin tax strategy routes (apps/api tax tax.controller.ts). Reading needs
// `tax.strategy.view`; every change needs the protected `tax.strategy.manage`.

export const TAX_VIEW_PERMISSION = 'tax.strategy.view';
export const TAX_MANAGE_PERMISSION = 'tax.strategy.manage';
export const TAX_STRATEGIES_PATH = 'tax/admin/strategies';
export const TAX_ACTIVE_PATH = 'tax/admin/strategies/active';
/** The longest strategy name and the highest rate the API accepts (rates are basis points). */
export const STRATEGY_NAME_MAX = 80;
export const MAX_RATE_BPS = 5000;

export type StrategyKind = 'flat-rate' | 'by-category';

export interface TaxStrategy {
  readonly id: string;
  readonly name: string;
  readonly kind: StrategyKind;
  readonly rateBps: number | null;
  readonly defaultRateBps: number | null;
  readonly categoryRatesBps: Readonly<Record<string, number>> | null;
  readonly active: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface TaxStrategyList {
  readonly builtInRateBps: number;
  readonly activeStrategyId: string | null;
  readonly categoryCodes: readonly string[];
  readonly strategies: readonly TaxStrategy[];
}

/** The body of a create or an update. */
export interface StrategyRequest {
  readonly name: string;
  readonly kind: StrategyKind;
  readonly rateBps?: number;
  readonly defaultRateBps?: number;
  readonly categoryRatesBps?: Readonly<Record<string, number>>;
}

/** Basis points as a percentage with up to two decimals ("10 %", "7.5 %"). */
export function percentOf(bps: number): string {
  return `${Number((bps / 100).toFixed(2))} %`;
}

/**
 * A percentage typed by a person as basis points, or null when it is not a number from 0 to 50 with
 * at most two decimals. Comma and point both work as the decimal mark.
 */
export function parsePercent(text: string): number | null {
  const clean = text.trim().replace(',', '.');
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(clean)) return null;
  const bps = Math.round(Number(clean) * 100);
  return bps >= 0 && bps <= MAX_RATE_BPS ? bps : null;
}

/** Basis points as the text of an input ("7.5"). */
export const percentInput = (bps: number): string => String(Number((bps / 100).toFixed(2)));
