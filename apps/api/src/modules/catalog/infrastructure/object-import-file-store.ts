import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { ObjectStore } from '../../../platform/storage/object-store';
import type { ImportFileStore } from '../application/ports/import-file-store';

/**
 * {@link ImportFileStore} over the platform's private object store (ADR-0016). The key is
 * `catalog/imports/<MARKET>/<job id>`: built from ids only, so a file name or any request text can
 * never reach a path; the store's own key check refuses anything else.
 */
export class ObjectImportFileStore implements ImportFileStore {
  constructor(private readonly store: ObjectStore) {}

  keyOf(market: MarketContext, id: Id<'PlatformImport'>): string {
    return `catalog/imports/${market.marketId}/${id}`;
  }

  put(key: string, bytes: Buffer): Promise<void> {
    return this.store.put(key, bytes);
  }

  get(key: string): Promise<Buffer | null> {
    return this.store.get(key);
  }

  delete(key: string): Promise<void> {
    return this.store.delete(key);
  }
}
