import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { ClearOrderedLines } from '../application/use-cases/clear-ordered-lines.use-case';
import type { ReadCheckoutLines } from '../application/use-cases/read-checkout-lines.use-case';
import type { CartCheckoutFacade, CartCheckoutFailure, CheckoutLine } from '../contracts';

/** Passes the caller's `CallContext` unchanged to one use case each, so the gate runs. */
export class CartCheckoutFacadeImplementation implements CartCheckoutFacade {
  constructor(
    private readonly read: ReadCheckoutLines,
    private readonly clear: ClearOrderedLines,
  ) {}

  async checkoutLines(
    context: CallContext,
  ): Promise<Result<readonly CheckoutLine[], CartCheckoutFailure>> {
    const result = await this.read.execute(context, {});
    if (result.ok) return result;
    // Only a denial or an unreadable cart reaches ordering; both stop the checkout.
    return result.error.code === 'access.denied'
      ? { ok: false, error: result.error as AccessDenied }
      : { ok: false, error: { code: 'cart.check-unavailable' } };
  }

  async clearOrdered(
    context: CallContext,
    request: Parameters<CartCheckoutFacade['clearOrdered']>[1],
  ) {
    const result = await this.clear.execute(context, request);
    if (result.ok) return result;
    return result.error.code === 'access.denied'
      ? ({ ok: false, error: result.error as AccessDenied } as const)
      : ({ ok: false, error: { code: 'conflict.stale' } } as const);
  }
}
