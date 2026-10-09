import type { Id, MarketId, Money, Temporal } from '@mondapac/shared-kernel';

// The pure rules of a cart (cart design 2.1, 6.1, 6.5, simplified for speed mode). No clock, no
// storage, no facade: the use case passes the instant, the ids and the facts it read.

export type CartOwner =
  | { readonly kind: 'account'; readonly accountId: Id<'Account'> }
  /** SHA-256 of the guest token, lowercase hex. The raw token is never part of the state. */
  | { readonly kind: 'guest'; readonly tokenHash: string };

export interface CartLine {
  readonly id: Id<'CartLine'>;
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
  /** Only to detect a price change (design 6.3); never a price source. */
  readonly priceAtAdd: Money;
  readonly addedAt: Temporal.Instant;
}

export interface CartState {
  readonly id: Id<'Cart'>;
  readonly marketId: MarketId;
  readonly owner: CartOwner;
  readonly status: 'active' | 'merged';
  readonly lastChangedAt: Temporal.Instant;
  readonly mergedIntoCartId: Id<'Cart'> | null;
  readonly mergedAt: Temporal.Instant | null;
  /** The version read; the repository writes `version + 1` on a save. */
  readonly version: number;
  readonly createdAt: Temporal.Instant;
  readonly lines: readonly CartLine[];
}

export interface CartLimits {
  /** `MarketConfig.maxLineQuantity` (AU 99). */
  readonly maxLineQuantity: number;
  /** The most lines one cart holds (AU 50). */
  readonly maxLines: number;
}

/** What the stock read says about a line: only `low` limits a quantity (design 6.1 step 5). */
export interface LineAvailability {
  readonly status: 'in-stock' | 'low' | 'out';
  readonly onlyLeft: number | null;
}

export type Clamp = 'market-ceiling' | 'only-left';

export interface Limited {
  readonly quantity: number;
  readonly clamped: Clamp | null;
}

/** `min(ceiling, onlyLeft)` when the status is `low`, else the ceiling (`LineCeilingPolicy`). */
export function limitQuantity(
  target: number,
  limits: CartLimits,
  availability: LineAvailability | null,
): Limited {
  const onlyLeft =
    availability?.status === 'low' && availability.onlyLeft !== null
      ? availability.onlyLeft
      : Number.POSITIVE_INFINITY;
  const ceiling = Math.min(limits.maxLineQuantity, onlyLeft);
  if (target <= ceiling) return { quantity: target, clamped: null };
  return {
    quantity: ceiling,
    clamped: onlyLeft < limits.maxLineQuantity ? 'only-left' : 'market-ceiling',
  };
}

/** A guest cart expires `ttlMs` after its last change, decided at read time (design 3.1). */
export function isExpired(cart: CartState, now: Temporal.Instant, ttlMs: number): boolean {
  return (
    cart.owner.kind === 'guest' &&
    now.epochMilliseconds - cart.lastChangedAt.epochMilliseconds >= ttlMs
  );
}

export type AddOutcome =
  | {
      readonly ok: true;
      readonly cart: CartState;
      readonly changed: boolean;
      readonly clamped: Clamp | null;
    }
  | { readonly ok: false; readonly code: 'cart.too-many-lines' };

export interface AddLineInput {
  readonly offerId: Id<'Offer'>;
  readonly variantId: Id<'Variant'>;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly availability: LineAvailability | null;
  readonly newLineId: Id<'CartLine'>;
}

/**
 * Add: target = existing + requested, limited by the ceiling and by `onlyLeft`; a target not
 * above the existing quantity leaves the line as it is. A new line over the line limit is
 * refused. A write sets `priceAtAdd` to the current price and `lastChangedAt` (design 6.1, 6.3).
 */
export function addLine(
  cart: CartState,
  input: AddLineInput,
  limits: CartLimits,
  now: Temporal.Instant,
): AddOutcome {
  const existing = cart.lines.find(
    (line) => line.offerId === input.offerId && line.variantId === input.variantId,
  );
  const have = existing?.quantity ?? 0;
  const limited = limitQuantity(have + input.quantity, limits, input.availability);
  if (limited.quantity <= have) return { ok: true, cart, changed: false, clamped: limited.clamped };
  if (existing === undefined && cart.lines.length >= limits.maxLines) {
    return { ok: false, code: 'cart.too-many-lines' };
  }
  const line: CartLine = {
    id: existing?.id ?? input.newLineId,
    offerId: input.offerId,
    variantId: input.variantId,
    quantity: limited.quantity,
    priceAtAdd: input.unitPrice,
    addedAt: existing?.addedAt ?? now,
  };
  const lines =
    existing === undefined
      ? [...cart.lines, line]
      : cart.lines.map((l) => (l.id === existing.id ? line : l));
  return {
    ok: true,
    cart: { ...cart, lines, lastChangedAt: now },
    changed: true,
    clamped: limited.clamped,
  };
}

export type SetQuantityOutcome =
  | {
      readonly ok: true;
      readonly cart: CartState;
      readonly changed: boolean;
      readonly clamped: Clamp | null;
    }
  | { readonly ok: false; readonly code: 'cart.line-not-found' };

/**
 * Change: an absolute quantity, limited as in add. `unitPrice` is the current price when the
 * line is priced, else null (the old `priceAtAdd` stays). A change that alters the quantity
 * resets `priceAtAdd` (design 6.3).
 */
export function setQuantity(
  cart: CartState,
  lineId: string,
  quantity: number,
  unitPrice: Money | null,
  availability: LineAvailability | null,
  limits: CartLimits,
  now: Temporal.Instant,
): SetQuantityOutcome {
  const line = cart.lines.find((l) => l.id === lineId);
  if (line === undefined) return { ok: false, code: 'cart.line-not-found' };
  const limited = limitQuantity(quantity, limits, availability);
  if (limited.quantity === line.quantity) {
    return { ok: true, cart, changed: false, clamped: limited.clamped };
  }
  const next: CartLine = {
    ...line,
    quantity: limited.quantity,
    priceAtAdd: unitPrice ?? line.priceAtAdd,
  };
  return {
    ok: true,
    cart: {
      ...cart,
      lines: cart.lines.map((l) => (l.id === line.id ? next : l)),
      lastChangedAt: now,
    },
    changed: true,
    clamped: limited.clamped,
  };
}

/** Remove a line. An unknown id is `cart.line-not-found`. */
export function removeLine(
  cart: CartState,
  lineId: string,
  now: Temporal.Instant,
):
  | { readonly ok: true; readonly cart: CartState }
  | { readonly ok: false; readonly code: 'cart.line-not-found' } {
  if (!cart.lines.some((l) => l.id === lineId)) return { ok: false, code: 'cart.line-not-found' };
  return {
    ok: true,
    cart: { ...cart, lines: cart.lines.filter((l) => l.id !== lineId), lastChangedAt: now },
  };
}

export interface MergeResult {
  /** The account cart after the merge. */
  readonly account: CartState;
  /** The guest cart, `merged` and without lines. */
  readonly guest: CartState;
  /** Lines whose merged quantity was limited. */
  readonly clamped: readonly {
    readonly offerId: Id<'Offer'>;
    readonly variantId: Id<'Variant'>;
    readonly clamped: Clamp;
  }[];
  /** Guest lines left out because the account cart is at its line limit. */
  readonly notAdded: readonly {
    readonly offerId: Id<'Offer'>;
    readonly variantId: Id<'Variant'>;
  }[];
}

/**
 * Merge a guest cart into an account cart (design 6.5): a shared sell unit takes the summed
 * quantity (limited) and the `priceAtAdd` and `addedAt` of the earlier line; other guest lines
 * are added oldest first until the line limit. `availabilityOf` answers per `offerId/variantId`.
 */
export function mergeCarts(
  account: CartState,
  guest: CartState,
  limits: CartLimits,
  availabilityOf: (offerId: Id<'Offer'>, variantId: Id<'Variant'>) => LineAvailability | null,
  now: Temporal.Instant,
): MergeResult {
  const lines = [...account.lines];
  const clamped: MergeResult['clamped'][number][] = [];
  const notAdded: MergeResult['notAdded'][number][] = [];
  const oldestFirst = [...guest.lines].sort(
    (a, b) => a.addedAt.epochMilliseconds - b.addedAt.epochMilliseconds,
  );
  for (const incoming of oldestFirst) {
    const at = lines.findIndex(
      (l) => l.offerId === incoming.offerId && l.variantId === incoming.variantId,
    );
    if (at >= 0) {
      const mine = lines[at]!;
      const limited = limitQuantity(
        mine.quantity + incoming.quantity,
        limits,
        availabilityOf(incoming.offerId, incoming.variantId),
      );
      const older =
        incoming.addedAt.epochMilliseconds < mine.addedAt.epochMilliseconds ? incoming : mine;
      lines[at] = {
        ...mine,
        quantity: limited.quantity,
        priceAtAdd: older.priceAtAdd,
        addedAt: older.addedAt,
      };
      if (limited.clamped !== null) {
        clamped.push({
          offerId: incoming.offerId,
          variantId: incoming.variantId,
          clamped: limited.clamped,
        });
      }
    } else if (lines.length >= limits.maxLines) {
      notAdded.push({ offerId: incoming.offerId, variantId: incoming.variantId });
    } else {
      lines.push(incoming);
    }
  }
  return {
    account: { ...account, lines, lastChangedAt: now },
    guest: {
      ...guest,
      status: 'merged',
      lines: [],
      mergedIntoCartId: account.id,
      mergedAt: now,
    },
    clamped,
    notAdded,
  };
}

/** The guest cart becomes the account's: the owner changes, the lines stay (design 6.5). */
export function transferToAccount(
  guest: CartState,
  accountId: Id<'Account'>,
  now: Temporal.Instant,
): CartState {
  return { ...guest, owner: { kind: 'account', accountId }, lastChangedAt: now };
}
