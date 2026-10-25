import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { OutboxWriteRefusedError } from '../../../platform/events/outbox-writer';
import type {
  CarrierBookingOutcome,
  CarrierDeliveryFailure,
  CarrierShipment,
} from '../contracts/shipping.facade';
import {
  advanceBooking,
  MONDAPAC_DRIVE,
  newBooking,
  progressOfDriveStatus,
  type CarrierBooking,
} from '../domain/carrier-booking';
import { carrierModeOf, parseBookingService } from '../domain/booking-service';
import { parseCarrierStop } from '../domain/carrier-stop';
import { parseDriveWebhook } from '../domain/drive-webhook-event';
import { CarrierDeliveryProgressed } from '../domain/events';
import { fulfilmentStrategyFor, REAL_TIME_DELIVERY } from '../domain/real-time-delivery';
import type { ShippingDependencies } from './shipping-dependencies';

// The `real_time_delivery` FulfillmentStrategy (SHP-02/03): book a paid seller order with the
// Market's real-time carrier, take the carrier's signed status webhooks, cancel. The carrier is
// called outside every unit (P 3.1 row 5); each use case has at most one read-write unit.
// Personal data (the two stops) goes to the carrier only: it is never stored, logged or put in
// an event, and a log line carries ids and codes.

const logger = new Logger('ShippingCarrierFlow');

const idOf = <K extends string>(value: unknown): Id<K> | null => {
  const parsed = typeof value === 'string' ? parseId<K>(value) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
};

const UNAVAILABLE = { code: 'shipping.carrier-unavailable' } as const;

/** The event of a booking at its current version, for the unit that stores the change. */
const progressed = (booking: CarrierBooking) =>
  CarrierDeliveryProgressed.record({
    aggregateId: booking.id,
    aggregateVersion: booking.version,
    occurredAt: booking.updatedAt,
    payload: {
      orderId: booking.orderId,
      sellerOrderId: booking.sellerOrderId,
      sellerId: booking.sellerId,
    },
  });

const log = (context: CallContext, msg: string, fields: Record<string, unknown>): void => {
  logger.log({
    msg,
    ...fields,
    marketId: context.market.marketId,
    correlationId: context.correlationId,
  });
};

/**
 * `book-carrier-delivery`: the strategy first (carrier on for the Market, pickup and drop-off
 * each in one of its ServiceAreas), then one booking per seller order. An existing booking
 * answers `already-booked` without a call. The carrier books once per `externalReference` (the
 * seller order id), so a retry after a lost answer finds the first delivery. A refusal (4xx)
 * answers `refused`; no carrier for the trip answers `no-carrier`. The seller never delivers
 * instead: ordering records that the platform must look at the order.
 */
export async function bookCarrierDelivery(
  deps: ShippingDependencies,
  context: CallContext,
  input: {
    readonly orderId: unknown;
    readonly sellerOrderId: unknown;
    readonly sellerId: unknown;
    readonly dropoff: unknown;
    readonly service: unknown;
  },
): Promise<Result<CarrierBookingOutcome, CarrierDeliveryFailure>> {
  const orderId = idOf<'Order'>(input?.orderId);
  const sellerOrderId = idOf<'SellerOrder'>(input?.sellerOrderId);
  const sellerId = idOf<'Seller'>(input?.sellerId);
  const dropoff = parseCarrierStop(input?.dropoff, 'dropoff');
  const service = parseBookingService(input?.service);
  const fields = [
    ...(orderId === null ? [{ path: 'orderId', code: 'format' }] : []),
    ...(sellerOrderId === null ? [{ path: 'sellerOrderId', code: 'format' }] : []),
    ...(sellerId === null ? [{ path: 'sellerId', code: 'format' }] : []),
    ...(dropoff.ok ? [] : dropoff.fields),
    ...(service.ok ? [] : service.fields),
  ];
  if (
    orderId === null ||
    sellerOrderId === null ||
    sellerId === null ||
    !dropoff.ok ||
    !service.ok
  ) {
    return err({ code: 'validation.failed', fields });
  }
  const { market } = context;
  const settings = deps.carrierPolicy.realTimeCarrier(market);
  const dropoffArea = deps.carrierPolicy.serviceAreaOf(market, dropoff.stop.postcode);
  // Without a carrier or a served drop-off nothing is read; the pickup is checked below.
  if (settings === null || dropoffArea === null || !settings.serviceAreas.includes(dropoffArea)) {
    log(context, 'shipping.carrier-booking', { outcome: 'no-carrier', sellerOrderId });
    return ok('no-carrier');
  }
  const existing = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.bookings.findBySellerOrder(market, sellerOrderId)),
    { readOnly: true },
  );
  if (!existing.ok) return err(UNAVAILABLE);
  if (existing.value !== null) return ok('already-booked');

  const pickup = await deps.pickups.pickupOf(context, { sellerId, sellerOrderId });
  if (!pickup.ok) {
    if (pickup.error.code === 'pickup.unavailable') return err(UNAVAILABLE);
    log(context, 'shipping.carrier-booking', { outcome: 'no-carrier', reason: 'no-pickup' });
    return ok('no-carrier');
  }
  const pickupStop = parseCarrierStop(pickup.value, 'pickup');
  if (!pickupStop.ok) {
    // The seller's file holds a phone or an address the carrier would refuse.
    log(context, 'shipping.carrier-booking', {
      outcome: 'no-carrier',
      reason: 'pickup-invalid',
    });
    return ok('no-carrier');
  }
  const pickupArea = deps.carrierPolicy.serviceAreaOf(market, pickupStop.stop.postcode);
  if (fulfilmentStrategyFor(settings, pickupArea, dropoffArea) !== REAL_TIME_DELIVERY) {
    log(context, 'shipping.carrier-booking', { outcome: 'no-carrier', sellerOrderId });
    return ok('no-carrier');
  }

  const answer = await deps.carrier.book(market, {
    externalReference: sellerOrderId,
    pickup: pickupStop.stop,
    dropoff: dropoff.stop,
    parcel: settings.parcel,
    mode: carrierModeOf(service.service),
    window: service.service.window,
  });
  if (!answer.ok) {
    log(context, 'shipping.carrier-booking', { outcome: answer.error.code, sellerOrderId });
    return answer.error.code === 'carrier.refused' ? ok('refused') : err(UNAVAILABLE);
  }
  const booking = newBooking({
    id: deps.ids.next<'CarrierBooking'>(),
    sellerOrderId,
    orderId,
    sellerId,
    carrierReference: answer.value.carrierReference,
    carrierStatus: answer.value.carrierStatus,
    now: deps.clock.now(),
  });
  const stored = await deps.unitOfWork.run<CarrierBookingOutcome, CarrierDeliveryFailure>(
    market,
    async () => {
      // A concurrent call booked the same reference first: the carrier holds one delivery.
      if ((await deps.bookings.insert(market, booking)) === 'exists') return ok('already-booked');
      try {
        await deps.outbox.append(context, [progressed(booking)]);
      } catch (error) {
        if (error instanceof OutboxWriteRefusedError) return err(UNAVAILABLE);
        throw error;
      }
      return ok('booked');
    },
  );
  log(context, 'shipping.carrier-booking', {
    outcome: stored.ok ? stored.value : stored.error.code,
    sellerOrderId,
    bookingId: booking.id,
  });
  return stored;
}

/** `carrier-shipment`: the carrier delivery of a seller order, for ordering. */
export async function readCarrierShipment(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly sellerOrderId: unknown },
): Promise<Result<CarrierShipment, CarrierDeliveryFailure>> {
  const sellerOrderId = idOf<'SellerOrder'>(input?.sellerOrderId);
  if (sellerOrderId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerOrderId', code: 'format' }] });
  }
  const { market } = context;
  const found = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.bookings.findBySellerOrder(market, sellerOrderId)),
    { readOnly: true },
  );
  if (!found.ok) return err(UNAVAILABLE);
  const booking = found.value;
  if (booking === null) return err({ code: 'shipping.carrier-delivery-not-found' });
  return ok({
    sellerOrderId: booking.sellerOrderId,
    // The carrier may have been switched off since: its code still names it.
    carrierName: deps.carrierPolicy.realTimeCarrier(market)?.displayName ?? booking.carrier,
    trackingRef: booking.carrierReference,
    progress: booking.progress,
  });
}

/**
 * `cancel-carrier-delivery`: asks the carrier to drop a delivery not yet picked up, then stores
 * the cancellation (the carrier's own webhook may have stored it first).
 */
export async function cancelCarrierDelivery(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly sellerOrderId: unknown },
): Promise<Result<'cancelled' | 'not-cancellable' | 'none', CarrierDeliveryFailure>> {
  const sellerOrderId = idOf<'SellerOrder'>(input?.sellerOrderId);
  if (sellerOrderId === null) {
    return err({ code: 'validation.failed', fields: [{ path: 'sellerOrderId', code: 'format' }] });
  }
  const { market } = context;
  const found = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.bookings.findBySellerOrder(market, sellerOrderId)),
    { readOnly: true },
  );
  if (!found.ok) return err(UNAVAILABLE);
  const booking = found.value;
  if (booking === null) return ok('none');
  if (booking.progress === 'cancelled') return ok('cancelled');
  if (booking.progress !== 'booked') return ok('not-cancellable');

  const answer = await deps.carrier.cancel(market, booking.carrierReference);
  if (!answer.ok) {
    log(context, 'shipping.carrier-cancel', { outcome: answer.error.code, sellerOrderId });
    // A refusal means the carrier can no longer cancel it (picked up meanwhile).
    return answer.error.code === 'carrier.refused' ? ok('not-cancellable') : err(UNAVAILABLE);
  }
  const now = deps.clock.now();
  return deps.unitOfWork.run<'cancelled' | 'not-cancellable', CarrierDeliveryFailure>(
    market,
    async () => {
      const current = await deps.bookings.findBySellerOrder(market, sellerOrderId);
      if (current === null) return err(UNAVAILABLE);
      const cancelled = advanceBooking(
        current,
        { progress: 'cancelled', carrierStatus: answer.value.carrierStatus },
        now,
      );
      if (cancelled === null) {
        return ok(current.progress === 'cancelled' ? 'cancelled' : 'not-cancellable');
      }
      if ((await deps.bookings.save(market, cancelled, current.version)) !== 'saved') {
        return err(UNAVAILABLE);
      }
      await deps.outbox.append(context, [progressed(cancelled)]);
      return ok('cancelled');
    },
  );
}

export interface ReceiveWebhookInput {
  /** The exact bytes of the request body. */
  readonly payload: Uint8Array;
  readonly timestamp: unknown;
  readonly signature: unknown;
}

/** What the receiver did with a verified event; every one answers 200. */
export type ReceiveWebhookOutcome = 'applied' | 'unchanged' | 'duplicate' | 'ignored';

export type ReceiveWebhookFailure =
  | { readonly code: 'validation.failed' }
  /** No webhook secret for the Market: the carrier retries later (503). */
  | { readonly code: 'shipping.webhook-unavailable' }
  | { readonly code: 'shipping.signature-invalid' }
  /** Signed, but about another Market or for a delivery of another reference. */
  | { readonly code: 'shipping.event-refused' }
  /** No booking (yet) for the reference: the carrier retries, so a race with booking settles. */
  | { readonly code: 'shipping.carrier-delivery-not-found' };

/**
 * `receive-carrier-webhook`: the signature is checked on the raw bytes (HMAC with timestamp,
 * within the replay window) before anything is read. A status event is taken once by its id
 * (`shipping.carrier_events`), in the same unit as the booking change and its event, so a
 * repeat changes nothing. Progress only moves forward (`advanceBooking`).
 */
export async function receiveCarrierWebhook(
  deps: ShippingDependencies,
  context: CallContext,
  input: ReceiveWebhookInput,
): Promise<Result<ReceiveWebhookOutcome, ReceiveWebhookFailure>> {
  const { market } = context;
  if (!deps.webhookSignature.configuredFor(market.marketId)) {
    return err({ code: 'shipping.webhook-unavailable' });
  }
  if (!(input?.payload instanceof Uint8Array)) return err({ code: 'validation.failed' });
  const signed = deps.webhookSignature.verify(market.marketId, input.payload, {
    timestamp: input.timestamp,
    signature: input.signature,
  });
  if (!signed) return err({ code: 'shipping.signature-invalid' });
  const parsed = parseDriveWebhook(input.payload);
  if (parsed.kind === 'invalid') return err({ code: 'validation.failed' });
  if (parsed.kind === 'other') return ok('ignored');
  const event = parsed.event;
  if (event.marketId !== market.marketId) return err({ code: 'shipping.event-refused' });
  const progress = progressOfDriveStatus(event.status);
  const sellerOrderId = event.externalReference as Id<'SellerOrder'>;
  const now = deps.clock.now();

  return deps.unitOfWork.run<ReceiveWebhookOutcome, ReceiveWebhookFailure>(market, async () => {
    const booking = await deps.bookings.findBySellerOrder(market, sellerOrderId);
    if (booking === null) return err({ code: 'shipping.carrier-delivery-not-found' });
    if (booking.carrierReference !== event.deliveryId)
      return err({ code: 'shipping.event-refused' });
    const taken = await deps.bookings.recordEvent(market, {
      eventId: event.eventId,
      carrier: MONDAPAC_DRIVE,
      receivedAt: now,
    });
    if (taken === 'duplicate') return ok('duplicate');
    // A status this version does not know yet is taken (so it is not sent again) and ignored.
    if (progress === null) return ok('ignored');
    const advanced = advanceBooking(booking, { progress, carrierStatus: event.status }, now);
    if (advanced === null) return ok('unchanged');
    if ((await deps.bookings.save(market, advanced, booking.version)) !== 'saved') {
      // A concurrent event moved it: commit nothing, the carrier sends this one again.
      throw new Error('receive-carrier-webhook: the booking changed meanwhile');
    }
    if (advanced.progress !== booking.progress) {
      await deps.outbox.append(context, [progressed(advanced)]);
    }
    return ok('applied');
  });
}
