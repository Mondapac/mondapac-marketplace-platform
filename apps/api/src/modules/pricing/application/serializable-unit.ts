import { AsyncLocalStorage } from 'node:async_hooks';
import type { MarketContext, Result } from '@mondapac/shared-kernel';
import type { EventDelivery } from '../../../platform/events/event-delivery';
import {
  MAX_UNIT_TIMEOUT_MS,
  type HandledOnce,
  type UnitOfWork,
} from '../../../platform/unit-of-work/unit-of-work';

/**
 * Marks the work of a unit that {@link runSerializable} opened. Module-private: the only way in
 * is `runSerializable`, which always asks the UnitOfWork for `serializable`.
 */
const serializableScope = new AsyncLocalStorage<true>();

/**
 * A repository method that may run only in a serializable unit was called elsewhere (pricing
 * design 9, M3; pricing-data 5.1; Hassan M1 on slice 1 part 2). A programming error: it throws,
 * so the unit rolls back and nothing is written.
 */
export class SerializableUnitRequiredError extends Error {
  override readonly name = 'SerializableUnitRequiredError';
  constructor(operation: string) {
    super(`${operation} runs only in a serializable unit opened by runSerializable`);
  }
}

/**
 * The one way pricing opens a `serializable` unit (pricing-data 5.1): the unit that inserts a
 * `price_series` row (and, later, a `cost_series` row), and the retirement and re-key handlers.
 * It closes the write skew between a first price and a retirement: under SERIALIZABLE for both
 * units PostgreSQL refuses one with `40001`, the UnitOfWork runs `work` again, and the retried
 * creator sees the tombstone.
 *
 * The platform UnitOfWork does not expose the isolation of the open unit, so this helper marks
 * its own work, and {@link assertSerializableUnit} fails closed outside it (Hassan M1).
 */
export function runSerializable<T, E>(
  unitOfWork: UnitOfWork,
  market: MarketContext,
  work: () => Promise<Result<T, E>>,
): Promise<Result<T, E>> {
  return unitOfWork.run(market, () => serializableScope.run(true, work), {
    isolation: 'serializable',
  });
}

/**
 * {@link runSerializable} for an event handler: the inbox row, the work and the delivery mark in
 * one `serializable` unit (`UnitOfWork.runOnce` with the isolation option). A `40001` retries the
 * whole unit, inbox row included. The retirement handlers use it (design 6.4, 9).
 */
export function runSerializableOnce<T, E>(
  unitOfWork: UnitOfWork,
  market: MarketContext,
  delivery: EventDelivery,
  work: () => Promise<Result<T, E>>,
): Promise<Result<HandledOnce<T>, E>> {
  return unitOfWork.runOnce(market, delivery, () => serializableScope.run(true, work), {
    isolation: 'serializable',
    // A Product's Variant is shared by every seller's Offer of a PLATFORM product: many series
    // in one unit, so the longest unit the platform allows.
    timeoutMs: MAX_UNIT_TIMEOUT_MS,
  });
}

/** Throws {@link SerializableUnitRequiredError} unless called inside {@link runSerializable}. */
export function assertSerializableUnit(operation: string): void {
  if (serializableScope.getStore() !== true) throw new SerializableUnitRequiredError(operation);
}
