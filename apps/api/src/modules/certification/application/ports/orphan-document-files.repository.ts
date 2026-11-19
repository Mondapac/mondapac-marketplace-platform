import type { MarketContext } from '@mondapac/shared-kernel';

/** Nest token of the {@link OrphanDocumentFilesRepository}. */
export const ORPHAN_DOCUMENT_FILES_REPOSITORY = Symbol(
  'CERTIFICATION_ORPHAN_DOCUMENT_FILES_REPOSITORY',
);

/**
 * The question the certificate file sweep asks (file storage pilot F6c). It runs in the caller's
 * open read-only unit; the Market comes from the `MarketContext` only.
 */
export interface OrphanDocumentFilesRepository {
  /**
   * Of the given object keys (`certification/<subject id>/<document id>`), the ones that no
   * uploaded-document row of this Market names AND whose subject belongs to this Market: a seller
   * with a certificate here, or this Market's platform subject. A key of any other subject, even
   * one of another Market that shares the store, is never returned.
   */
  unreferencedObjectKeys(
    market: MarketContext,
    keys: readonly string[],
  ): Promise<readonly string[]>;
}
