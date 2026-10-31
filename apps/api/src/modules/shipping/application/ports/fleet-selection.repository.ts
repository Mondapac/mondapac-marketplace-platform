import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { CarrierMethod } from '../../domain/booking-service';
import type { FleetCode } from '../../domain/fleet';
import type { FleetSelectionModel, SelectionRule } from '../../domain/fleet-selection';

/** The admin account that made a change (a plain id). */
export type ActorId = Id<'Account'>;

/**
 * The fleet-selection models, the active model per method and the per-fleet reliability scores
 * of one Market (`shipping.fleet_selection_*`, `shipping.fleet_reliability`). Every method runs
 * inside the caller's unit of work and is scoped by the Market.
 */
export interface FleetSelectionRepository {
  listModels(market: MarketContext): Promise<readonly FleetSelectionModel[]>;
  findModel(
    market: MarketContext,
    id: Id<'FleetSelectionModel'>,
  ): Promise<FleetSelectionModel | null>;

  /** `name-taken` when another model of the Market has the name (any case). */
  insertModel(
    market: MarketContext,
    model: FleetSelectionModel,
    by: ActorId,
  ): Promise<'inserted' | 'name-taken'>;

  /** Stores an edit when the stored version is still `expectedVersion`. */
  saveModel(
    market: MarketContext,
    model: FleetSelectionModel,
    expectedVersion: number,
    by: ActorId,
  ): Promise<'saved' | 'conflict' | 'name-taken'>;

  /** The active model id per method; a method without one uses the built-in default. */
  assignments(
    market: MarketContext,
  ): Promise<ReadonlyMap<CarrierMethod, Id<'FleetSelectionModel'>>>;

  /** Makes a model active for a method, or `null` to go back to the built-in default. */
  assign(
    market: MarketContext,
    method: CarrierMethod,
    modelId: Id<'FleetSelectionModel'> | null,
    by: ActorId,
    at: Temporal.Instant,
  ): Promise<void>;

  /** The rule active for a method, or null for the built-in default. */
  activeRule(market: MarketContext, method: CarrierMethod): Promise<SelectionRule | null>;

  /** The version of the fleet-selection page (the batch save): 0 before the first save. */
  selectionVersion(market: MarketContext): Promise<number>;

  /**
   * Raises the page version from `expectedVersion` (0: the first save inserts the row); `conflict`
   * when the stored version is not `expectedVersion`, nothing changed.
   */
  bumpSelectionVersion(
    market: MarketContext,
    expectedVersion: number,
    by: ActorId,
    at: Temporal.Instant,
  ): Promise<'bumped' | 'conflict'>;

  reliabilities(market: MarketContext): Promise<ReadonlyMap<FleetCode, number>>;
  setReliability(
    market: MarketContext,
    fleet: FleetCode,
    score: number,
    by: ActorId,
    at: Temporal.Instant,
  ): Promise<void>;
}

export const FLEET_SELECTION_REPOSITORY = Symbol('FLEET_SELECTION_REPOSITORY');
