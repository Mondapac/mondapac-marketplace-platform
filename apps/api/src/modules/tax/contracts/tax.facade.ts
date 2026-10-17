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
}

/** Nest token of the {@link TaxFacade}, provided by `TaxModule`. */
export const TAX_FACADE = Symbol('TAX_FACADE');
