import { err, minorUnitExponent, ok, Temporal } from '@mondapac/shared-kernel';
import type { Clock, MarketContext, Money, Result } from '@mondapac/shared-kernel';
import type {
  CarrierBookingAnswer,
  CarrierBookingRequest,
  CarrierFailure,
  CarrierGateway,
  CarrierParcel,
  CarrierQuote,
  CarrierQuoteRequest,
  CarrierQuoteStop,
  CarrierStop,
  FleetCapabilities,
  FleetDeliveryStatus,
} from '../application/ports/carrier-gateway';
import { addressLineOf } from '../domain/carrier-stop';
import type { ConfigZoom2uPolicy, Zoom2uConfig } from './config-zoom2u-policy';
import {
  ZOOM2U_API_URLS,
  type Zoom2uCallFailure,
  type Zoom2uEndpoint,
  type Zoom2uHttpClient,
} from './zoom2u-http-client';

/** Zoom2u's booking references look like `T20200101999999`; the pattern keeps a path free of `/`. */
const ZOOM2U_REFERENCE = /^[A-Za-z0-9_-]{6,40}$/;

/**
 * Zoom2u's statuses as the uppercase carrier status codes of the port. Any other status is not
 * one we understand: the answer counts as no answer.
 */
const STATUS_CODES: Readonly<Record<string, string>> = Object.freeze({
  Unassigned: 'UNASSIGNED',
  Accepted: 'ACCEPTED',
  'On Route to Pickup': 'ON_ROUTE_TO_PICKUP',
  'Picked up': 'PICKED_UP',
  'On Route to Dropoff': 'ON_ROUTE_TO_DROPOFF',
  'Tried to deliver': 'TRIED_TO_DELIVER',
  'Dropped Off': 'DROPPED_OFF',
  Cancelled: 'CANCELLED',
  Returning: 'RETURNING',
  Returned: 'RETURNED',
  'On Hold - With Courier': 'ON_HOLD_WITH_COURIER',
});

/** A new booking waits for a courier: Zoom2u's create answer carries no status of its own. */
const NEW_BOOKING_STATUS = STATUS_CODES.Unassigned!;
const CANCELLED_STATUS = STATUS_CODES.Cancelled!;

/**
 * The adapter's pure mapping of the status codes above (Zoom2u's words in upper case, spaces and
 * hyphens as underscores) to the common fleet status. A courier who has the parcel (a failed
 * attempt, on hold, on the way back) is still `picked_up`: only `Returned` ends it. A word this
 * version does not know is null: it is taken as received and changes nothing.
 */
export function toFleetStatus(raw: string): FleetDeliveryStatus | null {
  switch (raw.toUpperCase()) {
    case 'UNASSIGNED':
      return 'pending';
    case 'ACCEPTED':
    case 'ON_ROUTE_TO_PICKUP':
      return 'assigned';
    case 'PICKED_UP':
    case 'ON_ROUTE_TO_DROPOFF':
    case 'TRIED_TO_DELIVER':
    case 'RETURNING':
    case 'ON_HOLD_WITH_COURIER':
      return 'picked_up';
    case 'DROPPED_OFF':
      return 'delivered';
    case 'CANCELLED':
      return 'cancelled';
    case 'RETURNED':
      return 'returned';
    default:
      return null;
  }
}

/**
 * A quote is kept this long per Market, stops, parcel and mode, as for Drive and Uber: a checkout
 * repeated in a loop asks Zoom2u once. The keys are postcodes, places and settings only, never
 * personal data. At most {@link QUOTE_CACHE_SIZE} are kept.
 */
export const QUOTE_CACHE_MS = 5 * 60_000;
const QUOTE_CACHE_SIZE = 1000;

const NOT_CONFIGURED: CarrierFailure = Object.freeze({ code: 'carrier.not-configured' as const });
const UNAVAILABLE: CarrierFailure = Object.freeze({ code: 'carrier.unavailable' as const });
const REFUSED: CarrierFailure = Object.freeze({ code: 'carrier.refused' as const });
const UNAUTHORIZED: CarrierFailure = Object.freeze({ code: 'carrier.unauthorized' as const });

const failureOf = (error: Zoom2uCallFailure): CarrierFailure =>
  error === 'refused' ? REFUSED : error === 'unauthorized' ? UNAUTHORIZED : UNAVAILABLE;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Zoom2u's price (a JSON decimal in the local currency) as Money in the Market's currency. A
 * price with more digits than the currency has, zero or a negative, a non-number or one beyond
 * the safe integers is not a price (a free quote is not one the router can trust).
 */
function priceOf(price: unknown, currency: string): Money | null {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return null;
  const factor = 10 ** minorUnitExponent(currency);
  const minor = Math.round(price * factor);
  if (!Number.isSafeInteger(minor) || minor <= 0 || Math.abs(minor / factor - price) > 1e-9) {
    return null;
  }
  return { amount: BigInt(minor), currency };
}

/** Minutes to Zoom2u's `deliveredBy` time, or null when the answer gives none we can read. */
function etaMinutesOf(body: Record<string, unknown>, now: Temporal.Instant): number | null {
  if (typeof body.deliveredBy !== 'string') return null;
  try {
    const minutes = Math.ceil(
      (Temporal.Instant.from(body.deliveredBy).epochMilliseconds - now.epochMilliseconds) / 60_000,
    );
    return Number.isInteger(minutes) && minutes >= 0 && minutes <= 10_080 ? minutes : null;
  } catch {
    return null;
  }
}

/**
 * Hosts a tracking link may point to: `zoom2u.com` and its subdomains. This allow-list comes from
 * Zoom2u's public site (tracking pages are on its own domain), not from a contract; widen it only
 * on evidence from the test account.
 */
export const ZOOM2U_TRACKING_HOSTS = Object.freeze({ exact: 'zoom2u.com', suffix: '.zoom2u.com' });

/** The tracking link re-serialised when it is a plain https URL on a Zoom2u host, else null. */
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
  if (host !== ZOOM2U_TRACKING_HOSTS.exact && !host.endsWith(ZOOM2U_TRACKING_HOSTS.suffix)) {
    return null;
  }
  return url.toString();
}

/** `YYYY-MM-DDTHH:MM:SSZ`, the UTC form Zoom2u's `ReadyDateTime` takes. */
const utcSeconds = (instant: Temporal.Instant): string =>
  instant.toString({ smallestUnit: 'second' });

const placeOf = (place: { readonly locality: string | null; readonly region: string | null }) => ({
  ...(place.locality === null || place.locality === '' ? {} : { Suburb: place.locality }),
  ...(place.region === null || place.region === '' ? {} : { State: place.region }),
});

/** Zoom2u's location object for a booking. Email is sent empty: it may be blank, not omitted. */
const locationOf = (stop: CarrierStop, country: string) => ({
  ContactName: stop.contactName,
  Email: '',
  Phone: stop.contactPhone.replace(/ /g, ''),
  Notes: stop.notes ?? '',
  FullAddress: addressLineOf(stop),
  ...placeOf(stop),
  Postcode: stop.postcode,
  Country: country,
});

/**
 * Zoom2u has no postcode-only form: a quote's stop (the port gives postcodes, and the locality
 * and region when they come from a validated address, on purpose) is those and the Market's
 * country with the rest blank; Zoom2u may refuse such a stop, which makes a quote an estimate.
 */
const quoteLocationOf = (stop: CarrierQuoteStop, country: string) => ({
  ContactName: '',
  Email: '',
  Phone: '',
  Notes: '',
  ...placeOf(stop),
  Postcode: stop.postcode,
  Country: country,
});

/**
 * The Zoom2u adapter of the fleet port (Phase 6 package 5c, an external fleet). Quotes with
 * `POST quote`, books with `POST create` (`PurchaseOrderNumber` is the seller order id, a label
 * only: Zoom2u documents no idempotency key, so a booking is sent once and never retried and
 * `idempotentBooking` is false), cancels with `POST cancel/{reference}` and reads a status with
 * `GET status/{reference}`. The service (`DeliverySpeed`) of an on-demand trip is the Market's
 * `instantSpeed`, `VIP` or `3 hour`; a scheduled one is `Same day` with the buyer's window start
 * as `ReadyDateTime` (the API documents no deadline field, so the window end is not sent). The
 * key comes from the Region Stack's secrets and the switch from the Market's `shipping.zoom2u`;
 * with either missing every call answers `carrier.not-configured` and sends nothing, and
 * `capabilities` is null (the router never offers it a trip). A parcel beyond the fleet's limits
 * is refused without a call.
 */
export class Zoom2uCarrier implements CarrierGateway {
  readonly #quotes = new Map<string, { readonly at: number; readonly quote: CarrierQuote }>();

  readonly fleet = 'zoom2u' as const;

  constructor(
    private readonly policy: ConfigZoom2uPolicy,
    private readonly http: Zoom2uHttpClient,
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
    // What the fleet is known to refuse is not sent. A scheduled trip needs its window.
    if (!this.accepts(target.config, request.mode, request.parcel, target.currency)) {
      return err(REFUSED);
    }
    if (request.mode === 'scheduled' && request.window === null) return err(REFUSED);
    const answer = await this.http.post(
      target.endpoint,
      'create',
      {
        PurchaseOrderNumber: request.externalReference,
        DeliverySpeed: this.speedOf(target.config, request.mode),
        ...this.timing(request.mode, request.window),
        PackageDescription: 'Order',
        Pickup: locationOf(request.pickup, target.country),
        Dropoff: locationOf(request.dropoff, target.country),
      },
      'book',
    );
    if (!answer.ok) return err(failureOf(answer.error));
    const { body } = answer.value;
    if (!isObject(body) || typeof body.reference !== 'string') return err(UNAVAILABLE);
    if (!ZOOM2U_REFERENCE.test(body.reference)) return err(UNAVAILABLE);
    return ok({
      carrierReference: body.reference,
      carrierStatus: NEW_BOOKING_STATUS,
      trackingUrl: trackingUrlOf(body['tracking-link']),
    });
  }

  async quote(
    market: MarketContext,
    request: CarrierQuoteRequest,
  ): Promise<Result<CarrierQuote, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    if (!this.accepts(target.config, request.mode, request.parcel, target.currency)) {
      return err(REFUSED);
    }
    const speed = this.speedOf(target.config, request.mode);
    const stops = {
      Pickup: quoteLocationOf(request.pickup, target.country),
      Dropoff: quoteLocationOf(request.dropoff, target.country),
    };
    // A quote has no window to price: a scheduled one is an estimate from the stops alone.
    const key = `${market.marketId}|${JSON.stringify({ ...stops, parcel: request.parcel, mode: request.mode }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`;
    const now = this.clock.now();
    const cached = this.#quotes.get(key);
    if (cached !== undefined && now.epochMilliseconds - cached.at < QUOTE_CACHE_MS) {
      return ok(cached.quote);
    }
    const answer = await this.http.post(
      target.endpoint,
      'quote',
      { DeliverySpeed: speed, ...stops },
      'quote',
    );
    if (!answer.ok) return err(failureOf(answer.error));
    const { body } = answer.value;
    // A single speed was asked for: the answer is that one option. Any other is not a price.
    if (!isObject(body) || (body.deliverySpeed !== undefined && body.deliverySpeed !== speed)) {
      return err(UNAVAILABLE);
    }
    const price = priceOf(body.price, target.currency);
    if (price === null) return err(UNAVAILABLE);
    const quote: CarrierQuote = { price, etaMinutes: etaMinutesOf(body, now), expiresAt: null };
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
    if (!ZOOM2U_REFERENCE.test(carrierReference)) return err(REFUSED);
    // A 200 with no body is the whole answer; a booking past "On Route to Pickup" is a 400, which
    // answers refused (the router takes it as "needs an admin check").
    const answer = await this.http.post(
      target.endpoint,
      `cancel/${carrierReference}`,
      undefined,
      'cancel',
    );
    if (!answer.ok) return err(failureOf(answer.error));
    return ok({ carrierStatus: CANCELLED_STATUS });
  }

  async status(
    market: MarketContext,
    carrierReference: string,
  ): Promise<
    Result<{ readonly status: FleetDeliveryStatus; readonly carrierStatus: string }, CarrierFailure>
  > {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    if (!ZOOM2U_REFERENCE.test(carrierReference)) return err(REFUSED);
    const answer = await this.http.get(target.endpoint, `status/${carrierReference}`);
    if (!answer.ok) return err(failureOf(answer.error));
    // Only the reference and the status are read: the answer also names the courier and links
    // proof of delivery, which never leave this function.
    const { body } = answer.value;
    if (!isObject(body) || body.reference !== carrierReference) return err(UNAVAILABLE);
    const { status } = body;
    if (typeof status !== 'string' || !Object.hasOwn(STATUS_CODES, status)) {
      return err(UNAVAILABLE);
    }
    const carrierStatus = STATUS_CODES[status]!;
    const common = toFleetStatus(carrierStatus);
    return common === null ? err(UNAVAILABLE) : ok({ status: common, carrierStatus });
  }

  /** Whether the fleet takes this mode and parcel: the Market's modes and limits. */
  private accepts(
    config: Zoom2uConfig,
    mode: 'on_demand' | 'scheduled',
    parcel: CarrierParcel,
    currency: string,
  ): boolean {
    const { limits } = config;
    return (
      config.modes.includes(mode) &&
      (mode === 'on_demand' || config.supportsWindow) &&
      config.temperatures.includes(parcel.temperature) &&
      parcel.weightGrams <= limits.maxItemWeightGrams &&
      parcel.itemCount <= limits.maxItems &&
      // A value in another currency cannot be compared: refuse rather than guess.
      parcel.declaredValue.currency === currency &&
      parcel.declaredValue.amount <= BigInt(limits.maxOrderValueMinor)
    );
  }

  /** On demand uses the configured instant service; a scheduled trip is a `Same day` one. */
  private speedOf(config: Zoom2uConfig, mode: 'on_demand' | 'scheduled'): string {
    return mode === 'on_demand' ? config.instantSpeed : 'Same day';
  }

  /**
   * On demand adds nothing. A scheduled trip is asked for the buyer's window start as the pickup
   * time (`ReadyDateTime`), not for a configured lead time. Zoom2u documents no deadline field.
   */
  private timing(
    mode: 'on_demand' | 'scheduled',
    window: CarrierBookingRequest['window'],
  ): { ReadyDateTime?: string } {
    return mode === 'scheduled' && window !== null
      ? { ReadyDateTime: utcSeconds(window.start) }
      : {};
  }

  /** The endpoint of the Market, or null when Zoom2u is off for it. */
  private target(market: MarketContext): {
    readonly endpoint: Zoom2uEndpoint;
    readonly config: Zoom2uConfig;
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
        apiUrl: ZOOM2U_API_URLS[config.environment],
        apiKey: settings.apiKey,
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
