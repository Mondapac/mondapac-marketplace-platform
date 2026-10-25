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
import { addressLineOf } from '../domain/carrier-stop';
import type { ConfigCarrierPolicy } from './config-carrier-policy';
import type { DriveEndpoint, DriveHttpClient } from './drive-http-client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS = /^[A-Z][A-Z_]{1,39}$/;
/** Drive's amounts: minor units as decimal text (JSON has no 64-bit integer). */
const AMOUNT = /^(0|[1-9][0-9]{0,15})$/;
const CURRENCY = /^[A-Z]{3}$/;

/**
 * A quote is kept this long per Market, postcode pair, parcel and mode (Hassan, SHP-02/03): a
 * checkout repeated in a loop asks Drive once, not once per attempt. The keys are postcodes and
 * settings only, never personal data. At most {@link QUOTE_CACHE_SIZE} are kept.
 */
export const QUOTE_CACHE_MS = 5 * 60_000;
const QUOTE_CACHE_SIZE = 1000;

const NOT_CONFIGURED: CarrierFailure = Object.freeze({ code: 'carrier.not-configured' as const });
const UNAVAILABLE: CarrierFailure = Object.freeze({ code: 'carrier.unavailable' as const });
const REFUSED: CarrierFailure = Object.freeze({ code: 'carrier.refused' as const });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A stop as Drive's `createDeliveryBody` takes it (Drive geocodes the address itself). */
const stopBody = (stop: CarrierStop) => ({
  address: addressLineOf(stop),
  postcode: stop.postcode,
  contactName: stop.contactName,
  contactPhone: stop.contactPhone,
  ...(stop.notes === null ? {} : { notes: stop.notes }),
});

/** Drive's quote answer as its total; every other field (breakdown, distance, area) is dropped. */
function totalOf(body: unknown): Money | null {
  if (!isObject(body) || !isObject(body.total)) return null;
  const { amount, currency } = body.total;
  if (typeof amount !== 'string' || !AMOUNT.test(amount)) return null;
  if (typeof currency !== 'string' || !CURRENCY.test(currency)) return null;
  return { amount: BigInt(amount), currency };
}

/**
 * Drive's answer as a delivery id and status. Only those two fields are read: the answer also
 * echoes both stops, which never leave this function. An answer for another reference is not one.
 */
function deliveryOf(body: unknown, externalReference: string | null): CarrierBookingAnswer | null {
  if (!isObject(body)) return null;
  const { id, status } = body;
  if (typeof id !== 'string' || !UUID.test(id) || typeof status !== 'string') return null;
  if (!STATUS.test(status)) return null;
  if (externalReference !== null && body.externalReference !== externalReference) return null;
  return { carrierReference: id, carrierStatus: status };
}

/**
 * The Mondapac Drive adapter of the carrier port (SHP-02/03; Drive ADR-0001 decision 3). Books
 * with `POST /delivery/deliveries`, idempotent on the merchant and the seller order id as
 * `externalReference` (a repeat answers 200 with the first delivery); cancels with
 * `POST /delivery/deliveries/:id/cancel`. The merchant is the API key's (Drive takes no merchant
 * field). The endpoint comes from the Market's carrier settings, the API key from the Region
 * Stack's secrets.
 */
export class MondapacDriveCarrier implements CarrierGateway {
  readonly #quotes = new Map<string, { readonly at: number; readonly total: Money }>();

  constructor(
    private readonly policy: ConfigCarrierPolicy,
    private readonly apiKeys: Readonly<Record<string, string>>,
    private readonly http: DriveHttpClient,
    private readonly clock: Clock,
  ) {}

  async book(
    market: MarketContext,
    request: CarrierBookingRequest,
  ): Promise<Result<CarrierBookingAnswer, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    const answer = await this.http.post(
      target.endpoint,
      '/delivery/deliveries',
      {
        externalReference: request.externalReference,
        pickup: stopBody(request.pickup),
        dropoff: stopBody(request.dropoff),
        parcel: request.parcel,
        mode: request.mode,
        ...(request.window === null
          ? {}
          : {
              scheduledWindow: {
                start: request.window.start.toString(),
                end: request.window.end.toString(),
              },
            }),
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
    const body = {
      // Drive locates a stop from a point or an address; the postcode is given as both fields.
      pickup: { postcode: request.pickup.postcode, address: request.pickup.postcode },
      dropoff: { postcode: request.dropoff.postcode, address: request.dropoff.postcode },
      parcel: request.parcel,
      mode: request.mode,
    };
    const key = `${market.marketId}|${JSON.stringify(body)}`;
    const now = this.clock.now().epochMilliseconds;
    const cached = this.#quotes.get(key);
    if (cached !== undefined && now - cached.at < QUOTE_CACHE_MS) return ok(cached.total);
    const answer = await this.http.post(target.endpoint, '/delivery/quotes', body, 'quote');
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    const total = totalOf(answer.value.body);
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
    if (!UUID.test(carrierReference)) return err(REFUSED);
    const answer = await this.http.post(
      target.endpoint,
      `/delivery/deliveries/${carrierReference}/cancel`,
      { reason: 'Cancelled by the marketplace' },
      'cancel',
    );
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    const delivery = deliveryOf(answer.value.body, null);
    if (delivery === null || delivery.carrierReference !== carrierReference)
      return err(UNAVAILABLE);
    return ok({ carrierStatus: delivery.carrierStatus });
  }

  /** The endpoint of the Market, or null when the carrier is off for it. */
  private target(market: MarketContext): { readonly endpoint: DriveEndpoint } | null {
    const settings = this.policy.config(market.marketId);
    const apiKey = Object.hasOwn(this.apiKeys, market.marketId)
      ? this.apiKeys[market.marketId]
      : undefined;
    if (settings === null || apiKey === undefined) return null;
    return {
      endpoint: {
        baseUrl: settings.baseUrl,
        apiKey,
        marketId: market.marketId,
        timeoutMs: settings.timeoutMs,
        maxAttempts: settings.maxAttempts,
        backoffMs: settings.backoffMs,
        circuit: {
          failureThreshold: settings.circuitBreaker.failureThreshold,
          cooldownMs: settings.circuitBreaker.cooldownSeconds * 1000,
        },
      },
    };
  }
}
