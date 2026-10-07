import { AsyncLocalStorage } from 'node:async_hooks';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { GuardUnit } from './market-guard';

/**
 * The open unit (platform persistence design, "P", 3.2): the one value the persistence
 * layer's `AsyncLocalStorage` carries. The Market the unit was opened with, the read-only
 * flag, the model-delegate view `tx(market)` hands out (the transaction client's, or for a
 * read-only unit the guarded base client's; ADR-0025), and a `closed` flag that `run` sets
 * when the unit ends. No actor, no correlation id, no accessor for modules: only
 * `platform/persistence/` reads it (PA4).
 */
export class OpenUnit implements GuardUnit {
  #closed = false;

  constructor(
    readonly market: MarketContext,
    readonly readOnly: boolean,
    readonly view: object,
  ) {
    Object.freeze(this);
  }

  /** Set once by `run`; a query that meets a closed unit is refused (ADR-0025 condition (a)). */
  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    this.#closed = true;
  }
}

/** The single store of open units. Not exported from the persistence module. */
export const unitStorage = new AsyncLocalStorage<OpenUnit>();
