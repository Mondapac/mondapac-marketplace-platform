import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { RawReadPort } from '../../../platform/persistence/raw-reads/raw-read-port';
import type {
  StoreSearchReader,
  StoreSearchRequest,
} from '../application/ports/store-search.reader';
import { MAX_PAGE, MAX_PAGE_SIZE } from '../domain/search-query';
import type { StoreHit } from '../domain/store-document';

/**
 * {@link StoreSearchReader} over the module's raw read port: one listed statement, bound parameters
 * only (the visitor's text is `$3`). Limit and offset are whole numbers made here from checked
 * integers and travel as text.
 */
export class RawStoreSearchReader implements StoreSearchReader {
  constructor(private readonly rawReads: RawReadPort) {}

  async searchStores(
    market: MarketContext,
    request: StoreSearchRequest,
  ): Promise<readonly StoreHit[]> {
    const whole = (value: number, min: number, max: number): string => {
      if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new RangeError('search: page bounds out of range');
      }
      return String(value);
    };
    const rows = await this.rawReads.rawRead(market, 'search.store-search', {
      textSearchConfig: request.textSearchConfig,
      query: request.text,
      limit: whole(request.limit, 1, MAX_PAGE_SIZE + 1),
      offset: whole(request.offset, 0, MAX_PAGE * MAX_PAGE_SIZE),
    });
    return rows.map((row) => ({
      sellerId: row.sellerId as Id<'Seller'>,
      slug: row.slug,
      name: row.name,
      rank: row.rank,
    }));
  }
}
