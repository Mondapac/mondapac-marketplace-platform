import { MoneyError, addMoney, money, scaleMoney, subtractMoney } from '@mondapac/shared-kernel';
import type { Money } from '@mondapac/shared-kernel';

// The platform's margin on top of a fleet's quote (delivery models, package 4). The buyer pays
// the fleet quote plus the margin; the margin is a percent of the quote OR a fixed amount, and
// the total is then rounded UP to a step of minor units. The steps are counted in minor units of
// the Market currency, so they mean 5c, 10c, 50c and one dollar where the currency has cents
// and 5, 10, 50 and 100 units where it has none. All integer arithmetic (ADR-0007): a percent is
// basis points over an exact ratio, never a float.

/** Rounding steps in minor units; 1 is "no rounding". */
export const ROUNDING_STEPS = [1, 5, 10, 50, 100] as const;
export type RoundingStepMinor = (typeof ROUNDING_STEPS)[number];

export const isRoundingStep = (value: unknown): value is RoundingStepMinor =>
  typeof value === 'number' && (ROUNDING_STEPS as readonly number[]).includes(value);

/** The most a percent margin can be: 100.00 % of the quote, as basis points. */
export const MAX_MARGIN_BASIS_POINTS = 10_000;
/** The most a fixed margin can be, in minor units of the Market currency. */
export const MAX_FIXED_MARGIN_MINOR = 1_000_000;

export type DeliveryMargin =
  | { readonly kind: 'none' }
  | { readonly kind: 'percent'; readonly basisPoints: number }
  | { readonly kind: 'fixed'; readonly amountMinor: number };

/** What a margin rule is: the margin and the rounding of the total. */
export interface DeliveryPricing {
  readonly margin: DeliveryMargin;
  readonly roundingStepMinor: RoundingStepMinor;
}

export const NO_MARGIN: DeliveryPricing = Object.freeze({
  margin: Object.freeze({ kind: 'none' as const }),
  roundingStepMinor: 1,
});

/** The three parts of what a buyer pays for a delivery. `total` = `quote` + `margin`. */
export interface PricedDelivery {
  readonly quote: Money;
  /** What the platform adds: the margin and whatever the rounding adds on top of it. */
  readonly margin: Money;
  readonly total: Money;
}

/**
 * The buyer's price of a delivery: the fleet `quote` plus the margin, rounded up to the step.
 * Pure. The currency of the result is the quote's, which is the Market currency (a fixed margin
 * is in the Market currency, so the caller must not pass another one). A percent is rounded
 * half-up to a minor unit before the total is rounded up. A negative quote is a programmer error.
 */
export function applyDeliveryMargin(quote: Money, pricing: DeliveryPricing): PricedDelivery {
  if (quote.amount < 0n) throw new MoneyError('a delivery quote cannot be negative');
  const { margin } = pricing;
  const added =
    margin.kind === 'percent'
      ? scaleMoney(quote, BigInt(margin.basisPoints), 10_000n, 'half-up')
      : margin.kind === 'fixed'
        ? money(BigInt(margin.amountMinor), quote.currency)
        : money(0n, quote.currency);
  const before = addMoney(quote, added);
  const step = BigInt(pricing.roundingStepMinor);
  const rounded = ((before.amount + step - 1n) / step) * step;
  const total = money(rounded, quote.currency);
  return Object.freeze({ quote, margin: subtractMoney(total, quote), total });
}

type Field = { readonly path: string; readonly code: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses the pricing an admin sends: `{ margin: { kind, basisPoints | amountMinor }, roundingStepMinor }`.
 * Whole numbers only; an unknown key, kind or step, and a value past its limit are refused,
 * naming the path.
 */
export function parseDeliveryPricing(
  input: unknown,
  path = '',
):
  | { readonly ok: true; readonly value: DeliveryPricing }
  | { readonly ok: false; readonly fields: Field[] } {
  const at = (name: string): string => (path === '' ? name : `${path}.${name}`);
  if (!isObject(input)) return { ok: false, fields: [{ path: path || 'margin', code: 'type' }] };
  const fields: Field[] = [];
  for (const key of Object.keys(input)) {
    if (key !== 'margin' && key !== 'roundingStepMinor') {
      fields.push({ path: at('field'), code: 'unknown-field' });
      break;
    }
  }
  const step = input.roundingStepMinor;
  if (!isRoundingStep(step)) fields.push({ path: at('roundingStepMinor'), code: 'value' });
  const raw = input.margin;
  let margin: DeliveryMargin | null = null;
  if (!isObject(raw)) {
    fields.push({ path: at('margin'), code: 'type' });
  } else {
    const extra = Object.keys(raw).find(
      (key) => key !== 'kind' && key !== 'basisPoints' && key !== 'amountMinor',
    );
    if (extra !== undefined) fields.push({ path: at('margin.field'), code: 'unknown-field' });
    if (raw.kind === 'none') {
      if (raw.basisPoints !== undefined || raw.amountMinor !== undefined) {
        fields.push({ path: at('margin'), code: 'not-allowed' });
      } else margin = { kind: 'none' };
    } else if (raw.kind === 'percent') {
      const value = raw.basisPoints;
      if (raw.amountMinor !== undefined)
        fields.push({ path: at('margin.amountMinor'), code: 'not-allowed' });
      else if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > MAX_MARGIN_BASIS_POINTS
      ) {
        fields.push({ path: at('margin.basisPoints'), code: 'range' });
      } else margin = { kind: 'percent', basisPoints: value };
    } else if (raw.kind === 'fixed') {
      const value = raw.amountMinor;
      if (raw.basisPoints !== undefined)
        fields.push({ path: at('margin.basisPoints'), code: 'not-allowed' });
      else if (
        typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < 0 ||
        value > MAX_FIXED_MARGIN_MINOR
      ) {
        fields.push({ path: at('margin.amountMinor'), code: 'range' });
      } else margin = { kind: 'fixed', amountMinor: value };
    } else fields.push({ path: at('margin.kind'), code: 'value' });
  }
  if (fields.length > 0 || margin === null || !isRoundingStep(step)) return { ok: false, fields };
  return { ok: true, value: { margin, roundingStepMinor: step } };
}
