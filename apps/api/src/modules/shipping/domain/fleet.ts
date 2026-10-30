import type { Money } from '@mondapac/shared-kernel';
import type { CarrierMethod } from './booking-service';

// Fleets (delivery models, package 3). A fleet is a delivery provider the platform can book:
// Mondapac Drive (our own), Uber Direct, Zoom2u, DoorDash Drive, Australia Post, and a deterministic fake for
// tests. The seller never chooses one: the router picks per seller order from the buyer's method,
// what each fleet declares it can carry, and the admin's active selection model. Pure rules only.

/** Every fleet the platform knows. `fake_test` is for tests and development, never a Market's. */
export const FLEET_CODES = [
  'mondapac_drive',
  'uber_direct',
  'zoom2u',
  'doordash_drive',
  'auspost',
  'fake_test',
] as const;
export type FleetCode = (typeof FLEET_CODES)[number];

export const isFleetCode = (value: unknown): value is FleetCode =>
  typeof value === 'string' && (FLEET_CODES as readonly string[]).includes(value);

/** The fleet whose price and ETA win a tie: the platform's own (owner decision). */
export const OWN_FLEET: FleetCode = 'mondapac_drive';

/**
 * The order used when no model is active for a method, and the last tie-break: own fleet first,
 * then Uber Direct, Zoom2u, DoorDash Drive, Australia Post. The fake never outranks a real fleet.
 */
export const DEFAULT_FLEET_ORDER: readonly FleetCode[] = [
  'mondapac_drive',
  'uber_direct',
  'zoom2u',
  'doordash_drive',
  'auspost',
  'fake_test',
];

/**
 * The fleets whose delivery status the platform polls because they send no webhook it can verify
 * (Zoom2u: no signed webhook is known; Australia Post: none). Uber Direct and Mondapac Drive
 * push signed webhooks and are not polled.
 */
export const POLLED_FLEETS: readonly FleetCode[] = ['zoom2u', 'auspost'];

export const TEMPERATURES = ['ambient', 'chilled', 'frozen'] as const;
export type Temperature = (typeof TEMPERATURES)[number];

/** A fleet's delivery status, the same words for every fleet (each adapter maps its own). */
export const FLEET_DELIVERY_STATUSES = [
  'pending',
  'assigned',
  'picked_up',
  'delivered',
  'cancelled',
  'returned',
  'failed',
] as const;
export type FleetDeliveryStatus = (typeof FLEET_DELIVERY_STATUSES)[number];

/**
 * What a fleet declares for one Market. `null` from `capabilities(market)` means the fleet is OFF
 * for that Market (no settings, or no credentials): it is never a candidate.
 */
export interface FleetCapabilities {
  readonly fleet: FleetCode;
  readonly methods: readonly CarrierMethod[];
  /** ServiceArea codes (city areas) in which BOTH ends of a trip must fall. */
  readonly serviceAreas: readonly string[];
  /**
   * True for a fleet that carries to places outside every ServiceArea (Australia Post): the
   * drop-off must then fall in no city area at all (the pickup is not limited: a depot or post
   * office takes the parcel). Such a fleet is not tested against `serviceAreas`.
   */
  readonly outsideCityAreasOnly: boolean;
  readonly temperatures: readonly Temperature[];
  /** The heaviest single item carried, in grams; null: no limit. */
  readonly maxItemWeightGrams: number | null;
  readonly maxItems: number | null;
  readonly maxOrderValue: Money | null;
  /** Item classes (for example `alcohol`) this fleet refuses. */
  readonly prohibitedClasses: readonly string[];
  /**
   * True when the fleet books once per `externalReference`, so repeating a booking after a lost
   * answer is harmless. False: after an unavailable answer the order may already be booked, so
   * the router never repeats it and never tries another fleet.
   */
  readonly idempotentBooking: boolean;
  /** True when the fleet can be booked for a buyer's window (`scheduled`). */
  readonly supportsWindow: boolean;
}

/** What a seller order needs of a fleet. */
export interface FleetNeed {
  readonly method: CarrierMethod;
  readonly hasWindow: boolean;
  readonly temperature: Temperature;
  readonly heaviestItemGrams: number;
  readonly itemCount: number;
  readonly declaredValue: Money;
  /** Classes of the goods (catalog classification); empty until the catalog supplies them. */
  readonly classes: readonly string[];
  /** The ServiceArea code of the pickup and of the drop-off; null: in no city area. */
  readonly pickupArea: string | null;
  readonly dropoffArea: string | null;
}

/** Why a fleet cannot take an order, for logs and tests; `null` from {@link mismatchOf} means it can. */
export type FleetMismatch =
  'method' | 'window' | 'area' | 'temperature' | 'weight' | 'items' | 'value' | 'class';

/** The first reason `capabilities` cannot take `need`, or null when it can. */
export function mismatchOf(capabilities: FleetCapabilities, need: FleetNeed): FleetMismatch | null {
  if (!capabilities.methods.includes(need.method)) return 'method';
  if (need.hasWindow && !capabilities.supportsWindow) return 'window';
  if (capabilities.outsideCityAreasOnly) {
    if (need.dropoffArea !== null) return 'area';
  } else {
    const served = new Set(capabilities.serviceAreas);
    if (need.pickupArea === null || need.dropoffArea === null) return 'area';
    if (!served.has(need.pickupArea) || !served.has(need.dropoffArea)) return 'area';
  }
  if (!capabilities.temperatures.includes(need.temperature)) return 'temperature';
  if (
    capabilities.maxItemWeightGrams !== null &&
    need.heaviestItemGrams > capabilities.maxItemWeightGrams
  ) {
    return 'weight';
  }
  if (capabilities.maxItems !== null && need.itemCount > capabilities.maxItems) return 'items';
  const limit = capabilities.maxOrderValue;
  if (limit !== null) {
    // A value in another currency cannot be compared: refuse rather than guess.
    if (
      limit.currency !== need.declaredValue.currency ||
      need.declaredValue.amount > limit.amount
    ) {
      return 'value';
    }
  }
  if (need.classes.some((name) => capabilities.prohibitedClasses.includes(name))) return 'class';
  return null;
}
