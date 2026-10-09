import type { MarketContext } from '@mondapac/shared-kernel';
import type { RawReadName, RawReadParams, RawReadRow } from './statements';

export type { RawReadName, RawReadParams, RawReadRow } from './statements';

/**
 * The read-only raw door (ADR-0030 decision 1). A module's infrastructure calls
 * `rawRead(market, '<id>', params)` with a string literal id of the checked-in list; the Market
 * comes from the open read-only unit and is never a parameter. Implemented by
 * `PrismaRawReadPort`, bound by `PersistenceModule`.
 */
export interface RawReadPort {
  rawRead<K extends RawReadName>(
    market: MarketContext,
    id: K,
    params: RawReadParams<K>,
  ): Promise<RawReadRow<K>[]>;
}

/** Nest injection token of the {@link RawReadPort}. */
export const RAW_READ_PORT = Symbol('RAW_READ_PORT');
