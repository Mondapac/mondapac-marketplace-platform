import { err, minorUnitExponent, ok } from '@mondapac/shared-kernel';
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
import type { AusPostConfig, ConfigAusPostPolicy } from './config-auspost-policy';
import {
  AUSPOST_API_URLS,
  type AusPostCallFailure,
  type AusPostEndpoint,
  type AusPostHttpClient,
} from './auspost-http-client';

/** Australia Post's shipment and article ids are short alphanumeric strings; no `/` can pass. */
const ID = /^[A-Za-z0-9]{4,40}$/;
/**
 * Our carrier reference: the shipment id (to cancel it), then optionally `:` and the article id
 * (to track it), because the two calls name a parcel by different ids.
 */
const REFERENCE = /^([A-Za-z0-9]{4,40})(?::([A-Za-z0-9]{4,40}))?$/;

/**
 * Australia Post's tracking statuses as the uppercase carrier status codes of the port, keyed by
 * the lower-case status so that a change of case is not a new status. Any other status is not one
 * we understand: the answer counts as no answer.
 */
const STATUS_CODES: Readonly<Record<string, string>> = Object.freeze({
  created: 'CREATED',
  initiated: 'INITIATED',
  sealed: 'SEALED',
  'in transit': 'IN_TRANSIT',
  'awaiting collection': 'AWAITING_COLLECTION',
  'possible delay': 'POSSIBLE_DELAY',
  'unable to deliver': 'UNABLE_TO_DELIVER',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
});

const NEW_SHIPMENT_STATUS = STATUS_CODES.created!;
const CANCELLED_STATUS = STATUS_CODES.cancelled!;

/**
 * The adapter's pure mapping of the status codes above to the common fleet status, conservative
 * on purpose: only `DELIVERED` is delivered, and nothing is ever `failed` or `returned` on its
 * own (an "unable to deliver" parcel is carded, redelivered or returned later: the parcel is
 * still with the carrier). A word this version does not know is null: it is taken as received
 * and changes nothing.
 */
export function toFleetStatus(raw: string): FleetDeliveryStatus | null {
  switch (raw.toUpperCase()) {
    case 'CREATED':
    case 'INITIATED':
    case 'SEALED':
      return 'pending';
    case 'IN_TRANSIT':
    case 'AWAITING_COLLECTION':
    case 'POSSIBLE_DELAY':
    case 'UNABLE_TO_DELIVER':
      return 'picked_up';
    case 'DELIVERED':
      return 'delivered';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return null;
  }
}

/**
 * A quote is kept this long per Market, stops, parcel and mode, as for the other fleets: a
 * checkout repeated in a loop asks Australia Post once. The keys are postcodes, places and
 * settings only, never personal data. At most {@link QUOTE_CACHE_SIZE} are kept.
 */
export const QUOTE_CACHE_MS = 5 * 60_000;
const QUOTE_CACHE_SIZE = 1000;

const NOT_CONFIGURED: CarrierFailure = Object.freeze({ code: 'carrier.not-configured' as const });
const UNAVAILABLE: CarrierFailure = Object.freeze({ code: 'carrier.unavailable' as const });
const REFUSED: CarrierFailure = Object.freeze({ code: 'carrier.refused' as const });
const UNAUTHORIZED: CarrierFailure = Object.freeze({ code: 'carrier.unauthorized' as const });

const failureOf = (error: AusPostCallFailure): CarrierFailure =>
  error === 'refused' ? REFUSED : error === 'unauthorized' ? UNAUTHORIZED : UNAVAILABLE;

/** The API's field bounds: a name, an address line. */
const MAX_NAME = 40;
const MAX_LINE = 40;
const MAX_LINES = 3;

/** Longest delivery estimate we believe, in days. */
const MAX_ESTIMATE_DAYS = 60;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The first element of the array under `key` of a JSON object, or null. */
const firstOf = (value: unknown, key: string): unknown => {
  const list = isObject(value) ? value[key] : null;
  return Array.isArray(list) ? (list[0] as unknown) : null;
};

/**
 * Australia Post's price (a JSON decimal, or a decimal string) as Money in the Market's
 * currency. A price with more digits than the currency has, zero or a negative, a non-number or
 * one beyond the safe integers is not a price (a free quote is not one the router can trust).
 */
function priceOf(price: unknown, currency: string): Money | null {
  const value =
    typeof price === 'string' && /^\d{1,9}(\.\d{1,6})?$/.test(price) ? Number(price) : price;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  const factor = 10 ** minorUnitExponent(currency);
  const minor = Math.round(value * factor);
  if (!Number.isSafeInteger(minor) || minor <= 0 || Math.abs(minor / factor - value) > 1e-9) {
    return null;
  }
  return { amount: BigInt(minor), currency };
}

/** Minutes of a whole number of delivery-estimate days, or null when the answer gives none. */
function etaMinutesOf(price: Record<string, unknown>): number | null {
  const days = price.delivery_estimate_days;
  return typeof days === 'number' &&
    Number.isInteger(days) &&
    days >= 0 &&
    days <= MAX_ESTIMATE_DAYS
    ? days * 24 * 60
    : null;
}

/**
 * The buyer's tracking page for an article id: a constant https template on Australia Post's own
 * host, with the id (checked against {@link ID}) as its only variable part. The API's answer is
 * never trusted for a link.
 */
export const AUSPOST_TRACKING_URL = (articleId: string): string =>
  `https://auspost.com.au/mypost/track/#/details/${articleId}`;

/**
 * The parcel as the API's item: weight in kilograms and a cube of the same volume in whole
 * centimetres (the port carries a volume, not three dimensions), at least 1 cm a side.
 */
function itemOf(parcel: CarrierParcel, productId: string) {
  const side = Math.max(1, Math.round(Math.cbrt(parcel.volumeLitres * 1000)));
  return {
    product_id: productId,
    length: side,
    height: side,
    width: side,
    weight: Number((parcel.weightGrams / 1000).toFixed(3)),
  };
}

/** The locality as the API's suburb, and the region as its state, each only when it is given. */
const placeOf = (place: { readonly locality: string | null; readonly region: string | null }) => ({
  ...(place.locality === null || place.locality === ''
    ? {}
    : { suburb: place.locality.slice(0, MAX_LINE) }),
  ...(place.region === null || place.region === '' ? {} : { state: place.region }),
});

/**
 * The API's address of a stop: every address line is a street line (up to three), the locality is
 * the suburb and the region the state. The state is sent only when the address has one: core
 * logic does not infer it from a postcode.
 */
function addressOf(stop: CarrierStop) {
  const lines = stop.addressLines.filter((line) => line !== '').slice(0, MAX_LINES);
  return {
    name: stop.contactName.slice(0, MAX_NAME),
    lines: lines.map((line) => line.slice(0, MAX_LINE)),
    ...placeOf(stop),
    postcode: stop.postcode,
    phone: stop.contactPhone.replace(/ /g, ''),
  };
}

/** A quote's stop: the postcode, and the locality and region when they come from a saved address. */
const quoteAddressOf = (stop: CarrierQuoteStop) => ({ ...placeOf(stop), postcode: stop.postcode });

/**
 * The Australia Post adapter of the fleet port (Phase 6 package 5d, an external fleet for
 * scheduled, multi-day parcels outside the city fleets' service areas). Quotes with
 * `POST prices/items`, creates with `POST shipments` (the seller order id goes in
 * `sender_references` and `shipment_reference`, labels only: no idempotency key is documented,
 * so a create is sent once and never retried and `idempotentBooking` is false), cancels with
 * `DELETE shipments/{id}` (before a label or order exists) and reads a status with
 * `GET track?tracking_ids=`. Only the `scheduled` mode is served, and it has no buyer window:
 * delivery takes days, so a window on a booking is ignored (the capabilities say
 * `supportsWindow: false`, so the router never offers a windowed order to this fleet). A trip
 * that is `on_demand`, a parcel that is not ambient, or one beyond the fleet's limits is refused
 * without a call. The credentials come from the Region Stack's secrets and the switch from the
 * Market's `shipping.auspost`; with either missing every call answers `carrier.not-configured`
 * and sends nothing, and `capabilities` is null (the router never offers it a trip).
 */
export class AusPostCarrier implements CarrierGateway {
  readonly #quotes = new Map<string, { readonly at: number; readonly quote: CarrierQuote }>();

  readonly fleet = 'auspost' as const;

  constructor(
    private readonly policy: ConfigAusPostPolicy,
    private readonly http: AusPostHttpClient,
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
    // `request.window` is deliberately not read: a scheduled parcel has no buyer window here.
    if (!this.accepts(target.config, request.mode, request.parcel, target.currency)) {
      return err(REFUSED);
    }
    const answer = await this.http.post(
      target.endpoint,
      'shipments',
      {
        shipments: [
          {
            shipment_reference: request.externalReference,
            sender_references: [request.externalReference],
            from: addressOf(request.pickup),
            to: {
              ...addressOf(request.dropoff),
              ...(request.dropoff.notes === null || request.dropoff.notes === ''
                ? {}
                : { delivery_instructions: request.dropoff.notes.slice(0, 128) }),
            },
            items: [
              {
                ...itemOf(request.parcel, target.config.productId),
                item_reference: request.externalReference,
              },
            ],
          },
        ],
      },
      'book',
    );
    if (!answer.ok) return err(failureOf(answer.error));
    const { body } = answer.value;
    const shipment = firstOf(body, 'shipments');
    if (!isObject(shipment) || typeof shipment.shipment_id !== 'string') return err(UNAVAILABLE);
    if (!ID.test(shipment.shipment_id)) return err(UNAVAILABLE);
    const item = firstOf(shipment, 'items');
    const details = isObject(item) ? item.tracking_details : null;
    const article = isObject(details) ? details.article_id : null;
    // The article id arrives with the shipment; without it the parcel can be cancelled but not
    // tracked, so the reference is the shipment id alone and there is no tracking link.
    const tracked = typeof article === 'string' && ID.test(article) ? article : null;
    return ok({
      carrierReference:
        tracked === null ? shipment.shipment_id : `${shipment.shipment_id}:${tracked}`,
      carrierStatus: NEW_SHIPMENT_STATUS,
      trackingUrl: tracked === null ? null : AUSPOST_TRACKING_URL(tracked),
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
    const productId = target.config.productId;
    const body = {
      from: quoteAddressOf(request.pickup),
      to: quoteAddressOf(request.dropoff),
      items: [itemOf(request.parcel, productId)],
    };
    const key = `${market.marketId}|${JSON.stringify({ ...body, parcel: request.parcel }, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))}`;
    const now = this.clock.now().epochMilliseconds;
    const cached = this.#quotes.get(key);
    if (cached !== undefined && now - cached.at < QUOTE_CACHE_MS) return ok(cached.quote);
    const answer = await this.http.post(target.endpoint, 'prices/items', body, 'quote');
    if (!answer.ok) return err(failureOf(answer.error));
    const first = firstOf(answer.value.body, 'items');
    const list = isObject(first) ? first.prices : null;
    const prices: unknown[] = Array.isArray(list) ? (list as unknown[]) : [];
    // One item was priced for one product: that product's price, and no other, is the answer.
    const wanted = prices.find((p) => isObject(p) && p.product_id === productId);
    const total = isObject(wanted) ? priceOf(wanted.calculated_price, target.currency) : null;
    if (total === null || !isObject(wanted)) return err(UNAVAILABLE);
    const quote: CarrierQuote = { price: total, etaMinutes: etaMinutesOf(wanted), expiresAt: null };
    this.#quotes.delete(key);
    if (this.#quotes.size >= QUOTE_CACHE_SIZE) {
      // The oldest entry goes first: a Map iterates in insertion order.
      this.#quotes.delete(this.#quotes.keys().next().value!);
    }
    this.#quotes.set(key, { at: now, quote });
    return ok(quote);
  }

  async cancel(
    market: MarketContext,
    carrierReference: string,
  ): Promise<Result<{ readonly carrierStatus: string }, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    const parts = REFERENCE.exec(carrierReference);
    if (parts === null) return err(REFUSED);
    // A shipment with a label or an order is refused (4xx); the empty answer is the whole answer.
    const answer = await this.http.delete(target.endpoint, `shipments/${parts[1]!}`);
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
    const article = REFERENCE.exec(carrierReference)?.[2];
    // A reference without an article id cannot be tracked.
    if (article === undefined) return err(REFUSED);
    const answer = await this.http.get(target.endpoint, `track?tracking_ids=${article}`);
    if (!answer.ok) return err(failureOf(answer.error));
    // Only the id and the status are read: the answer also carries events with places and
    // times, which never leave this function.
    const { body } = answer.value;
    const result = firstOf(body, 'tracking_results');
    if (!isObject(result) || result.tracking_id !== article) return err(UNAVAILABLE);
    const { status } = result;
    const lower = typeof status === 'string' ? status.toLowerCase() : '';
    if (!Object.hasOwn(STATUS_CODES, lower)) return err(UNAVAILABLE);
    const carrierStatus = STATUS_CODES[lower]!;
    const common = toFleetStatus(carrierStatus);
    return common === null ? err(UNAVAILABLE) : ok({ status: common, carrierStatus });
  }

  /**
   * Whether the fleet takes this mode and parcel: scheduled only (Australia Post delivers in
   * days, never on demand), ambient only, and the Market's limits. The same rule as the
   * capabilities, and a window is neither required nor looked at.
   */
  private accepts(
    config: AusPostConfig,
    mode: 'on_demand' | 'scheduled',
    parcel: CarrierParcel,
    currency: string,
  ): boolean {
    const { limits } = config;
    return (
      mode === 'scheduled' &&
      config.modes.includes(mode) &&
      parcel.temperature === 'ambient' &&
      parcel.weightGrams <= limits.maxItemWeightGrams &&
      parcel.itemCount <= limits.maxItems &&
      // A value in another currency cannot be compared: refuse rather than guess.
      parcel.declaredValue.currency === currency &&
      parcel.declaredValue.amount <= BigInt(limits.maxOrderValueMinor)
    );
  }

  /** The endpoint of the Market, or null when Australia Post is off for it. */
  private target(market: MarketContext): {
    readonly endpoint: AusPostEndpoint;
    readonly config: AusPostConfig;
    readonly currency: string;
  } | null {
    const settings = this.policy.settings(market.marketId);
    if (settings === null) return null;
    const { config } = settings;
    return {
      config,
      currency: settings.currency,
      endpoint: {
        marketId: market.marketId,
        apiUrl: AUSPOST_API_URLS[config.environment],
        apiKey: settings.apiKey,
        apiPassword: settings.apiPassword,
        accountNumber: settings.accountNumber,
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
