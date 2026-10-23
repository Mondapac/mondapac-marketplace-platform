import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result, Temporal } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CartDependencies } from '../cart-operations';
import type { IdleAccountCart, IdleCartCursor } from '../ports/cart.repository';

/** The most carts one page answers. */
export const MAX_IDLE_CARTS_PAGE = 200;
/** The most accounts one page may be narrowed to (a Market's test accounts). */
export const MAX_IDLE_CARTS_ACCOUNTS = 50;

export interface ListIdleAccountCartsInput {
  readonly changedAfter: Temporal.Instant;
  readonly changedAtOrBefore: Temporal.Instant;
  readonly after: IdleCartCursor | null;
  readonly limit: number;
  readonly accountIds?: readonly Id<'Account'>[];
}

export type ListIdleAccountCartsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'validation.failed' };

/**
 * `cart.list-idle-account-carts` (personalization 1c; rule `system`): one page of the Market's
 * signed-in customers' carts that hold lines and were last changed inside the window, for the
 * notifications cart reminder job. Guest and merged carts never appear, nor a cart the buyer has
 * not changed since a paid order cleared it. Ids, the last change and a line count only.
 */
export class ListIdleAccountCarts extends UseCase<
  ListIdleAccountCartsInput,
  readonly IdleAccountCart[],
  ListIdleAccountCartsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'cart.list-idle-account-carts',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CartDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ListIdleAccountCartsInput,
  ): Promise<Result<readonly IdleAccountCart[], ListIdleAccountCartsFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_IDLE_CARTS_PAGE) {
      return err({ code: 'validation.failed' });
    }
    if (input.accountIds !== undefined && input.accountIds.length > MAX_IDLE_CARTS_ACCOUNTS) {
      return err({ code: 'validation.failed' });
    }
    const page = await this.deps.unitOfWork.run<readonly IdleAccountCart[], never>(
      context.market,
      async () => ok(await this.deps.carts.idleAccountCarts(context.market, input)),
      { readOnly: true },
    );
    if (!page.ok) return err({ code: 'access.denied' });
    return ok(page.value);
  }
}
