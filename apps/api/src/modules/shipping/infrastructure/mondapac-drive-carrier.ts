import { err, ok } from '@mondapac/shared-kernel';
import type { MarketContext, Result } from '@mondapac/shared-kernel';
import type {
  CarrierBookingAnswer,
  CarrierBookingRequest,
  CarrierFailure,
  CarrierGateway,
  CarrierStop,
} from '../application/ports/carrier-gateway';
import { addressLineOf } from '../domain/carrier-stop';
import type { ConfigCarrierPolicy } from './config-carrier-policy';
import type { DriveEndpoint, DriveHttpClient } from './drive-http-client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STATUS = /^[A-Z][A-Z_]{1,39}$/;

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
  constructor(
    private readonly policy: ConfigCarrierPolicy,
    private readonly apiKeys: Readonly<Record<string, string>>,
    private readonly http: DriveHttpClient,
  ) {}

  async book(
    market: MarketContext,
    request: CarrierBookingRequest,
  ): Promise<Result<CarrierBookingAnswer, CarrierFailure>> {
    const target = this.target(market);
    if (target === null) return err(NOT_CONFIGURED);
    const answer = await this.http.post(target.endpoint, '/delivery/deliveries', {
      externalReference: request.externalReference,
      pickup: stopBody(request.pickup),
      dropoff: stopBody(request.dropoff),
      parcel: request.parcel,
      mode: request.mode,
    });
    if (!answer.ok) return err(answer.error === 'refused' ? REFUSED : UNAVAILABLE);
    const delivery = deliveryOf(answer.value.body, request.externalReference);
    return delivery === null ? err(UNAVAILABLE) : ok(delivery);
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
