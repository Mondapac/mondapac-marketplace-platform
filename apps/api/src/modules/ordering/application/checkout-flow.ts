import { err, ok, money } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Money,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { CartCheckoutFacade } from '../../cart';
import type { CommissionPayoutsFacade, ExclusiveBuyer } from '../../commission-payouts';
import type { CustomersCheckoutFacade } from '../../customers';
import type {
  PromotionsFacade,
  RedeemFacadeFailure,
  RedeemRequest,
  RedeemResult,
} from '../../promotions';
import type { QuotedDelivery, ShippingFacade } from '../../shipping';
import type { TaxFacade } from '../../tax';
import type {
  InsufficientReason,
  InventoryOrderingPort,
  ReserveFailure,
  ReserveResult,
} from '../../inventory/contracts/ordering-port';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import {
  DEFAULT_DELIVERY_METHOD,
  parseDeliveryChoices,
  type DeliveryChoice,
} from '../domain/delivery-method';
import {
  addShipping,
  cancelOrder,
  type ChargedDeliveryQuote,
  parseSellerNotes,
  planOrder,
  type OrderLine,
  type OrderState,
  type ShipTo,
} from '../domain/order';
import { orderCancelledEvent } from '../domain/events';
import { NO_DISCOUNT } from '../domain/discounts';
import {
  hasDiscounts,
  lineKeyOf,
  parseDiscountCode,
  priceOrder,
  type PricingInput,
} from './checkout-pricing';
import type { CheckoutGateway } from './ports/checkout-gateway';
import type { DeliveryMethodPolicy } from './ports/delivery-method-policy';
import type { PaymentAttemptLimits } from './ports/payment-attempt-limits';
import type { PickupCodeVault } from './ports/pickup-code-vault';
import type { PickupCodeRepository } from './ports/pickup-code.repository';
import type { OrderLabels } from './ports/order-labels';
import type { OrderTaxCategories } from './ports/order-tax-categories';
import type { OrderProducts } from './ports/order-products';
import type { OrderingPolicy } from './ports/ordering-policy';
import type { OrderRepository } from './ports/order.repository';
import type { RefundRepository } from './ports/refund.repository';
import type { ShipToCipher } from './ports/ship-to-cipher';

export interface OrderingDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly orders: OrderRepository;
  /** Refunds of seller orders and their credit notes (tax step 3). */
  readonly refunds: RefundRepository;
  readonly gateway: CheckoutGateway;
  readonly policy: OrderingPolicy;
  readonly cart: CartCheckoutFacade;
  /** The customer's address book: checkout copies the chosen address onto the order. */
  readonly customers: CustomersCheckoutFacade;
  readonly shipTo: ShipToCipher;
  readonly inventory: InventoryOrderingPort;
  readonly shipping: ShippingFacade;
  readonly commission: CommissionPayoutsFacade;
  readonly tax: TaxFacade;
  /** The product's tax category of each Offer bought (catalog's published revision). */
  readonly taxCategories: OrderTaxCategories;
  /** The product of each Offer bought, for the promotions quote (package T2). */
  readonly products: OrderProducts;
  /** The discounts of the order: quoted before the total, redeemed once the order is stored. */
  readonly promotions: PromotionsFacade;
  readonly outbox: OutboxWriter;
  /** The audit of refunds (tax step 3). */
  readonly audit: AuditWriter;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  /** Display names for the panel order pages (advisory; never inside a unit). */
  readonly labels: OrderLabels;
  /** Which delivery methods a seller order may use (shipping's delivery settings, through the facade). */
  readonly deliveryMethods: DeliveryMethodPolicy;
  /** The pickup codes of seller orders the buyer collects in person (delivery models, package 2). */
  readonly pickupCodes: PickupCodeRepository;
  /** Makes, hashes and seals those codes under the buyer's key. */
  readonly pickupVault: PickupCodeVault;
  /** The card payment attempts of one customer account per window (rate limit). */
  readonly attempts: PaymentAttemptLimits;
}

export type StartCheckoutFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { path: string; code: string }[];
    }
  /** The chosen address is not one of the customer's (unknown, removed or another's). */
  | { readonly code: 'ordering.address-not-found' }
  /** The Market does not deliver to the chosen address's postcode (ServiceArea config). */
  | { readonly code: 'ordering.outside-delivery-area' }
  /** A seller of the cart does not offer the delivery method the buyer chose for it. */
  | {
      readonly code: 'ordering.delivery-method-unavailable';
      readonly methodSellerIds: readonly Id<'Seller'>[];
    }
  /** A seller the buyer chose in-person pickup for has no approved pickup address. */
  | {
      readonly code: 'ordering.pickup-unavailable';
      readonly methodSellerIds: readonly Id<'Seller'>[];
    }
  | { readonly code: 'ordering.cart-empty' }
  | { readonly code: 'ordering.cart-not-purchasable'; readonly lineIndexes: readonly number[] }
  | { readonly code: 'ordering.check-unavailable' }
  /** The cart is not ready: a seller is below its minimum order, or it cannot be checked. */
  | {
      readonly code: 'ordering.cart-not-ready';
      readonly sellers: readonly {
        readonly sellerId: Id<'Seller'>;
        readonly reason: 'below-minimum' | 'check-unavailable';
        readonly minimum: ReturnType<typeof money> | null;
      }[];
    }
  /**
   * The delivery price changed since the buyer saw it (its quote stopped holding and the fleets
   * now ask another price): nothing was reserved or charged; the buyer confirms the new price.
   */
  | {
      readonly code: 'ordering.delivery-quote-changed';
      readonly quotes: readonly {
        readonly sellerId: Id<'Seller'>;
        readonly quoteId: string;
        readonly total: Money;
        readonly validUntil: string;
      }[];
    }
  | {
      readonly code: 'ordering.stock-insufficient';
      readonly lines: readonly {
        readonly offerId: Id<'Offer'>;
        readonly variantId: Id<'Variant'>;
        readonly reason: InsufficientReason;
      }[];
    }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.retry' }
  | { readonly code: 'ordering.payment-unavailable' }
  /**
   * The total the buyer saw is not the total the server computed now (a price, a fee or a tax
   * moved): nothing was reserved or charged; the buyer confirms the new total.
   */
  | { readonly code: 'ordering.price-changed'; readonly total: ReturnType<typeof money> }
  /** The discount code the buyer typed gives this cart nothing (unknown, used up, not eligible). */
  | { readonly code: 'ordering.discount-code-not-applied' }
  /** The card is not one the Market accepts (Visa and Mastercard only). */
  | { readonly code: 'ordering.card-not-accepted' }
  /** The bank refused the card. Nothing was charged; the stock hold was released. */
  | { readonly code: 'ordering.card-declined' };

export interface CheckoutStarted {
  readonly orderId: Id<'Order'>;
  readonly checkoutUrl: string;
  readonly payBy: Temporal.Instant;
  readonly total: ReturnType<typeof money>;
}

const chargedQuoteOf = (quote: QuotedDelivery | undefined): ChargedDeliveryQuote | null =>
  quote === undefined
    ? null
    : {
        quoteId: quote.quoteId,
        fleet: quote.fleet,
        quoteAmount: quote.quote.amount,
        marginAmount: quote.margin.amount,
        quotedAt: quote.quotedAt,
        expiresAt: quote.validUntil,
      };

/** Reads of the order tried when linking the provider's object to it loses a race. */
const LINK_ATTEMPTS = 3;

/** A lock timeout on reserve costs the holder's rate budget, so retry once at most. */
const RESERVE_ATTEMPTS = 2;

async function reserveWithRetry(
  deps: OrderingDependencies,
  context: CallContext,
  orderId: Id<'Order'>,
  lines: readonly { offerId: Id<'Offer'>; variantId: Id<'Variant'>; quantity: number }[],
): Promise<Result<ReserveResult, ReserveFailure>> {
  let last: Result<ReserveResult, ReserveFailure> = err({ code: 'conflict.retry' });
  for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
    last = await deps.inventory.reserve(context, { checkoutRef: orderId, lines });
    if (last.ok || last.error.code !== 'conflict.retry') return last;
  }
  return last;
}

/**
 * Checkouts with a discount code one customer account may make in one window of the
 * `checkout-payment` counter (10 minutes). Not a Market setting.
 */
export const DISCOUNT_CODE_ATTEMPTS_PER_WINDOW = 10;

/** A lock timeout in promotions writes nothing, so the redemption is tried again a few times. */
const REDEEM_ATTEMPTS = 3;

async function redeemWithRetry(
  deps: OrderingDependencies,
  context: CallContext,
  request: RedeemRequest,
): Promise<Result<RedeemResult, RedeemFacadeFailure>> {
  let last: Result<RedeemResult, RedeemFacadeFailure> = err({ code: 'conflict.retry' });
  for (let attempt = 0; attempt < REDEEM_ATTEMPTS; attempt += 1) {
    last = await deps.promotions.redeem(context, request);
    if (last.ok || last.error.code !== 'conflict.retry') return last;
  }
  return last;
}

/**
 * What the customer sends to start checkout: the id of an address of their address book and,
 * optionally, a note to each seller (`{ [sellerId]: text }`, plain text, 200 characters at most).
 */
export interface StartCheckoutInput {
  readonly addressId: unknown;
  readonly sellerNotes?: unknown;
  /**
   * The buyer's delivery method per seller: `{ [sellerId]: { method, windowStart?, windowEnd?, quoteId? } }`.
   * A seller without an entry gets {@link DEFAULT_DELIVERY_METHOD} until the basket asks.
   */
  readonly deliveryMethods?: unknown;
  /** The one discount code the buyer typed (package T2); absent, null or empty for none. */
  readonly code?: unknown;
}

/**
 * Reads the chosen address from the customer's address book and checks that the Market delivers
 * there, before anything is reserved: no order is ever placed without an address in the
 * delivery area.
 */
export async function readShipTo(
  deps: OrderingDependencies,
  context: CallContext,
  addressId: unknown,
): Promise<Result<ShipTo, StartCheckoutFailure>> {
  if (addressId === undefined || addressId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'addressId', code: 'required' }] });
  }
  const address = await deps.customers.deliveryAddress(context, addressId);
  if (!address.ok) {
    switch (address.error.code) {
      case 'access.denied':
        return err({ code: 'access.denied' });
      case 'validation.failed':
        return err({ code: 'validation.failed', fields: [{ path: 'addressId', code: 'format' }] });
      case 'customers.address-not-found':
        return err({ code: 'ordering.address-not-found' });
      default:
        return err({ code: 'ordering.check-unavailable' });
    }
  }
  const a = address.value;
  const shipTo: ShipTo = {
    recipientFirstName: a.recipientFirstName,
    recipientLastName: a.recipientLastName,
    phone: a.phone,
    line1: a.line1,
    line2: a.line2,
    suburb: a.suburb,
    region: a.region,
    postcode: a.postcode,
    deliveryNotes: a.deliveryNotes,
    countryCode: a.countryCode,
  };
  const delivers = await deps.shipping.deliversTo(context, a.postcode);
  if (!delivers.ok) {
    // A stored postcode the area check cannot read is outside every area; a failed read is not.
    return err(
      delivers.error.code === 'validation.failed'
        ? { code: 'ordering.outside-delivery-area' }
        : { code: 'ordering.check-unavailable' },
    );
  }
  return delivers.value ? ok(shipTo) : err({ code: 'ordering.outside-delivery-area' });
}

/**
 * `start-checkout`: the signed-in customer's cart becomes a pending order and a hosted payment
 * page. In order: copy the chosen delivery address (customers package 2) and check the Market
 * delivers there, read the cart (price and stock verdicts), plan sellers and totals, reserve the
 * stock for the whole checkout (all lines or none), store the order and its Stripe idempotency
 * key, create the Checkout session, store its id. Nothing is captured here. Any failure after
 * the reservation releases it and cancels the order.
 */
export async function startCheckout(
  deps: OrderingDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  input: StartCheckoutInput,
): Promise<Result<CheckoutStarted, StartCheckoutFailure>> {
  const placed = await placeOrder(deps, context, accountId, input, hostedPage(deps));
  if (!placed.ok) return placed;
  const { order, payBy, answer } = placed.value;
  return ok({ orderId: order.id, checkoutUrl: answer.url, payBy, total: order.total });
}

/** An order stored, its stock held and its payment started by a {@link PaymentStep}. */
export interface PlacedOrder<T> {
  readonly order: OrderState;
  readonly payBy: Temporal.Instant;
  readonly answer: T;
}

/** What a payment step is given once the order is stored and its stock is held. */
export interface ChargeRequest {
  readonly order: OrderState;
  /** One line per seller package, delivery and added tax, for the hosted page. */
  readonly packages: readonly { readonly label: string; readonly amount: bigint }[];
  readonly urls: { readonly success: string; readonly cancel: string };
  readonly payBy: Temporal.Instant;
}

/** What a payment step answers: how to link the provider's object to the order, and the answer. */
export interface Charged<T> {
  readonly link: (order: OrderState) => OrderState;
  /** Whether the order already carries this provider object (a webhook got there first). */
  readonly isLinked: (order: OrderState) => boolean;
  readonly answer: T;
}

/**
 * The part of checkout that differs between the hosted page and a card payment on our own page.
 * Everything before it (address, cart, prices, delivery, tax, stock) is shared, so both ways
 * price the order on the server and never take a price from the client.
 */
export interface PaymentStep<T> {
  /** After the total is known, before anything is reserved: a refusal here costs nothing. */
  precheck(total: Money): Promise<StartCheckoutFailure | null>;
  /** After the order is stored and its stock is held. */
  charge(request: ChargeRequest): Promise<Result<Charged<T>, StartCheckoutFailure>>;
  /** The link could not be stored: stop whatever {@link charge} opened. Best effort. */
  undo(charged: Charged<T>): Promise<void>;
}

function hostedPage(
  deps: OrderingDependencies,
): PaymentStep<{ readonly url: string; readonly sessionId: string }> {
  return {
    precheck: () => Promise.resolve(null),
    async charge({ order, packages, urls, payBy }) {
      const session = await deps.gateway.createSession({
        orderId: order.id,
        marketId: order.marketId,
        currency: order.total.currency,
        packages,
        successUrl: urls.success,
        cancelUrl: urls.cancel,
        expiresAt: payBy,
        idempotencyKey: order.stripeIdempotencyKey,
      });
      if (!session.ok) return err({ code: 'ordering.payment-unavailable' } as const);
      const { sessionId, url } = session.value;
      return ok({
        link: (fresh: OrderState) => ({ ...fresh, stripeSessionId: sessionId }),
        isLinked: (fresh: OrderState) => fresh.stripeSessionId === sessionId,
        answer: { url, sessionId },
      });
    },
    async undo(charged) {
      await deps.gateway.expireSession(charged.answer.sessionId);
    },
  };
}

/**
 * The shared checkout: in order, the address, the cart, the plan and prices, the stock hold, the
 * stored order, then the payment step's charge and the link of its object to the order.
 */
export async function placeOrder<T>(
  deps: OrderingDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  input: StartCheckoutInput,
  step: PaymentStep<T>,
): Promise<Result<PlacedOrder<T>, StartCheckoutFailure>> {
  const notes = parseSellerNotes(input?.sellerNotes);
  if (!notes.ok) {
    return err({ code: 'validation.failed', fields: [{ path: notes.path, code: notes.code }] });
  }
  const choices = parseDeliveryChoices(input?.deliveryMethods, deps.clock.now());
  if (!choices.ok) return err({ code: 'validation.failed', fields: choices.fields });
  const code = parseDiscountCode(input?.code);
  if (!code.ok)
    return err({ code: 'validation.failed', fields: [{ path: 'code', code: 'format' }] });
  // Whether a code applies is an answer about the code, so trying codes is counted per account
  // (applied or not, so the limit itself tells nothing): a few per window, never a guessing
  // oracle. A counter that cannot be read refuses the attempt (fail closed).
  if (code.code !== null) {
    try {
      const counted = await deps.attempts.count(
        `discount-code:${context.market.marketId}:${accountId}`,
      );
      if (counted.count > DISCOUNT_CODE_ATTEMPTS_PER_WINDOW) {
        return err({ code: 'request.throttled', retryAfterSeconds: counted.retryAfterSeconds });
      }
    } catch {
      return err({ code: 'ordering.check-unavailable' });
    }
  }
  const address = await readShipTo(deps, context, input?.addressId);
  if (!address.ok) return address;
  const read = await deps.cart.checkoutLines(context);
  if (!read.ok) {
    if (read.error.code === 'cart.not-ready') {
      return err({ code: 'ordering.cart-not-ready', sellers: read.error.details.sellers });
    }
    return err(
      read.error.code === 'access.denied'
        ? { code: 'access.denied' }
        : { code: 'ordering.check-unavailable' },
    );
  }
  const planned = planOrder(read.value, { maxLines: deps.policy.maxLines() });
  if (!planned.ok) return err(planned.error);
  // The buyer's method per seller (a choice for a seller not in the cart is dropped), checked
  // against the delivery-method policy before anything is reserved.
  const choiceOf = (sellerId: Id<'Seller'>): DeliveryChoice =>
    choices.choices.get(sellerId) ?? { method: DEFAULT_DELIVERY_METHOD, window: null };
  const refused: Id<'Seller'>[] = [];
  // The preparation minutes the Market gives each seller, frozen on its seller order.
  const prepMinutes = new Map<Id<'Seller'>, number | null>();
  for (const { sellerId } of planned.plan.sellers) {
    const choice = choiceOf(sellerId);
    if (!(await deps.deliveryMethods.allows(context, sellerId, choice.method, choice.window))) {
      refused.push(sellerId);
      continue;
    }
    prepMinutes.set(
      sellerId,
      await deps.deliveryMethods.readyPrepMinutes(context, sellerId, choice.method, choice.window),
    );
  }
  if (refused.length > 0) {
    return err({ code: 'ordering.delivery-method-unavailable', methodSellerIds: refused });
  }
  // In-person pickup (owner decision): offered by every seller with an approved pickup address,
  // free of any delivery fee. A failed read refuses the checkout; it is never "no address".
  const pickupSellers = planned.plan.sellers
    .map((seller) => seller.sellerId)
    .filter((sellerId) => choiceOf(sellerId).method === 'pickup');
  if (pickupSellers.length > 0) {
    const available = await deps.shipping.pickupAvailability(context, pickupSellers);
    if (!available.ok) {
      return err(
        available.error.code === 'access.denied'
          ? { code: 'access.denied' }
          : { code: 'ordering.check-unavailable' },
      );
    }
    const without = pickupSellers.filter((sellerId) => !available.value.has(sellerId));
    if (without.length > 0) {
      return err({ code: 'ordering.pickup-unavailable', methodSellerIds: without });
    }
  }
  // The delivery price of each seller order is the fleet's live quote plus the Market's margin,
  // asked and stored by shipping (never a price the client sends), for the sellers that deliver;
  // a pickup is free. Only the postcode, suburb and region of the saved address go to a fleet.
  const dropoff = {
    postcode: address.value.postcode,
    locality: address.value.suburb,
    region: address.value.region,
  };
  const charges = new Map<Id<'Seller'>, QuotedDelivery>();
  const changed: {
    sellerId: Id<'Seller'>;
    quoteId: string;
    total: Money;
    validUntil: string;
  }[] = [];
  const noFleet: Id<'Seller'>[] = [];
  const unknownQuote: string[] = [];
  for (const seller of planned.plan.sellers) {
    const choice = choiceOf(seller.sellerId);
    if (choice.method === 'pickup') continue;
    const charged = await deps.shipping.chargeDelivery(context, {
      seller: {
        sellerId: seller.sellerId,
        itemCount: seller.lines.reduce((count, line) => count + line.quantity, 0),
        declaredValueMinor: Number(seller.subtotal),
      },
      method: choice.method,
      quoteId: choice.quoteId ?? null,
      dropoff,
    });
    if (charged.ok) {
      charges.set(seller.sellerId, charged.value);
      continue;
    }
    switch (charged.error.code) {
      case 'access.denied':
        return err({ code: 'access.denied' });
      case 'shipping.quote-changed':
        changed.push({
          sellerId: seller.sellerId,
          quoteId: charged.error.quote.quoteId,
          total: charged.error.quote.total,
          validUntil: charged.error.quote.validUntil.toString(),
        });
        break;
      case 'shipping.quote-unavailable':
        noFleet.push(seller.sellerId);
        break;
      case 'shipping.quote-not-found':
        unknownQuote.push(`deliveryMethods.${seller.sellerId}.quoteId`);
        break;
      default:
        return err({ code: 'ordering.check-unavailable' });
    }
  }
  if (unknownQuote.length > 0) {
    return err({
      code: 'validation.failed',
      fields: unknownQuote.map((path) => ({ path, code: 'unknown' })),
    });
  }
  if (noFleet.length > 0) {
    return err({ code: 'ordering.delivery-method-unavailable', methodSellerIds: noFleet });
  }
  if (changed.length > 0) return err({ code: 'ordering.delivery-quote-changed', quotes: changed });
  const fees = new Map<Id<'Seller'>, Money>(
    planned.plan.sellers.map((seller) => [
      seller.sellerId,
      charges.get(seller.sellerId)?.total ?? money(0n, planned.plan.currency),
    ]),
  );
  const priced = addShipping(planned.plan, fees);
  if (!priced.ok) {
    // A quote in another currency than the cart's: shipping and the cart disagree on the Market.
    return err({ code: 'ordering.check-unavailable' });
  }
  const plan = priced.plan;
  // A note to a seller that is no longer in the cart is dropped: the cart may have changed since
  // the page was drawn, and the note has nobody to go to.
  const sellerNotes = Object.fromEntries(
    plan.sellers.flatMap(({ sellerId }) => {
      const note = notes.notes.get(sellerId);
      return note === undefined ? [] : [[sellerId, note] as const];
    }),
  );
  // The address and the notes are sealed under the account's key before anything is reserved.
  const shipToSealed = await deps.shipTo.seal(context.market, accountId, {
    ...address.value,
    ...(Object.keys(sellerNotes).length > 0 ? { sellerNotes } : {}),
  });
  // The account was erased between the read and the seal: its address is gone.
  if (!shipToSealed.ok) return err({ code: 'ordering.address-not-found' });
  // The buyer's exclusive seller (customers phase 4b), asked once. Any failure means none: the
  // standard rate (fail closed on the platform's side, never a lower rate by mistake).
  const exclusive: ExclusiveBuyer | null = await deps.customers.ownExclusiveSeller(context).then(
    (read) => (read.ok ? read.value : null),
    () => null,
  );
  // The commission rate of each seller is frozen on its lines now (COM-04); no rate, no order.
  // The exclusive seller's lines get the Market's lower rate while its window is open.
  const rates = await deps.commission.commissionRates(
    context,
    plan.sellers.map((seller) => seller.sellerId),
    exclusive,
  );
  if (!rates.ok) {
    return err(
      rates.error.code === 'access.denied'
        ? { code: 'access.denied' }
        : { code: 'ordering.check-unavailable' },
    );
  }

  // The tax of each line is frozen on it now (ADR-0039 decision 4); no tax answer, no order.
  const planLines = plan.sellers.flatMap((seller) => seller.lines);
  let categories: ReadonlyMap<Id<'Offer'>, string>;
  let products: ReadonlyMap<Id<'Offer'>, Id<'Product'>>;
  try {
    const offerIds = planLines.map((line) => line.offerId);
    categories = await deps.taxCategories.categoriesOf(context, offerIds);
    // Promotions target products: each line's product goes into the quote (package T2).
    products = await deps.products.productsOf(context, offerIds);
  } catch {
    return err({ code: 'ordering.check-unavailable' });
  }
  // A bought Offer has a published product, so its category is known; one that is not is a
  // failed check, never a silent default rate.
  if (planLines.some((line) => !categories.has(line.offerId) || !products.has(line.offerId))) {
    return err({ code: 'ordering.check-unavailable' });
  }
  const provisionalTaxBps = deps.policy.provisionalTaxBps(context.market);
  if (provisionalTaxBps === null) return err({ code: 'ordering.check-unavailable' });
  // Whether this is the customer's first order comes from ordering's own paid orders only.
  const history = await deps.unitOfWork.run<boolean, never>(
    context.market,
    async () => ok(await deps.orders.hasPaidOrder(context.market, accountId)),
    { readOnly: true },
  );
  if (!history.ok) return err({ code: 'ordering.check-unavailable' });
  const pricing: PricingInput = {
    accountId,
    plan,
    rates: rates.value,
    categories,
    products,
    methodOf: (sellerId) => choiceOf(sellerId).method,
    zone: deps.policy.deliveryZone(context.market, address.value.postcode),
    code: code.code,
    isFirstOrder: !history.value,
    provisionalTaxBps,
  };
  // The discounts, the tax on what the buyer pays after them, and the totals (package T2).
  const prices = await priceOrder(deps, context, pricing);
  if (!prices.ok) return prices;
  // A code that gives nothing is refused before anything is reserved: the buyer typed it to pay
  // less, so the order is never placed at the full price without telling them.
  if (code.code !== null && !prices.value.discounts.codeApplied) {
    return err({ code: 'ordering.discount-code-not-applied' });
  }
  const { discounts, lineTax, shippingTax, shippingInclusive, addedTax, sellerTotals, total } =
    prices.value;
  const lineDiscount = (line: { offerId: Id<'Offer'>; variantId: Id<'Variant'> }) =>
    discounts.lines.get(lineKeyOf(line)) ?? NO_DISCOUNT;
  const shippingDiscount = (sellerId: Id<'Seller'>): bigint =>
    discounts.shipping.get(sellerId) ?? 0n;
  // An order the discounts make free has nothing to charge, and a payment page needs an amount:
  // it is refused before anything is reserved or redeemed (orders at no cost are not built).
  if (total <= 0n) return err({ code: 'ordering.check-unavailable' });
  // The payment step may refuse now (the total moved, the card is not accepted): nothing is
  // reserved yet, so a refusal here costs nothing.
  const turnedDown = await step.precheck(money(total, plan.currency));
  if (turnedDown !== null) return err(turnedDown);

  const orderId = deps.ids.next<'Order'>();
  const urls = deps.policy.returnUrls(context.market, orderId);
  if (urls === null) return err({ code: 'ordering.payment-unavailable' });

  const reserved = await reserveWithRetry(
    deps,
    context,
    orderId,
    plan.sellers.flatMap((seller) =>
      seller.lines.map(({ offerId, variantId, quantity }) => ({ offerId, variantId, quantity })),
    ),
  );
  if (!reserved.ok) {
    const failure = reserved.error;
    switch (failure.code) {
      case 'inventory.insufficient':
        return err({ code: 'ordering.stock-insufficient', lines: failure.details.lines });
      case 'request.throttled':
        return err(failure);
      case 'access.unavailable':
        return err(failure);
      case 'conflict.retry':
        return err(failure);
      case 'access.denied':
        return err(failure);
      default:
        // Validation, batch size: the plan already respects them, so this is a fault.
        return err({ code: 'ordering.check-unavailable' });
    }
  }
  const reservation = reserved.value;
  const reservationLine = new Map(
    reservation.lines.map((line) => [`${line.offerId}/${line.variantId}`, line.reservationLineId]),
  );

  const now = deps.clock.now();
  const payBy = now.add({ milliseconds: deps.policy.sessionTtlMs() });
  const sellerOrders = plan.sellers.map((seller) => ({
    id: deps.ids.next<'SellerOrder'>(),
    seller,
  }));
  const lines: OrderLine[] = [];
  for (const { id: sellerOrderId, seller } of sellerOrders) {
    const rate = rates.value.get(seller.sellerId);
    for (const line of seller.lines) {
      const reservationLineId = reservationLine.get(lineKeyOf(line));
      const tax = lineTax.get(lineKeyOf(line))!;
      const discount = lineDiscount(line);
      if (reservationLineId === undefined || rate === undefined) {
        await deps.inventory.releaseOwnReservation(context, {
          reservationId: reservation.reservationId,
        });
        return err({ code: 'ordering.check-unavailable' });
      }
      lines.push({
        id: deps.ids.next<'OrderLine'>(),
        sellerOrderId,
        offerId: line.offerId,
        variantId: line.variantId,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineAmount: line.unitPrice.amount * BigInt(line.quantity),
        discountAmount: discount.amount,
        discountSellerShare: discount.sellerShare,
        discountPlatformShare: discount.platformShare,
        taxInclusive: line.taxInclusive,
        reservationLineId,
        commissionRateBps: rate.rateBps,
        commissionRateReason: rate.reason,
        exclusiveSeller: exclusive !== null && exclusive.sellerId === seller.sellerId,
        taxRateBps: tax.rateBps,
        taxAmount: tax.tax,
        taxCategoryCode: categories.get(line.offerId)!,
      });
    }
  }
  const order: OrderState = {
    id: orderId,
    marketId: context.market.marketId,
    accountId,
    status: 'pending-payment',
    cancelReason: null,
    paymentState: 'none',
    total: money(total, plan.currency),
    reservationId: reservation.reservationId,
    stripeIdempotencyKey: `checkout-${orderId}`,
    stripeSessionId: null,
    stripePaymentIntentId: null,
    paymentExpiresAt: payBy,
    createdAt: now,
    confirmedAt: null,
    cancelledAt: null,
    version: 1,
    taxStrategyId: prices.value.taxStrategyId,
    shipToSealed: shipToSealed.value,
    sellerOrders: sellerOrders.map(({ id, seller }) => ({
      id,
      sellerId: seller.sellerId,
      subtotal: seller.subtotal,
      shipping: seller.shipping,
      discount: seller.lines.reduce((sum, line) => sum + lineDiscount(line).amount, 0n),
      shippingDiscount: shippingDiscount(seller.sellerId),
      shippingTaxRateBps: shippingTax.get(seller.sellerId)!.rateBps,
      shippingTax: shippingTax.get(seller.sellerId)!.tax,
      shippingTaxInclusive: shippingInclusive.get(seller.sellerId)!,
      total: sellerTotals.get(seller.sellerId)!,
      fulfilment: 'to-ship' as const,
      carrier: null,
      trackingRef: null,
      shippedAt: null,
      deliveredAt: null,
      inventoryRecordedAt: null,
      ledgerState: 'pending' as const,
      deliveryMethod: choiceOf(seller.sellerId).method,
      deliveryWindow: choiceOf(seller.sellerId).window,
      readyAt: null,
      readyPrepMinutes: prepMinutes.get(seller.sellerId) ?? null,
      deliveryAttention: null,
      deliveryQuote: chargedQuoteOf(charges.get(seller.sellerId)),
    })),
    lines,
  };

  // The order, with its idempotency key, is stored before the provider is called.
  const stored = await deps.unitOfWork.run<true, StartCheckoutFailure>(context.market, async () => {
    await deps.orders.insert(context.market, order);
    return ok(true as const);
  });
  if (!stored.ok) {
    await deps.inventory.releaseOwnReservation(context, {
      reservationId: reservation.reservationId,
    });
    return stored;
  }

  // The order's discounts are reserved before anything is charged (package T2): promotions prices
  // the cart again under its locks and reserves exactly what the stored order holds, or refuses.
  // A refusal cancels the order (its event releases whatever was held) and frees the stock; the
  // buyer is told the new total and nothing is charged.
  if (hasDiscounts(discounts.summary)) {
    const redeemed = await redeemWithRetry(deps, context, {
      orderId,
      customerAccountId: accountId,
      request: discounts.request,
      expected: discounts.summary,
    });
    if (!redeemed.ok) {
      await abandon(deps, context, order, 'discount-changed');
      await deps.inventory.releaseOwnReservation(context, {
        reservationId: reservation.reservationId,
      });
      switch (redeemed.error.code) {
        case 'promotions.quote-changed':
        case 'promotions.redemption-released': {
          // The quote promotions answered used the old commission: price everything again.
          const again = await priceOrder(deps, context, pricing);
          if (!again.ok) return again;
          return err({
            code: 'ordering.price-changed',
            total: money(again.value.total, plan.currency),
          });
        }
        case 'conflict.retry':
          return err({ code: 'conflict.retry' });
        case 'access.denied':
          return err({ code: 'access.denied' });
        default:
          return err({ code: 'ordering.check-unavailable' });
      }
    }
  }

  // What the buyer pays per seller: the goods and the delivery net of their discounts, and the tax
  // added on top. The Stripe lines add up to the order's total.
  const packages = sellerOrders.flatMap(({ seller }, index) => {
    const goods =
      seller.subtotal - seller.lines.reduce((sum, line) => sum + lineDiscount(line).amount, 0n);
    const delivery = seller.shipping - shippingDiscount(seller.sellerId);
    // A part at no cost (goods discounted to zero, a free delivery) is no line: Stripe takes no
    // zero-priced item.
    return [
      ...(goods > 0n ? [{ label: `MondaPac order, package ${index + 1}`, amount: goods }] : []),
      ...(delivery > 0n ? [{ label: `Delivery, package ${index + 1}`, amount: delivery }] : []),
      ...(addedTax.get(seller.sellerId)! > 0n
        ? [{ label: `Tax, package ${index + 1}`, amount: addedTax.get(seller.sellerId)! }]
        : []),
    ];
  });
  const charged = await step.charge({ order, packages, urls, payBy });
  if (!charged.ok) {
    await abandon(deps, context, order, 'provider-failed');
    await deps.inventory.releaseOwnReservation(context, {
      reservationId: reservation.reservationId,
    });
    return charged;
  }

  let alreadyCancelled = false;
  const linked = await deps.unitOfWork.run<OrderState, StartCheckoutFailure>(
    context.market,
    async () => {
      // A signed webhook can land between this read and the save (the card was authorised and
      // the order confirmed already). A stale save then reads the order again: if it already
      // carries this payment, the link is done and the payment must not be undone.
      for (let attempt = 0; attempt < LINK_ATTEMPTS; attempt += 1) {
        const fresh = await deps.orders.findById(context.market, orderId);
        if (fresh === null) return err({ code: 'ordering.payment-unavailable' } as const);
        if (charged.value.isLinked(fresh)) {
          // The webhook confirmed and then cancelled the order (stock gone, capture refused):
          // it already voided the payment and released the stock. The buyer is told it failed.
          if (fresh.status === 'cancelled') {
            alreadyCancelled = true;
            return err({ code: 'ordering.payment-unavailable' } as const);
          }
          return ok(fresh);
        }
        // Another checkout of this customer superseded the order before the link: the payment
        // is undone (void, release) and the buyer is told it did not go through.
        if (fresh.status !== 'pending-payment') {
          return err({ code: 'ordering.payment-unavailable' } as const);
        }
        const next = charged.value.link(fresh);
        const saved = await deps.orders.save(context.market, next);
        if (saved === 'saved') return ok({ ...next, version: next.version + 1 });
      }
      return err({ code: 'conflict.retry' } as const);
    },
  );
  if (!linked.ok && alreadyCancelled) return linked;
  if (!linked.ok) {
    await step.undo(charged.value);
    await abandon(deps, context, order, 'provider-failed');
    await deps.inventory.releaseOwnReservation(context, {
      reservationId: reservation.reservationId,
    });
    return linked;
  }

  await supersedeOthers(deps, context, accountId, orderId);
  return ok({ order: linked.value, payBy, answer: charged.value.answer });
}

/**
 * Saves an order just cancelled with its {@link OrderCancelled} event, in the caller's unit:
 * promotions releases what the order reserved (package T2). False when another unit saved the
 * order first (nothing is written then).
 */
async function saveCancelled(
  deps: OrderingDependencies,
  context: CallContext,
  cancelled: OrderState,
): Promise<boolean> {
  if ((await deps.orders.save(context.market, cancelled)) !== 'saved') return false;
  await deps.outbox.append(context, [
    orderCancelledEvent({ id: cancelled.id, version: cancelled.version + 1 }, deps.clock.now()),
  ]);
  return true;
}

/** Cancels the stored order after a failure that follows its insert. */
async function abandon(
  deps: OrderingDependencies,
  context: CallContext,
  order: OrderState,
  reason: 'provider-failed' | 'discount-changed',
): Promise<void> {
  await deps.unitOfWork.run<true, never>(context.market, async () => {
    const fresh = await deps.orders.findById(context.market, order.id);
    const cancelled = fresh === null ? null : cancelOrder(fresh, reason, 'none', deps.clock.now());
    if (cancelled !== null) await saveCancelled(deps, context, cancelled);
    return ok(true as const);
  });
}

/**
 * The customer's earlier unpaid orders can no longer be paid: their stock hold was replaced by
 * this checkout's. Best effort; a late payment of an old session is voided when it arrives.
 */
async function supersedeOthers(
  deps: OrderingDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  keep: Id<'Order'>,
): Promise<void> {
  const pending = await deps.unitOfWork.run<readonly OrderState[], never>(
    context.market,
    async () => ok(await deps.orders.findPending(context.market, accountId)),
    { readOnly: true },
  );
  if (!pending.ok) return;
  for (const old of pending.value.filter((order) => order.id !== keep)) {
    const done = await deps.unitOfWork.run<boolean, never>(context.market, async () => {
      const fresh = await deps.orders.findById(context.market, old.id);
      const cancelled =
        fresh === null
          ? null
          : cancelOrder(fresh, 'superseded', fresh.paymentState, deps.clock.now());
      if (cancelled === null) return ok(false);
      return ok(await saveCancelled(deps, context, cancelled));
    });
    if (done.ok && done.value && old.stripeSessionId !== null) {
      await deps.gateway.expireSession(old.stripeSessionId);
    }
    // A card payment of the old order is stopped too (the same key as a cancel, so a repeat is
    // one call to Stripe). Best effort: Stripe refuses a PaymentIntent that is already cancelled.
    if (done.ok && done.value && old.stripePaymentIntentId !== null) {
      await deps.gateway.voidAuthorisation(
        old.stripePaymentIntentId,
        `void-${old.stripePaymentIntentId}`,
      );
    }
  }
}
