import { err, ok } from '@mondapac/shared-kernel';
import type { Clock, MarketContext, Money, Result } from '@mondapac/shared-kernel';
import type {
  CarrierBookingAnswer,
  CarrierBookingRequest,
  CarrierFailure,
  CarrierGateway,
  CarrierQuoteRequest,
  CarrierStop,
} from '../application/ports/carrier-gateway';
import type { ConfigUberDirectPolicy, UberDirectCapabilities } from './config-uber-direct-policy';
import {
  UBER_API_URL,
  UBER_AUTH_URL,
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
 * A quote is kept this long per Market, postcode pair, parcel and mode, as for Drive: a checkout
 * repeated in a loop asks Uber once. Uber's own quotes live 15 minutes. The keys are postcodes
 * and settings only, never personal data. At most {@link QUOTE_CACHE_SIZE} are kept.
 */
export const QUOTE_CACHE_MS = 5 * 60_000;
const QUOTE_CACHE_SIZE = 1000;

const NOT_CONFIGURED: CarrierFailure = Object.freeze({ code: 'carrier.not-configured' as const });
const UNAVAILABLE: CarrierFailure = Object.freeze({ code: 'carrier.unavailable' as const });
const REFUSED: CarrierFailure = Object.freeze({ code: 'carrier.refused' as const });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Uber's structured address, sent as the JSON text Uber's `*_address` fields take. Uber has no
 * postcode-only form, so a quote's stop (the port gives postcodes only, on purpose) is the
 * Market's country and the postcode with no street lines; Uber may refuse such a stop or price it
 * from the postcode's centre, which makes a quote an estimate. A booking has the full lines.
 */
const addressOf = (country: string, postcode: string, lines: readonly string[]): string =>
  JSON.stringify({ street_address: lines, zip_code: postcode, country });

/** Uber wants an international number; spaces are dropped and the rest is passed as given. */
const phoneOf = (phone: string): string => phone.replace(/ /g, '');

/** The part of a stop Uber's create call takes, for `pickup` or `dropoff`. */
const stopBody = (side: 'pickup' | 'dropoff', stop: CarrierStop, country: string) => ({
  [`${side}_name`]: stop.contactName,
  [`${side}_address`]: addressOf(
    country,
    stop.postcode,
    stop.addressLines.filter((line) => line !== ''),
  ),
  [`${side}_phone_number`]: phoneOf(stop.contactPhone),
  ...(stop.notes === null ? {} : { [`${side}_notes`]: stop.notes }),
});

/**
 * Uber's quote answer as a price: `fee` in minor units (an integer) and the ISO currency, read as
 * `currency_type` (upper case) or else `currency` (lower case in Uber's answers). Every other
 * field is dropped.
 */
function feeOf(body: unknown): Money | null {
  if (!isObject(body)) return null;
  const { fee } = body;
  if (typeof fee !== 'number' || !Number.isSafeInteger(fee) || fee < 0) return null;
  const raw = typeof body.currency_type === 'string' ? body.currency_type : body.currency;
  if (typeof raw !== 'string') return null;
  const currency = raw.toUpperCase();
  if (!CURRENCY.test(currency)) return null;
  return { amount: BigInt(fee), currency };
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
  return { carrierReference: id, carrierStatus: STATUS_CODES[status]! };
}

/**
 * The Uber Direct adapter of the carrier port (Phase 6 package 5b, an external fleet). Quotes
 * with `POST delivery_quotes`, books with `POST deliveries` (the seller order id is `external_id`,
 * the retry key), cancels with `POST deliveries/{id}/cancel` and reads a status with
 * `GET deliveries/{id}`. Credentials come from the Market's `shipping.uberDirect` switch and the
 * Region Stack's secrets; with the switch off or a credential missing every call answers
 * `carrier.not-configured` and sends nothing. Not registered as the active carrier anywhere:
 * the fleet router decides.
 */
export class UberDirectCarrier implements CarrierGateway {
  readonly #quotes = new Map<string, { readonly at: number; readonly total: Money }>();

  constructor(
    private readonly policy: ConfigUberDirectPolicy,
    private readonly http: UberDirectHttpClient,
    private readonly clock: Clock,
  ) {}

  /** What the fleet serves and takes in the Market, or null when it is off. Not on the port. */
  capabilities(market: MarketContext): UberDirectCapabilities | null {
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
      'deliveries',
      {
        external_id: request.externalReference,
        ...stopBody('pickup', request.pickup, target.country),
        ...stopBody('dropoff', request.dropoff, target.country),
        manifest_items: [{ name: 'Order', quantity: 1, weight: request.parcel.weightGrams }],
        ...this.timing(request.mode, target.config.scheduledLeadMinutes),
      },
      'book',
    );
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    const delivery = deliveryOf(answer.value.body, request.externalReference);
    return delivery === null ? err(UNAVAILABLE) : ok(delivery);
  }

  async quote(
    market: MarketContext,
    request: CarrierQuoteRequest,
  ): Promise<Result<Money, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    if (!target.config.modes.includes(request.mode)) return err(REFUSED);
    const stops = {
      pickup_address: addressOf(target.country, request.pickup.postcode, []),
      dropoff_address: addressOf(target.country, request.dropoff.postcode, []),
    };
    const key = `${market.marketId}|${JSON.stringify({ ...stops, parcel: request.parcel, mode: request.mode })}`;
    const now = this.clock.now().epochMilliseconds;
    const cached = this.#quotes.get(key);
    if (cached !== undefined && now - cached.at < QUOTE_CACHE_MS) return ok(cached.total);
    const answer = await this.http.post(
      target.endpoint,
      'delivery_quotes',
      { ...stops, ...this.timing(request.mode, target.config.scheduledLeadMinutes) },
      'quote',
    );
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    const total = feeOf(answer.value.body);
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
    if (!UBER_ID.test(carrierReference)) return err(REFUSED);
    const answer = await this.http.post(
      target.endpoint,
      `deliveries/${carrierReference}/cancel`,
      {},
      'cancel',
    );
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    const delivery = deliveryOf(answer.value.body, null);
    if (delivery === null || delivery.carrierReference !== carrierReference)
      return err(UNAVAILABLE);
    return ok({ carrierStatus: delivery.carrierStatus });
  }

  /** The status of a delivery, for polling where Uber's webhook is not used. Not on the port. */
  async status(
    market: MarketContext,
    carrierReference: string,
  ): Promise<Result<{ readonly carrierStatus: string }, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    if (!UBER_ID.test(carrierReference)) return err(REFUSED);
    const answer = await this.http.get(target.endpoint, `deliveries/${carrierReference}`);
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    const delivery = deliveryOf(answer.value.body, null);
    if (delivery === null || delivery.carrierReference !== carrierReference)
      return err(UNAVAILABLE);
    return ok({ carrierStatus: delivery.carrierStatus });
  }

  /** A scheduled trip asks for a pickup the configured lead from now; on demand adds nothing. */
  private timing(
    mode: 'on_demand' | 'scheduled',
    leadMinutes: number,
  ): { pickup_ready_dt?: string } {
    return mode === 'scheduled'
      ? { pickup_ready_dt: this.clock.now().add({ minutes: leadMinutes }).toString() }
      : {};
  }

  /** The endpoint of the Market, or null when Uber Direct is off for it. */
  private target(market: MarketContext): {
    readonly endpoint: UberDirectEndpoint;
    readonly config: NonNullable<ReturnType<ConfigUberDirectPolicy['settings']>>['config'];
    readonly country: string;
  } | null {
    const settings = this.policy.settings(market.marketId);
    if (settings === null) return null;
    const { config } = settings;
    return {
      config,
      country: settings.country,
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
