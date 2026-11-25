import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Money, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AbandonedCartTotalsReader } from '../ports/abandoned-cart-totals';

/** The most lines one count reads; beyond it the count is refused, never answered short. */
export const MAX_ABANDONED_CART_LINES = 20_000;

export interface CountAbandonedCartsInput {
  /** A cart counts when it was last changed at or before this instant. */
  readonly changedAtOrBefore: Temporal.Instant;
}

export interface AbandonedCartTotals {
  readonly carts: number;
  /** The lines at the price when added or last changed, one sum per currency, by currency. */
  readonly values: readonly Money[];
}

export type CountAbandonedCartsFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed' }
  /** More than {@link MAX_ABANDONED_CART_LINES} lines: asking again cannot succeed. */
  | { readonly code: 'cart.abandoned-too-large' };

/**
 * `cart.count-abandoned-carts` (dashboards v2, phase 2; rule `system`, for reporting's nightly
 * snapshot): the Market's ACTIVE carts, guest and account, that hold a line, carry no order mark
 * and were last changed at or before the instant, and their lines' value at the price when added
 * (approximate: prices change). Counts and sums only; no id is answered or logged. One read-only
 * unit (ADR-0025).
 */
export class CountAbandonedCarts extends UseCase<
  CountAbandonedCartsInput,
  AbandonedCartTotals,
  CountAbandonedCartsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.count-abandoned-carts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: {
      readonly unitOfWork: UnitOfWork;
      readonly totals: AbandonedCartTotalsReader;
    },
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CountAbandonedCartsInput,
  ): Promise<Result<AbandonedCartTotals, CountAbandonedCartsFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    if (typeof input?.changedAtOrBefore?.epochMilliseconds !== 'number') {
      return err({ code: 'validation.failed' });
    }
    const read = await this.deps.unitOfWork.run(
      context.market,
      async () =>
        ok(
          await this.deps.totals.totals(
            context.market,
            input.changedAtOrBefore,
            MAX_ABANDONED_CART_LINES,
          ),
        ),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.denied' });
    if (read.value === null) return err({ code: 'cart.abandoned-too-large' });
    return ok(read.value);
  }
}
