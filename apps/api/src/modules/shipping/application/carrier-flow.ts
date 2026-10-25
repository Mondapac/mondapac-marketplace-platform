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
  newBooking,
  progressOfFleetStatus,
  type CarrierBooking,
} from '../domain/carrier-booking';
import { carrierModeOf, parseBookingService } from '../domain/booking-service';
import { parseCarrierStop } from '../domain/carrier-stop';
import { parseDriveWebhook, toFleetStatus } from '../domain/drive-webhook-event';
import { CarrierDeliveryProgressed } from '../domain/events';
import { TEMPERATURES, type FleetNeed } from '../domain/fleet';
import { capableFleets, routeBooking } from './fleet-router';
import type { CarrierBookingRequest } from './ports/carrier-gateway';
import type { ShippingDependencies } from './shipping-dependencies';

// The `real_time_delivery` FulfillmentStrategy (SHP-02/03): book a paid seller order with the
// fleet the router picks, take the carrier's signed status webhooks, cancel. The carrier is
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

/** The size of the parcel: what the request says, else the Market's defaults. */
function parcelOf(
  deps: ShippingDependencies,
  context: CallContext,
  raw: unknown,
):
  | {
      readonly ok: true;
      readonly parcel: CarrierBookingRequest['parcel'];
      readonly classes: string[];
    }
  | { readonly ok: false; readonly fields: { path: string; code: string }[] } {
  const defaults = deps.carrierPolicy.parcelDefaults(context.market);
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const fields: { path: string; code: string }[] = [];
  const whole = (key: string, fallback: number, min: number, max: number): number => {
    const entry = value[key];
    if (entry === undefined || entry === null) return fallback;
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < min || entry > max) {
      fields.push({ path: `parcel.${key}`, code: 'range' });
      return fallback;
    }
    return entry;
  };
  const weightGrams = whole('weightGrams', defaults.weightGrams, 1, 1_000_000);
  const itemCount = whole('itemCount', 1, 1, 10_000);
  const valueMinor = whole('declaredValueMinor', 0, 0, Number.MAX_SAFE_INTEGER);
  const temperature =
    value.temperature === undefined || value.temperature === null
      ? defaults.temperature
      : TEMPERATURES.find((candidate) => candidate === value.temperature);
  if (temperature === undefined) fields.push({ path: 'parcel.temperature', code: 'value' });
  const classes = Array.isArray(value.classes) ? (value.classes as unknown[]) : [];
  if (!classes.every((name) => typeof name === 'string' && /^[a-z][a-z0-9-]{0,39}$/u.test(name))) {
    fields.push({ path: 'parcel.classes', code: 'format' });
  }
  if (fields.length > 0 || temperature === undefined) return { ok: false, fields };
  return {
    ok: true,
    classes: classes as string[],
    parcel: {
      weightGrams,
      volumeLitres: defaults.volumeLitres,
      temperature,
      itemCount,
      declaredValue: { amount: BigInt(valueMinor), currency: deps.policy.currency(context.market) },
    },
  };
}

/**
 * `book-carrier-delivery`: the router first (the fleets that are on for the Market and can carry
 * the order, ranked by the admin's active model for the buyer's method), then one booking per
 * seller order, naming the fleet that took it. An existing booking answers `already-booked`
 * without a call. A fleet that books once per `externalReference` (the seller order id) makes a
 * retry after a lost answer harmless; one that cannot is never repeated and never replaced, and
 * answers `unknown` (the order may be booked: an admin checks). A refusal by every capable fleet
 * answers `refused`; nobody able answers `no-carrier`. The seller never delivers instead:
 * ordering records that the platform must look at the order.
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
    readonly parcel?: unknown;
  },
): Promise<Result<CarrierBookingOutcome, CarrierDeliveryFailure>> {
  const orderId = idOf<'Order'>(input?.orderId);
  const sellerOrderId = idOf<'SellerOrder'>(input?.sellerOrderId);
  const sellerId = idOf<'Seller'>(input?.sellerId);
  const dropoff = parseCarrierStop(input?.dropoff, 'dropoff');
  const service = parseBookingService(input?.service);
  const parcel = parcelOf(deps, context, input?.parcel);
  const fields = [
    ...(orderId === null ? [{ path: 'orderId', code: 'format' }] : []),
    ...(sellerOrderId === null ? [{ path: 'sellerOrderId', code: 'format' }] : []),
    ...(sellerId === null ? [{ path: 'sellerId', code: 'format' }] : []),
    ...(dropoff.ok ? [] : dropoff.fields),
    ...(service.ok ? [] : service.fields),
    ...(parcel.ok ? [] : parcel.fields),
  ];
  if (
    orderId === null ||
    sellerOrderId === null ||
    sellerId === null ||
    !dropoff.ok ||
    !service.ok ||
    !parcel.ok
  ) {
    return err({ code: 'validation.failed', fields });
  }
  const { market } = context;
  const dropoffArea = deps.carrierPolicy.serviceAreaOf(market, dropoff.stop.postcode);
  // With no fleet on for the Market nothing is read; the pickup is read below.
  if (!deps.fleets.all().some((gateway) => gateway.capabilities(market) !== null)) {
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
  const need: FleetNeed = {
    method: service.service.method,
    hasWindow: service.service.window !== null,
    temperature: parcel.parcel.temperature,
    heaviestItemGrams: parcel.parcel.weightGrams,
    itemCount: parcel.parcel.itemCount,
    declaredValue: parcel.parcel.declaredValue,
    classes: parcel.classes,
    pickupArea,
    dropoffArea,
  };
  if (capableFleets(deps, context, need).length === 0) {
    log(context, 'shipping.carrier-booking', { outcome: 'no-carrier', sellerOrderId });
    return ok('no-carrier');
  }

  const routed = await routeBooking(deps, context, {
    sellerOrderId,
    method: service.service.method,
    need,
    request: {
      externalReference: sellerOrderId,
      pickup: pickupStop.stop,
      dropoff: dropoff.stop,
      parcel: parcel.parcel,
      method: service.service.method,
      mode: carrierModeOf(service.service),
      window: service.service.window,
    },
  });
  switch (routed.kind) {
    case 'store-unavailable':
    case 'unavailable':
      log(context, 'shipping.carrier-booking', { outcome: routed.kind, sellerOrderId });
      return err(UNAVAILABLE);
    case 'no-fleet':
      log(context, 'shipping.carrier-booking', { outcome: 'no-carrier', sellerOrderId });
      return ok('no-carrier');
    case 'refused':
      log(context, 'shipping.carrier-booking', { outcome: 'refused', sellerOrderId });
      return ok('refused');
    case 'unknown':
      log(context, 'shipping.carrier-booking', {
        outcome: 'unknown',
        fleet: routed.fleet,
        sellerOrderId,
      });
      return ok('unknown');
    case 'booked':
      break;
  }
  const booking = newBooking({
    id: deps.ids.next<'CarrierBooking'>(),
    sellerOrderId,
    orderId,
    sellerId,
    fleet: routed.fleet,
    carrierReference: routed.answer.carrierReference,
    carrierStatus: routed.answer.carrierStatus,
    now: deps.clock.now(),
  });
  const stored = await deps.unitOfWork.run<CarrierBookingOutcome, CarrierDeliveryFailure>(
    market,
    async () => {
      await deps.bookings.clearAttempt(market, sellerOrderId);
      // A concurrent call booked the same reference first: the fleet holds one delivery.
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
    fleet: routed.fleet,
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
    carrierName: deps.carrierPolicy.fleetDisplayName(market, booking.fleet),
    trackingRef: booking.carrierReference,
    progress: booking.progress,
  });
}

/**
 * `cancel-carrier-delivery`: asks the fleet that holds the booking to drop a delivery not yet
 * picked up, then stores the cancellation (the fleet's own webhook may have stored it first).
 * A refusal means the fleet can no longer cancel it (picked up meanwhile) when the fleet dedupes;
 * from a fleet that cannot, a refusal is ambiguous (a lost first answer comes back refused on the
 * retry), so it answers `unknown` and ordering records it for an admin to check.
 */
export async function cancelCarrierDelivery(
  deps: ShippingDependencies,
  context: CallContext,
  input: { readonly sellerOrderId: unknown },
): Promise<Result<'cancelled' | 'not-cancellable' | 'none' | 'unknown', CarrierDeliveryFailure>> {
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

  const gateway = deps.fleets.get(booking.fleet);
  if (gateway === undefined) return err(UNAVAILABLE);
  const answer = await gateway.cancel(market, booking.carrierReference);
  if (!answer.ok) {
    log(context, 'shipping.carrier-cancel', {
      outcome: answer.error.code,
      fleet: booking.fleet,
      sellerOrderId,
    });
    if (answer.error.code === 'carrier.refused') {
      // A fleet off for the Market now cannot say whether it dedupes: ambiguous, like one that cannot.
      const dedupes = gateway.capabilities(market)?.idempotentBooking === true;
      return ok(dedupes ? 'not-cancellable' : 'unknown');
    }
    if (answer.error.code === 'carrier.unauthorized') {
      logger.warn({
        msg: 'shipping.fleet-unauthorized',
        fleet: booking.fleet,
        call: 'cancel',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    return err(UNAVAILABLE);
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
  // The common status first (Drive's words stop here); an unknown word is taken and ignored.
  const fleetStatus = toFleetStatus(event.status);
  const progress = fleetStatus === null ? null : progressOfFleetStatus(fleetStatus);
  const sellerOrderId = event.externalReference as Id<'SellerOrder'>;
  const now = deps.clock.now();

  return deps.unitOfWork.run<ReceiveWebhookOutcome, ReceiveWebhookFailure>(market, async () => {
    const booking = await deps.bookings.findBySellerOrder(market, sellerOrderId);
    if (booking === null) return err({ code: 'shipping.carrier-delivery-not-found' });
    // This route is Drive's: an event never moves another fleet's booking.
    if (booking.fleet !== 'mondapac_drive' || booking.carrierReference !== event.deliveryId)
      return err({ code: 'shipping.event-refused' });
    const taken = await deps.bookings.recordEvent(market, {
      eventId: event.eventId,
      carrier: 'mondapac_drive',
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
