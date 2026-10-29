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
import type { CheckoutLine } from '../contracts';
import { Logger } from '@nestjs/common';
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
import {
  evaluateMinimumOrder,
  type BuyableLine,
  type MinimumOrderEvaluation,
  type MinimumOrderState,
} from '../domain/cart-evaluator';
import {
  GUEST_CREATE_ORIGIN,
  GUEST_WRITE_CART,
  GUEST_WRITE_ORIGIN,
  rateVerdict,
  type RateLimit,
  type RateReservation,
} from '../domain/rate-limits';
import type { CartPolicy } from './ports/cart-policy';
import type { CartRepository } from './ports/cart.repository';
import type { GuestTokens } from './ports/guest-tokens';
import type { RateCounterKeys } from './ports/rate-counter-keys';
import type { RateCounterRepository } from './ports/rate-counter.repository';
import {
  verdictKey,
  type LineDisplay,
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
  readonly counters: RateCounterRepository;
  readonly counterKeys: RateCounterKeys;
}

export type Fields = readonly { readonly path: string; readonly code: string }[];

export type CartFailure =
  | { readonly code: 'validation.failed'; readonly fields: Fields }
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'conflict.stale' }
  | { readonly code: 'cart.check-unavailable' }
  | { readonly code: 'cart.not-ready'; readonly sellers: readonly NotReadySeller[] }
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
  /** What the buyer sees of the unit (name, label, image); null when catalog did not answer it. */
  readonly display: LineDisplay | null;
}

/** The minimum-order state of a seller group (design 6.4) and the minimum when it is public. */
export interface MinimumOrderView {
  readonly state: MinimumOrderState;
  /** The seller's minimum for `met` and `below-minimum`; null otherwise. */
  readonly minimum: Money | null;
}

export interface SellerGroupView {
  /** Null for lines whose seller could not be determined. */
  readonly sellerId: Id<'Seller'> | null;
  /** The public store name ("Sold by"); null when unknown or not answered. */
  readonly sellerName: string | null;
  /** Sum of the buyable lines at the current price; null when there are none or prices mix. */
  readonly subtotal: Money | null;
  readonly minimumOrder: MinimumOrderView;
  readonly lines: readonly LineView[];
}

/** A seller that stops checkout (design 6.6): below its minimum, or its minimum cannot be checked. */
export interface NotReadySeller {
  readonly sellerId: Id<'Seller'>;
  readonly reason: 'below-minimum' | 'check-unavailable';
  /** The seller's minimum, public, for `below-minimum`; null for `check-unavailable`. */
  readonly minimum: Money | null;
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

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });
const rateLogger = new Logger('CartRateLimit');

/**
 * Guest line writes are throttled before any facade call or write (cart design 4, 6.1 step 1;
 * Hassan H-1). The counters are reserved in their own unit, so a refused attempt keeps its count,
 * and the creation count stays even when the add is then refused. A missing origin or a failing
 * counter store refuses with `access.unavailable` and nothing is written (fail closed).
 * `cartHash` is the SHA-256 of the guest token (hex); the raw token never reaches a counter.
 * Merge, viewing and account carts are not counted here.
 */
async function reserveGuestWrite(
  deps: CartDependencies,
  context: CallContext,
  origin: string | null,
  cartHash: string | null,
  creating: boolean,
): Promise<CartFailure | null> {
  const { market } = context;
  if (origin === null) {
    rateLogger.warn({
      msg: 'cart.guest-write.origin-unavailable',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return UNAVAILABLE;
  }
  const wanted: { limit: RateLimit; subject: string }[] = [];
  if (creating) wanted.push({ limit: GUEST_CREATE_ORIGIN, subject: origin });
  if (cartHash !== null) wanted.push({ limit: GUEST_WRITE_CART, subject: cartHash });
  wanted.push({ limit: GUEST_WRITE_ORIGIN, subject: origin });
  try {
    const now = deps.clock.now();
    const keyed = wanted.map(({ limit, subject }) => ({
      limit,
      keyHash: deps.counterKeys.keyOf(market, limit.kind, subject),
    }));
    const reserved = await deps.unitOfWork.run<readonly RateReservation[], CartFailure>(
      market,
      async () => ok(await deps.counters.reserve(market, keyed, now)),
    );
    if (!reserved.ok) throw new Error('counter unit refused');
    const verdict = rateVerdict(
      wanted.map(({ limit }) => limit),
      reserved.value,
      now,
    );
    if (verdict.allowed) return null;
    rateLogger.warn({
      msg: 'cart.guest-write.throttled',
      metric: 'request.throttled',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return { code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds };
  } catch {
    rateLogger.error({
      msg: 'cart.guest-write.rate-counters-unavailable',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return UNAVAILABLE;
  }
}

/** The token hash of a guest caller, or null for an account or a missing or malformed token. */
const hashOfCaller = (deps: CartDependencies, caller: CartCaller): string | null =>
  caller.kind === 'guest' && caller.token !== null ? deps.tokens.hashOf(caller.token) : null;

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

function lineView(
  line: CartLine,
  verdict: LineVerdict | undefined,
  display: LineDisplay | undefined,
): LineView {
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
    display: display ?? null,
  };
}

interface Group {
  readonly sellerId: Id<'Seller'> | null;
  readonly lines: LineView[];
  readonly buyable: BuyableLine[];
  sum: bigint;
  currency: string | null;
  mixed: boolean;
}

/** Groups lines by seller and sums the buyable ones (design 6.2). */
function groupLines(
  cart: CartState,
  verdicts: ReadonlyMap<string, LineVerdict>,
  displays: ReadonlyMap<string, LineDisplay>,
): Group[] {
  const groups = new Map<string | null, Group>();
  for (const line of cart.lines) {
    const verdict = verdicts.get(verdictKey(line));
    const view = lineView(line, verdict, displays.get(verdictKey(line)));
    const key = verdict?.sellerId ?? null;
    const group: Group = groups.get(key) ?? {
      sellerId: key,
      lines: [],
      buyable: [],
      sum: 0n,
      currency: null,
      mixed: false,
    };
    group.lines.push(view);
    if (view.state === 'buyable' && view.unitPrice !== null) {
      if (group.currency !== null && group.currency !== view.unitPrice.currency) group.mixed = true;
      group.currency = view.unitPrice.currency;
      group.sum += view.unitPrice.amount * BigInt(line.quantity);
      group.buyable.push({
        unitPrice: view.unitPrice,
        quantity: line.quantity,
        taxInclusive: verdict?.taxInclusive ?? null,
      });
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * `CartEvaluator` over the groups (design 6.4): one `sellers.sellerSummaries` read for the
 * distinct sellers of groups that have a buyable line, then the pure rule per group. A group
 * without a seller id cannot have a buyable line. Called before any unit opens.
 */
async function evaluateGroups(
  deps: CartDependencies,
  context: CallContext,
  groups: readonly Group[],
): Promise<readonly MinimumOrderEvaluation[]> {
  const sellerIds = groups.flatMap((group) =>
    group.buyable.length > 0 && group.sellerId !== null ? [group.sellerId] : [],
  );
  const minimums =
    sellerIds.length === 0
      ? new Map<Id<'Seller'>, never>()
      : await deps.facts.sellerMinimums(context, sellerIds);
  return groups.map((group) =>
    evaluateMinimumOrder(
      group.buyable,
      group.sellerId === null ? undefined : minimums.get(group.sellerId),
    ),
  );
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
  const [verdicts, displays] = await Promise.all([
    deps.facts.evaluate(context, cart.lines),
    deps.facts.lineDisplays(context, cart.lines),
  ]);
  const groups = groupLines(cart, verdicts, displays);
  const sellerIds = groups.flatMap((group) => (group.sellerId === null ? [] : [group.sellerId]));
  const [evaluations, names] = await Promise.all([
    evaluateGroups(deps, context, groups),
    sellerIds.length === 0
      ? new Map<Id<'Seller'>, string>()
      : deps.facts.sellerNames(context, sellerIds),
  ]);
  return ok({
    groups: groups.map((group, index) => ({
      sellerId: group.sellerId,
      sellerName: group.sellerId === null ? null : (names.get(group.sellerId) ?? null),
      subtotal: group.currency === null || group.mixed ? null : money(group.sum, group.currency),
      minimumOrder: {
        state: evaluations[index]!.state,
        minimum: evaluations[index]!.minimum,
      },
      lines: group.lines,
    })),
    lineCount: cart.lines.length,
    cookie,
  });
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
  origin?: string | null,
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

  // A guest write is counted first, before any facade call or write (design 6.1 step 1). Whether
  // a usable guest cart exists decides if this add also counts as a creation.
  if (caller.kind === 'guest') {
    const found = await deps.unitOfWork.run<Loaded, CartFailure>(
      context.market,
      async () => ok(await load(deps, context.market, caller)),
      { readOnly: true },
    );
    if (!found.ok) return found;
    const hasCart = found.value.cart !== null;
    const refused = await reserveGuestWrite(
      deps,
      context,
      origin ?? null,
      hasCart ? hashOfCaller(deps, caller) : null,
      !hasCart,
    );
    if (refused !== null) return err(refused);
  }

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
  origin?: string | null,
): Promise<Result<LineWritten, CartFailure>> {
  const fields: { path: string; code: string }[] = [];
  const lineId = parseId<'CartLine'>(input?.lineId);
  if (!lineId.ok) fields.push({ path: 'lineId', code: 'format' });
  const quantity = asQuantity(input?.quantity);
  if (quantity === null) fields.push({ path: 'quantity', code: 'format' });
  if (!lineId.ok || quantity === null) return err({ code: 'validation.failed', fields });
  if (caller.kind === 'guest') {
    const refused = await reserveGuestWrite(
      deps,
      context,
      origin ?? null,
      hashOfCaller(deps, caller),
      false,
    );
    if (refused !== null) return err(refused);
  }

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
  // A line that cannot be bought now can be lowered, never raised (design 6.1).
  if (quantity > line.quantity && verdict?.state !== 'buyable') {
    return err(
      verdict === undefined || verdict.state === 'check-unavailable'
        ? { code: 'cart.check-unavailable' }
        : { code: 'cart.offer-not-purchasable', reason: verdict.reason ?? 'no-valid-price' },
    );
  }

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
  origin?: string | null,
): Promise<Result<{ readonly cookie: GuestCookie | null }, CartFailure>> {
  const lineId = parseId<'CartLine'>(input?.lineId);
  if (!lineId.ok) {
    return err({ code: 'validation.failed', fields: [{ path: 'lineId', code: 'format' }] });
  }
  if (caller.kind === 'guest') {
    const refused = await reserveGuestWrite(
      deps,
      context,
      origin ?? null,
      hashOfCaller(deps, caller),
      false,
    );
    if (refused !== null) return err(refused);
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
    // The guest cart first: it drops its lines, which the account cart then takes over under the
    // same ids (a line id is a primary key).
    if ((await deps.carts.save(context.market, result.guest)) === 'stale') {
      return err({ code: 'conflict.stale' });
    }
    if ((await deps.carts.save(context.market, result.account)) === 'stale') {
      return err({ code: 'conflict.stale' });
    }
    return ok({ merged: true, clamped: result.clamped, notAdded: result.notAdded, cookie });
  });
}

/**
 * `checkout-lines`: the signed-in customer's lines with the current verdict of each, for
 * `ordering`. Fails closed: a failed facade makes a line `check-unavailable`. Ready only when no
 * seller with a buyable line is below its minimum order or has a minimum that cannot be checked
 * (design 6.4, 6.6): otherwise `cart.not-ready` with the sellers, each with its public minimum.
 */
export async function checkoutLines(
  deps: CartDependencies,
  context: CallContext,
  caller: Extract<CartCaller, { kind: 'account' }>,
): Promise<Result<readonly CheckoutLine[], CartFailure>> {
  const loaded = await deps.unitOfWork.run<Loaded, CartFailure>(
    context.market,
    async () => ok(await load(deps, context.market, caller)),
    { readOnly: true },
  );
  if (!loaded.ok) return loaded;
  const cart = loaded.value.cart;
  if (cart === null || cart.lines.length === 0) return ok([]);
  const verdicts = await deps.facts.evaluate(context, cart.lines);
  // Checkout needs no display data.
  const groups = groupLines(cart, verdicts, new Map());
  const evaluations = await evaluateGroups(deps, context, groups);
  const sellers = groups.flatMap((group, index): NotReadySeller[] => {
    const evaluation = evaluations[index]!;
    if (group.sellerId === null) return [];
    if (evaluation.state === 'below-minimum') {
      return [{ sellerId: group.sellerId, reason: 'below-minimum', minimum: evaluation.minimum }];
    }
    return evaluation.state === 'check-unavailable'
      ? [{ sellerId: group.sellerId, reason: 'check-unavailable', minimum: null }]
      : [];
  });
  if (sellers.length > 0) return err({ code: 'cart.not-ready', sellers });
  return ok(
    cart.lines.map((line) => {
      const verdict = verdicts.get(verdictKey(line));
      return {
        offerId: line.offerId,
        variantId: line.variantId,
        quantity: line.quantity,
        state: verdict?.state ?? 'check-unavailable',
        sellerId: verdict?.sellerId ?? null,
        unitPrice: verdict?.unitPrice ?? null,
        taxInclusive: verdict?.taxInclusive ?? null,
      };
    }),
  );
}

/** `clear-ordered`: drops the ordered sell units from the account's active cart (system). */
export async function clearOrdered(
  deps: CartDependencies,
  context: CallContext,
  request: {
    readonly accountId: Id<'Account'>;
    readonly units: readonly { readonly offerId: Id<'Offer'>; readonly variantId: Id<'Variant'> }[];
  },
): Promise<Result<{ readonly removed: number }, CartFailure>> {
  const caller: CartCaller = { kind: 'account', accountId: request.accountId };
  const wanted = new Set(request.units.map((unit) => verdictKey(unit)));
  return deps.unitOfWork.run<{ removed: number }, CartFailure>(context.market, async () => {
    const loaded = await load(deps, context.market, caller);
    const cart = loaded.cart;
    if (cart === null) return ok({ removed: 0 });
    const kept = cart.lines.filter((line) => !wanted.has(verdictKey(line)));
    const removed = cart.lines.length - kept.length;
    if (removed === 0) return ok({ removed });
    const now = deps.clock.now();
    const saved = await deps.carts.save(context.market, {
      ...cart,
      lines: kept,
      lastChangedAt: now,
    });
    if (saved === 'stale') return err({ code: 'conflict.stale' } as const);
    // Personalization 1c: the lines left after an order get no cart reminder until the buyer
    // changes the cart again.
    await deps.carts.markOrdered(context.market, cart.id, now);
    return ok({ removed });
  });
}
