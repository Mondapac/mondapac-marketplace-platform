import { parseAmount } from '../wallet/money.ts';
import { MAX_COUNT, type RefundLimit } from './types.ts';
import { minorToField } from '../disputes/amount.ts';

export interface LimitForm {
  readonly count: string;
  readonly amount: string;
}

export type LimitFormErrors = {
  count?: 'count';
  amount?: 'amount-required' | 'amount' | 'currency';
};

/** The form's starting values: the cap being edited, or empty for a first one. */
export function formOf(limit: RefundLimit | null, currency: string): LimitForm {
  return limit === null
    ? { count: '', amount: '' }
    : { count: String(limit.maxCount), amount: minorToField(limit.maxAmount.amount, currency) };
}

export type LimitBody =
  | {
      readonly ok: true;
      /** The PUT body: the amount is minor units as a string, never a float. */
      readonly body: { maxCount: number; maxAmount: string };
    }
  | { readonly ok: false; readonly errors: LimitFormErrors };

/** The PUT body for what was typed (without the version), or what is wrong with it. */
export function bodyOf(form: LimitForm, currency: string): LimitBody {
  const errors: LimitFormErrors = {};
  const countText = form.count.trim();
  const count = /^[0-9]{1,4}$/.test(countText) ? Number(countText) : 0;
  if (count < 1 || count > MAX_COUNT) errors.count = 'count';
  const amount = parseAmount(form.amount, currency);
  if (!amount.ok) {
    errors.amount =
      amount.problem === 'currency'
        ? 'currency'
        : amount.problem === 'required'
          ? 'amount-required'
          : 'amount';
  }
  if (errors.count !== undefined || errors.amount !== undefined || !amount.ok) {
    return { ok: false, errors };
  }
  return { ok: true, body: { maxCount: count, maxAmount: amount.minor } };
}
