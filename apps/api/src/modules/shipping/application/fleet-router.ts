import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { CarrierMethod } from '../domain/booking-service';
import {
  mismatchOf,
  type FleetCapabilities,
  type FleetCode,
  type FleetNeed,
} from '../domain/fleet';
import {
  DEFAULT_RELIABILITY,
  DEFAULT_RULE,
  needsQuotes,
  rankFleets,
  type Candidate,
} from '../domain/fleet-selection';
import type {
  CarrierBookingAnswer,
  CarrierBookingRequest,
  CarrierFailure,
  CarrierGateway,
  CarrierQuote,
  CarrierQuoteRequest,
  CarrierQuoteStop,
  CarrierStop,
} from './ports/carrier-gateway';
import type { ShippingDependencies } from './shipping-dependencies';

// The fleet router (delivery models, package 3): which fleet books a seller order. The fleets
// that can carry it (by what each declares for the Market) are ranked by the admin's active
// model for the Market and the buyer's method, and booked in that order. The next fleet is tried
// only when the one before said nothing was booked: not configured, refused, unauthorized, not-sent (all
// guaranteed to mean nothing was booked). When a fleet that cannot dedupe a repeated booking
// (`idempotentBooking: false`) goes quiet, the order may already be booked there: the router
// never repeats it and never tries another fleet, and the order needs an admin.

const logger = new Logger('ShippingFleetRouter');

export type RoutedBooking =
  | {
      readonly kind: 'booked';
      readonly fleet: FleetCode;
      readonly answer: CarrierBookingAnswer;
    }
  /** No fleet can carry the order (or the model's list leaves none). */
  | { readonly kind: 'no-fleet' }
  /** Every fleet that could carry it refused. */
  | { readonly kind: 'refused' }
  /** A fleet that cannot dedupe went quiet: the order may be booked there. Needs an admin. */
  | { readonly kind: 'unknown'; readonly fleet: FleetCode }
  /** A fleet that dedupes failed: retry later, the same fleet is tried first. */
  | { readonly kind: 'unavailable' };

const quoteStopOf = (stop: CarrierStop): CarrierQuoteStop => ({
  postcode: stop.postcode,
  locality: stop.locality === '' ? null : stop.locality,
  region: stop.region,
});

/** The fleets that can carry `need` in the Market, with what each declares. */
export function capableFleets(
  deps: ShippingDependencies,
  context: CallContext,
  need: FleetNeed,
): { readonly gateway: CarrierGateway; readonly capabilities: FleetCapabilities }[] {
  const found: { gateway: CarrierGateway; capabilities: FleetCapabilities }[] = [];
  for (const gateway of deps.fleets.all()) {
    const capabilities = gateway.capabilities(context.market);
    if (capabilities === null) continue;
    const mismatch = mismatchOf(capabilities, need);
    if (mismatch !== null) {
      logger.debug({
        msg: 'shipping.fleet-skipped',
        fleet: gateway.fleet,
        reason: mismatch,
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      continue;
    }
    found.push({ gateway, capabilities });
  }
  return found;
}

const warnUnauthorized = (context: CallContext, fleet: FleetCode, call: string): void => {
  // An operations problem (wrong or missing credentials): ids and codes only.
  logger.warn({
    msg: 'shipping.fleet-unauthorized',
    fleet,
    call,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
};

/**
 * Asks each of the fleets for its price of the trip, all at once; a fleet that does not answer is
 * absent from the answer (the caller treats it as no quote). The calls run outside every unit.
 */
export async function quoteFleets(
  deps: ShippingDependencies,
  context: CallContext,
  fleets: readonly { gateway: CarrierGateway; capabilities: FleetCapabilities }[],
  request: CarrierQuoteRequest,
): Promise<ReadonlyMap<FleetCode, CarrierQuote>> {
  const taken = new Map<FleetCode, CarrierQuote>();
  await Promise.all(
    fleets.map(async ({ gateway }) => {
      const quote = await gateway.quote(context.market, request);
      if (quote.ok) taken.set(gateway.fleet, quote.value);
      else if (quote.error.code === 'carrier.unauthorized') {
        warnUnauthorized(context, gateway.fleet, 'quote');
      }
    }),
  );
  return taken;
}

/** The quote a booking request stands for: the same trip, with the postcodes and places only. */
export const quoteRequestOf = (request: CarrierBookingRequest): CarrierQuoteRequest => ({
  pickup: quoteStopOf(request.pickup),
  dropoff: quoteStopOf(request.dropoff),
  parcel: request.parcel,
  method: request.method,
  mode: request.mode,
});

/**
 * Picks the fleet for a seller order and books it. The fleets are called outside every unit (the
 * attempt notes are their own small units, written before the call so a lost answer is never
 * forgotten).
 */
export async function routeBooking(
  deps: ShippingDependencies,
  context: CallContext,
  input: {
    readonly sellerOrderId: Id<'SellerOrder'>;
    readonly method: CarrierMethod;
    readonly need: FleetNeed;
    readonly request: CarrierBookingRequest;
    /**
     * The fleet the buyer was quoted and charged for, when there is one: it is tried first when it
     * can still carry the order, whatever the model ranks first now, so a booking goes to another
     * fleet (a fallback) only when the charged one is off, cannot carry it or says no.
     */
    readonly charged?: FleetCode | null;
  },
): Promise<RoutedBooking | { readonly kind: 'store-unavailable' }> {
  const { market } = context;
  const { sellerOrderId, method, need, request } = input;
  const charged = input.charged ?? null;
  const state = await deps.unitOfWork.run(
    market,
    async () =>
      ok({
        attempt: await deps.bookings.findAttempt(market, sellerOrderId),
        rule: await deps.selection.activeRule(market, method),
        reliability: await deps.selection.reliabilities(market),
      }),
    { readOnly: true },
  );
  if (!state.ok) return { kind: 'store-unavailable' };
  const { attempt, rule, reliability } = state.value;

  const capable = capableFleets(deps, context, need);

  // An earlier try went quiet: it may have booked. A fleet that dedupes is asked again, first;
  // one that cannot is never asked again (and nobody else is asked instead).
  let first: FleetCode | null = null;
  if (attempt !== null) {
    const earlier = deps.fleets.get(attempt);
    const declared = earlier?.capabilities(market) ?? null;
    if (declared === null || !declared.idempotentBooking) {
      logger.warn({
        msg: 'shipping.fleet-booking-unknown',
        fleet: attempt,
        sellerOrderId,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return { kind: 'unknown', fleet: attempt };
    }
    first = attempt;
  }

  const active = rule ?? DEFAULT_RULE;
  let candidates: Candidate[] = capable.map(({ gateway }) => ({
    fleet: gateway.fleet,
    quote: null,
    reliability: reliability.get(gateway.fleet) ?? DEFAULT_RELIABILITY,
  }));
  if (candidates.length > 1 && needsQuotes(active)) {
    const quotes = await quoteFleets(deps, context, capable, quoteRequestOf(request));
    candidates = candidates.map((c) => ({
      ...c,
      quote: quotes.has(c.fleet)
        ? {
            price: quotes.get(c.fleet)!.price,
            etaMinutes: quotes.get(c.fleet)!.etaMinutes,
          }
        : null,
    }));
  }
  let order = rankFleets(active, candidates);
  if (charged !== null && capable.some((c) => c.gateway.fleet === charged)) {
    order = [charged, ...order.filter((fleet) => fleet !== charged)];
  }
  if (first !== null) order = [first, ...order.filter((fleet) => fleet !== first)];
  if (first !== null && !order.includes(first)) {
    // The fleet that was asked can no longer take the order: it may still hold the booking.
    return { kind: 'unknown', fleet: first };
  }

  let refused = false;
  for (const fleet of order) {
    const entry = capable.find((c) => c.gateway.fleet === fleet)!;
    const noted = await deps.unitOfWork.run(market, async () => {
      await deps.bookings.markAttempt(market, sellerOrderId, fleet, deps.clock.now());
      return ok(true);
    });
    if (!noted.ok) return { kind: 'store-unavailable' };
    const answer: Result<CarrierBookingAnswer, CarrierFailure> = await entry.gateway.book(
      market,
      request,
    );
    if (answer.ok) return { kind: 'booked', fleet, answer: answer.value };
    const code = answer.error.code;
    logger.log({
      msg: 'shipping.fleet-booking',
      fleet,
      outcome: code,
      sellerOrderId,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    if (code === 'carrier.unavailable') {
      // The note stays: the order may be booked there.
      return entry.capabilities.idempotentBooking
        ? { kind: 'unavailable' }
        : { kind: 'unknown', fleet };
    }
    if (code === 'carrier.unauthorized') warnUnauthorized(context, fleet, 'book');
    if (code === 'carrier.refused') refused = true;
    // Not configured, refused, unauthorized, not-sent: nothing was booked. Drop the note, try the next.
    const cleared = await deps.unitOfWork.run(market, async () => {
      await deps.bookings.clearAttempt(market, sellerOrderId);
      return ok(true);
    });
    if (!cleared.ok) return { kind: 'store-unavailable' };
  }
  return refused ? { kind: 'refused' } : { kind: 'no-fleet' };
}
