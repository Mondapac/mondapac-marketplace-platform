import { Logger } from '@nestjs/common';
import { err, money, ok, parseId } from '@mondapac/shared-kernel';
import type { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { CarrierMethod } from '../domain/booking-service';
import { applyDeliveryMargin } from '../domain/delivery-margin';
import {
  isFresh,
  matchesScope,
  newDeliveryQuote,
  sameTotal,
  toQuotedDelivery,
  type DeliveryQuote,
  type MethodQuote,
  type QuotedDelivery,
  type QuoteScope,
  type SellerDeliveryQuotes,
} from '../domain/delivery-quote';
import type { DeliverySettings } from '../domain/delivery-settings';
import { isDeliveryMethod } from '../domain/delivery-methods';
import type { FleetNeed, FleetCode } from '../domain/fleet';
import {
  DEFAULT_RELIABILITY,
  DEFAULT_RULE,
  rankFleets,
  type Candidate,
} from '../domain/fleet-selection';
import { readAvailability } from './delivery-settings-flow';
import { capableFleets, quoteFleets } from './fleet-router';
import type { CarrierParcel, CarrierQuote, CarrierQuoteStop } from './ports/carrier-gateway';
import { sellerIdsOf } from './seller-ids';
import type { ShippingDependencies } from './shipping-dependencies';

// The delivery price a buyer is quoted and charged at checkout (delivery models, package 5). For a
// seller and a delivery method the fleets that can carry the order are asked for their price, the
// active selection model picks the fleet, and the buyer pays that fleet's quote plus the Market's
// margin. The quote is stored: checkout charges the stored quote and never a price the client
// sends. A quote holds 10 minutes (never past the fleet's own expiry) and is asked again after.
// The stops of a quote are the seller's approved pickup postcode and the buyer's saved address
// (SHP-02/03): never free text. Fleets are called outside every unit.

const logger = new Logger('ShippingDeliveryQuoteFlow');

/** At most this many sellers per call, so one cart never fans out into unbounded fleet calls. */
export const MAX_QUOTED_SELLERS = 10;

/** The methods a fleet quotes for; a pickup is free. */
export const QUOTED_METHODS: readonly CarrierMethod[] = ['instant', 'same_day', 'scheduled'];

/** An expired quote is kept this long (a day) before the buyer's next request removes it. */
const KEEP_EXPIRED_HOURS = 24;

type Field = { readonly path: string; readonly code: string };

export type DeliveryQuoteFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly Field[] }
  | { readonly code: 'shipping.unavailable' };

export type ChargeDeliveryFailure =
  | DeliveryQuoteFailure
  /** The quote id is unknown, or it is another buyer's, seller's, method's or address's. */
  | { readonly code: 'shipping.quote-not-found' }
  /** No fleet can carry the order, or none gave a price now. */
  | { readonly code: 'shipping.quote-unavailable' }
  /** The quote the buyer saw had expired and the price is now different: show `quote` and ask again. */
  | { readonly code: 'shipping.quote-changed'; readonly quote: QuotedDelivery };

/** The drop-off of a quote: the postcode of a saved address, and where it is when it says so. */
export interface QuoteDropoffInput {
  readonly postcode: string;
  readonly locality: string | null;
  readonly region: string | null;
}

const POSTCODE = /^[\x20-\x7e]{1,16}$/u;

const customerOf = (context: CallContext): Id<'Account'> | null => {
  const actor = context.actor;
  return actor.kind === 'authenticated' && actor.population === 'customer' ? actor.accountId : null;
};

const textOrNull = (value: unknown): string | null | undefined => {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && value.length <= 80 ? value : undefined;
};

function dropoffOf(raw: unknown): Result<QuoteDropoffInput, Field[]> {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const postcode = typeof value.postcode === 'string' ? value.postcode.trim() : '';
  const locality = textOrNull(value.locality);
  const region = textOrNull(value.region);
  const fields: Field[] = [
    ...(POSTCODE.test(postcode) ? [] : [{ path: 'dropoff.postcode', code: 'format' }]),
    ...(locality === undefined ? [{ path: 'dropoff.locality', code: 'format' }] : []),
    ...(region === undefined ? [{ path: 'dropoff.region', code: 'format' }] : []),
  ];
  if (fields.length > 0 || locality === undefined || region === undefined) return err(fields);
  return ok({ postcode, locality, region });
}

/** What a quote needs to know about one seller order's parcel (checkout reads it from the cart). */
export interface QuoteSellerInput {
  readonly sellerId: Id<'Seller'>;
  readonly itemCount: number;
  readonly declaredValueMinor: number;
}

function sellersOf(raw: unknown): Result<QuoteSellerInput[], Field[]> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_QUOTED_SELLERS) {
    return err([{ path: 'sellers', code: 'range' }]);
  }
  const ids = sellerIdsOf((raw as { sellerId?: unknown }[]).map((entry) => entry?.sellerId));
  if (!ids.ok) return err([{ path: 'sellers', code: 'format' }]);
  if (ids.value.length !== raw.length) return err([{ path: 'sellers', code: 'duplicate' }]);
  const sellers: QuoteSellerInput[] = [];
  const fields: Field[] = [];
  (raw as Record<string, unknown>[]).forEach((entry, index) => {
    const itemCount = entry.itemCount;
    const declared = entry.declaredValueMinor;
    if (
      !Number.isSafeInteger(itemCount) ||
      (itemCount as number) < 1 ||
      (itemCount as number) > 10_000
    ) {
      fields.push({ path: `sellers.${index}.itemCount`, code: 'range' });
    }
    if (!Number.isSafeInteger(declared) || (declared as number) < 0) {
      fields.push({ path: `sellers.${index}.declaredValueMinor`, code: 'range' });
    }
    sellers.push({
      sellerId: ids.value[index]!,
      itemCount: itemCount as number,
      declaredValueMinor: declared as number,
    });
  });
  return fields.length > 0 ? err(fields) : ok(sellers);
}

interface AskContext {
  readonly accountId: Id<'Account'>;
  readonly dropoff: QuoteDropoffInput;
  readonly settings: DeliverySettings;
  readonly currency: string;
  readonly now: Temporal.Instant;
}

/** The parcel of a quote: the Market's defaults, the seller order's item count and value. */
function parcelOf(
  deps: ShippingDependencies,
  context: CallContext,
  ask: AskContext,
  seller: QuoteSellerInput,
): CarrierParcel {
  const defaults = deps.carrierPolicy.parcelDefaults(context.market);
  return {
    weightGrams: defaults.weightGrams,
    volumeLitres: defaults.volumeLitres,
    temperature: defaults.temperature,
    itemCount: seller.itemCount,
    declaredValue: money(BigInt(seller.declaredValueMinor), ask.currency),
  };
}

/**
 * Asks the fleets that can carry the trip for their price and returns the quote of the one the
 * Market's active model ranks first among those that answered with a usable price. Nothing is
 * stored here.
 */
async function askFleets(
  deps: ShippingDependencies,
  context: CallContext,
  ask: AskContext,
  seller: QuoteSellerInput,
  method: CarrierMethod,
  pickupPostcode: string,
): Promise<DeliveryQuote | 'no-fleet' | 'failed'> {
  const { market } = context;
  const parcel = parcelOf(deps, context, ask, seller);
  const need: FleetNeed = {
    method,
    hasWindow: method === 'scheduled',
    temperature: parcel.temperature,
    heaviestItemGrams: parcel.weightGrams,
    itemCount: parcel.itemCount,
    declaredValue: parcel.declaredValue,
    classes: [],
    pickupArea: deps.carrierPolicy.serviceAreaOf(market, pickupPostcode),
    dropoffArea: deps.carrierPolicy.serviceAreaOf(market, ask.dropoff.postcode),
  };
  const capable = capableFleets(deps, context, need);
  if (capable.length === 0) return 'no-fleet';

  const pickup: CarrierQuoteStop = { postcode: pickupPostcode, locality: null, region: null };
  const dropoff: CarrierQuoteStop = ask.dropoff;
  const rankState = await deps.unitOfWork.run(
    market,
    async () =>
      ok({
        rule: await deps.selection.activeRule(market, method),
        reliability: await deps.selection.reliabilities(market),
      }),
    { readOnly: true },
  );
  if (!rankState.ok) return 'failed';
  const answers = await quoteFleets(deps, context, capable, {
    pickup,
    dropoff,
    parcel,
    method,
    mode: method === 'scheduled' ? 'scheduled' : 'on_demand',
  });
  const bounds = deps.policy.quoteBounds(market);
  // A price outside the Market's sanity range, in another currency, or already expired is a fleet
  // fault or a misconfiguration, never a price to charge.
  const usable = new Map<FleetCode, CarrierQuote>();
  for (const [fleet, answer] of answers) {
    const price = answer.price;
    const outOfBounds =
      bounds !== null &&
      (price.amount < BigInt(bounds.minMinor) || price.amount > BigInt(bounds.maxMinor));
    if (price.currency !== ask.currency || price.amount < 0n || outOfBounds) {
      logger.warn({
        msg: 'shipping.delivery-quote-unusable',
        fleet,
        reason: price.currency !== ask.currency ? 'currency' : 'bounds',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      continue;
    }
    usable.set(fleet, answer);
  }
  if (usable.size === 0) return 'failed';
  const candidates: Candidate[] = capable
    .filter(({ gateway }) => usable.has(gateway.fleet))
    .map(({ gateway }) => ({
      fleet: gateway.fleet,
      quote: {
        price: usable.get(gateway.fleet)!.price,
        etaMinutes: usable.get(gateway.fleet)!.etaMinutes,
      },
      reliability: rankState.value.reliability.get(gateway.fleet) ?? DEFAULT_RELIABILITY,
    }));
  // The fleets without a price are not candidates here (unlike at booking): the buyer is charged
  // the price of a fleet that gave one.
  const ranked = rankFleets(rankState.value.rule ?? DEFAULT_RULE, candidates);
  for (const fleet of ranked) {
    const answer = usable.get(fleet);
    if (answer === undefined) continue;
    const priced = applyDeliveryMargin(answer.price, ask.settings);
    const quote = newDeliveryQuote({
      id: deps.ids.next<'DeliveryQuote'>(),
      scope: {
        accountId: ask.accountId,
        sellerId: seller.sellerId,
        method,
        dropoffPostcode: ask.dropoff.postcode,
      },
      fleet,
      priced,
      etaMinutes: answer.etaMinutes,
      fleetExpiresAt: answer.expiresAt,
      now: ask.now,
    });
    if (quote !== null) return quote;
  }
  return 'failed';
}

/** The stored quotes still fresh for each (seller, method) of the request. */
async function freshQuotes(
  deps: ShippingDependencies,
  context: CallContext,
  ask: AskContext,
  scopes: readonly QuoteScope[],
): Promise<Result<ReadonlyMap<string, DeliveryQuote>, DeliveryQuoteFailure>> {
  const found = await deps.unitOfWork.run<ReadonlyMap<string, DeliveryQuote>, DeliveryQuoteFailure>(
    context.market,
    async () => {
      const quotes = new Map<string, DeliveryQuote>();
      for (const scope of scopes) {
        const quote = await deps.quotes.findFresh(context.market, scope, ask.now);
        if (quote !== null) quotes.set(`${scope.sellerId}/${scope.method}`, quote);
      }
      return ok(quotes);
    },
    { readOnly: true },
  );
  return found.ok ? found : err({ code: 'shipping.unavailable' });
}

/** Stores new quotes (one read-write unit) and removes the buyer's long-expired ones. */
async function storeQuotes(
  deps: ShippingDependencies,
  context: CallContext,
  ask: AskContext,
  quotes: readonly DeliveryQuote[],
): Promise<boolean> {
  if (quotes.length === 0) return true;
  const stored = await deps.unitOfWork.run<true, DeliveryQuoteFailure>(context.market, async () => {
    await deps.quotes.deleteExpired(
      context.market,
      ask.accountId,
      ask.now.subtract({ hours: KEEP_EXPIRED_HOURS }),
    );
    for (const quote of quotes) await deps.quotes.insert(context.market, quote);
    return ok(true as const);
  });
  return stored.ok;
}

/**
 * `quote-deliveries`: for each asked seller (at most 10) the delivery methods open now, and the
 * price of each delivering method that is open: reused while a stored quote of this buyer, seller,
 * method and address still holds, else asked of the fleets and stored. A pickup has no price.
 * A failed read of the settings or of the sellers' pickup details fails the whole answer, never
 * "everything is open".
 */
export async function quoteDeliveries(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly sellers: unknown; readonly dropoff: unknown },
): Promise<Result<ReadonlyMap<Id<'Seller'>, SellerDeliveryQuotes>, DeliveryQuoteFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const parsedSellers = sellersOf(input?.sellers);
  const parsedDropoff = dropoffOf(input?.dropoff);
  if (!parsedSellers.ok || !parsedDropoff.ok) {
    return err({
      code: 'validation.failed',
      fields: [
        ...(parsedSellers.ok ? [] : parsedSellers.error),
        ...(parsedDropoff.ok ? [] : parsedDropoff.error),
      ],
    });
  }
  const sellers = parsedSellers.value;
  const dropoff = parsedDropoff.value;
  const read = await readAvailability(
    deps,
    context,
    sellers.map((seller) => seller.sellerId),
  );
  if (!read.ok) return err({ code: 'shipping.unavailable' });
  const ask: AskContext = {
    accountId,
    dropoff,
    settings: read.value.settings,
    currency: deps.policy.currency(context.market),
    now: deps.clock.now(),
  };
  // The methods to price: delivering ones that are open for the seller, and the seller has a
  // pickup postcode to quote from.
  const wanted = sellers.flatMap((seller) => {
    const availability = read.value.availability.get(seller.sellerId)!;
    const pickupPostcode = read.value.pickupPostcodes.get(seller.sellerId) ?? null;
    return QUOTED_METHODS.filter((method) =>
      availability.methods.some((entry) => entry.method === method && entry.available),
    ).map((method) => ({ seller, method, pickupPostcode }));
  });
  const scopes = wanted.map(({ seller, method }): QuoteScope => ({
    accountId,
    sellerId: seller.sellerId,
    method,
    dropoffPostcode: dropoff.postcode,
  }));
  const fresh = await freshQuotes(deps, context, ask, scopes);
  if (!fresh.ok) return fresh;

  const asked = await Promise.all(
    wanted.map(async ({ seller, method, pickupPostcode }) => {
      const key = `${seller.sellerId}/${method}`;
      const reused = fresh.value.get(key);
      if (reused !== undefined) return { seller, method, answer: reused };
      // No pickup postcode, no trip to quote.
      if (pickupPostcode === null) return { seller, method, answer: 'no-fleet' as const };
      return {
        seller,
        method,
        answer: await askFleets(deps, context, ask, seller, method, pickupPostcode),
      };
    }),
  );
  const created = asked.flatMap(({ answer }) =>
    typeof answer === 'string' || fresh.value.has(`${answer.sellerId}/${answer.method}`)
      ? []
      : [answer],
  );
  if (!(await storeQuotes(deps, context, ask, created))) {
    return err({ code: 'shipping.unavailable' });
  }
  logger.log({
    msg: 'shipping.delivery-quotes',
    sellers: sellers.length,
    reused: fresh.value.size,
    asked: created.length,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });

  const answer = new Map<Id<'Seller'>, SellerDeliveryQuotes>();
  for (const seller of sellers) {
    const quotes: Partial<Record<CarrierMethod, MethodQuote>> = {};
    for (const entry of asked.filter((item) => item.seller.sellerId === seller.sellerId)) {
      quotes[entry.method] =
        entry.answer === 'no-fleet'
          ? { kind: 'no-fleet' }
          : entry.answer === 'failed'
            ? { kind: 'failed' }
            : { kind: 'quoted', quote: toQuotedDelivery(entry.answer) };
    }
    answer.set(seller.sellerId, {
      availability: read.value.availability.get(seller.sellerId)!,
      pickupPostcode: read.value.pickupPostcodes.get(seller.sellerId) ?? null,
      quotes,
    });
  }
  return ok(answer);
}

/**
 * `charge-delivery`: the delivery price checkout charges for one seller order. With a `quoteId`
 * (the price the buyer saw), the stored quote is charged while it holds; once it stopped holding
 * the fleets are asked again, and if the price is not the one the buyer saw the answer is
 * `shipping.quote-changed` with the new quote, so the buyer confirms it. Without a `quoteId` the
 * quote that holds is charged, or a new one is asked. The client never sends a price.
 */
export async function chargeDelivery(
  deps: ShippingDependencies,
  context: CallContext,
  input: {
    readonly seller: unknown;
    readonly method: unknown;
    readonly quoteId: unknown;
    readonly dropoff: unknown;
  },
): Promise<Result<QuotedDelivery, ChargeDeliveryFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const parsedSeller = sellersOf([input?.seller]);
  const parsedDropoff = dropoffOf(input?.dropoff);
  const method = isDeliveryMethod(input?.method) && input.method !== 'pickup' ? input.method : null;
  const asked = input?.quoteId !== null && input?.quoteId !== undefined;
  const quoteId =
    asked && typeof input.quoteId === 'string' ? parseId<'DeliveryQuote'>(input.quoteId) : null;
  if (
    !parsedSeller.ok ||
    !parsedDropoff.ok ||
    method === null ||
    (asked && (quoteId === null || !quoteId.ok))
  ) {
    return err({
      code: 'validation.failed',
      fields: [
        ...(parsedSeller.ok ? [] : parsedSeller.error),
        ...(parsedDropoff.ok ? [] : parsedDropoff.error),
        ...(method === null ? [{ path: 'method', code: 'value' }] : []),
        ...(asked && (quoteId === null || !quoteId.ok)
          ? [{ path: 'quoteId', code: 'format' }]
          : []),
      ],
    });
  }
  const seller = parsedSeller.value[0]!;
  const dropoff = parsedDropoff.value;
  const scope: QuoteScope = {
    accountId,
    sellerId: seller.sellerId,
    method,
    dropoffPostcode: dropoff.postcode,
  };
  const now = deps.clock.now();

  let seen: DeliveryQuote | null = null;
  if (quoteId !== null && quoteId.ok) {
    const found = await deps.unitOfWork.run<DeliveryQuote | null, ChargeDeliveryFailure>(
      context.market,
      async () => ok(await deps.quotes.findById(context.market, quoteId.value)),
      { readOnly: true },
    );
    if (!found.ok) return err({ code: 'shipping.unavailable' });
    // Another buyer's quote, or another seller's, method's or address's, is no quote at all.
    if (found.value === null || !matchesScope(found.value, scope)) {
      return err({ code: 'shipping.quote-not-found' });
    }
    seen = found.value;
    if (isFresh(seen, now)) return ok(toQuotedDelivery(seen));
  }

  const read = await readAvailability(deps, context, [seller.sellerId]);
  if (!read.ok) return err({ code: 'shipping.unavailable' });
  const ask: AskContext = {
    accountId,
    dropoff,
    settings: read.value.settings,
    currency: deps.policy.currency(context.market),
    now,
  };
  const current = await freshQuotes(deps, context, ask, [scope]);
  if (!current.ok) return current;
  let quote = current.value.get(`${seller.sellerId}/${method}`) ?? null;
  if (quote === null) {
    const pickupPostcode = read.value.pickupPostcodes.get(seller.sellerId);
    if (pickupPostcode === undefined) return err({ code: 'shipping.quote-unavailable' });
    const answer = await askFleets(deps, context, ask, seller, method, pickupPostcode);
    if (typeof answer === 'string') return err({ code: 'shipping.quote-unavailable' });
    if (!(await storeQuotes(deps, context, ask, [answer]))) {
      return err({ code: 'shipping.unavailable' });
    }
    quote = answer;
  }
  if (seen !== null && !sameTotal(seen, quote)) {
    logger.log({
      msg: 'shipping.delivery-quote-changed',
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: 'shipping.quote-changed', quote: toQuotedDelivery(quote) });
  }
  return ok(toQuotedDelivery(quote));
}
