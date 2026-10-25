import { err, minorUnitExponent, ok } from '@mondapac/shared-kernel';
import type { Clock, MarketContext, Money, Result } from '@mondapac/shared-kernel';
import type {
  CarrierBookingAnswer,
  CarrierBookingRequest,
  CarrierFailure,
  CarrierGateway,
  CarrierQuoteRequest,
  CarrierStop,
} from '../application/ports/carrier-gateway';
import { addressLineOf } from '../domain/carrier-stop';
import type { ConfigZoom2uPolicy, Zoom2uCapabilities } from './config-zoom2u-policy';
import { ZOOM2U_API_URLS, type Zoom2uEndpoint, type Zoom2uHttpClient } from './zoom2u-http-client';

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
 * A quote is kept this long per Market, postcode pair, parcel and mode, as for Drive and Uber: a
 * checkout repeated in a loop asks Zoom2u once. The keys are postcodes and settings only, never
 * personal data. At most {@link QUOTE_CACHE_SIZE} are kept.
 */
export const QUOTE_CACHE_MS = 5 * 60_000;
const QUOTE_CACHE_SIZE = 1000;

const NOT_CONFIGURED: CarrierFailure = Object.freeze({ code: 'carrier.not-configured' as const });
const UNAVAILABLE: CarrierFailure = Object.freeze({ code: 'carrier.unavailable' as const });
const REFUSED: CarrierFailure = Object.freeze({ code: 'carrier.refused' as const });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Zoom2u's price (a JSON decimal in the local currency) as Money in the Market's currency.
 * A price with more digits than the currency has, a negative, a non-number or one beyond the safe
 * integers is not a price.
 */
function priceOf(price: unknown, currency: string): Money | null {
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return null;
  const factor = 10 ** minorUnitExponent(currency);
  const minor = Math.round(price * factor);
  if (!Number.isSafeInteger(minor) || Math.abs(minor / factor - price) > 1e-9) return null;
  return { amount: BigInt(minor), currency };
}

/** `YYYY-MM-DDTHH:MM:SSZ`, the UTC form Zoom2u's `ReadyDateTime` takes. */
const utcSeconds = (instant: { toString(options: { smallestUnit: 'second' }): string }): string =>
  instant.toString({ smallestUnit: 'second' });

/** Zoom2u's location object for a booking. Email is sent empty: it may be blank, not omitted. */
const locationOf = (stop: CarrierStop, country: string) => ({
  ContactName: stop.contactName,
  Email: '',
  Phone: stop.contactPhone.replace(/ /g, ''),
  Notes: stop.notes ?? '',
  FullAddress: `${addressLineOf(stop)} ${stop.postcode}`,
  Country: country,
});

/**
 * Zoom2u has no postcode-only form: a quote's stop (the port gives postcodes only, on purpose) is
 * the postcode and the Market's country with the rest blank; Zoom2u may refuse such a stop, which
 * makes a quote an estimate at best.
 */
const quoteLocationOf = (postcode: string, country: string) => ({
  ContactName: '',
  Email: '',
  Phone: '',
  Notes: '',
  Postcode: postcode,
  Country: country,
});

/**
 * The Zoom2u adapter of the carrier port (Phase 6 package 5c, an external fleet). Quotes with
 * `POST quote` (one `DeliverySpeed`, from the Market's mode map), books with `POST create`
 * (`PurchaseOrderNumber` is the seller order id, a label only: Zoom2u documents no idempotency
 * key, so a booking is sent once and never retried), cancels with `POST cancel/{reference}` and
 * reads a status with `GET status/{reference}`. The key comes from the Region Stack's secrets and
 * the switch from the Market's `shipping.zoom2u`; with either missing every call answers
 * `carrier.not-configured` and sends nothing. Not registered as the active carrier anywhere: the
 * fleet router decides.
 */
export class Zoom2uCarrier implements CarrierGateway {
  readonly #quotes = new Map<string, { readonly at: number; readonly total: Money }>();

  constructor(
    private readonly policy: ConfigZoom2uPolicy,
    private readonly http: Zoom2uHttpClient,
    private readonly clock: Clock,
  ) {}

  /** What the fleet serves and takes in the Market, or null when it is off. Not on the port. */
  capabilities(market: MarketContext): Zoom2uCapabilities | null {
    return this.policy.capabilities(market);
  }

  async book(
    market: MarketContext,
    request: CarrierBookingRequest,
  ): Promise<Result<CarrierBookingAnswer, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    const { limits, modes } = target.config;
    // What the fleet is known to refuse is not sent.
    if (!modes.includes(request.mode) || request.parcel.weightGrams > limits.maxItemWeightGrams) {
      return err(REFUSED);
    }
    const answer = await this.http.post(
      target.endpoint,
      'create',
      {
        PurchaseOrderNumber: request.externalReference,
        DeliverySpeed: target.config.deliverySpeeds[request.mode],
        ...this.timing(request.mode, target.config.scheduledLeadMinutes),
        PackageDescription: 'Order',
        Pickup: locationOf(request.pickup, target.country),
        Dropoff: locationOf(request.dropoff, target.country),
      },
      'book',
    );
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    const { body } = answer.value;
    if (!isObject(body) || typeof body.reference !== 'string') return err(UNAVAILABLE);
    if (!ZOOM2U_REFERENCE.test(body.reference)) return err(UNAVAILABLE);
    return ok({ carrierReference: body.reference, carrierStatus: NEW_BOOKING_STATUS });
  }

  async quote(
    market: MarketContext,
    request: CarrierQuoteRequest,
  ): Promise<Result<Money, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    if (!target.config.modes.includes(request.mode)) return err(REFUSED);
    const speed = target.config.deliverySpeeds[request.mode];
    const stops = {
      Pickup: quoteLocationOf(request.pickup.postcode, target.country),
      Dropoff: quoteLocationOf(request.dropoff.postcode, target.country),
    };
    const key = `${market.marketId}|${JSON.stringify({ ...stops, parcel: request.parcel, mode: request.mode })}`;
    const now = this.clock.now().epochMilliseconds;
    const cached = this.#quotes.get(key);
    if (cached !== undefined && now - cached.at < QUOTE_CACHE_MS) return ok(cached.total);
    const answer = await this.http.post(
      target.endpoint,
      'quote',
      {
        DeliverySpeed: speed,
        ...this.timing(request.mode, target.config.scheduledLeadMinutes),
        ...stops,
      },
      'quote',
    );
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    const { body } = answer.value;
    // A single speed was asked for: the answer is that one option. Any other is not a price.
    if (!isObject(body) || (body.deliverySpeed !== undefined && body.deliverySpeed !== speed)) {
      return err(UNAVAILABLE);
    }
    const total = priceOf(body.price, target.currency);
    if (total === null) return err(UNAVAILABLE);
    this.#quotes.delete(key);
    if (this.#quotes.size >= QUOTE_CACHE_SIZE) {
      // The oldest entry goes first: a Map iterates in insertion order.
      this.#quotes.delete(this.#quotes.keys().next().value!);
    }
    this.#quotes.set(key, { at: now, total });
    return ok(total);
  }

  async cancel(
    market: MarketContext,
    carrierReference: string,
  ): Promise<Result<{ readonly carrierStatus: string }, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    if (!ZOOM2U_REFERENCE.test(carrierReference)) return err(REFUSED);
    // A 200 with no body is the whole answer; a booking past "On Route to Pickup" is a 400.
    const answer = await this.http.post(
      target.endpoint,
      `cancel/${carrierReference}`,
      undefined,
      'cancel',
    );
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    return ok({ carrierStatus: CANCELLED_STATUS });
  }

  /** The status of a booking, for polling where Zoom2u's webhook is not used. Not on the port. */
  async status(
    market: MarketContext,
    carrierReference: string,
  ): Promise<Result<{ readonly carrierStatus: string }, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    if (!ZOOM2U_REFERENCE.test(carrierReference)) return err(REFUSED);
    const answer = await this.http.get(target.endpoint, `status/${carrierReference}`);
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    // Only the reference and the status are read: the answer also names the courier and links
    // proof of delivery, which never leave this function.
    const { body } = answer.value;
    if (!isObject(body) || body.reference !== carrierReference) return err(UNAVAILABLE);
    const { status } = body;
    if (typeof status !== 'string' || !Object.hasOwn(STATUS_CODES, status)) {
      return err(UNAVAILABLE);
    }
    return ok({ carrierStatus: STATUS_CODES[status]! });
  }

  /** A scheduled trip asks for a pickup the configured lead from now; on demand adds nothing. */
  private timing(mode: 'on_demand' | 'scheduled', leadMinutes: number): { ReadyDateTime?: string } {
    return mode === 'scheduled'
      ? { ReadyDateTime: utcSeconds(this.clock.now().add({ minutes: leadMinutes })) }
      : {};
  }

  /** The endpoint of the Market, or null when Zoom2u is off for it. */
  private target(market: MarketContext): {
    readonly endpoint: Zoom2uEndpoint;
    readonly config: NonNullable<ReturnType<ConfigZoom2uPolicy['settings']>>['config'];
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
