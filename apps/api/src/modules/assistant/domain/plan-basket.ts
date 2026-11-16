import { addMoney, money } from '@mondapac/shared-kernel';
import type { Money } from '@mondapac/shared-kernel';
import {
  UNIT_WORDS,
  normaliseText,
  parsePackSize,
  statesMultiPack,
  wantedMeasure,
  type BasketUnit,
  type Measure,
} from './pack-size';

/**
 * The basket planner (smart baskets design, sections 1 and 2): from a parsed shopping list and
 * what a search found for each line, it picks the products, the pack counts and the store, and
 * adds the totals. Pure and deterministic: the model only parses the list (text, quantity, unit);
 * every pick, price and total is computed here from the owning modules' answers, so none of them
 * can come from model text (ADR-0019 R1, R4; plan guardrail 1). Nothing here changes a cart.
 */

export type CartMode = 'multi-store' | 'single-store';
/** `best-match`: the first result that fits the line. Stage 2 adds `cheapest` beside it. */
export type BasketGoal = 'best-match';

/** One line of the buyer's list, as the model parsed it and `parsePlanBasket` checked it. */
export interface BasketItem {
  readonly text: string;
  /** More than 0; a whole number of packs when `unit` is null or `each`. */
  readonly quantity: number;
  readonly unit: BasketUnit | null;
}

/** One search result for a line, in the search's own order (best match first). */
export interface BasketCandidate {
  readonly offerId: string;
  readonly productId: string;
  readonly sellerId: string;
  readonly sellerName: string | null;
  readonly name: string;
  /** The buyer price of the Offer now (a "from" price when `priceFrom`); null when unreadable. */
  readonly price: Money | null;
  readonly priceFrom: boolean;
  readonly taxInclusive: boolean | null;
}

export interface BasketPlanInput {
  readonly items: readonly BasketItem[];
  /** `candidates[i]` are the search results for `items[i]`. */
  readonly candidates: readonly (readonly BasketCandidate[])[];
  readonly mode: CartMode;
  readonly goal: BasketGoal;
}

/** The most lines a list may have (the typed or pasted list of stage 1). */
export const MAX_BASKET_ITEMS = 40;
/** The most packs of one product a line asks for. */
export const MAX_PACKS = 99;
/** Options shown beside an uncertain line, and alternatives beside a found one. */
export const MAX_OPTIONS = 3;
export const MAX_ALTERNATIVES = 2;
/** Other stores offered in single-store mode. */
export const MAX_ALTERNATIVE_STORES = 3;

/** A product the buyer may pick for a line, with the packs it would take when that is known. */
export interface BasketOption {
  readonly offerId: string;
  readonly productId: string;
  readonly sellerId: string;
  readonly sellerName: string | null;
  readonly name: string;
  readonly price: Money;
  readonly priceFrom: boolean;
  readonly taxInclusive: boolean | null;
  /** Packs of this product for the wish; null when the pack size is unknown (buyer chooses). */
  readonly quantity: number | null;
  readonly sizeNote: SizeNote | null;
}

/** `exact`: the packs add up to the wish; `larger`: the buyer gets a bit more than asked. */
export type SizeNote = 'exact' | 'larger';

export interface BasketLine {
  readonly itemIndex: number;
  readonly text: string;
  readonly offerId: string;
  readonly productId: string;
  readonly sellerId: string;
  readonly name: string;
  /** Packs. */
  readonly quantity: number;
  /** The price of one pack. */
  readonly price: Money;
  readonly lineTotal: Money;
  readonly priceFrom: boolean;
  readonly taxInclusive: boolean | null;
  readonly sizeNote: SizeNote | null;
  /** Up to two other products that fit this line, for the buyer's swap. */
  readonly alternatives: readonly BasketOption[];
}

export interface BasketStore {
  readonly sellerId: string;
  readonly sellerName: string | null;
  readonly lines: readonly BasketLine[];
  readonly subtotal: Money;
  /** True when a line is a "from" price, so the subtotal is the lowest it can be. */
  readonly subtotalIsFrom: boolean;
}

export interface UncertainLine {
  readonly itemIndex: number;
  readonly text: string;
  readonly options: readonly BasketOption[];
}

export interface NotFoundLine {
  readonly itemIndex: number;
  readonly text: string;
  /** `not-in-store`: other stores have it, the chosen one (single-store) does not. */
  readonly reason: 'not-found' | 'not-in-store';
}

export interface AlternativeStore {
  readonly sellerId: string;
  readonly sellerName: string | null;
  /** How many lines of the list this store covers, of `BasketProposal.itemCount`. */
  readonly covered: number;
  readonly total: Money;
}

export interface BasketProposal {
  readonly mode: CartMode;
  readonly goal: BasketGoal;
  readonly itemCount: number;
  readonly stores: readonly BasketStore[];
  readonly uncertain: readonly UncertainLine[];
  readonly notFound: readonly NotFoundLine[];
  /** Single-store mode only: the next best stores (coverage, then total). */
  readonly alternativeStores: readonly AlternativeStore[];
  /** The sum of the store subtotals; null when nothing was picked. */
  readonly total: Money | null;
  readonly totalIsFrom: boolean;
  /**
   * Delivery fees and minimum orders are not read here: the storefront shows them at checkout.
   * Always true until a read of them is published to this module.
   */
  readonly deliveryShownAtCheckout: true;
}

type Fit = {
  readonly auto: boolean;
  readonly quantity: number | null;
  readonly sizeNote: SizeNote | null;
};

const NOISE = /[^\p{L}\p{N}]+/u;

/** The words of a line that a product name must contain: no numbers (the size is read apart). */
export function tokensOf(text: string): readonly string[] {
  return normaliseText(text)
    .split(NOISE)
    .filter((token) => token.length >= 2 && !/^\d+$/.test(token) && !UNIT_WORDS.has(token));
}

/** One word of a line against one word of a name: equal, or a plural of it ("egg", "eggs"; "برنج", "برنج‌ها"). */
function sameWord(token: string, word: string): boolean {
  if (word === token) return true;
  for (const ending of ['s', 'es', 'ها', 'های']) {
    if (word === token + ending || (token.length >= 4 && token === word + ending)) return true;
  }
  return false;
}

// Whole words only ("tea" is not in "steak", "teak" or "teabags"): a product whose name only
// contains the word inside a longer one is an option for the buyer, never an automatic pick.
function nameMatches(tokens: readonly string[], name: string): boolean {
  if (tokens.length === 0) return false;
  const words = normaliseText(name).split(NOISE);
  return tokens.every((token) => words.some((word) => sameWord(token, word)));
}

/** How a product fits a wish: the packs it takes, or why it cannot be picked on its own. */
function fitOf(wanted: Measure, name: string, priceFrom: boolean): Fit | null {
  if (wanted.kind === 'count') {
    // "12 eggs" is not twelve cartons of "Eggs 12 pack": the buyer says which they mean.
    if (statesMultiPack(name)) return { auto: false, quantity: null, sizeNote: null };
    const packs = Math.max(1, Math.ceil(wanted.amount));
    return packs > MAX_PACKS ? null : { auto: true, quantity: packs, sizeNote: null };
  }
  const pack = parsePackSize(name);
  // With Variants at different prices the size is often the Variant: the buyer picks it.
  if (pack === null || priceFrom) return { auto: false, quantity: null, sizeNote: null };
  if (pack.kind !== wanted.kind) return null;
  const packs = Math.max(1, Math.ceil(wanted.amount / pack.amount));
  if (packs > MAX_PACKS) return null;
  const delivered = packs * pack.amount;
  return {
    auto: delivered <= wanted.amount * 2,
    quantity: packs,
    sizeNote: delivered === wanted.amount ? 'exact' : 'larger',
  };
}

interface Evaluated {
  readonly candidate: BasketCandidate & { readonly price: Money };
  readonly fit: Fit;
  readonly matches: boolean;
}

const optionOf = ({ candidate, fit }: Evaluated): BasketOption => ({
  offerId: candidate.offerId,
  productId: candidate.productId,
  sellerId: candidate.sellerId,
  sellerName: candidate.sellerName,
  name: candidate.name,
  price: candidate.price,
  priceFrom: candidate.priceFrom,
  taxInclusive: candidate.taxInclusive,
  quantity: fit.quantity,
  sizeNote: fit.sizeNote,
});

const isPicked = (entry: Evaluated): boolean => entry.matches && entry.fit.auto;

/** Every usable result of one line, in the search's order; results in another currency are dropped. */
function evaluate(
  item: BasketItem,
  candidates: readonly BasketCandidate[],
  currency: string | null,
): readonly Evaluated[] {
  const tokens = tokensOf(item.text);
  const wanted = wantedMeasure(item.quantity, item.unit);
  const seen = new Set<string>();
  const out: Evaluated[] = [];
  for (const candidate of candidates) {
    if (candidate.price === null || candidate.price.currency !== currency) continue;
    if (candidate.price.amount <= 0n || seen.has(candidate.offerId)) continue;
    seen.add(candidate.offerId);
    const fit = fitOf(wanted, candidate.name, candidate.priceFrom);
    if (fit === null) continue;
    out.push({
      candidate: candidate as BasketCandidate & { readonly price: Money },
      fit,
      matches: nameMatches(tokens, candidate.name),
    });
  }
  return out;
}

function lineOf(
  itemIndex: number,
  item: BasketItem,
  pick: Evaluated,
  rest: readonly Evaluated[],
): BasketLine {
  const { candidate, fit } = pick;
  const quantity = fit.quantity ?? 1;
  const alternatives = rest
    .filter((entry) => isPicked(entry) && entry.candidate.offerId !== candidate.offerId)
    .slice(0, MAX_ALTERNATIVES)
    .map(optionOf);
  return {
    itemIndex,
    text: item.text,
    offerId: candidate.offerId,
    productId: candidate.productId,
    sellerId: candidate.sellerId,
    name: candidate.name,
    quantity,
    price: candidate.price,
    lineTotal: money(candidate.price.amount * BigInt(quantity), candidate.price.currency),
    priceFrom: candidate.priceFrom,
    taxInclusive: candidate.taxInclusive,
    sizeNote: fit.sizeNote,
    alternatives,
  };
}

function storeOf(
  sellerId: string,
  sellerName: string | null,
  lines: readonly BasketLine[],
): BasketStore {
  const subtotal = lines.map((line) => line.lineTotal).reduce((sum, next) => addMoney(sum, next));
  return {
    sellerId,
    sellerName,
    lines,
    subtotal,
    subtotalIsFrom: lines.some((line) => line.priceFrom),
  };
}

/** The currency of the list: the first readable price (a Market has one currency). */
function currencyOf(candidates: readonly (readonly BasketCandidate[])[]): string | null {
  for (const results of candidates) {
    for (const candidate of results) if (candidate.price !== null) return candidate.price.currency;
  }
  return null;
}

/**
 * The basket for a parsed list. A line is *found* when a result carries every word of the line and
 * its pack size fits the wish (or the wish is a count); *uncertain* when results exist but none is
 * a clear fit (up to three options for the buyer); *not found* otherwise. In `multi-store` mode
 * each line takes its best result from any store; in `single-store` mode one store is chosen by
 * coverage, then total, and the next best stores are offered. The result depends only on the
 * input: the same list and results always give the same basket.
 */
export function planBasket(input: BasketPlanInput): BasketProposal {
  const { items, mode, goal } = input;
  const currency = currencyOf(input.candidates);
  const evaluated = items.map((item, index) =>
    evaluate(item, input.candidates[index] ?? [], currency),
  );

  const uncertain: UncertainLine[] = [];
  const notFound: NotFoundLine[] = [];
  const found = new Map<
    number,
    { line: BasketLine; sellerId: string; sellerName: string | null }
  >();
  let alternativeStores: AlternativeStore[] = [];

  const leftOver = (index: number, pool: readonly Evaluated[], reason: NotFoundLine['reason']) => {
    const options = pool.slice(0, MAX_OPTIONS).map(optionOf);
    if (options.length > 0) uncertain.push({ itemIndex: index, text: items[index]!.text, options });
    else notFound.push({ itemIndex: index, text: items[index]!.text, reason });
  };

  const pickBest = (index: number, pool: readonly Evaluated[]): BasketLine | null => {
    const pick = pool.find(isPicked);
    return pick === undefined ? null : lineOf(index, items[index]!, pick, pool);
  };

  if (mode === 'multi-store') {
    items.forEach((_, index) => {
      const pool = evaluated[index]!;
      const line = pickBest(index, pool);
      if (line === null) leftOver(index, pool, 'not-found');
      else {
        const pick = pool.find((entry) => entry.candidate.offerId === line.offerId)!;
        found.set(index, {
          line,
          sellerId: line.sellerId,
          sellerName: pick.candidate.sellerName,
        });
      }
    });
  } else {
    // Coverage and total of every store that has at least one clear pick.
    const sellers = new Map<
      string,
      { covered: number; total: Money | null; name: string | null }
    >();
    items.forEach((_, index) => {
      const pool = evaluated[index]!;
      const seenSellers = new Set<string>();
      for (const entry of pool) {
        const sellerId = entry.candidate.sellerId;
        if (!isPicked(entry) || seenSellers.has(sellerId)) continue;
        seenSellers.add(sellerId);
        const line = lineOf(index, items[index]!, entry, []);
        const current = sellers.get(sellerId) ?? {
          covered: 0,
          total: null,
          name: entry.candidate.sellerName,
        };
        sellers.set(sellerId, {
          covered: current.covered + 1,
          total: current.total === null ? line.lineTotal : addMoney(current.total, line.lineTotal),
          name: current.name,
        });
      }
    });
    const ranked = [...sellers.entries()].sort(
      ([idA, a], [idB, b]) =>
        b.covered - a.covered ||
        (a.total!.amount < b.total!.amount ? -1 : a.total!.amount > b.total!.amount ? 1 : 0) ||
        (idA < idB ? -1 : idA > idB ? 1 : 0),
    );
    const best = ranked[0];
    alternativeStores = ranked.slice(1, 1 + MAX_ALTERNATIVE_STORES).map(([sellerId, data]) => ({
      sellerId,
      sellerName: data.name,
      covered: data.covered,
      total: data.total!,
    }));
    items.forEach((_, index) => {
      const pool = evaluated[index]!;
      if (best === undefined) {
        leftOver(index, pool, 'not-found');
        return;
      }
      const [bestId, bestData] = best;
      const own = pool.filter((entry) => entry.candidate.sellerId === bestId);
      const line = pickBest(index, own);
      if (line !== null) {
        found.set(index, { line, sellerId: bestId, sellerName: bestData.name });
        return;
      }
      leftOver(index, own, pool.some(isPicked) ? 'not-in-store' : 'not-found');
    });
  }

  // Group the picked lines by store, in the order the list names them.
  const groups = new Map<string, { name: string | null; lines: BasketLine[] }>();
  for (const index of [...found.keys()].sort((a, b) => a - b)) {
    const entry = found.get(index)!;
    const group = groups.get(entry.sellerId) ?? { name: entry.sellerName, lines: [] };
    group.lines.push(entry.line);
    groups.set(entry.sellerId, group);
  }
  const stores = [...groups.entries()].map(([sellerId, group]) =>
    storeOf(sellerId, group.name, group.lines),
  );
  const total =
    stores.length === 0
      ? null
      : stores.map((store) => store.subtotal).reduce((sum, next) => addMoney(sum, next));
  return {
    mode,
    goal,
    itemCount: items.length,
    stores,
    uncertain: uncertain.sort((a, b) => a.itemIndex - b.itemIndex),
    notFound: notFound.sort((a, b) => a.itemIndex - b.itemIndex),
    alternativeStores,
    total,
    totalIsFrom: stores.some((store) => store.subtotalIsFrom),
    deliveryShownAtCheckout: true,
  };
}

/**
 * Whether every line of a list is the buyer's own words: each word of each line (units and
 * numbers aside) appears in what the buyer wrote in this conversation. A line the model made up
 * or took from a seller's text fails, so the card never shows model text (ADR-0019 R1, R9).
 */
export function linesAreBuyersOwn(
  items: readonly BasketItem[],
  buyerTexts: readonly string[],
): boolean {
  const words = normaliseText(buyerTexts.join('\n')).split(NOISE);
  return items.every((item) => {
    // Every word of any length, so single letters cannot hide a word from the check.
    const lineWords = normaliseText(item.text)
      .split(NOISE)
      .filter((word) => word !== '' && !/^\d+$/.test(word) && !UNIT_WORDS.has(word));
    return (
      tokensOf(item.text).length > 0 &&
      lineWords.every((token) =>
        words.some((word) => sameWord(token, word) || sameWord(word, token)),
      )
    );
  });
}
