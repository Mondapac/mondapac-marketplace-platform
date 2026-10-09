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
 * A repository method that may run only in a serializable unit was called elsewhere (inventory
 * data design 4.5). A programming error: it throws, so the unit rolls back and nothing is written.
 */
export class SerializableUnitRequiredError extends Error {
  override readonly name = 'SerializableUnitRequiredError';
  constructor(operation: string) {
    super(`${operation} runs only in a serializable unit opened by runSerializable`);
  }
}

/**
 * The one way inventory opens a `serializable` unit (data design 4.5, finding F2): the stock write
 * that may create the first item of a sell unit, and the retirement handler. It closes the write
 * skew between that creation and a retirement tombstone: under SERIALIZABLE for both units
 * PostgreSQL refuses one with `40001`, the UnitOfWork runs `work` again, and the retried creator
 * sees the tombstone.
 *
 * The platform UnitOfWork does not expose the isolation of the open unit, so this helper marks its
 * own work, and {@link assertSerializableUnit} fails closed outside it.
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
 * whole unit, inbox row included.
 */
export function runSerializableOnce<T, E>(
  unitOfWork: UnitOfWork,
  market: MarketContext,
  delivery: EventDelivery,
  work: () => Promise<Result<T, E>>,
): Promise<Result<HandledOnce<T>, E>> {
  return unitOfWork.runOnce(market, delivery, () => serializableScope.run(true, work), {
    isolation: 'serializable',
    // A Variant of a PLATFORM product is retired across every seller's Offer (data design 4.4):
    // many sell units in one unit, so it gets the longest unit the platform allows.
    timeoutMs: MAX_UNIT_TIMEOUT_MS,
  });
}

/** Throws {@link SerializableUnitRequiredError} unless called inside {@link runSerializable}. */
export function assertSerializableUnit(operation: string): void {
  if (serializableScope.getStore() !== true) throw new SerializableUnitRequiredError(operation);
}
