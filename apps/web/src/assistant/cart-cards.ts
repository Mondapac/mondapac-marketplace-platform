// The cart cards of the buyer assistant (stage 1): a proposed cart change, the buyer's own cart and
// a planned shopping list. The server builds them from the cart's and the planner's own reads; the
// widget only checks and shows them, and changes the cart through the cart routes after a click
// (ADR-0019 R4). Every field is checked: a bad field drops the field or the card, never guesses.

import { id, isRecord, optionalMoney, text, whole, type CardMoney } from './card-values.ts';

export type CartMode = 'multi-store' | 'single-store';

/** The most units, lines and rows the widget takes from one card (the server's own caps are lower). */
const UNITS_MAX = 10;
const GROUPS_MAX = 20;
const LINES_MAX = 60;
const OPTIONS_MAX = 3;
const ROWS_MAX = 40;
const QUANTITY_MAX = 9999;

export interface CartActionUnit {
  readonly variantId: string;
  readonly label: string | null;
  readonly price: CardMoney | null;
  readonly taxInclusive: boolean | null;
  readonly maxQuantity: number | null;
  readonly lineId: string | null;
  readonly inCart: number | null;
  readonly addable: number | null;
}

export interface CartAction {
  readonly kind: 'cart-action';
  readonly action: 'add' | 'set-quantity' | 'remove';
  readonly offerId: string;
  readonly productId: string | null;
  readonly sellerId: string | null;
  readonly sellerName: string | null;
  readonly name: string | null;
  readonly lineId: string | null;
  readonly currentQuantity: number | null;
  readonly quantity: number;
  readonly limited: boolean;
  readonly cartFull: boolean | null;
  readonly units: readonly CartActionUnit[];
  readonly cartMode: CartMode;
  /** single-store: the cart holds another store's lines; null means not known, never "safe". */
  readonly otherStore: boolean | null;
}

export interface CartSummaryLine {
  readonly lineId: string;
  readonly offerId: string;
  readonly variantId: string;
  readonly productId: string | null;
  readonly name: string | null;
  readonly variantLabel: string | null;
  readonly quantity: number;
  readonly state: 'buyable' | 'unavailable' | 'check-unavailable';
  readonly unitPrice: CardMoney | null;
  readonly maxQuantity: number | null;
}

export interface CartSummaryGroup {
  readonly sellerId: string | null;
  readonly sellerName: string | null;
  readonly subtotal: CardMoney | null;
  readonly minimumOrder: {
    readonly state: 'not-applicable' | 'none' | 'met' | 'below-minimum' | 'check-unavailable';
    readonly minimum: CardMoney | null;
  };
  readonly lines: readonly CartSummaryLine[];
}

export interface CartSummary {
  readonly kind: 'cart';
  readonly lineCount: number;
  readonly total: CardMoney | null;
  readonly groups: readonly CartSummaryGroup[];
}

export interface BasketOptionView {
  readonly offerId: string;
  readonly productId: string;
  readonly sellerId: string;
  readonly sellerName: string | null;
  readonly name: string;
  /** The sell unit the price is of; null while the server sends none (the line cannot be added). */
  readonly variantId: string | null;
  readonly price: CardMoney;
  readonly priceFrom: boolean;
  readonly taxInclusive: boolean | null;
  /** Packs for the wish; null when the pack size is unknown (the buyer chooses). */
  readonly quantity: number | null;
  readonly sizeNote: 'exact' | 'larger' | null;
  /** The most packs the buyer may add of this unit; null when the server sends none. */
  readonly maxQuantity: number | null;
}

export interface BasketLineView extends BasketOptionView {
  readonly itemIndex: number;
  /** What the buyer wrote for this line (their own words, shown as text). */
  readonly wish: string;
  readonly lineTotal: CardMoney;
  readonly alternatives: readonly BasketOptionView[];
}

export interface BasketStoreView {
  readonly sellerId: string;
  readonly sellerName: string | null;
  readonly lines: readonly BasketLineView[];
  readonly subtotal: CardMoney;
  readonly subtotalIsFrom: boolean;
}

export interface BasketProposalView {
  readonly kind: 'basket-proposal';
  readonly mode: CartMode;
  readonly itemCount: number;
  readonly stores: readonly BasketStoreView[];
  readonly uncertain: readonly {
    readonly itemIndex: number;
    readonly wish: string;
    readonly options: readonly BasketOptionView[];
  }[];
  readonly notFound: readonly {
    readonly itemIndex: number;
    readonly wish: string;
    readonly reason: 'not-found' | 'not-in-store';
  }[];
  readonly alternativeStores: readonly {
    readonly sellerId: string;
    readonly sellerName: string | null;
    readonly covered: number;
    readonly total: CardMoney;
  }[];
  readonly total: CardMoney | null;
  readonly totalIsFrom: boolean;
}

const mode = (value: unknown): CartMode | null =>
  value === 'multi-store' || value === 'single-store' ? value : null;

const flag = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null);

const list = (value: unknown, max: number): readonly unknown[] =>
  Array.isArray(value) ? (value as unknown[]).slice(0, max) : [];

function unitOf(raw: unknown): CartActionUnit | null {
  if (!isRecord(raw)) return null;
  const variantId = id(raw.variantId);
  if (!variantId) return null;
  const price = optionalMoney(raw.price);
  const lineId = raw.lineId === null || raw.lineId === undefined ? null : id(raw.lineId);
  // A line id that is not one drops the unit: a click would otherwise address the wrong thing.
  if (raw.lineId !== null && raw.lineId !== undefined && lineId === null) return null;
  return {
    variantId,
    label: text(raw.label, 80),
    price: price ?? null,
    taxInclusive: flag(raw.taxInclusive),
    maxQuantity: whole(raw.maxQuantity, 0, QUANTITY_MAX),
    lineId,
    inCart: whole(raw.inCart, 0, QUANTITY_MAX),
    addable: whole(raw.addable, 0, QUANTITY_MAX),
  };
}

export function cartActionOf(card: Record<string, unknown>): CartAction | null {
  const action = card.action;
  if (action !== 'add' && action !== 'set-quantity' && action !== 'remove') return null;
  const offerId = id(card.offerId);
  const cartMode = mode(card.cartMode);
  if (!offerId || !cartMode) return null;
  const units = list(card.units, UNITS_MAX).flatMap((raw) => {
    const unit = unitOf(raw);
    return unit ? [unit] : [];
  });
  if (units.length === 0 || units.length !== list(card.units, UNITS_MAX).length) return null;
  const lineId = card.lineId === null || card.lineId === undefined ? null : id(card.lineId);
  if (action !== 'add' && lineId === null) return null;
  const quantity = whole(card.quantity, 0, QUANTITY_MAX);
  if (quantity === null || (action !== 'remove' && quantity < 1)) return null;
  const nullableId = (value: unknown) => (value === null || value === undefined ? null : id(value));
  return {
    kind: 'cart-action',
    action,
    offerId,
    productId: nullableId(card.productId),
    sellerId: nullableId(card.sellerId),
    sellerName: text(card.sellerName, 120),
    name: text(card.name, 200),
    lineId,
    currentQuantity: whole(card.currentQuantity, 0, QUANTITY_MAX),
    quantity,
    limited: card.limited === true,
    cartFull: flag(card.cartFull),
    units,
    cartMode,
    // Anything but an explicit false means the widget must read the cart before it adds (never "safe").
    otherStore: cartMode === 'multi-store' ? false : flag(card.otherStore),
  };
}

const MIN_STATES = ['not-applicable', 'none', 'met', 'below-minimum', 'check-unavailable'] as const;
const LINE_STATES = ['buyable', 'unavailable', 'check-unavailable'] as const;

export function cartSummaryOf(card: Record<string, unknown>): CartSummary | null {
  const lineCount = whole(card.lineCount, 0, 10_000);
  if (lineCount === null || !Array.isArray(card.groups)) return null;
  const total = optionalMoney(card.total);
  if (total === undefined) return null;
  const groups: CartSummaryGroup[] = [];
  for (const raw of list(card.groups, GROUPS_MAX)) {
    if (!isRecord(raw) || !isRecord(raw.minimumOrder) || !Array.isArray(raw.lines)) return null;
    const state = MIN_STATES.find((s) => s === (raw.minimumOrder as Record<string, unknown>).state);
    if (!state) return null;
    const lines: CartSummaryLine[] = [];
    for (const row of list(raw.lines, LINES_MAX)) {
      if (!isRecord(row)) return null;
      const lineId = id(row.lineId);
      const offerId = id(row.offerId);
      const variantId = id(row.variantId);
      const lineState = LINE_STATES.find((s) => s === row.state);
      const quantity = whole(row.quantity, 1, QUANTITY_MAX);
      if (!lineId || !offerId || !variantId || !lineState || quantity === null) return null;
      const unitPrice = optionalMoney(row.unitPrice);
      lines.push({
        lineId,
        offerId,
        variantId,
        productId: id(row.productId),
        name: text(row.name, 200),
        variantLabel: text(row.variantLabel, 80),
        quantity,
        state: lineState,
        unitPrice: unitPrice ?? null,
        maxQuantity: whole(row.maxQuantity, 0, QUANTITY_MAX),
      });
    }
    const subtotal = optionalMoney(raw.subtotal);
    const minimum = optionalMoney(raw.minimumOrder.minimum);
    groups.push({
      sellerId: id(raw.sellerId),
      sellerName: text(raw.sellerName, 120),
      subtotal: subtotal ?? null,
      minimumOrder: { state, minimum: minimum ?? null },
      lines,
    });
  }
  return { kind: 'cart', lineCount, total: total ?? null, groups };
}

function optionOf(raw: unknown): BasketOptionView | null {
  if (!isRecord(raw)) return null;
  const offerId = id(raw.offerId);
  const productId = id(raw.productId);
  const sellerId = id(raw.sellerId);
  const name = text(raw.name, 200);
  const price = optionalMoney(raw.price);
  if (!offerId || !productId || !sellerId || !name || price === null || price === undefined)
    return null;
  const sizeNote = raw.sizeNote === 'exact' || raw.sizeNote === 'larger' ? raw.sizeNote : null;
  return {
    offerId,
    productId,
    sellerId,
    sellerName: text(raw.sellerName, 120),
    name,
    variantId: id(raw.variantId),
    price,
    priceFrom: raw.priceFrom === true,
    taxInclusive: flag(raw.taxInclusive),
    quantity: whole(raw.quantity, 1, 99),
    sizeNote,
    maxQuantity: whole(raw.maxQuantity, 0, QUANTITY_MAX),
  };
}

function optionsOf(value: unknown): BasketOptionView[] | null {
  const options: BasketOptionView[] = [];
  for (const raw of list(value, OPTIONS_MAX)) {
    const option = optionOf(raw);
    if (!option) return null;
    options.push(option);
  }
  return options;
}

export function basketProposalOf(card: Record<string, unknown>): BasketProposalView | null {
  const proposal = card.proposal;
  if (!isRecord(proposal)) return null;
  const cartMode = mode(proposal.mode);
  const itemCount = whole(proposal.itemCount, 0, ROWS_MAX);
  if (!cartMode || itemCount === null) return null;
  const stores: BasketStoreView[] = [];
  for (const raw of list(proposal.stores, ROWS_MAX)) {
    if (!isRecord(raw)) return null;
    const sellerId = id(raw.sellerId);
    const subtotal = optionalMoney(raw.subtotal);
    if (!sellerId || !subtotal) return null;
    const lines: BasketLineView[] = [];
    for (const row of list(raw.lines, ROWS_MAX)) {
      const option = optionOf(row);
      if (!option || !isRecord(row)) return null;
      const lineTotal = optionalMoney(row.lineTotal);
      const index = whole(row.itemIndex, 0, ROWS_MAX);
      const alternatives = optionsOf(row.alternatives);
      if (option.quantity === null || !lineTotal || index === null || !alternatives) return null;
      lines.push({
        ...option,
        itemIndex: index,
        wish: text(row.text, 200) ?? option.name,
        lineTotal,
        alternatives,
      });
    }
    stores.push({
      sellerId,
      sellerName: text(raw.sellerName, 120),
      lines,
      subtotal,
      subtotalIsFrom: raw.subtotalIsFrom === true,
    });
  }
  const uncertain: BasketProposalView['uncertain'][number][] = [];
  for (const raw of list(proposal.uncertain, ROWS_MAX)) {
    if (!isRecord(raw)) return null;
    const index = whole(raw.itemIndex, 0, ROWS_MAX);
    const options = optionsOf(raw.options);
    if (index === null || !options) return null;
    uncertain.push({ itemIndex: index, wish: text(raw.text, 200) ?? '', options });
  }
  const notFound: BasketProposalView['notFound'][number][] = [];
  for (const raw of list(proposal.notFound, ROWS_MAX)) {
    if (!isRecord(raw)) return null;
    const index = whole(raw.itemIndex, 0, ROWS_MAX);
    if (index === null || (raw.reason !== 'not-found' && raw.reason !== 'not-in-store'))
      return null;
    notFound.push({ itemIndex: index, wish: text(raw.text, 200) ?? '', reason: raw.reason });
  }
  const alternativeStores: BasketProposalView['alternativeStores'][number][] = [];
  for (const raw of list(proposal.alternativeStores, 3)) {
    if (!isRecord(raw)) return null;
    const sellerId = id(raw.sellerId);
    const total = optionalMoney(raw.total);
    const covered = whole(raw.covered, 0, ROWS_MAX);
    if (!sellerId || !total || covered === null) return null;
    alternativeStores.push({ sellerId, sellerName: text(raw.sellerName, 120), covered, total });
  }
  const total = optionalMoney(proposal.total);
  if (total === undefined) return null;
  return {
    kind: 'basket-proposal',
    mode: cartMode,
    itemCount,
    stores,
    uncertain,
    notFound,
    alternativeStores,
    total,
    totalIsFrom: proposal.totalIsFrom === true,
  };
}

/** One of the three cart cards, or null when the card is another kind or fails its checks. */
export function cartCardOf(
  card: Record<string, unknown>,
): CartAction | CartSummary | BasketProposalView | null {
  if (card.kind === 'cart-action') return cartActionOf(card);
  if (card.kind === 'cart') return cartSummaryOf(card);
  if (card.kind === 'basket-proposal') return basketProposalOf(card);
  return null;
}
