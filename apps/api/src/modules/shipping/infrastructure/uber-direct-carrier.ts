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
  CarrierQuoteStop,
  FleetCapabilities,
  FleetDeliveryStatus,
} from '../application/ports/carrier-gateway';
import type { ConfigUberDirectPolicy, UberDirectConfig } from './config-uber-direct-policy';
import {
  UBER_API_URL,
  UBER_AUTH_URL,
  type UberCallFailure,
  type UberDirectEndpoint,
  type UberDirectHttpClient,
} from './uber-direct-http-client';

/** Uber's ids are `del_...` / `dqt_...` tokens; the pattern also keeps a path free of `/` and `..`. */
const UBER_ID = /^[A-Za-z0-9_-]{8,80}$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * Uber's delivery statuses as the uppercase carrier status codes of the port. Any other status is
 * not one we understand: the answer counts as no answer.
 */
const STATUS_CODES: Readonly<Record<string, string>> = Object.freeze({
  pending: 'PENDING',
  pickup: 'PICKUP',
  pickup_complete: 'PICKUP_COMPLETE',
  dropoff: 'DROPOFF',
  delivered: 'DELIVERED',
  canceled: 'CANCELED',
  returned: 'RETURNED',
});

/**
 * The adapter's pure mapping of the status codes above (Uber's words in upper case) to the common
 * fleet status. A word this version does not know is null: it is taken as received and changes
 * nothing.
 */
export function toFleetStatus(raw: string): FleetDeliveryStatus | null {
  switch (raw.toUpperCase()) {
    case 'PENDING':
      return 'pending';
    case 'PICKUP':
      return 'assigned';
    case 'PICKUP_COMPLETE':
    case 'DROPOFF':
      return 'picked_up';
    case 'DELIVERED':
      return 'delivered';
    case 'CANCELED':
      return 'cancelled';
    case 'RETURNED':
      return 'returned';
    default:
      return null;
  }
}

/**
 * A quote is kept this long per Market, stops, parcel and mode, as for Drive: a checkout repeated
 * in a loop asks Uber once (and never past the quote's own `expires`). The keys are postcodes,
 * places and settings only, never personal data. At most {@link QUOTE_CACHE_SIZE} are kept.
 */
export const QUOTE_CACHE_MS = 5 * 60_000;
const QUOTE_CACHE_SIZE = 1000;

const NOT_CONFIGURED: CarrierFailure = Object.freeze({ code: 'carrier.not-configured' as const });
const UNAVAILABLE: CarrierFailure = Object.freeze({ code: 'carrier.unavailable' as const });
const REFUSED: CarrierFailure = Object.freeze({ code: 'carrier.refused' as const });
const UNAUTHORIZED: CarrierFailure = Object.freeze({ code: 'carrier.unauthorized' as const });
const NOT_SENT: CarrierFailure = Object.freeze({ code: 'carrier.not-sent' as const });

const failureOf = (error: UberCallFailure): CarrierFailure =>
  error === 'refused'
    ? REFUSED
    : error === 'unauthorized'
      ? UNAUTHORIZED
      : error === 'not-sent'
        ? NOT_SENT
        : UNAVAILABLE;

/** Uber's two behaviours: instant and same day are on demand, a scheduled one has its window. */
const modeOf = (method: CarrierBookingRequest['method']): 'on_demand' | 'scheduled' =>
  method === 'scheduled' ? 'scheduled' : 'on_demand';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Uber's structured address, sent as the JSON text Uber's `*_address` fields take: the street
 * lines, the locality (`city`) and the region (`state`) when known, the postcode and the Market's
 * country. A quote's stop may have no street lines (Uber may refuse such a stop or price it from
 * the postcode's centre, which makes a quote an estimate); a booking has the full lines.
 */
const addressOf = (
  country: string,
  place: {
    readonly postcode: string;
    readonly locality: string | null;
    readonly region: string | null;
  },
  lines: readonly string[],
): string =>
  JSON.stringify({
    street_address: lines,
    ...(place.locality === null || place.locality === '' ? {} : { city: place.locality }),
    ...(place.region === null || place.region === '' ? {} : { state: place.region }),
    zip_code: place.postcode,
    country,
  });

/** Uber wants an international number; spaces are dropped and the rest is passed as given. */
const phoneOf = (phone: string): string => phone.replace(/ /g, '');

type Side = 'pickup' | 'dropoff';

/** The coordinates of a stop, when it has them (Uber takes them beside the address). */
const pointBody = (side: Side, location: { readonly lat: number; readonly lng: number } | null) =>
  location === null
    ? {}
    : { [`${side}_latitude`]: location.lat, [`${side}_longitude`]: location.lng };

/** The part of a stop Uber's create call takes, for `pickup` or `dropoff`. */
const stopBody = (side: Side, stop: CarrierStop, country: string) => ({
  [`${side}_name`]: stop.contactName,
  [`${side}_address`]: addressOf(
    country,
    { postcode: stop.postcode, locality: stop.locality, region: stop.region },
    stop.addressLines.filter((line) => line !== ''),
  ),
  ...pointBody(side, stop.location),
  [`${side}_phone_number`]: phoneOf(stop.contactPhone),
  ...(stop.notes === null ? {} : { [`${side}_notes`]: stop.notes }),
});

/** The part of a quote stop Uber's quote call takes (no name, phone or street). */
const quoteStopBody = (side: Side, stop: CarrierQuoteStop, country: string) => ({
  [`${side}_address`]: addressOf(country, stop, []),
});

/** Minutes as a whole number from Uber's `duration` (or the time to `dropoff_eta`), or null. */
function etaMinutesOf(body: Record<string, unknown>, now: Temporal.Instant): number | null {
  const ok = (minutes: number): boolean =>
    Number.isInteger(minutes) && minutes >= 0 && minutes <= 10_080;
  const { duration } = body;
  if (typeof duration === 'number' && Number.isFinite(duration)) {
    const minutes = Math.round(duration);
    return ok(minutes) ? minutes : null;
  }
  if (typeof body.dropoff_eta === 'string') {
    try {
      const minutes = Math.ceil(
        Temporal.Instant.from(body.dropoff_eta).epochMilliseconds / 60_000 -
          now.epochMilliseconds / 60_000,
      );
      return ok(minutes) ? minutes : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Uber's quote answer as a price: `fee` in minor units (an integer) and the ISO currency, read as
 * `currency_type` (upper case) or else `currency` (lower case in Uber's answers); with the
 * estimate in minutes (`duration`, or the time to `dropoff_eta`) and the quote's `expires`, each
 * null when absent or not valid. Every other field is dropped.
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
  const raw = typeof body.currency_type === 'string' ? body.currency_type : body.currency;
  if (typeof raw !== 'string') return null;
  const currency = raw.toUpperCase();
  if (!CURRENCY.test(currency)) return null;
  // A price in another currency than the Market's cannot be compared or charged: no quote.
  if (currency !== marketCurrency) return null;
  let expiresAt: Temporal.Instant | null = null;
  if (typeof body.expires === 'string') {
    try {
      expiresAt = Temporal.Instant.from(body.expires);
    } catch {
      expiresAt = null;
    }
  }
  return {
    price: { amount: BigInt(fee), currency },
    etaMinutes: etaMinutesOf(body, now),
    expiresAt,
  };
}

/**
 * Hosts a tracking link may point to: `uber.com` and its subdomains. This allow-list comes from
 * Uber's public documentation (tracking links are on Uber's own domains), not from a contract;
 * widen it only on evidence from the test account.
 */
export const UBER_TRACKING_HOSTS = Object.freeze({ exact: 'uber.com', suffix: '.uber.com' });

/** The tracking link re-serialised when it is a plain https URL on an Uber host, else null. */
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
  if (host !== UBER_TRACKING_HOSTS.exact && !host.endsWith(UBER_TRACKING_HOSTS.suffix)) {
    return null;
  }
  return url.toString();
}

/**
 * Uber's delivery as an id and status code. Only those two fields (and `external_id`, checked)
 * are read: the answer also echoes both stops, which never leave this function. An answer for
 * another reference is not one.
 */
function deliveryOf(body: unknown, externalReference: string | null): CarrierBookingAnswer | null {
  if (!isObject(body)) return null;
  const { id, status } = body;
  if (typeof id !== 'string' || !UBER_ID.test(id) || typeof status !== 'string') return null;
  if (!Object.hasOwn(STATUS_CODES, status)) return null;
  if (externalReference !== null && body.external_id !== externalReference) return null;
  return {
    carrierReference: id,
    carrierStatus: STATUS_CODES[status]!,
    trackingUrl: trackingUrlOf(body.tracking_url),
  };
}

/**
 * The Uber Direct adapter of the fleet port (Phase 6 package 5b, an external fleet). Quotes with
 * `POST delivery_quotes`, books with `POST deliveries` (the seller order id is `external_id`; its
 * dedupe by Uber is unverified, so a booking is a single attempt and `idempotentBooking` is false;
 * an open circuit or a token that could not be had for a non-credential reason answers
 * `carrier.not-sent`, as nothing left), cancels with `POST deliveries/{id}/cancel` and reads a
 * status with `GET deliveries/{id}`. The request's `method` picks the behaviour: an on-demand trip (instant, same day) carries no timing; a
 * scheduled one is booked for the buyer's window, sent as Uber's drop-off window. Credentials
 * come from the Market's `shipping.uberDirect` switch and the Region Stack's secrets; with the
 * switch off or a credential missing every call answers `carrier.not-configured` and sends
 * nothing, and `capabilities` is null (the router never offers it a trip). A parcel beyond the
 * fleet's limits is refused without a call.
 */
export class UberDirectCarrier implements CarrierGateway {
  readonly #quotes = new Map<string, { readonly at: number; readonly quote: CarrierQuote }>();

  readonly fleet = 'uber_direct' as const;

  constructor(
    private readonly policy: ConfigUberDirectPolicy,
    private readonly http: UberDirectHttpClient,
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
    const mode = modeOf(request.method);
    if (!this.accepts(target.config, mode, request.parcel, target.currency)) {
      return err(REFUSED);
    }
    if (mode === 'scheduled' && request.window === null) return err(REFUSED);
    const answer = await this.http.post(
      target.endpoint,
      'deliveries',
      {
        external_id: request.externalReference,
        ...stopBody('pickup', request.pickup, target.country),
        ...stopBody('dropoff', request.dropoff, target.country),
        manifest_items: [
          {
            name: 'Order',
            quantity: request.parcel.itemCount,
            weight: request.parcel.weightGrams,
          },
        ],
        manifest_total_value: Number(request.parcel.declaredValue.amount),
        ...this.timing(mode, request.window),
      },
      'book',
    );
    if (!answer.ok) return err(failureOf(answer.error));
    const delivery = deliveryOf(answer.value.body, request.externalReference);
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
    const stops = {
      ...quoteStopBody('pickup', request.pickup, target.country),
      ...quoteStopBody('dropoff', request.dropoff, target.country),
      manifest_total_value: Number(request.parcel.declaredValue.amount),
    };
    // A quote has no window to price: a scheduled one is an estimate from the stops alone.
    const key = `${market.marketId}|${JSON.stringify({
      ...stops,
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
    const answer = await this.http.post(target.endpoint, 'delivery_quotes', stops, 'quote');
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
    if (!UBER_ID.test(carrierReference)) return err(REFUSED);
    const answer = await this.http.post(
      target.endpoint,
      `deliveries/${carrierReference}/cancel`,
      {},
      'cancel',
    );
    if (!answer.ok) return err(failureOf(answer.error));
    const delivery = deliveryOf(answer.value.body, null);
    if (delivery === null || delivery.carrierReference !== carrierReference)
      return err(UNAVAILABLE);
    return ok({ carrierStatus: delivery.carrierStatus });
  }

  async status(
    market: MarketContext,
    carrierReference: string,
  ): Promise<
    Result<{ readonly status: FleetDeliveryStatus; readonly carrierStatus: string }, CarrierFailure>
  > {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    if (!UBER_ID.test(carrierReference)) return err(REFUSED);
    const answer = await this.http.get(target.endpoint, `deliveries/${carrierReference}`);
    if (!answer.ok) return err(failureOf(answer.error));
    const delivery = deliveryOf(answer.value.body, null);
    if (delivery === null || delivery.carrierReference !== carrierReference)
      return err(UNAVAILABLE);
    const status = toFleetStatus(delivery.carrierStatus);
    return status === null
      ? err(UNAVAILABLE)
      : ok({ status, carrierStatus: delivery.carrierStatus });
  }

  /** Whether the fleet takes this mode and parcel: the Market's modes and limits. */
  private accepts(
    config: UberDirectConfig,
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
   * On demand adds nothing. A scheduled trip is asked for the buyer's window as Uber's drop-off
   * window (`dropoff_ready_dt` to `dropoff_deadline_dt`), not for a configured lead time.
   */
  private timing(
    mode: 'on_demand' | 'scheduled',
    window: CarrierBookingRequest['window'],
  ): { dropoff_ready_dt?: string; dropoff_deadline_dt?: string } {
    return mode === 'scheduled' && window !== null
      ? {
          dropoff_ready_dt: window.start.toString(),
          dropoff_deadline_dt: window.end.toString(),
        }
      : {};
  }

  /** The endpoint of the Market, or null when Uber Direct is off for it. */
  private target(market: MarketContext): {
    readonly endpoint: UberDirectEndpoint;
    readonly config: UberDirectConfig;
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
        authUrl: UBER_AUTH_URL,
        apiUrl: UBER_API_URL,
        customerId: settings.customerId,
        clientId: settings.clientId,
        clientSecret: settings.clientSecret,
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
