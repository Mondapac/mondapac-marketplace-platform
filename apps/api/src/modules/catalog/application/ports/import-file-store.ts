import type { Id, MarketContext } from '@mondapac/shared-kernel';

/**
 * Where the uploaded import files live: private object storage (ADR-0016), never the database. The
 * key is built here from the Market and the job id, never from a file name or any request text.
 */
export interface ImportFileStore {
  /** The key a job's file is stored under. */
  keyOf(market: MarketContext, id: Id<'PlatformImport'>): string;
  put(key: string, bytes: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export const IMPORT_FILE_STORE = Symbol('CATALOG_IMPORT_FILE_STORE');
