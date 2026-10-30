import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result, Temporal } from '@mondapac/shared-kernel';
import {
  advanceBooking,
  progressOfFleetStatus,
  type CarrierBooking,
  type CarrierProgress,
} from '../domain/carrier-booking';
import { POLLED_FLEETS } from '../domain/fleet';
import { parseUberWebhook, toFleetStatus } from '../domain/uber-webhook-event';
import { progressed } from './carrier-flow';
import type { ShippingDependencies } from './shipping-dependencies';

// The status of the external fleets (Phase 6 package 5e): Uber Direct pushes a signed webhook;
// Zoom2u and Australia Post have none the platform can verify, so their open bookings are polled.
// Both end in the same step (`applyReport`), which moves the booking forward only, in one unit
// with its event, and keeps no personal data and no proof of delivery, only that one exists.

const logger = new Logger('ShippingFleetStatus');

/**
 * The key an Uber event is taken under in `shipping.carrier_events`, whose id column is a UUID:
 * the first 128 bits of the SHA-256 of the fleet and the event id, shaped as a UUID. The same
 * event always has the same key; Uber's id format does not matter.
 */
export function uberEventKey(eventId: string): string {
  const hex = createHash('sha256').update(`uber_direct|${eventId}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

interface CarrierProgressReport {
  readonly progress: CarrierProgress;
  readonly carrierStatus: string;
  readonly proofOfDelivery?: boolean;
}

export interface ReceiveUberWebhookInput {
  /** The exact bytes of the request body. */
  readonly payload: Uint8Array;
  /** The `x-uber-signature` header, unread. */
  readonly signature: unknown;
}

export type ReceiveUberWebhookFailure =
  | { readonly code: 'validation.failed' }
  /**
   * Uber Direct is off for the Market, or has no signing secret there: the route does not exist
   * (404), so an unsigned caller cannot tell the two apart.
   */
  | { readonly code: 'shipping.fleet-off' }
  | { readonly code: 'shipping.signature-invalid' }
  /** No booking (yet) under the delivery id: Uber retries, so a race with booking settles. */
  | { readonly code: 'shipping.carrier-delivery-not-found' };

/** What the step did with a verified event; every one answers 200. */
export type FleetWebhookOutcome = 'applied' | 'unchanged' | 'duplicate' | 'ignored';

/**
 * Moves `booking` to what the fleet reported, inside the caller's unit: the change and its event
 * are stored together. `conflict` when a concurrent change won (the caller retries or skips).
 */
async function applyReport(
  deps: ShippingDependencies,
  context: CallContext,
  booking: CarrierBooking,
  report: CarrierProgressReport,
  now: Temporal.Instant,
): Promise<'applied' | 'unchanged' | 'conflict'> {
  const { market } = context;
  const advanced = advanceBooking(booking, report, now);
  if (advanced === null) return 'unchanged';
  if ((await deps.bookings.save(market, advanced, booking.version)) !== 'saved') return 'conflict';
  if (advanced.progress !== booking.progress) {
    await deps.outbox.append(context, [progressed(advanced)]);
  }
  return 'applied';
}

/**
 * `receive-uber-webhook`: Uber Direct's delivery status event. Off for the Market, or without a signing
 * secret there, is 404 before anything else. The signature (HMAC-SHA256 of the raw bytes under the Market's secret) is
 * checked before the body is read; the Market is the route's, never the body's. The booking is
 * found by Uber's delivery id within that Market and fleet, so an event cannot move another
 * fleet's or Market's booking. An event is taken once by its id. A proof of delivery is kept as
 * its instant alone.
 */
export async function receiveUberWebhook(
  deps: ShippingDependencies,
  context: CallContext,
  input: ReceiveUberWebhookInput,
): Promise<Result<FleetWebhookOutcome, ReceiveUberWebhookFailure>> {
  const { market } = context;
  if (
    deps.fleets.get('uber_direct')?.capabilities(market) == null ||
    !deps.uberWebhookSignature.configuredFor(market.marketId)
  ) {
    return err({ code: 'shipping.fleet-off' });
  }
  if (!(input?.payload instanceof Uint8Array)) return err({ code: 'validation.failed' });
  if (!deps.uberWebhookSignature.verify(market.marketId, input.payload, input.signature)) {
    return err({ code: 'shipping.signature-invalid' });
  }
  const parsed = parseUberWebhook(input.payload);
  if (parsed.kind === 'invalid') return err({ code: 'validation.failed' });
  if (parsed.kind === 'other') return ok('ignored');
  const { event } = parsed;
  const fleetStatus = toFleetStatus(event.status);
  const progress = fleetStatus === null ? null : progressOfFleetStatus(fleetStatus);
  const now = deps.clock.now();

  return deps.unitOfWork.run<FleetWebhookOutcome, ReceiveUberWebhookFailure>(market, async () => {
    const booking = await deps.bookings.findByCarrierReference(
      market,
      'uber_direct',
      event.deliveryId,
    );
    if (booking === null) return err({ code: 'shipping.carrier-delivery-not-found' });
    const taken = await deps.bookings.recordEvent(market, {
      eventId: uberEventKey(event.eventId),
      carrier: 'uber_direct',
      receivedAt: now,
    });
    if (taken === 'duplicate') return ok('duplicate');
    // A status this version does not know yet is taken (so it is not sent again) and ignored.
    if (progress === null) return ok('ignored');
    const applied = await applyReport(
      deps,
      context,
      booking,
      {
        progress,
        carrierStatus: event.status.toUpperCase(),
        proofOfDelivery: event.proofOfDelivery,
      },
      now,
    );
    // A concurrent event moved it: commit nothing, Uber sends this one again.
    if (applied === 'conflict')
      throw new Error('receive-uber-webhook: the booking changed meanwhile');
    return ok(applied);
  });
}

/** How many open bookings of one fleet one poll asks about. */
export const POLL_BATCH = 25;

export interface PollSummary {
  readonly fleets: number;
  readonly asked: number;
  readonly changed: number;
  readonly failed: number;
}

export type PollFailure = { readonly code: 'shipping.carrier-unavailable' };

/**
 * `poll-fleet-status`: for each fleet that is on for the Market and has no verifiable webhook
 * ({@link POLLED_FLEETS}), asks the fleet about its open bookings (booked or picked up), the ones
 * asked least recently first, at most {@link POLL_BATCH} per fleet per run. The fleet is called
 * outside every unit; each booking is then stored in its own unit, so one failure costs one
 * booking. A booking is marked as asked whatever the answer, so a stuck one never starves the
 * rest. A fleet that answers unauthorized or not configured is skipped for the run. Idempotent
 * and safe to overlap with itself: the change is a conditional save by version.
 */
export async function pollFleetStatus(
  deps: ShippingDependencies,
  context: CallContext,
): Promise<Result<PollSummary, PollFailure>> {
  const { market } = context;
  let fleets = 0;
  let asked = 0;
  let changed = 0;
  let failed = 0;
  for (const fleet of POLLED_FLEETS) {
    const gateway = deps.fleets.get(fleet);
    if (gateway === undefined || gateway.capabilities(market) === null) continue;
    fleets += 1;
    const open = await deps.unitOfWork.run(
      market,
      async () => ok(await deps.bookings.listOpen(market, fleet, POLL_BATCH)),
      { readOnly: true },
    );
    if (!open.ok) return err({ code: 'shipping.carrier-unavailable' });
    for (const booking of open.value) {
      const answer = await gateway.status(market, booking.carrierReference);
      asked += 1;
      if (!answer.ok) {
        failed += 1;
        if (answer.error.code === 'carrier.unauthorized') {
          logger.warn({
            msg: 'shipping.fleet-unauthorized',
            fleet,
            call: 'status',
            marketId: market.marketId,
            correlationId: context.correlationId,
          });
        }
        if (
          answer.error.code === 'carrier.unauthorized' ||
          answer.error.code === 'carrier.not-configured'
        ) {
          break;
        }
      }
      const now = deps.clock.now();
      const outcome = await deps.unitOfWork.run<'applied' | 'unchanged' | 'conflict', PollFailure>(
        market,
        async () => {
          const current = await deps.bookings.findBySellerOrder(market, booking.sellerOrderId);
          if (current === null || current.id !== booking.id) return ok('unchanged');
          await deps.bookings.markPolled(market, current.id, now);
          if (!answer.ok) return ok('unchanged');
          return ok(
            await applyReport(
              deps,
              context,
              current,
              {
                progress: progressOfFleetStatus(answer.value.status),
                carrierStatus: answer.value.carrierStatus,
              },
              now,
            ),
          );
        },
      );
      if (!outcome.ok || outcome.value === 'conflict') failed += 1;
      else if (outcome.value === 'applied') changed += 1;
    }
  }
  logger.log({
    msg: 'shipping.fleet-poll',
    fleets,
    asked,
    changed,
    failed,
    marketId: market.marketId,
    correlationId: context.correlationId,
  });
  return ok({ fleets, asked, changed, failed });
}
