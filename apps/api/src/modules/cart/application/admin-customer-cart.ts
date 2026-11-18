import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { isPlatformAdminActor } from '../../../platform/authz';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type {
  AdminCustomerCart,
  AdminSavedItem,
  AdminSavedItemsRequest,
  CartAdminFailure,
} from '../contracts/cart-admin.facade';
import type { CartRepository } from './ports/cart.repository';
import type { SavedItemRepository } from './ports/saved-item.repository';
import { MAX_SAVED_ITEMS } from './saved-operations';

// The admin's reads of one customer's cart (customers management phase 2b): the current cart and
// the saved-for-later list, ids and quantities only. Only a platform admin that is not acting as
// anyone; the gate checks `cart.customer-cart.view`.

export interface AdminCartDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly carts: Pick<CartRepository, 'findActiveByAccount'>;
  readonly saved: Pick<SavedItemRepository, 'list' | 'count'>;
}

/**
 * The saved items one account can hold are capped at {@link MAX_SAVED_ITEMS} by the save use
 * case; the admin read allows twice that as a margin, so it follows the cap if the cap changes.
 */
export const SAVED_READ_CAP = MAX_SAVED_ITEMS * 2;

export async function readAdminCustomerCart(
  deps: AdminCartDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
): Promise<Result<AdminCustomerCart, CartAdminFailure>> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  const read = await deps.unitOfWork.run(
    context.market,
    async () => {
      const [cart, savedCount] = await Promise.all([
        deps.carts.findActiveByAccount(context.market, accountId),
        deps.saved.count(context.market, accountId),
      ]);
      return ok({ cart, savedCount });
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  const { cart, savedCount } = read.value;
  return ok({
    cart:
      cart === null
        ? null
        : {
            createdAt: cart.createdAt.toString(),
            lastChangedAt: cart.lastChangedAt.toString(),
            lines: cart.lines.map((line) => ({
              offerId: line.offerId,
              variantId: line.variantId,
              quantity: line.quantity,
              priceAtAdd: line.priceAtAdd,
              addedAt: line.addedAt.toString(),
            })),
          },
    savedCount,
  });
}

export async function readAdminSavedItems(
  deps: AdminCartDependencies,
  context: CallContext,
  request: AdminSavedItemsRequest,
): Promise<
  Result<
    { readonly rows: readonly AdminSavedItem[]; readonly total: number | null },
    CartAdminFailure
  >
> {
  if (!isPlatformAdminActor(context.actor)) return err({ code: 'access.denied' });
  const read = await deps.unitOfWork.run(
    context.market,
    async () => ok(await deps.saved.list(context.market, request.accountId, SAVED_READ_CAP)),
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  // The store answers newest first; the list is short enough to order and cut here.
  const all = request.direction === 'asc' ? [...read.value].reverse() : read.value;
  const offset = Math.max(request.window.offset, 0);
  const rows = all.slice(offset, offset + Math.max(request.window.limit, 0)).map((item) => ({
    savedItemId: item.id,
    offerId: item.offerId,
    variantId: item.variantId,
    savedAt: item.savedAt.toString(),
  }));
  return ok({ rows, total: request.withTotal ? all.length : null });
}
