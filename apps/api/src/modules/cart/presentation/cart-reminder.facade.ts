import type { CallContext } from '@mondapac/shared-kernel';
import type { ListIdleAccountCarts } from '../application/use-cases/list-idle-account-carts.use-case';
import type { CartReminderFacade } from '../contracts';

/** Passes the caller's `CallContext` unchanged to the use case, so the gate runs. */
export class CartReminderFacadeImplementation implements CartReminderFacade {
  constructor(private readonly list: ListIdleAccountCarts) {}

  async idleCarts(context: CallContext, request: Parameters<CartReminderFacade['idleCarts']>[1]) {
    const result = await this.list.execute(context, request);
    if (result.ok) return result;
    return result.error.code === 'validation.failed'
      ? ({ ok: false, error: { code: 'validation.failed' } } as const)
      : ({ ok: false, error: result.error } as const);
  }
}
