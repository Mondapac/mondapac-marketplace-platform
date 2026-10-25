import { err, minorUnitExponent, ok } from '@mondapac/shared-kernel';
import type { Clock, MarketContext, Money, Result } from '@mondapac/shared-kernel';
import type {
  CarrierBookingAnswer,
  CarrierBookingRequest,
  CarrierFailure,
  CarrierGateway,
  CarrierParcel,
  CarrierQuoteRequest,
  CarrierStop,
} from '../application/ports/carrier-gateway';
import type { AusPostCapabilities, ConfigAusPostPolicy } from './config-auspost-policy';
import {
  AUSPOST_API_URLS,
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
 * Australia Post's tracking statuses as the uppercase carrier status codes of the port. Any
 * other status is not one we understand: the answer counts as no answer.
 */
const STATUS_CODES: Readonly<Record<string, string>> = Object.freeze({
  Created: 'CREATED',
  Initiated: 'INITIATED',
  Sealed: 'SEALED',
  'In transit': 'IN_TRANSIT',
  'Awaiting collection': 'AWAITING_COLLECTION',
  'Possible delay': 'POSSIBLE_DELAY',
  'Unable to deliver': 'UNABLE_TO_DELIVER',
  Delivered: 'DELIVERED',
  Cancelled: 'CANCELLED',
});

const NEW_SHIPMENT_STATUS = STATUS_CODES.Created!;
const CANCELLED_STATUS = STATUS_CODES.Cancelled!;

/**
 * A quote is kept this long per Market, postcode pair, parcel and mode, as for the other fleets:
 * a checkout repeated in a loop asks Australia Post once. The keys are postcodes and settings
 * only, never personal data. At most {@link QUOTE_CACHE_SIZE} are kept.
 */
export const QUOTE_CACHE_MS = 5 * 60_000;
const QUOTE_CACHE_SIZE = 1000;

const NOT_CONFIGURED: CarrierFailure = Object.freeze({ code: 'carrier.not-configured' as const });
const UNAVAILABLE: CarrierFailure = Object.freeze({ code: 'carrier.unavailable' as const });
const REFUSED: CarrierFailure = Object.freeze({ code: 'carrier.refused' as const });

/** The API's field bounds: a name, an address line. */
const MAX_NAME = 40;
const MAX_LINE = 40;
const MAX_LINES = 3;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The first element of the array under `key` of a JSON object, or null. */
const firstOf = (value: unknown, key: string): unknown => {
  const list = isObject(value) ? value[key] : null;
  return Array.isArray(list) ? (list[0] as unknown) : null;
};

/**
 * Australia Post's price (a JSON decimal, or a decimal string) as Money in the Market's
 * currency. A price with more digits than the currency has, a negative, a non-number or one
 * beyond the safe integers is not a price.
 */
function priceOf(price: unknown, currency: string): Money | null {
  const value =
    typeof price === 'string' && /^\d{1,9}(\.\d{1,6})?$/.test(price) ? Number(price) : price;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  const factor = 10 ** minorUnitExponent(currency);
  const minor = Math.round(value * factor);
  if (!Number.isSafeInteger(minor) || Math.abs(minor / factor - value) > 1e-9) return null;
  return { amount: BigInt(minor), currency };
}

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

/**
 * The API's address of a stop. The port has address lines and a postcode only: the last line
 * (when there are several) is sent as the suburb and the Market's state is NOT sent, because the
 * port does not carry it and core logic must not guess it from a postcode; Australia Post may
 * refuse such an address (a gap of the port).
 */
function addressOf(stop: CarrierStop) {
  const lines = stop.addressLines.filter((line) => line !== '');
  const suburb = lines.length > 1 ? lines[lines.length - 1]! : '';
  const street = (lines.length > 1 ? lines.slice(0, -1) : lines).slice(0, MAX_LINES);
  return {
    name: stop.contactName.slice(0, MAX_NAME),
    lines: street.map((line) => line.slice(0, MAX_LINE)),
    suburb: suburb.slice(0, MAX_LINE),
    postcode: stop.postcode,
    phone: stop.contactPhone.replace(/ /g, ''),
  };
}

/**
 * The Australia Post adapter of the carrier port (Phase 6 package 5d, an external fleet for
 * scheduled, multi-day parcels outside the city fleets' service areas). Quotes with
 * `POST prices/items`, creates with `POST shipments` (the seller order id goes in
 * `sender_references` and `shipment_reference`, labels only: no idempotency key is documented,
 * so a create is sent once and never retried), cancels with `DELETE shipments/{id}` (before a
 * label or order exists) and reads a status with `GET track?tracking_ids=`. `on_demand` is not
 * served, and neither is a parcel that is not ambient: both are refused without a call. The
 * credentials come from the Region Stack's secrets and the switch from the Market's
 * `shipping.auspost`; with either missing every call answers `carrier.not-configured` and sends
 * nothing. Not registered as the active carrier anywhere: the fleet router decides.
 */
export class AusPostCarrier implements CarrierGateway {
  readonly #quotes = new Map<string, { readonly at: number; readonly total: Money }>();

  constructor(
    private readonly policy: ConfigAusPostPolicy,
    private readonly http: AusPostHttpClient,
    private readonly clock: Clock,
  ) {}

  /** What the fleet serves and takes in the Market, or null when it is off. Not on the port. */
  capabilities(market: MarketContext): AusPostCapabilities | null {
    return this.policy.capabilities(market);
  }

  async book(
    market: MarketContext,
    request: CarrierBookingRequest,
  ): Promise<Result<CarrierBookingAnswer, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    if (!this.servable(target.config, request.mode, request.parcel)) return err(REFUSED);
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
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    const { body } = answer.value;
    const shipment = firstOf(body, 'shipments');
    if (!isObject(shipment) || typeof shipment.shipment_id !== 'string') return err(UNAVAILABLE);
    if (!ID.test(shipment.shipment_id)) return err(UNAVAILABLE);
    const item = firstOf(shipment, 'items');
    const details = isObject(item) ? item.tracking_details : null;
    const article = isObject(details) ? details.article_id : null;
    // The article id arrives with the shipment; without it the parcel can be cancelled but not
    // tracked, so the reference is the shipment id alone.
    const carrierReference =
      typeof article === 'string' && ID.test(article)
        ? `${shipment.shipment_id}:${article}`
        : shipment.shipment_id;
    return ok({ carrierReference, carrierStatus: NEW_SHIPMENT_STATUS });
  }

  async quote(
    market: MarketContext,
    request: CarrierQuoteRequest,
  ): Promise<Result<Money, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    if (!this.servable(target.config, request.mode, request.parcel)) return err(REFUSED);
    const productId = target.config.productId;
    const body = {
      from: { postcode: request.pickup.postcode },
      to: { postcode: request.dropoff.postcode },
      items: [itemOf(request.parcel, productId)],
    };
    const key = `${market.marketId}|${JSON.stringify(body)}`;
    const now = this.clock.now().epochMilliseconds;
    const cached = this.#quotes.get(key);
    if (cached !== undefined && now - cached.at < QUOTE_CACHE_MS) return ok(cached.total);
    const answer = await this.http.post(target.endpoint, 'prices/items', body, 'quote');
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    const first = firstOf(answer.value.body, 'items');
    const list = isObject(first) ? first.prices : null;
    const prices: unknown[] = Array.isArray(list) ? (list as unknown[]) : [];
    // One item was priced for one product: that product's price, and no other, is the answer.
    const wanted = prices.find((p) => isObject(p) && p.product_id === productId);
    const total = isObject(wanted) ? priceOf(wanted.calculated_price, target.currency) : null;
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
    const parts = REFERENCE.exec(carrierReference);
    if (parts === null) return err(REFUSED);
    // A shipment with a label or an order is refused (4xx); the empty answer is the whole answer.
    const answer = await this.http.delete(target.endpoint, `shipments/${parts[1]!}`);
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    return ok({ carrierStatus: CANCELLED_STATUS });
  }

  /** The status of a parcel, for polling. Not on the port. */
  async status(
    market: MarketContext,
    carrierReference: string,
  ): Promise<Result<{ readonly carrierStatus: string }, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    const article = REFERENCE.exec(carrierReference)?.[2];
    // A reference without an article id cannot be tracked.
    if (article === undefined) return err(REFUSED);
    const answer = await this.http.get(target.endpoint, `track?tracking_ids=${article}`);
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    // Only the id and the status are read: the answer also carries events with places and
    // times, which never leave this function.
    const { body } = answer.value;
    const result = firstOf(body, 'tracking_results');
    if (!isObject(result) || result.tracking_id !== article) return err(UNAVAILABLE);
    const { status } = result;
    if (typeof status !== 'string' || !Object.hasOwn(STATUS_CODES, status)) {
      return err(UNAVAILABLE);
    }
    return ok({ carrierStatus: STATUS_CODES[status]! });
  }

  /**
   * What the fleet is known to refuse is not sent: a trip that is not scheduled (Australia Post
   * delivers in days, never on demand), a parcel that is not ambient (perishable, chilled and
   * frozen goods are not carried) and one above the weight limit.
   */
  private servable(
    config: NonNullable<ReturnType<ConfigAusPostPolicy['settings']>>['config'],
    mode: 'on_demand' | 'scheduled',
    parcel: CarrierParcel,
  ): boolean {
    return (
      mode === 'scheduled' &&
      config.modes.includes(mode) &&
      parcel.temperature === 'ambient' &&
      parcel.weightGrams <= config.limits.maxItemWeightGrams
    );
  }

  /** The endpoint of the Market, or null when Australia Post is off for it. */
  private target(market: MarketContext): {
    readonly endpoint: AusPostEndpoint;
    readonly config: NonNullable<ReturnType<ConfigAusPostPolicy['settings']>>['config'];
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
