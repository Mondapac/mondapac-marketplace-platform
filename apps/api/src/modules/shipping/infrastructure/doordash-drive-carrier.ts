import { randomUUID } from 'node:crypto';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Clock, MarketContext, Result } from '@mondapac/shared-kernel';
import type {
  CarrierBookingAnswer,
  CarrierBookingRequest,
  CarrierFailure,
  CarrierGateway,
  CarrierParcel,
  CarrierQuote,
  CarrierQuoteRequest,
  CarrierStop,
  FleetCapabilities,
  FleetDeliveryStatus,
} from '../application/ports/carrier-gateway';
import type {
  ConfigDoorDashDrivePolicy,
  DoorDashDriveConfig,
} from './config-doordash-drive-policy';
import {
  DOORDASH_API_URL,
  type DoorDashCallFailure,
  type DoorDashDriveEndpoint,
  type DoorDashDriveHttpClient,
} from './doordash-drive-http-client';

/**
 * Our `external_delivery_id` is the seller order id, and it is also the carrier reference we keep.
 * The pattern keeps a path free of `/` and `..`.
 */
const DELIVERY_ID = /^[A-Za-z0-9_-]{8,100}$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * DoorDash's `delivery_status` values as the upper-case carrier status codes of the port. `quote`
 * is a quote, not a delivery, so it is not here: an answer in that state counts as no answer.
 */
const STATUS_CODES: Readonly<Record<string, string>> = Object.freeze({
  created: 'CREATED',
  confirmed: 'CONFIRMED',
  enroute_to_pickup: 'ENROUTE_TO_PICKUP',
  arrived_at_pickup: 'ARRIVED_AT_PICKUP',
  picked_up: 'PICKED_UP',
  enroute_to_dropoff: 'ENROUTE_TO_DROPOFF',
  arrived_at_dropoff: 'ARRIVED_AT_DROPOFF',
  delivered: 'DELIVERED',
  enroute_to_return: 'ENROUTE_TO_RETURN',
  returned: 'RETURNED',
  cancelled: 'CANCELLED',
});

/**
 * The adapter's pure mapping of the status codes above to the common fleet status. A word this
 * version does not know is null: it is taken as received and changes nothing. A parcel on its
 * way back to the pickup (`ENROUTE_TO_RETURN`) is still with the courier, so it stays `picked_up`
 * until DoorDash says `RETURNED`.
 */
export function toFleetStatus(raw: string): FleetDeliveryStatus | null {
  switch (raw.toUpperCase()) {
    case 'CREATED':
      return 'pending';
    case 'CONFIRMED':
    case 'ENROUTE_TO_PICKUP':
    case 'ARRIVED_AT_PICKUP':
      return 'assigned';
    case 'PICKED_UP':
    case 'ENROUTE_TO_DROPOFF':
    case 'ARRIVED_AT_DROPOFF':
    case 'ENROUTE_TO_RETURN':
      return 'picked_up';
    case 'DELIVERED':
      return 'delivered';
    case 'CANCELLED':
      return 'cancelled';
    case 'RETURNED':
      return 'returned';
    default:
      return null;
  }
}

/** DoorDash holds a quote for five minutes; ours is treated as good for a little less. */
export const QUOTE_HOLD_MS = 270_000;
/** A quote is reused per Market, stops, parcel and mode this long (inside {@link QUOTE_HOLD_MS}). */
export const QUOTE_CACHE_MS = 240_000;
const QUOTE_CACHE_SIZE = 1000;

const NOT_CONFIGURED: CarrierFailure = Object.freeze({ code: 'carrier.not-configured' as const });
const UNAVAILABLE: CarrierFailure = Object.freeze({ code: 'carrier.unavailable' as const });
const REFUSED: CarrierFailure = Object.freeze({ code: 'carrier.refused' as const });
const UNAUTHORIZED: CarrierFailure = Object.freeze({ code: 'carrier.unauthorized' as const });
const NOT_SENT: CarrierFailure = Object.freeze({ code: 'carrier.not-sent' as const });

const failureOf = (error: DoorDashCallFailure): CarrierFailure =>
  error === 'refused' || error === 'conflict'
    ? REFUSED
    : error === 'unauthorized'
      ? UNAUTHORIZED
      : error === 'not-sent'
        ? NOT_SENT
        : UNAVAILABLE;

/** DoorDash's behaviours: instant and same day are on demand, a scheduled one has its time. */
const modeOf = (method: CarrierBookingRequest['method']): 'on_demand' | 'scheduled' =>
  method === 'scheduled' ? 'scheduled' : 'on_demand';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** DoorDash takes an address as one line: the street lines, locality, region and postcode, country. */
const addressOf = (
  country: string,
  place: {
    readonly postcode: string;
    readonly locality: string | null;
    readonly region: string | null;
  },
  lines: readonly string[],
): string => {
  const area = [place.locality, place.region, place.postcode]
    .filter((part): part is string => part !== null && part !== '')
    .join(' ');
  return [...lines, area, country].filter((part) => part !== '').join(', ');
};

/** DoorDash wants an international number; spaces are dropped and the rest is passed as given. */
const phoneOf = (phone: string): string => phone.replace(/ /g, '');

/** The parts of a stop DoorDash's create call takes, for the pickup or the drop-off. */
const pickupBody = (stop: CarrierStop, country: string) => ({
  pickup_address: addressOf(
    country,
    stop,
    stop.addressLines.filter((line) => line !== ''),
  ),
  pickup_business_name: stop.contactName,
  pickup_phone_number: phoneOf(stop.contactPhone),
  ...(stop.notes === null ? {} : { pickup_instructions: stop.notes }),
});

const dropoffBody = (stop: CarrierStop, country: string) => ({
  dropoff_address: addressOf(
    country,
    stop,
    stop.addressLines.filter((line) => line !== ''),
  ),
  dropoff_contact_given_name: stop.contactName,
  dropoff_phone_number: phoneOf(stop.contactPhone),
  ...(stop.notes === null ? {} : { dropoff_instructions: stop.notes }),
});

/**
 * A quote's stops are postcodes and places only (no name, phone or street, SHP-02/03). DoorDash's
 * quote call also asks for the business name, the contact name and both phone numbers, which a
 * quote request does not carry: generic labels stand in for the names and the phones are left
 * out. This is a known gap of the port (see the PR notes); a quote may be refused until the
 * sandbox account shows what DoorDash accepts.
 */
const quoteStopBody = (request: CarrierQuoteRequest, country: string) => ({
  pickup_address: addressOf(country, request.pickup, []),
  pickup_business_name: 'Pickup',
  dropoff_address: addressOf(country, request.dropoff, []),
  dropoff_contact_given_name: 'Customer',
});

/** Minutes from now to DoorDash's estimated drop-off time, or null when absent or not valid. */
function etaMinutesOf(body: Record<string, unknown>, now: Temporal.Instant): number | null {
  if (typeof body.dropoff_time_estimated !== 'string') return null;
  try {
    const minutes = Math.ceil(
      Temporal.Instant.from(body.dropoff_time_estimated).epochMilliseconds / 60_000 -
        now.epochMilliseconds / 60_000,
    );
    return Number.isInteger(minutes) && minutes >= 0 && minutes <= 10_080 ? minutes : null;
  } catch {
    return null;
  }
}

/**
 * DoorDash's quote answer as a price: `fee` in minor units (an integer) and the ISO currency, in
 * the Market's currency only; the estimate in minutes from `dropoff_time_estimated`; the quote
 * holds for five minutes from now. Every other field is dropped.
 */
function quoteOf(
  body: unknown,
  now: Temporal.Instant,
  marketCurrency: string,
): CarrierQuote | null {
  if (!isObject(body)) return null;
  const { fee } = body;
  // A free quote (0) is not a price the router can trust: require a positive fee.
  if (typeof fee !== 'number' || !Number.isSafeInteger(fee) || fee <= 0) return null;
  if (typeof body.currency !== 'string') return null;
  const currency = body.currency.toUpperCase();
  if (!CURRENCY.test(currency)) return null;
  // A price in another currency than the Market's cannot be compared or charged: no quote.
  if (currency !== marketCurrency) return null;
  return {
    price: { amount: BigInt(fee), currency },
    etaMinutes: etaMinutesOf(body, now),
    expiresAt: Temporal.Instant.fromEpochMilliseconds(now.epochMilliseconds + QUOTE_HOLD_MS),
  };
}

/**
 * Hosts a tracking link may point to: `doordash.com` and its subdomains. This allow-list comes
 * from DoorDash's public documentation, not from a contract; widen it only on evidence from the
 * sandbox account.
 */
export const DOORDASH_TRACKING_HOSTS = Object.freeze({
  exact: 'doordash.com',
  suffix: '.doordash.com',
});

/** The tracking link re-serialised when it is a plain https URL on a DoorDash host, else null. */
function trackingUrlOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return null;
  const host = url.hostname.toLowerCase();
  if (host !== DOORDASH_TRACKING_HOSTS.exact && !host.endsWith(DOORDASH_TRACKING_HOSTS.suffix)) {
    return null;
  }
  return url.toString();
}

/**
 * DoorDash's delivery as a reference and status code. Only the id, the status and the tracking
 * link are read: the answer also echoes both stops, which never leave this function. An answer
 * for another delivery, or one that is still a quote, is not one.
 */
function deliveryOf(body: unknown, expectedId: string): CarrierBookingAnswer | null {
  if (!isObject(body)) return null;
  const { external_delivery_id: id, delivery_status: status } = body;
  if (id !== expectedId || typeof status !== 'string') return null;
  if (!Object.hasOwn(STATUS_CODES, status)) return null;
  return {
    carrierReference: id,
    carrierStatus: STATUS_CODES[status]!,
    trackingUrl: trackingUrlOf(body.tracking_url),
  };
}

/**
 * The DoorDash Drive adapter of the fleet port (an external fleet). Quotes with
 * `POST /drive/v2/quotes` (a fresh `external_delivery_id` per quote, the fee held five minutes),
 * books with `POST /drive/v2/deliveries` (no quote is accepted: the price is the fleet's at
 * booking time), cancels with `PUT /drive/v2/deliveries/{id}/cancel` and reads a status with
 * `GET /drive/v2/deliveries/{id}`.
 *
 * Booking is idempotent: the `external_delivery_id` is the seller order id, which we supply. A
 * repeated create answers 409 (`duplicate_delivery_id`), which means "already booked": the
 * adapter reads that delivery back with a GET and returns it (a delivery found cancelled is
 * `carrier.refused`, so the router tries another fleet). Hence `idempotentBooking` is true and
 * the client may retry a booking. The carrier reference we keep is that same id.
 *
 * Credentials come from the Market's `shipping.doordashDrive` switch and the Region Stack's
 * secrets; with the switch off or a credential missing every call answers
 * `carrier.not-configured` and sends nothing, and `capabilities` is null. A parcel beyond the
 * fleet's limits is refused without a call.
 */
export class DoorDashDriveCarrier implements CarrierGateway {
  readonly #quotes = new Map<string, { readonly at: number; readonly quote: CarrierQuote }>();

  readonly fleet = 'doordash_drive' as const;

  constructor(
    private readonly policy: ConfigDoorDashDrivePolicy,
    private readonly http: DoorDashDriveHttpClient,
    private readonly clock: Clock,
  ) {}

  capabilities(market: MarketContext): FleetCapabilities | null {
    return this.policy.capabilities(market);
  }

  async book(
    market: MarketContext,
    request: CarrierBookingRequest,
  ): Promise<Result<CarrierBookingAnswer, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    const mode = modeOf(request.method);
    if (!this.accepts(target.config, mode, request.parcel, target.currency)) {
      return err(REFUSED);
    }
    if (mode === 'scheduled' && request.window === null) return err(REFUSED);
    const id = request.externalReference;
    if (!DELIVERY_ID.test(id)) return err(REFUSED);
    const created = await this.http.send(
      target.endpoint,
      'POST',
      'deliveries',
      {
        external_delivery_id: id,
        ...pickupBody(request.pickup, target.country),
        ...dropoffBody(request.dropoff, target.country),
        order_value: Number(request.parcel.declaredValue.amount),
        currency: request.parcel.declaredValue.currency,
        items: [{ name: 'Order', quantity: request.parcel.itemCount }],
        ...this.timing(mode, request.window),
      },
      'book',
    );
    if (!created.ok && created.error === 'conflict') {
      // Already booked under this id (a retry after a lost answer): read the delivery back.
      const existing = await this.http.send(
        target.endpoint,
        'GET',
        `deliveries/${id}`,
        undefined,
        'status',
      );
      if (!existing.ok) return err(failureOf(existing.error));
      const found = deliveryOf(existing.value.body, id);
      if (found === null) return err(UNAVAILABLE);
      // A cancelled delivery is not a booking: the router must not count it as one.
      return toFleetStatus(found.carrierStatus) === 'cancelled' ? err(REFUSED) : ok(found);
    }
    if (!created.ok) return err(failureOf(created.error));
    const delivery = deliveryOf(created.value.body, id);
    return delivery === null ? err(UNAVAILABLE) : ok(delivery);
  }

  async quote(
    market: MarketContext,
    request: CarrierQuoteRequest,
  ): Promise<Result<CarrierQuote, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    const mode = modeOf(request.method);
    if (!this.accepts(target.config, mode, request.parcel, target.currency)) {
      return err(REFUSED);
    }
    const stops = quoteStopBody(request, target.country);
    const orderValue = Number(request.parcel.declaredValue.amount);
    const key = `${market.marketId}|${JSON.stringify({
      ...stops,
      orderValue,
      weight: request.parcel.weightGrams,
      items: request.parcel.itemCount,
      mode,
    })}`;
    const now = this.clock.now();
    const cached = this.#quotes.get(key);
    if (
      cached !== undefined &&
      now.epochMilliseconds - cached.at < QUOTE_CACHE_MS &&
      (cached.quote.expiresAt === null || Temporal.Instant.compare(now, cached.quote.expiresAt) < 0)
    ) {
      return ok(cached.quote);
    }
    const answer = await this.http.send(
      target.endpoint,
      'POST',
      'quotes',
      {
        // Each quote needs an id of its own; it is not a delivery and is never used again.
        external_delivery_id: `quote-${randomUUID()}`,
        ...stops,
        order_value: orderValue,
        currency: request.parcel.declaredValue.currency,
      },
      'quote',
    );
    if (!answer.ok) return err(failureOf(answer.error));
    const quote = quoteOf(answer.value.body, now, target.currency);
    if (quote === null) return err(UNAVAILABLE);
    this.#quotes.delete(key);
    if (this.#quotes.size >= QUOTE_CACHE_SIZE) {
      // The oldest entry goes first: a Map iterates in insertion order.
      this.#quotes.delete(this.#quotes.keys().next().value!);
    }
    this.#quotes.set(key, { at: now.epochMilliseconds, quote });
    return ok(quote);
  }

  async cancel(
    market: MarketContext,
    carrierReference: string,
  ): Promise<Result<{ readonly carrierStatus: string }, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    if (!DELIVERY_ID.test(carrierReference)) return err(REFUSED);
    const answer = await this.http.send(
      target.endpoint,
      'PUT',
      `deliveries/${carrierReference}/cancel`,
      undefined,
      'cancel',
    );
    if (!answer.ok) return err(failureOf(answer.error));
    const delivery = deliveryOf(answer.value.body, carrierReference);
    return delivery === null ? err(UNAVAILABLE) : ok({ carrierStatus: delivery.carrierStatus });
  }

  async status(
    market: MarketContext,
    carrierReference: string,
  ): Promise<
    Result<{ readonly status: FleetDeliveryStatus; readonly carrierStatus: string }, CarrierFailure>
  > {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    if (!DELIVERY_ID.test(carrierReference)) return err(REFUSED);
    const answer = await this.http.send(
      target.endpoint,
      'GET',
      `deliveries/${carrierReference}`,
      undefined,
      'status',
    );
    if (!answer.ok) return err(failureOf(answer.error));
    const delivery = deliveryOf(answer.value.body, carrierReference);
    if (delivery === null) return err(UNAVAILABLE);
    const status = toFleetStatus(delivery.carrierStatus);
    return status === null
      ? err(UNAVAILABLE)
      : ok({ status, carrierStatus: delivery.carrierStatus });
  }

  /** Whether the fleet takes this mode and parcel: the Market's modes and limits. */
  private accepts(
    config: DoorDashDriveConfig,
    mode: 'on_demand' | 'scheduled',
    parcel: CarrierParcel,
    currency: string,
  ): boolean {
    const { limits } = config;
    return (
      config.modes.includes(mode) &&
      config.temperatures.includes(parcel.temperature) &&
      parcel.weightGrams <= limits.maxItemWeightGrams &&
      parcel.itemCount <= limits.maxItems &&
      // A value in another currency cannot be compared: refuse rather than guess.
      parcel.declaredValue.currency === currency &&
      parcel.declaredValue.amount <= BigInt(limits.maxOrderValueMinor)
    );
  }

  /**
   * On demand adds nothing. A scheduled trip is asked to arrive at the start of the buyer's
   * window (`dropoff_time`); DoorDash takes one time, not a window.
   */
  private timing(
    mode: 'on_demand' | 'scheduled',
    window: CarrierBookingRequest['window'],
  ): { dropoff_time?: string } {
    return mode === 'scheduled' && window !== null ? { dropoff_time: window.start.toString() } : {};
  }

  /** The endpoint of the Market, or null when DoorDash Drive is off for it. */
  private target(market: MarketContext): {
    readonly endpoint: DoorDashDriveEndpoint;
    readonly config: DoorDashDriveConfig;
    readonly country: string;
    readonly currency: string;
  } | null {
    const settings = this.policy.settings(market.marketId);
    if (settings === null) return null;
    const { config } = settings;
    return {
      config,
      country: settings.country,
      currency: settings.currency,
      endpoint: {
        marketId: market.marketId,
        apiUrl: DOORDASH_API_URL,
        developerId: settings.developerId,
        keyId: settings.keyId,
        signingSecret: settings.signingSecret,
        timeoutMs: config.timeoutMs,
        maxAttempts: config.maxAttempts,
        backoffMs: config.backoffMs,
        circuit: {
          failureThreshold: config.circuitBreaker.failureThreshold,
          cooldownMs: config.circuitBreaker.cooldownSeconds * 1000,
        },
      },
    };
  }
}
