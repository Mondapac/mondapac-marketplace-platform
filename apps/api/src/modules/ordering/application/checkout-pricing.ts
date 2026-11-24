import { err, money, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { lineCommission, type CommissionRateMap } from '../../commission-payouts';
import type {
  DiscountSummary,
  PromotionsFacade,
  QuoteRequest,
  QuoteResult,
} from '../../promotions';
import { discountSummaryOf } from '../../promotions';
import type { TaxAnswer, TaxFacade } from '../../tax';
import { NO_DISCOUNT, type LineDiscount } from '../domain/discounts';
import type { DeliveryMethod } from '../domain/delivery-method';
import type { Plan, PlannedLine } from '../domain/order';

/** What pricing needs of checkout's dependencies (a narrow view, so the files form no cycle). */
export interface PricingDependencies {
  readonly promotions: PromotionsFacade;
  readonly tax: TaxFacade;
}

/** How pricing fails; each is also a failure of `start-checkout`. */
export type PricingFailure =
  { readonly code: 'access.denied' } | { readonly code: 'ordering.check-unavailable' };

// The prices of a checkout once its plan, delivery fees, commission rates and tax categories are
// known (promotions package T2): the discounts promotions quotes for the cart, then the tax of
// every line and delivery on what the buyer pays after them, then the totals. Run again, with the
// same inputs, when a redemption finds that the discounts no longer hold: the buyer is shown the
// new total and nothing is charged.

/** The key of a line in the plan: its Offer and Variant (one line each per order). */
export const lineKeyOf = (line: Pick<PlannedLine, 'offerId' | 'variantId'>): string =>
  `${line.offerId}/${line.variantId}`;

/** Quotes tried while the commission the quote was given moves (owner Q6: the cap follows it). */
const QUOTE_ATTEMPTS = 3;

/** The code a buyer typed, checked for shape only: promotions decides what it is worth. */
export function parseDiscountCode(
  raw: unknown,
): { readonly ok: true; readonly code: string | null } | { readonly ok: false } {
  if (raw === undefined || raw === null) return { ok: true, code: null };
  if (typeof raw !== 'string') return { ok: false };
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, code: null };
  // Printable characters only, 64 at most (promotions normalises the case and the spacing).
  if (trimmed.length > 64 || !/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/u.test(trimmed)) {
    return { ok: false };
  }
  return { ok: true, code: trimmed };
}

/** What the prices of a checkout are worked out from. */
export interface PricingInput {
  readonly accountId: Id<'Account'>;
  readonly plan: Plan;
  readonly rates: CommissionRateMap;
  readonly categories: ReadonlyMap<Id<'Offer'>, string>;
  readonly products: ReadonlyMap<Id<'Offer'>, Id<'Product'>>;
  /** The buyer's delivery method per seller: a pickup has no delivery charge to discount. */
  readonly methodOf: (sellerId: Id<'Seller'>) => DeliveryMethod;
  /** The promotions delivery zone of the address (its ServiceArea); null for none. */
  readonly zone: string | null;
  readonly code: string | null;
  /** From ordering's own history only: the account has no paid order in the Market. */
  readonly isFirstOrder: boolean;
}

/** The discounts of the order, as quoted, and the request they were quoted with. */
export interface OrderDiscounts {
  /** The request to repeat in the redemption (promotions prices it again under its locks). */
  readonly request: QuoteRequest;
  /** What the stored order holds; the redemption reserves exactly this or refuses. */
  readonly summary: DiscountSummary;
  /** Each line's discount and funding, by {@link lineKeyOf}. */
  readonly lines: ReadonlyMap<string, LineDiscount>;
  /** The discount on each seller's delivery price (platform-funded). */
  readonly shipping: ReadonlyMap<Id<'Seller'>, bigint>;
  /** Whether the code the buyer typed gave a discount (false without a code). */
  readonly codeApplied: boolean;
}

/** Whether the order took any discount (nothing to redeem otherwise). */
export const hasDiscounts = (summary: DiscountSummary): boolean =>
  summary.applied.length > 0 || summary.lines.length > 0 || summary.shipping.length > 0;

type TaxLine = TaxAnswer['lines'][number];

export interface PricedOrder {
  readonly discounts: OrderDiscounts;
  readonly lineTax: ReadonlyMap<string, TaxLine>;
  readonly shippingTax: ReadonlyMap<Id<'Seller'>, TaxLine>;
  /** The delivery price is a fleet quote with tax included, so its tax is shown, not added. */
  readonly shippingInclusive: ReadonlyMap<Id<'Seller'>, boolean>;
  /** Tax charged on top of the goods and the delivery, per seller. */
  readonly addedTax: ReadonlyMap<Id<'Seller'>, bigint>;
  /** Each seller's total: goods and delivery net of their discounts, plus the added tax. */
  readonly sellerTotals: ReadonlyMap<Id<'Seller'>, bigint>;
  readonly total: bigint;
  readonly taxStrategyId: TaxAnswer['strategyId'];
}

const unavailable = (): Result<never, PricingFailure> =>
  err({ code: 'ordering.check-unavailable' });

/**
 * The discounts of the plan from promotions (under the buyer's `CallContext`; promotions takes
 * the customer from the session), read back into each line and delivery charge and checked: a
 * quote that does not add up is a failed check, never a guessed discount.
 */
export async function quoteDiscounts(
  deps: PricingDependencies,
  context: CallContext,
  input: PricingInput,
  lineTaxRates: readonly number[],
): Promise<Result<OrderDiscounts, PricingFailure>> {
  const { plan } = input;
  const planLines = plan.sellers.flatMap((seller) =>
    seller.lines.map((line) => ({ seller: seller.sellerId, line })),
  );
  const lineIds = new Map<string, { key: string; lineAmount: bigint }>();
  const lines: QuoteRequest['lines'][number][] = [];
  for (const [index, { seller, line }] of planLines.entries()) {
    const productId = input.products.get(line.offerId);
    const rate = input.rates.get(seller);
    if (productId === undefined || rate === undefined) return unavailable();
    const id = `line-${index}`;
    lineIds.set(id, {
      key: lineKeyOf(line),
      lineAmount: line.unitPrice.amount * BigInt(line.quantity),
    });
    lines.push({
      id,
      sellerId: seller,
      productId,
      unitPrice: line.unitPrice,
      quantity: line.quantity,
    });
  }
  // A delivery that costs something can be discounted (free shipping by zone); a pickup cannot.
  const shippingIds = new Map<string, { sellerId: Id<'Seller'>; amount: bigint }>();
  const shipping: QuoteRequest['shipping'][number][] = [];
  if (input.zone !== null) {
    for (const [index, seller] of plan.sellers.entries()) {
      if (seller.shipping <= 0n || input.methodOf(seller.sellerId) === 'pickup') continue;
      const id = `ship-${index}`;
      shippingIds.set(id, { sellerId: seller.sellerId, amount: seller.shipping });
      shipping.push({
        id,
        sellerId: seller.sellerId,
        zoneCode: input.zone,
        amount: money(seller.shipping, plan.currency),
      });
    }
  }

  // The order's commission as the ledger will post it: on each line after the seller's share of
  // its discount. The first quote is given the commission with no discount; when the shares it
  // answers move the commission and the platform funds part of the discounts, the cart is quoted
  // again with the commission those shares give (the platform's share is capped by it).
  const commissionOf = (sellerShares: ReadonlyMap<string, bigint>): bigint =>
    planLines.reduce(
      (sum, { seller, line }, index) =>
        sum +
        lineCommission({
          amount:
            line.unitPrice.amount * BigInt(line.quantity) -
            (sellerShares.get(`line-${index}`) ?? 0n),
          taxInclusive: line.taxInclusive,
          // The line's own tax rate by its category (0 when GST-free), as the ledger takes it out.
          taxBps: lineTaxRates[index]!,
          rateBps: input.rates.get(seller)!.rateBps,
        }).commission,
      0n,
    );
  let commission = commissionOf(new Map());
  for (let attempt = 0; attempt < QUOTE_ATTEMPTS; attempt += 1) {
    const request: QuoteRequest = {
      lines,
      shipping,
      code: input.code,
      isFirstOrder: input.isFirstOrder,
      customerAccountId: input.accountId,
      // Ordering has no test orders: a test-mode promotion never reaches a real order.
      testMode: false,
      orderCommission: money(commission, plan.currency),
    };
    const quoted = await deps.promotions.quote(context, request);
    if (!quoted.ok) {
      return err(
        quoted.error.code === 'access.denied'
          ? { code: 'access.denied' }
          : { code: 'ordering.check-unavailable' },
      );
    }
    const read = readQuote(quoted.value, plan.currency, lineIds, shippingIds);
    if (read === null) return unavailable();
    const next = commissionOf(read.sellerShares);
    if (next === commission || quoted.value.totals.platformShare === 0n) {
      return ok({
        request,
        summary: discountSummaryOf(quoted.value),
        lines: read.lines,
        shipping: read.shipping,
        codeApplied: quoted.value.code === 'APPLIED',
      });
    }
    commission = next;
  }
  return unavailable();
}

/** The quote's discounts by line key and seller, or null when the answer does not add up. */
function readQuote(
  quote: QuoteResult,
  currency: string,
  lineIds: ReadonlyMap<string, { key: string; lineAmount: bigint }>,
  shippingIds: ReadonlyMap<string, { sellerId: Id<'Seller'>; amount: bigint }>,
): {
  readonly lines: ReadonlyMap<string, LineDiscount>;
  readonly sellerShares: ReadonlyMap<string, bigint>;
  readonly shipping: ReadonlyMap<Id<'Seller'>, bigint>;
} | null {
  if (quote.currency !== currency) return null;
  const lines = new Map<string, LineDiscount>();
  const sellerShares = new Map<string, bigint>();
  for (const result of quote.lines) {
    const known = lineIds.get(result.lineId);
    if (known === undefined || lines.has(known.key)) return null;
    const sellerShare = result.allocations.reduce((sum, a) => sum + a.sellerShare, 0n);
    const platformShare = result.allocations.reduce((sum, a) => sum + a.platformShare, 0n);
    if (
      result.discount < 0n ||
      result.discount > known.lineAmount ||
      sellerShare < 0n ||
      platformShare < 0n ||
      sellerShare + platformShare !== result.discount
    ) {
      return null;
    }
    lines.set(
      known.key,
      result.discount === 0n
        ? NO_DISCOUNT
        : { amount: result.discount, sellerShare, platformShare },
    );
    sellerShares.set(result.lineId, sellerShare);
  }
  if (lines.size !== lineIds.size) return null;
  const shipping = new Map<Id<'Seller'>, bigint>();
  for (const result of quote.shipping) {
    const known = shippingIds.get(result.shippingId);
    if (known === undefined || shipping.has(known.sellerId)) return null;
    if (result.discount < 0n || result.discount > known.amount) return null;
    shipping.set(known.sellerId, result.discount);
  }
  if (shipping.size !== shippingIds.size) return null;
  return { lines, sellerShares, shipping };
}

/**
 * The tax rate of each product line of the plan, in plan order, from the strategy in force: a
 * rate depends only on the line's tax category, so the commission the discount quote is capped by
 * is the ledger's (a GST-free line keeps its whole amount as base). Asked once, before the quote.
 */
async function lineTaxRates(
  deps: PricingDependencies,
  context: CallContext,
  input: PricingInput,
): Promise<Result<readonly number[], PricingFailure>> {
  const planLines = input.plan.sellers.flatMap((seller) => seller.lines);
  const answer = await deps.tax.calculateTax(
    context,
    planLines.map((line) => ({
      amount: line.unitPrice.amount * BigInt(line.quantity),
      taxInclusive: line.taxInclusive,
      categoryCode: input.categories.get(line.offerId)!,
    })),
  );
  if (!answer.ok || answer.value.lines.length !== planLines.length) {
    return err(
      !answer.ok && answer.error.code === 'access.denied'
        ? { code: 'access.denied' }
        : { code: 'ordering.check-unavailable' },
    );
  }
  return ok(answer.value.lines.map((line) => line.rateBps));
}

/**
 * The checkout's prices: the discounts, then the tax of every line and delivery on what the
 * buyer pays after them (ADR-0039 decision 4), then each seller's total and the order's.
 */
export async function priceOrder(
  deps: PricingDependencies,
  context: CallContext,
  input: PricingInput,
): Promise<Result<PricedOrder, PricingFailure>> {
  const { plan } = input;
  const rates = await lineTaxRates(deps, context, input);
  if (!rates.ok) return rates;
  const discounts = await quoteDiscounts(deps, context, input, rates.value);
  if (!discounts.ok) return discounts;
  const lineDiscount = (line: PlannedLine): LineDiscount =>
    discounts.value.lines.get(lineKeyOf(line)) ?? NO_DISCOUNT;
  const shippingDiscount = (sellerId: Id<'Seller'>): bigint =>
    discounts.value.shipping.get(sellerId) ?? 0n;

  const planLines = plan.sellers.flatMap((seller) => seller.lines);
  // The shipping price of each seller is taxed in the same answer, after the product lines, at
  // the strategy's default rate (no category). A fleet quote is a price with tax included (and
  // so is the margin on it), so the delivery is always inclusive: its tax is shown, not added.
  const shippingInclusive = new Map(plan.sellers.map((seller) => [seller.sellerId, true]));
  const taxed = await deps.tax.calculateTax(context, [
    ...planLines.map((line) => ({
      amount: line.unitPrice.amount * BigInt(line.quantity) - lineDiscount(line).amount,
      taxInclusive: line.taxInclusive,
      categoryCode: input.categories.get(line.offerId)!,
    })),
    ...plan.sellers.map((seller) => ({
      amount: seller.shipping - shippingDiscount(seller.sellerId),
      taxInclusive: shippingInclusive.get(seller.sellerId)!,
      categoryCode: null,
    })),
  ]);
  if (!taxed.ok || taxed.value.lines.length !== planLines.length + plan.sellers.length) {
    return err(
      !taxed.ok && taxed.error.code === 'access.denied'
        ? { code: 'access.denied' }
        : { code: 'ordering.check-unavailable' },
    );
  }
  const lineTax = new Map(
    planLines.map((line, index) => [lineKeyOf(line), taxed.value.lines[index]!]),
  );
  const shippingTax = new Map(
    plan.sellers.map((seller, index) => [
      seller.sellerId,
      taxed.value.lines[planLines.length + index]!,
    ]),
  );
  // Tax on a price that excludes it is charged on top of the goods and the shipping, per seller.
  const addedTax = new Map(
    plan.sellers.map((seller) => [
      seller.sellerId,
      seller.lines.reduce(
        (sum, line) => (line.taxInclusive ? sum : sum + lineTax.get(lineKeyOf(line))!.tax),
        0n,
      ) + (shippingInclusive.get(seller.sellerId)! ? 0n : shippingTax.get(seller.sellerId)!.tax),
    ]),
  );
  const sellerTotals = new Map(
    plan.sellers.map((seller) => [
      seller.sellerId,
      seller.subtotal -
        seller.lines.reduce((sum, line) => sum + lineDiscount(line).amount, 0n) +
        seller.shipping -
        shippingDiscount(seller.sellerId) +
        addedTax.get(seller.sellerId)!,
    ]),
  );
  const total = [...sellerTotals.values()].reduce((sum, amount) => sum + amount, 0n);
  return ok({
    discounts: discounts.value,
    lineTax,
    shippingTax,
    shippingInclusive,
    addedTax,
    sellerTotals,
    total,
    taxStrategyId: taxed.value.strategyId,
  });
}
