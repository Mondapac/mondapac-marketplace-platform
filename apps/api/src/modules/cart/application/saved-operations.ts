import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result, Temporal } from '@mondapac/shared-kernel';
import { removeLine, type LineAvailability } from '../domain/cart';
import {
  addItem,
  type CartDependencies,
  type CartFailure,
  type LineWritten,
} from './cart-operations';
import type { AccountCaller } from './customer-caller';
import { verdictKey, type LineVerdict, type UnavailableReason } from './ports/line-facts';
import type { SavedItem, SavedItemRepository } from './ports/saved-item.repository';

// Saved for later (cart v4): a signed-in customer moves a cart line to a list and back. The list
// holds sell units only, no quantity and no price; each read checks them like cart lines. A guest
// keeps its list in the browser, so every operation here is for an account.

/** The most items one account keeps; saving one more is refused until one is removed. */
export const MAX_SAVED_ITEMS = 100;
/** An item nobody touched for this long is deleted by the hourly purge (days). */
export const SAVED_ITEM_RETENTION_DAYS = 365;

export interface SavedDependencies extends CartDependencies {
  readonly saved: SavedItemRepository;
}

export type SavedFailure =
  CartFailure | { readonly code: 'cart.saved-not-found' } | { readonly code: 'cart.saved-full' };

export interface SavedItemView {
  readonly savedId: Id<'SavedItem'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly savedAt: Temporal.Instant;
  readonly state: LineVerdict['state'];
  readonly reason: UnavailableReason | null;
  readonly sellerId: Id<'Seller'> | null;
  readonly unitPrice: Money | null;
  readonly availability: LineAvailability | null;
}

const savedIdOf = (value: unknown): Result<Id<'SavedItem'>, SavedFailure> => {
  const parsed = typeof value === 'string' ? parseId<'SavedItem'>(value) : null;
  return parsed !== null && parsed.ok
    ? ok(parsed.value)
    : err({ code: 'validation.failed', fields: [{ path: 'savedId', code: 'format' }] });
};

/** `view-saved`: the account's items, newest first, each with its current price and stock. */
export async function viewSaved(
  deps: SavedDependencies,
  context: CallContext,
  caller: AccountCaller,
): Promise<Result<readonly SavedItemView[], SavedFailure>> {
  const read = await deps.unitOfWork.run<readonly SavedItem[], SavedFailure>(
    context.market,
    async () => ok(await deps.saved.list(context.market, caller.accountId, MAX_SAVED_ITEMS)),
    { readOnly: true },
  );
  if (!read.ok) return read;
  const items = read.value;
  if (items.length === 0) return ok([]);
  const verdicts = await deps.facts.evaluate(context, items);
  return ok(
    items.map((item) => {
      const verdict = verdicts.get(verdictKey(item));
      return {
        savedId: item.id,
        offerId: item.offerId,
        variantId: item.variantId,
        savedAt: item.savedAt,
        state: verdict?.state ?? 'check-unavailable',
        reason: verdict?.reason ?? null,
        sellerId: verdict?.sellerId ?? null,
        unitPrice: verdict?.unitPrice ?? null,
        availability: verdict?.availability ?? null,
      };
    }),
  );
}

/**
 * `save-for-later`: moves a line of the account's cart to the list, in one unit (the line leaves
 * the cart and the item is stored, or neither). Saving a unit already on the list moves it to the
 * top. No facade is asked: an unbuyable line may be saved too.
 */
export async function saveForLater(
  deps: SavedDependencies,
  context: CallContext,
  caller: AccountCaller,
  input: { readonly lineId: unknown },
): Promise<Result<{ readonly savedId: Id<'SavedItem'> }, SavedFailure>> {
  const lineId = typeof input?.lineId === 'string' ? parseId<'CartLine'>(input.lineId) : null;
  if (lineId === null || !lineId.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'lineId', code: 'format' }] });
  }
  return deps.unitOfWork.run<{ readonly savedId: Id<'SavedItem'> }, SavedFailure>(
    context.market,
    async () => {
      const now = deps.clock.now();
      const cart = await deps.carts.findActiveByAccount(context.market, caller.accountId);
      const line = cart?.lines.find((l) => l.id === lineId.value);
      if (cart === null || line === undefined) return err({ code: 'cart.line-not-found' });
      const existing = await deps.saved.list(context.market, caller.accountId, MAX_SAVED_ITEMS);
      const already = existing.some(
        (item) => item.offerId === line.offerId && item.variantId === line.variantId,
      );
      if (
        !already &&
        (await deps.saved.count(context.market, caller.accountId)) >= MAX_SAVED_ITEMS
      ) {
        return err({ code: 'cart.saved-full' });
      }
      const stored = await deps.saved.upsert(context.market, {
        id: deps.ids.next<'SavedItem'>(),
        accountId: caller.accountId,
        offerId: line.offerId,
        variantId: line.variantId,
        savedAt: now,
      });
      const removed = removeLine(cart, line.id, now);
      if (!removed.ok) return err({ code: removed.code });
      // A stale cart rolls the whole unit back, the saved item with it.
      if ((await deps.carts.save(context.market, removed.cart)) === 'stale') {
        return err({ code: 'conflict.stale' });
      }
      return ok({ savedId: stored.id });
    },
  );
}

/**
 * `move-saved-to-cart`: takes the item off the list, then adds one of it to the cart through the
 * same checks as an add; a refused add puts the item back. Taking it off first means two requests
 * at once cannot both add it: the second finds nothing.
 */
export async function moveSavedToCart(
  deps: SavedDependencies,
  context: CallContext,
  caller: AccountCaller,
  input: { readonly savedId: unknown },
): Promise<Result<LineWritten, SavedFailure>> {
  const savedId = savedIdOf(input?.savedId);
  if (!savedId.ok) return savedId;
  const taken = await deps.unitOfWork.run<SavedItem, SavedFailure>(context.market, async () => {
    const item = await deps.saved.find(context.market, caller.accountId, savedId.value);
    if (item === null || !(await deps.saved.delete(context.market, caller.accountId, item.id))) {
      return err({ code: 'cart.saved-not-found' });
    }
    return ok(item);
  });
  if (!taken.ok) return taken;
  const item = taken.value;
  const added = await addItem(deps, context, caller, {
    offerId: item.offerId,
    variantId: item.variantId,
    quantity: 1,
  });
  if (!added.ok) {
    // Best effort: the item goes back with its id and its time; a failure here only loses it.
    await deps.unitOfWork.run<SavedItem, SavedFailure>(context.market, async () =>
      ok(await deps.saved.upsert(context.market, item)),
    );
  }
  return added;
}

/** `remove-saved`: takes an item off the account's list. */
export async function removeSaved(
  deps: SavedDependencies,
  context: CallContext,
  caller: AccountCaller,
  input: { readonly savedId: unknown },
): Promise<Result<{ readonly removed: true }, SavedFailure>> {
  const savedId = savedIdOf(input?.savedId);
  if (!savedId.ok) return savedId;
  return deps.unitOfWork.run<{ readonly removed: true }, SavedFailure>(context.market, async () =>
    (await deps.saved.delete(context.market, caller.accountId, savedId.value))
      ? ok({ removed: true as const })
      : err({ code: 'cart.saved-not-found' }),
  );
}
