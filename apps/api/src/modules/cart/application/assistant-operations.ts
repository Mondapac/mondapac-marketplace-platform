import { err, money, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Money, Result } from '@mondapac/shared-kernel';
import {
  MAX_ASSISTANT_SELL_UNITS,
  type AssistantCart,
  type AssistantCartFailure,
  type AssistantOfferUnits,
  type AssistantSellUnit,
} from '../contracts/cart-assistant.facade';
import { limitQuantity, type CartLimits, type LineAvailability } from '../domain/cart';
import { viewCart, type CartDependencies } from './cart-operations';
import type { AccountCaller } from './customer-caller';
import { verdictKey } from './ports/line-facts';

// The cart reads of the buyer assistant's cart cards (stage 1, S1-B1): the cart page's own
// composition and the add's own checks, read only. Nothing here writes.

/** The highest quantity a line may hold now (the add's `LineCeilingPolicy`, design 6.1). */
const maxQuantityOf = (limits: CartLimits, availability: LineAvailability | null): number =>
  limitQuantity(Number.MAX_SAFE_INTEGER, limits, availability).quantity;

/** The sum of the store subtotals, or null when one is unknown or the currencies mix. */
function totalOf(subtotals: readonly (Money | null)[]): Money | null {
  if (subtotals.length === 0) return null;
  let sum = 0n;
  let currency: string | null = null;
  for (const subtotal of subtotals) {
    if (subtotal === null) return null;
    if (currency !== null && currency !== subtotal.currency) return null;
    currency = subtotal.currency;
    sum += subtotal.amount;
  }
  return currency === null ? null : money(sum, currency);
}

/** `ownCart`: the signed-in customer's cart as the cart page composes it, with each line's max. */
export async function assistantCart(
  deps: CartDependencies,
  context: CallContext,
  caller: AccountCaller,
): Promise<Result<AssistantCart, AssistantCartFailure>> {
  const viewed = await viewCart(deps, context, caller);
  if (!viewed.ok) {
    return err(
      viewed.error.code === 'access.denied'
        ? { code: 'access.denied' }
        : { code: 'cart.check-unavailable' },
    );
  }
  const limits = deps.policy.limits(context.market);
  const groups = viewed.value.groups.map((group) => ({
    sellerId: group.sellerId,
    sellerName: group.sellerName,
    subtotal: group.subtotal,
    minimumOrder: group.minimumOrder,
    lines: group.lines.map((line) => ({
      lineId: line.lineId,
      offerId: line.offerId,
      variantId: line.variantId,
      productId: line.display?.productId ?? null,
      productName: line.display?.productName ?? null,
      variantLabel: line.display?.variantLabel ?? null,
      quantity: line.quantity,
      state: line.state,
      unitPrice: line.unitPrice,
      maxQuantity: line.state === 'buyable' ? maxQuantityOf(limits, line.availability) : null,
    })),
  }));
  // Only stores with something buyable count towards the total.
  const subtotals = groups
    .filter((group) => group.lines.some((line) => line.state === 'buyable'))
    .map((group) => group.subtotal);
  return ok({ groups, lineCount: viewed.value.lineCount, total: totalOf(subtotals) });
}

/**
 * `offerUnits`: the units of one Offer that the cart's add would accept now (design 6.1 steps
 * 2 to 5), each with its price and the highest quantity. Catalog lists the units; the same
 * verdict as an add decides each one. A failed store read is `cart.check-unavailable` when no
 * unit could be checked; nothing is guessed.
 */
export async function assistantOfferUnits(
  deps: CartDependencies,
  context: CallContext,
  rawOfferId: string,
): Promise<Result<AssistantOfferUnits, AssistantCartFailure>> {
  const offerId = parseId<'Offer'>(rawOfferId);
  if (!offerId.ok) return err({ code: 'validation.failed' });
  const listed = await deps.facts.offerSellUnits(context, offerId.value);
  if (listed === null) return err({ code: 'cart.check-unavailable' });
  if (listed === 'absent' || listed.variantIds.length === 0) {
    return err({ code: 'cart.offer-not-purchasable' });
  }
  const refs = listed.variantIds
    .slice(0, MAX_ASSISTANT_SELL_UNITS)
    .map((variantId) => ({ offerId: offerId.value, variantId }));
  const [verdicts, displays, names] = await Promise.all([
    deps.facts.evaluate(context, refs),
    deps.facts.lineDisplays(context, refs),
    deps.facts.sellerNames(context, [listed.sellerId]),
  ]);
  const limits = deps.policy.limits(context.market);
  const units: AssistantSellUnit[] = [];
  let unchecked = false;
  for (const ref of refs) {
    const verdict = verdicts.get(verdictKey(ref));
    if (verdict === undefined || verdict.state === 'check-unavailable') {
      unchecked = true;
      continue;
    }
    // Only a unit of the listed seller counts (a verdict names the seller it checked).
    if (verdict.state !== 'buyable' || verdict.unitPrice === null) continue;
    if (verdict.sellerId !== listed.sellerId) continue;
    units.push({
      variantId: ref.variantId,
      label: displays.get(verdictKey(ref))?.variantLabel ?? null,
      unitPrice: verdict.unitPrice,
      taxInclusive: verdict.taxInclusive,
      maxQuantity: maxQuantityOf(limits, verdict.availability),
    });
  }
  if (units.length === 0) {
    return err(
      unchecked ? { code: 'cart.check-unavailable' } : { code: 'cart.offer-not-purchasable' },
    );
  }
  const first = displays.get(verdictKey(refs[0]!));
  return ok({
    offerId: offerId.value,
    sellerId: listed.sellerId,
    sellerName: names.get(listed.sellerId) ?? null,
    productId: listed.productId,
    productName:
      first?.productName ??
      [...displays.values()].find((display) => display.productName !== null)?.productName ??
      null,
    units,
  });
}
