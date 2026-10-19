import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

export type TaxFailure =
  | AccessDenied
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** The Market has no built-in strategy and none is active, or the read failed: fail closed. */
  | { readonly code: 'tax.unavailable' };

/** One line to work the tax of. */
export interface TaxLineInput {
  /** The line amount in minor units, never negative. */
  readonly amount: bigint;
  readonly taxInclusive: boolean;
  /** A tax category code of the Market, or null. */
  readonly categoryCode: string | null;
}

export interface TaxLineAnswer {
  readonly rateBps: number;
  readonly tax: bigint;
  readonly net: bigint;
  readonly gross: bigint;
}

export interface TaxAnswer {
  /** The strategy used: its id, or null for the Market's built-in one. */
  readonly strategyId: Id<'TaxStrategy'> | null;
  /** One answer per input line, in the same order. */
  readonly lines: readonly TaxLineAnswer[];
}

/** One refunded part of an order line: units at positions `[unitsBefore, unitsBefore + units)`. */
export interface RefundLineInput {
  /** The line tax frozen at placement, in minor units. */
  readonly tax: bigint;
  /** The line's quantity. */
  readonly quantity: number;
  /** Units of the line already refunded before this refund. */
  readonly unitsBefore: number;
  /** Units refunded now, at least 1. */
  readonly units: number;
}

/** One refunded part of an amount-based charge (the flat shipping fee). */
export interface RefundChargeInput {
  /** The charge's tax frozen at placement. */
  readonly tax: bigint;
  /** The charge's gross (what the customer paid for it, tax included). */
  readonly gross: bigint;
  /** The cumulative refunded gross of the charge before and after this refund. */
  readonly before: bigint;
  readonly after: bigint;
}

export interface RefundTaxAnswer {
  /** The tax this refund reverses, one per input, in the same order. */
  readonly lines: readonly bigint[];
  readonly charges: readonly bigint[];
}

/**
 * What `ordering` calls. The method takes the caller's `CallContext` unchanged and is not
 * exposed over HTTP.
 */
export interface TaxFacade {
  /** The tax of up to 200 lines under the Market's strategy in force now. */
  calculateTax(
    context: CallContext,
    lines: readonly TaxLineInput[],
  ): Promise<Result<TaxAnswer, TaxFailure>>;

  /**
   * The tax a refund reverses (tax design 4.8), from the frozen values only: never from a current
   * price, rate or strategy. Up to 200 lines and 10 charges.
   */
  reverseRefundTax(
    context: CallContext,
    input: {
      readonly lines: readonly RefundLineInput[];
      readonly charges: readonly RefundChargeInput[];
    },
  ): Promise<Result<RefundTaxAnswer, TaxFailure>>;
}

/** Nest token of the {@link TaxFacade}, provided by `TaxModule`. */
export const TAX_FACADE = Symbol('TAX_FACADE');
