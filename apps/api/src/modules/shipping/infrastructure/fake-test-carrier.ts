import { err, ok } from '@mondapac/shared-kernel';
import type { MarketContext, Result } from '@mondapac/shared-kernel';
import type {
  CarrierBookingAnswer,
  CarrierBookingRequest,
  CarrierFailure,
  CarrierGateway,
  CarrierQuote,
  CarrierQuoteRequest,
} from '../application/ports/carrier-gateway';
import type { FleetCapabilities, FleetDeliveryStatus } from '../domain/fleet';

/** The words the fake reports, mapped by {@link toFleetStatus}. */
export const FAKE_STATUSES = [
  'QUEUED',
  'ASSIGNED',
  'ON_ROUTE',
  'DONE',
  'CANCELLED',
  'LOST',
] as const;
type FakeStatus = (typeof FAKE_STATUSES)[number];

/** The fake fleet's pure mapping of its own status words to the common fleet status. */
export function toFleetStatus(raw: string): FleetDeliveryStatus | null {
  switch (raw) {
    case 'QUEUED':
      return 'pending';
    case 'ASSIGNED':
      return 'assigned';
    case 'ON_ROUTE':
      return 'picked_up';
    case 'DONE':
      return 'delivered';
    case 'CANCELLED':
      return 'cancelled';
    case 'LOST':
      return 'failed';
    default:
      return null;
  }
}

type Call = 'book' | 'quote' | 'cancel' | 'status';

/**
 * A deterministic fleet for tests and development (`fake_test`). Never a real carrier: it is
 * listed only in a Market's `shipping.fleets` for tests (the ZZ fixture) and is left out of a
 * production Stack. Its price and ETA derive from the drop-off postcode, so a test can predict
 * them; it books once per reference; and a test can script the next answer of any call.
 */
export class FakeTestCarrier implements CarrierGateway {
  readonly fleet = 'fake_test' as const;
  /** Every booking request received, in order (the stops are test data). */
  readonly booked: CarrierBookingRequest[] = [];
  readonly cancelled: string[] = [];
  readonly quoted: CarrierQuoteRequest[] = [];
  readonly #byReference = new Map<string, { reference: string; status: FakeStatus }>();
  readonly #scripted = new Map<Call, CarrierFailure[]>();

  /**
   * `capabilitiesOf` answers per Market (null: off); `idempotentBooking: false` makes the fake
   * behave like a fleet that cannot dedupe a repeated booking.
   */
  constructor(
    private readonly capabilitiesOf: (market: MarketContext) => FleetCapabilities | null,
    private readonly options: { readonly idempotentBooking?: boolean } = {},
  ) {}

  /** The next call of that kind fails with `failure` (once each, in order). */
  failNext(call: Call, ...failures: CarrierFailure[]): void {
    this.#scripted.set(call, [...(this.#scripted.get(call) ?? []), ...failures]);
  }

  /** Moves a booked delivery to a status, as a fleet would report it. */
  report(carrierReference: string, status: FakeStatus): void {
    for (const entry of this.#byReference.values()) {
      if (entry.reference === carrierReference) entry.status = status;
    }
  }

  capabilities(market: MarketContext): FleetCapabilities | null {
    const declared = this.capabilitiesOf(market);
    if (declared === null) return null;
    return { ...declared, idempotentBooking: this.options.idempotentBooking ?? true };
  }

  private scripted(call: Call): CarrierFailure | null {
    return this.#scripted.get(call)?.shift() ?? null;
  }

  book(
    market: MarketContext,
    request: CarrierBookingRequest,
  ): Promise<Result<CarrierBookingAnswer, CarrierFailure>> {
    if (this.capabilities(market) === null)
      return Promise.resolve(err({ code: 'carrier.not-configured' }));
    this.booked.push(request);
    const failure = this.scripted('book');
    if (failure !== null) return Promise.resolve(err(failure));
    const key = `${market.marketId}|${request.externalReference}`;
    let entry = this.#byReference.get(key);
    if (entry === undefined || this.options.idempotentBooking === false) {
      entry = {
        reference: `fake-${request.externalReference}${this.options.idempotentBooking === false ? `-${this.#byReference.size}` : ''}`,
        status: 'QUEUED',
      };
      this.#byReference.set(key, entry);
    }
    return Promise.resolve(
      ok({
        carrierReference: entry.reference,
        carrierStatus: entry.status,
        trackingUrl: `https://fake.invalid/track/${entry.reference}`,
      }),
    );
  }

  quote(
    market: MarketContext,
    request: CarrierQuoteRequest,
  ): Promise<Result<CarrierQuote, CarrierFailure>> {
    if (this.capabilities(market) === null)
      return Promise.resolve(err({ code: 'carrier.not-configured' }));
    this.quoted.push(request);
    const failure = this.scripted('quote');
    if (failure !== null) return Promise.resolve(err(failure));
    let spread = 0;
    for (const char of request.dropoff.postcode) spread += char.charCodeAt(0);
    return Promise.resolve(
      ok({
        price: {
          amount: BigInt(1000 + (spread % 500)),
          currency: request.parcel.declaredValue.currency,
        },
        etaMinutes: 30 + (spread % 60),
        expiresAt: null,
      }),
    );
  }

  cancel(
    market: MarketContext,
    carrierReference: string,
  ): Promise<Result<{ readonly carrierStatus: string }, CarrierFailure>> {
    if (this.capabilities(market) === null)
      return Promise.resolve(err({ code: 'carrier.not-configured' }));
    this.cancelled.push(carrierReference);
    const failure = this.scripted('cancel');
    if (failure !== null) return Promise.resolve(err(failure));
    const entry = [...this.#byReference.values()].find((e) => e.reference === carrierReference);
    if (entry === undefined || entry.status === 'ON_ROUTE' || entry.status === 'DONE') {
      return Promise.resolve(err({ code: 'carrier.refused' }));
    }
    entry.status = 'CANCELLED';
    return Promise.resolve(ok({ carrierStatus: 'CANCELLED' }));
  }

  status(
    market: MarketContext,
    carrierReference: string,
  ): Promise<
    Result<{ readonly status: FleetDeliveryStatus; readonly carrierStatus: string }, CarrierFailure>
  > {
    if (this.capabilities(market) === null)
      return Promise.resolve(err({ code: 'carrier.not-configured' }));
    const failure = this.scripted('status');
    if (failure !== null) return Promise.resolve(err(failure));
    const entry = [...this.#byReference.values()].find((e) => e.reference === carrierReference);
    const status = entry === undefined ? null : toFleetStatus(entry.status);
    if (entry === undefined || status === null)
      return Promise.resolve(err({ code: 'carrier.refused' }));
    return Promise.resolve(ok({ status, carrierStatus: entry.status }));
  }
}
