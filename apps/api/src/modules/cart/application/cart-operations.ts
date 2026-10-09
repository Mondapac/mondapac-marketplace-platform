import { err, money, ok, parseId } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  MarketContext,
  Money,
  Result,
} from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  addLine,
  isExpired,
  mergeCarts,
  removeLine,
  setQuantity,
  transferToAccount,
  type CartLine,
  type CartState,
  type Clamp,
  type LineAvailability,
} from '../domain/cart';
import type { CartPolicy } from './ports/cart-policy';
import type { CartRepository } from './ports/cart.repository';
import type { GuestTokens } from './ports/guest-tokens';
import {
  verdictKey,
  type LineFactsSource,
  type LineVerdict,
  type UnavailableReason,
} from './ports/line-facts';

// The operations behind the cart use cases (cart design 6.1 to 6.5, simplified for speed mode).
// The account use cases and the guest use cases (one rule each: `own-resources` and `anonymous`)
// call the same functions with a different `CartCaller`.

export type CartCaller =
  | { readonly kind: 'account'; readonly accountId: Id<'Account'> }
  /** `token` is the raw cookie value, or null when the request carried none. */
  | { readonly kind: 'guest'; readonly token: string | null };

/** What the controller does with the guest cookie after the call. */
export type GuestCookie =
  { readonly action: 'set'; readonly token: string } | { readonly action: 'clear' };

export interface CartDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly carts: CartRepository;
  readonly tokens: GuestTokens;
  readonly policy: CartPolicy;
  readonly facts: LineFactsSource;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

export type Fields = readonly { readonly path: string; readonly code: string }[];

export type CartFailure =
  | { readonly code: 'validation.failed'; readonly fields: Fields }
  | { readonly code: 'access.denied' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'cart.check-unavailable' }
  | { readonly code: 'cart.too-many-lines' }
  | { readonly code: 'cart.line-not-found' }
  | { readonly code: 'cart.offer-not-purchasable'; readonly reason: UnavailableReason };

export interface LineView {
  readonly lineId: Id<'CartLine'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
  readonly state: LineVerdict['state'];
  readonly reason: UnavailableReason | null;
  readonly unitPrice: Money | null;
  /** The price at add, when the current price differs (design 6.3). */
  readonly priceChanged: { readonly previous: Money } | null;
  readonly availability: LineAvailability | null;
}

export interface SellerGroupView {
  /** Null for lines whose seller could not be determined. */
  readonly sellerId: Id<'Seller'> | null;
  /** Sum of the buyable lines at the current price; null when there are none or prices mix. */
  readonly subtotal: Money | null;
  readonly lines: readonly LineView[];
}

export interface CartView {
  readonly groups: readonly SellerGroupView[];
  readonly lineCount: number;
  readonly cookie: GuestCookie | null;
}

export interface LineWritten {
  readonly lineId: Id<'CartLine'> | null;
  readonly quantity: number;
  /** False when the request changed nothing (for example the line is already at its limit). */
  readonly changed: boolean;
  readonly clamped: Clamp | null;
  readonly cookie: GuestCookie | null;
}

export interface MergeOutput {
  readonly merged: boolean;
  readonly clamped: readonly { offerId: Id<'Offer'>; variantId: Id<'Variant'>; clamped: Clamp }[];
  readonly notAdded: readonly { offerId: Id<'Offer'>; variantId: Id<'Variant'> }[];
  readonly cookie: GuestCookie;
}

/** A quantity in a request: a whole number of 1 to 9 digits. */
const QUANTITY = /^[1-9][0-9]{0,8}$/;
const asQuantity = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && QUANTITY.test(String(value))
    ? value
    : null;

interface Loaded {
  readonly cart: CartState | null;
  /** The guest cookie named no usable cart: expired, merged, unknown or malformed. */
  readonly staleCookie: boolean;
}

/** Finds the caller's cart. Runs inside a unit. */
async function load(
  deps: CartDependencies,
  market: MarketContext,
  caller: CartCaller,
): Promise<Loaded> {
  if (caller.kind === 'account') {
    return {
      cart: await deps.carts.findActiveByAccount(market, caller.accountId),
      staleCookie: false,
    };
  }
  if (caller.token === null) return { cart: null, staleCookie: false };
  const hash = deps.tokens.hashOf(caller.token);
  const found = hash === null ? null : await deps.carts.findByGuestHash(market, hash);
  const usable =
    found !== null &&
    found.status === 'active' &&
    !isExpired(found, deps.clock.now(), deps.policy.guestTtlMs());
  return { cart: usable ? found : null, staleCookie: !usable };
}

const cookieAfterRead = (caller: CartCaller, loaded: Loaded): GuestCookie | null =>
  caller.kind === 'guest' && loaded.staleCookie ? { action: 'clear' } : null;

/** The cookie after a guest write: the same token again renews its `Max-Age`. */
const cookieAfterWrite = (caller: CartCaller, token: string | null): GuestCookie | null =>
  caller.kind === 'guest' && token !== null ? { action: 'set', token } : null;

function lineView(line: CartLine, verdict: LineVerdict | undefined): LineView {
  const v: LineVerdict = verdict ?? {
    state: 'check-unavailable',
    reason: null,
    sellerId: null,
    unitPrice: null,
    taxInclusive: null,
    availability: null,
  };
  const changed =
    v.unitPrice !== null &&
    (v.unitPrice.amount !== line.priceAtAdd.amount ||
      v.unitPrice.currency !== line.priceAtAdd.currency);
  return {
    lineId: line.id,
    offerId: line.offerId,
    variantId: line.variantId,
    quantity: line.quantity,
    state: v.state,
    reason: v.reason,
    unitPrice: v.unitPrice,
    priceChanged: changed ? { previous: line.priceAtAdd } : null,
    availability: v.availability,
  };
}

/** Groups lines by seller and sums the buyable ones (design 6.2; the minimum order is later). */
function compose(cart: CartState, verdicts: ReadonlyMap<string, LineVerdict>): SellerGroupView[] {
  const groups = new Map<
    string | null,
    { lines: LineView[]; sum: bigint; currency: string | null; mixed: boolean }
  >();
  for (const line of cart.lines) {
    const verdict = verdicts.get(verdictKey(line));
    const view = lineView(line, verdict);
    const key = verdict?.sellerId ?? null;
    const group = groups.get(key) ?? { lines: [], sum: 0n, currency: null, mixed: false };
    group.lines.push(view);
    if (view.state === 'buyable' && view.unitPrice !== null) {
      if (group.currency !== null && group.currency !== view.unitPrice.currency) group.mixed = true;
      group.currency = view.unitPrice.currency;
      group.sum += view.unitPrice.amount * BigInt(line.quantity);
    }
    groups.set(key, group);
  }
  return [...groups].map(([sellerId, group]) => ({
    sellerId: sellerId as Id<'Seller'> | null,
    subtotal: group.currency === null || group.mixed ? null : money(group.sum, group.currency),
    lines: group.lines,
  }));
}

/** `view`: the cart composed with the other modules' answers; a failed facade marks lines. */
export async function viewCart(
  deps: CartDependencies,
  context: CallContext,
  caller: CartCaller,
): Promise<Result<CartView, CartFailure>> {
  const loaded = await deps.unitOfWork.run<Loaded, CartFailure>(
    context.market,
    async () => ok(await load(deps, context.market, caller)),
    { readOnly: true },
  );
  if (!loaded.ok) return loaded;
  const cart = loaded.value.cart;
  const cookie = cookieAfterRead(caller, loaded.value);
  if (cart === null || cart.lines.length === 0) {
    return ok({ groups: [], lineCount: 0, cookie });
  }
  const verdicts = await deps.facts.evaluate(context, cart.lines);
  return ok({ groups: compose(cart, verdicts), lineCount: cart.lines.length, cookie });
}

export interface AddInput {
  readonly offerId: string;
  readonly variantId: string;
  readonly quantity: number;
}

/** `add` (design 6.1): refused when the line would be unbuyable; the quantity is limited. */
export async function addItem(
  deps: CartDependencies,
  context: CallContext,
  caller: CartCaller,
  input: AddInput,
): Promise<Result<LineWritten, CartFailure>> {
  const fields: { path: string; code: string }[] = [];
  const offerId = parseId<'Offer'>(input?.offerId);
  if (!offerId.ok) fields.push({ path: 'offerId', code: 'format' });
  const variantId = parseId<'Variant'>(input?.variantId);
  if (!variantId.ok) fields.push({ path: 'variantId', code: 'format' });
  const quantity = asQuantity(input?.quantity);
  if (quantity === null) fields.push({ path: 'quantity', code: 'format' });
  if (!offerId.ok || !variantId.ok || quantity === null) {
    return err({ code: 'validation.failed', fields });
  }
  const ref = { offerId: offerId.value, variantId: variantId.value };

  const verdict = (await deps.facts.evaluate(context, [ref])).get(verdictKey(ref));
  if (verdict === undefined || verdict.state === 'check-unavailable') {
    return err({ code: 'cart.check-unavailable' });
  }
  if (verdict.state === 'unavailable' || verdict.unitPrice === null) {
    return err({
      code: 'cart.offer-not-purchasable',
      reason: verdict.reason ?? 'no-valid-price',
    });
  }
  const unitPrice = verdict.unitPrice;
  const availability = verdict.availability;
  const limits = deps.policy.limits(context.market);
  const issued = caller.kind === 'guest' && caller.token === null ? deps.tokens.issue() : null;
  const newLineId = deps.ids.next<'CartLine'>();
  const newCartId = deps.ids.next<'Cart'>();

  return deps.unitOfWork.run<LineWritten, CartFailure>(context.market, async () => {
    const now = deps.clock.now();
    const loaded = await load(deps, context.market, caller);
    // A guest whose cookie named no usable cart starts a new one with a new token.
    const fresh = loaded.cart === null;
    const guestToken =
      caller.kind === 'guest'
        ? fresh
          ? (issued ?? deps.tokens.issue())
          : { token: caller.token!, hash: '' }
        : null;
    const base: CartState =
      loaded.cart ??
      ({
        id: newCartId,
        marketId: context.market.marketId,
        owner:
          caller.kind === 'account'
            ? { kind: 'account', accountId: caller.accountId }
            : { kind: 'guest', tokenHash: guestToken!.hash },
        status: 'active',
        lastChangedAt: now,
        mergedIntoCartId: null,
        mergedAt: null,
        version: 1,
        createdAt: now,
        lines: [],
      } satisfies CartState);
    const result = addLine(
      base,
      { ...ref, quantity, unitPrice, availability, newLineId },
      limits,
      now,
    );
    if (!result.ok) return err({ code: result.code });
    const line = result.cart.lines.find(
      (l) => l.offerId === ref.offerId && l.variantId === ref.variantId,
    );
    const cookie = cookieAfterWrite(caller, guestToken?.token ?? null);
    if (!result.changed) {
      return ok({
        lineId: line?.id ?? null,
        quantity: line?.quantity ?? 0,
        changed: false,
        clamped: result.clamped,
        cookie,
      });
    }
    const saved = fresh
      ? (await deps.carts.insert(context.market, result.cart)) === 'inserted'
        ? 'saved'
        : 'stale'
      : await deps.carts.save(context.market, result.cart);
    if (saved === 'stale') return err({ code: 'conflict.stale' });
    return ok({
      lineId: line!.id,
      quantity: line!.quantity,
      changed: true,
      clamped: result.clamped,
      cookie,
    });
  });
}

export interface SetQuantityInput {
  readonly lineId: string;
  readonly quantity: number;
}

/** `set-quantity` (design 6.1): an absolute value; an unbuyable line can still be lowered. */
export async function setLineQuantity(
  deps: CartDependencies,
  context: CallContext,
  caller: CartCaller,
  input: SetQuantityInput,
): Promise<Result<LineWritten, CartFailure>> {
  const fields: { path: string; code: string }[] = [];
  const lineId = parseId<'CartLine'>(input?.lineId);
  if (!lineId.ok) fields.push({ path: 'lineId', code: 'format' });
  const quantity = asQuantity(input?.quantity);
  if (quantity === null) fields.push({ path: 'quantity', code: 'format' });
  if (!lineId.ok || quantity === null) return err({ code: 'validation.failed', fields });

  const read = await deps.unitOfWork.run<Loaded, CartFailure>(
    context.market,
    async () => ok(await load(deps, context.market, caller)),
    { readOnly: true },
  );
  if (!read.ok) return read;
  const line = read.value.cart?.lines.find((l) => l.id === lineId.value);
  if (line === undefined) return err({ code: 'cart.line-not-found' });
  const verdict = (await deps.facts.evaluate(context, [line])).get(verdictKey(line));
  const limits = deps.policy.limits(context.market);

  return deps.unitOfWork.run<LineWritten, CartFailure>(context.market, async () => {
    const now = deps.clock.now();
    const loaded = await load(deps, context.market, caller);
    if (loaded.cart === null) return err({ code: 'cart.line-not-found' });
    const result = setQuantity(
      loaded.cart,
      lineId.value,
      quantity,
      verdict?.unitPrice ?? null,
      verdict?.availability ?? null,
      limits,
      now,
    );
    if (!result.ok) return err({ code: result.code });
    const cookie = cookieAfterWrite(caller, caller.kind === 'guest' ? caller.token : null);
    const written = result.cart.lines.find((l) => l.id === lineId.value)!;
    if (result.changed) {
      const saved = await deps.carts.save(context.market, result.cart);
      if (saved === 'stale') return err({ code: 'conflict.stale' });
    }
    return ok({
      lineId: written.id,
      quantity: written.quantity,
      changed: result.changed,
      clamped: result.clamped,
      cookie,
    });
  });
}

/** `remove` (design 6.1): no facade read. */
export async function removeItem(
  deps: CartDependencies,
  context: CallContext,
  caller: CartCaller,
  input: { readonly lineId: string },
): Promise<Result<{ readonly cookie: GuestCookie | null }, CartFailure>> {
  const lineId = parseId<'CartLine'>(input?.lineId);
  if (!lineId.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'lineId', code: 'format' }] });
  }
  return deps.unitOfWork.run<{ cookie: GuestCookie | null }, CartFailure>(
    context.market,
    async () => {
      const loaded = await load(deps, context.market, caller);
      if (loaded.cart === null) return err({ code: 'cart.line-not-found' } as const);
      const result = removeLine(loaded.cart, lineId.value, deps.clock.now());
      if (!result.ok) return err({ code: result.code } as const);
      const saved = await deps.carts.save(context.market, result.cart);
      if (saved === 'stale') return err({ code: 'conflict.stale' } as const);
      return ok({
        cookie: cookieAfterWrite(caller, caller.kind === 'guest' ? caller.token : null),
      });
    },
  );
}

/**
 * `merge-guest-cart` (design 6.5): in the signed-in request, from that request's cookie only.
 * Always clears the guest cookie. None, expired or already merged is a successful no-op.
 */
export async function mergeGuestCart(
  deps: CartDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  guestToken: string | null,
): Promise<Result<MergeOutput, CartFailure>> {
  const cookie = { action: 'clear' } as const;
  const nothing: MergeOutput = { merged: false, clamped: [], notAdded: [], cookie };
  const guest: CartCaller = { kind: 'guest', token: guestToken };
  const read = await deps.unitOfWork.run<Loaded, CartFailure>(
    context.market,
    async () => ok(await load(deps, context.market, guest)),
    { readOnly: true },
  );
  if (!read.ok) return read;
  if (read.value.cart === null) return ok(nothing);
  const verdicts = await deps.facts.evaluate(context, read.value.cart.lines);
  const availability = (offerId: Id<'Offer'>, variantId: Id<'Variant'>) =>
    verdicts.get(verdictKey({ offerId, variantId }))?.availability ?? null;
  const limits = deps.policy.limits(context.market);

  return deps.unitOfWork.run<MergeOutput, CartFailure>(context.market, async () => {
    const now = deps.clock.now();
    const guestLoaded = await load(deps, context.market, guest);
    if (guestLoaded.cart === null) return ok(nothing);
    const accountLoaded = await load(deps, context.market, { kind: 'account', accountId });
    if (accountLoaded.cart === null) {
      const moved = transferToAccount(guestLoaded.cart, accountId, now);
      const saved = await deps.carts.save(context.market, moved);
      if (saved === 'stale') return err({ code: 'conflict.stale' });
      return ok({ ...nothing, merged: true });
    }
    const result = mergeCarts(accountLoaded.cart, guestLoaded.cart, limits, availability, now);
    if ((await deps.carts.save(context.market, result.account)) === 'stale') {
      return err({ code: 'conflict.stale' });
    }
    if ((await deps.carts.save(context.market, result.guest)) === 'stale') {
      return err({ code: 'conflict.stale' });
    }
    return ok({ merged: true, clamped: result.clamped, notAdded: result.notAdded, cookie });
  });
}
