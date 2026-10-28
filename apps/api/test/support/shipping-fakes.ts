import type { Id, MarketContext, Money, Temporal } from '@mondapac/shared-kernel';
import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { CarrierBookingRepository } from '../../src/modules/shipping/application/ports/carrier-booking.repository';
import type {
  CarrierBookingRequest,
  CarrierFailure,
  CarrierQuoteRequest,
  CarrierStop,
} from '../../src/modules/shipping/application/ports/carrier-gateway';
import type { DeliverySettingsRepository } from '../../src/modules/shipping/application/ports/delivery-settings.repository';
import type { DeliveryMethod } from '../../src/modules/shipping/domain/delivery-methods';
import {
  DEFAULT_DELIVERY_SETTINGS,
  type DeliverySettings,
  type DeliverySettingsInput,
} from '../../src/modules/shipping/domain/delivery-settings';
import type { FleetRegistry } from '../../src/modules/shipping/application/ports/fleet-registry';
import type { FleetSelectionRepository } from '../../src/modules/shipping/application/ports/fleet-selection.repository';
import type { PickupDirectory } from '../../src/modules/shipping/application/ports/pickup-directory';
import type { CarrierGateway } from '../../src/modules/shipping/application/ports/carrier-gateway';
import type { CarrierMethod } from '../../src/modules/shipping/domain/booking-service';
import type { CarrierBooking } from '../../src/modules/shipping/domain/carrier-booking';
import type { FleetCapabilities, FleetCode } from '../../src/modules/shipping/domain/fleet';
import type {
  FleetSelectionModel,
  SelectionRule,
} from '../../src/modules/shipping/domain/fleet-selection';

// In-memory stand-ins of shipping's ports for the unit tests of the carrier flows, the router and
// the fleet-selection use cases. They keep the rules of the real repositories that matter to the
// flows (one booking per seller order, versioned saves, unique model names, one event per id).

export class MemoryBookings implements CarrierBookingRepository {
  readonly rows = new Map<string, CarrierBooking>();
  readonly events = new Set<string>();
  readonly attempts = new Map<string, FleetCode>();
  findBySellerOrder(m: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    return Promise.resolve(this.rows.get(`${m.marketId}|${sellerOrderId}`) ?? null);
  }
  findByCarrierReference(m: MarketContext, fleet: FleetCode, carrierReference: string) {
    return Promise.resolve(
      [...this.rows.entries()].find(
        ([key, b]) =>
          key.startsWith(`${m.marketId}|`) &&
          b.fleet === fleet &&
          b.carrierReference === carrierReference,
      )?.[1] ?? null,
    );
  }
  listOpen(m: MarketContext, fleet: FleetCode, limit: number) {
    const at = (b: CarrierBooking) => b.polledAt?.epochMilliseconds ?? -1;
    return Promise.resolve(
      [...this.rows.entries()]
        .filter(
          ([key, b]) =>
            key.startsWith(`${m.marketId}|`) &&
            b.fleet === fleet &&
            (b.progress === 'booked' || b.progress === 'picked-up'),
        )
        .map(([, b]) => b)
        .sort(
          (a, b) => at(a) - at(b) || a.createdAt.epochMilliseconds - b.createdAt.epochMilliseconds,
        )
        .slice(0, limit),
    );
  }
  markPolled(m: MarketContext, bookingId: Id<'CarrierBooking'>, at: Temporal.Instant) {
    for (const [key, b] of this.rows) {
      if (key.startsWith(`${m.marketId}|`) && b.id === bookingId) {
        this.rows.set(key, { ...b, polledAt: at });
      }
    }
    return Promise.resolve();
  }
  insert(m: MarketContext, booking: CarrierBooking) {
    const key = `${m.marketId}|${booking.sellerOrderId}`;
    if (this.rows.has(key)) return Promise.resolve('exists' as const);
    this.rows.set(key, booking);
    return Promise.resolve('inserted' as const);
  }
  save(m: MarketContext, booking: CarrierBooking, expectedVersion: number) {
    const key = `${m.marketId}|${booking.sellerOrderId}`;
    const current = this.rows.get(key);
    if (current?.version !== expectedVersion) return Promise.resolve('conflict' as const);
    // As the database: a save writes the business columns, not the poll's own `polledAt`.
    this.rows.set(key, { ...booking, polledAt: current.polledAt });
    return Promise.resolve('saved' as const);
  }
  findAttempt(m: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    return Promise.resolve(this.attempts.get(`${m.marketId}|${sellerOrderId}`) ?? null);
  }
  markAttempt(m: MarketContext, sellerOrderId: Id<'SellerOrder'>, fleet: FleetCode) {
    this.attempts.set(`${m.marketId}|${sellerOrderId}`, fleet);
    return Promise.resolve();
  }
  clearAttempt(m: MarketContext, sellerOrderId: Id<'SellerOrder'>) {
    this.attempts.delete(`${m.marketId}|${sellerOrderId}`);
    return Promise.resolve();
  }
  recordEvent(m: MarketContext, event: { readonly eventId: string; readonly carrier: string }) {
    const key = `${m.marketId}|${event.carrier}|${event.eventId}`;
    if (this.events.has(key)) return Promise.resolve('duplicate' as const);
    this.events.add(key);
    return Promise.resolve('recorded' as const);
  }
}

export class MemorySelection implements FleetSelectionRepository {
  readonly models = new Map<string, FleetSelectionModel & { marketId: string }>();
  readonly active = new Map<string, Id<'FleetSelectionModel'> | null>();
  readonly scores = new Map<string, number>();
  listModels(m: MarketContext) {
    return Promise.resolve([...this.models.values()].filter((x) => x.marketId === m.marketId));
  }
  findModel(m: MarketContext, id: Id<'FleetSelectionModel'>) {
    const model = this.models.get(id);
    return Promise.resolve(model?.marketId === m.marketId ? model : null);
  }
  private taken(m: MarketContext, name: string, except: string | null) {
    return [...this.models.values()].some(
      (x) =>
        x.marketId === m.marketId && x.id !== except && x.name.toLowerCase() === name.toLowerCase(),
    );
  }
  insertModel(m: MarketContext, model: FleetSelectionModel) {
    if (this.taken(m, model.name, null)) return Promise.resolve('name-taken' as const);
    this.models.set(model.id, { ...model, marketId: m.marketId });
    return Promise.resolve('inserted' as const);
  }
  saveModel(m: MarketContext, model: FleetSelectionModel, expectedVersion: number) {
    if (this.taken(m, model.name, model.id)) return Promise.resolve('name-taken' as const);
    if (this.models.get(model.id)?.version !== expectedVersion) {
      return Promise.resolve('conflict' as const);
    }
    this.models.set(model.id, { ...model, marketId: m.marketId });
    return Promise.resolve('saved' as const);
  }
  assignments(m: MarketContext) {
    const map = new Map<CarrierMethod, Id<'FleetSelectionModel'>>();
    for (const [key, id] of this.active) {
      const [market, method] = key.split('|') as [string, CarrierMethod];
      if (market === m.marketId && id !== null) map.set(method, id);
    }
    return Promise.resolve(map);
  }
  assign(m: MarketContext, method: CarrierMethod, modelId: Id<'FleetSelectionModel'> | null) {
    this.active.set(`${m.marketId}|${method}`, modelId);
    return Promise.resolve();
  }
  activeRule(m: MarketContext, method: CarrierMethod): Promise<SelectionRule | null> {
    const id = this.active.get(`${m.marketId}|${method}`) ?? null;
    return Promise.resolve(id === null ? null : (this.models.get(id)?.rule ?? null));
  }
  reliabilities(m: MarketContext) {
    const map = new Map<FleetCode, number>();
    for (const [key, score] of this.scores) {
      const [market, fleet] = key.split('|') as [string, FleetCode];
      if (market === m.marketId) map.set(fleet, score);
    }
    return Promise.resolve(map);
  }
  setReliability(m: MarketContext, fleet: FleetCode, score: number) {
    this.scores.set(`${m.marketId}|${fleet}`, score);
    return Promise.resolve();
  }
}

/** The delivery settings of each Market and the methods taken away from each seller, in memory. */
export class MemoryDeliverySettings implements DeliverySettingsRepository {
  readonly rows = new Map<string, DeliverySettings>();
  readonly sellers = new Map<string, readonly DeliveryMethod[]>();
  settings(m: MarketContext) {
    return Promise.resolve(this.rows.get(m.marketId) ?? DEFAULT_DELIVERY_SETTINGS);
  }
  saveSettings(m: MarketContext, input: DeliverySettingsInput, expectedVersion: number) {
    const current = this.rows.get(m.marketId)?.version ?? 0;
    if (current !== expectedVersion) return Promise.resolve('conflict' as const);
    const saved: DeliverySettings = { ...input, version: expectedVersion + 1 };
    this.rows.set(m.marketId, saved);
    return Promise.resolve(saved);
  }
  unsupportedOf(m: MarketContext, sellerIds: readonly Id<'Seller'>[]) {
    const map = new Map<Id<'Seller'>, readonly DeliveryMethod[]>();
    for (const id of sellerIds) {
      const row = this.sellers.get(`${m.marketId}|${id}`);
      if (row !== undefined) map.set(id, row);
    }
    return Promise.resolve(map);
  }
  setUnsupported(m: MarketContext, sellerId: Id<'Seller'>, methods: readonly DeliveryMethod[]) {
    this.sellers.set(`${m.marketId}|${sellerId}`, methods);
    return Promise.resolve();
  }
}

export class FakePickups implements PickupDirectory {
  answer: Result<CarrierStop, { readonly code: 'pickup.not-found' | 'pickup.unavailable' }> = err({
    code: 'pickup.not-found',
  });
  pickupOf() {
    return Promise.resolve(this.answer);
  }
  postcodes: Result<ReadonlyMap<Id<'Seller'>, string>, { readonly code: 'pickup.unavailable' }> =
    ok(new Map());
  postcodesOf() {
    return Promise.resolve(this.postcodes);
  }
  zones: Result<ReadonlyMap<Id<'Seller'>, string>, { readonly code: 'pickup.unavailable' }> = ok(
    new Map(),
  );
  zonesOf() {
    return Promise.resolve(this.zones);
  }
}

/** A registry over the given gateways. */
export class ListRegistry implements FleetRegistry {
  constructor(private gateways: readonly CarrierGateway[]) {}
  set(gateways: readonly CarrierGateway[]): void {
    this.gateways = gateways;
  }
  get(fleet: FleetCode) {
    return this.gateways.find((gateway) => gateway.fleet === fleet);
  }
  all() {
    return this.gateways;
  }
}

/** What a {@link ScriptedFleet} does on a call: answers, or an error code. */
type Answer<T> = Result<T, CarrierFailure>;

/**
 * A fleet whose capabilities, price, ETA and answers a test sets. It counts every call, so a test
 * can assert a fleet was (not) asked, and in which order.
 */
export class ScriptedFleet implements CarrierGateway {
  readonly calls: string[] = [];
  readonly quoted: CarrierQuoteRequest[] = [];
  readonly booked: CarrierBookingRequest[] = [];
  declared: FleetCapabilities | null;
  price: Money | null = null;
  etaMinutes: number | null = null;
  quoteFailure: CarrierFailure | null = null;
  bookFailures: CarrierFailure[] = [];
  cancelAnswer: Answer<{ readonly carrierStatus: string }> = ok({ carrierStatus: 'CANCELLED' });

  constructor(
    readonly fleet: FleetCode,
    capabilities: FleetCapabilities | null,
  ) {
    this.declared = capabilities;
  }

  capabilities(): FleetCapabilities | null {
    return this.declared;
  }

  book(_market: MarketContext, request: CarrierBookingRequest) {
    this.calls.push('book');
    this.booked.push(request);
    const failure = this.bookFailures.shift();
    if (failure !== undefined) return Promise.resolve(err(failure));
    return Promise.resolve(
      ok({
        carrierReference: `${this.fleet}-${request.externalReference}`,
        carrierStatus: 'QUEUED',
        trackingUrl: null,
      }),
    );
  }

  quote(_market: MarketContext, request: CarrierQuoteRequest) {
    this.calls.push('quote');
    this.quoted.push(request);
    if (this.quoteFailure !== null) return Promise.resolve(err(this.quoteFailure));
    if (this.price === null) return Promise.resolve(err({ code: 'carrier.unavailable' } as const));
    return Promise.resolve(ok({ price: this.price, etaMinutes: this.etaMinutes, expiresAt: null }));
  }

  cancel() {
    this.calls.push('cancel');
    return Promise.resolve(this.cancelAnswer);
  }

  status() {
    this.calls.push('status');
    return Promise.resolve(err({ code: 'carrier.unavailable' } as const));
  }
}
