import { Injectable } from '@nestjs/common';
import { isMinted } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import { MarketMismatchError, NoUnitOfWorkError } from '../unit-of-work/errors';
import type { MarketTransaction } from './guarded-client';
import { unitStorage } from './unit-store';

export type { MarketTransaction } from './guarded-client';

/**
 * The one door of module code to the database (platform persistence design, "P", 3.3).
 * A repository in `modules/<m>/infrastructure/` calls `tx(market)` on every call and never
 * keeps what it returns; it is typed against {@link MarketTransaction}.
 *
 * `tx(market)` returns the open unit's model delegates. It throws `NoUnitOfWorkError` when
 * no unit is open (or the unit has ended) and `MarketMismatchError` when `market` is not
 * the unit's Market and tenant. Every query it serves still passes the market guard (P 4).
 */
@Injectable()
export class PrismaService {
  tx(market: MarketContext): MarketTransaction {
    const unit = unitStorage.getStore();
    if (unit === undefined || unit.closed) throw new NoUnitOfWorkError();
    if (
      !isMinted(market) ||
      market.marketId !== unit.market.marketId ||
      market.tenantId !== unit.market.tenantId
    ) {
      throw new MarketMismatchError();
    }
    return unit.view as MarketTransaction;
  }
}
