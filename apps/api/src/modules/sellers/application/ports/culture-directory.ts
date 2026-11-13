import type { CallContext, Id, Result } from '@mondapac/shared-kernel';

/** The directory could not answer: no partial answer, and the caller refuses (fail closed). */
export interface CultureDirectoryUnavailable {
  readonly code: 'culture-directory.unavailable';
}

/** What `sellers` knows of a culture of `catalog`. */
export interface CultureInfo {
  readonly id: Id<'Culture'>;
  readonly code: string;
  readonly status: 'draft' | 'active' | 'inactive';
  readonly requiredCertificationType: string | null;
  readonly names: Readonly<Record<string, string>>;
}

/**
 * The cultures of the context's Market among some ids (ADR-0047: `catalog` owns the cultures).
 * Bound to catalog's `culturesByIds` by `SellerStoreProfileModule` (catalog imports sellers, so
 * sellers cannot import catalog's module). The adapter opens a read-only unit of its own, so the
 * caller holds no unit open while asking. An unknown id is absent from the answer.
 */
export interface CultureDirectory {
  byIds(
    context: CallContext,
    cultureIds: readonly Id<'Culture'>[],
  ): Promise<Result<ReadonlyMap<Id<'Culture'>, CultureInfo>, CultureDirectoryUnavailable>>;

  /** Every ACTIVE culture of the Market (ADR-0048: what "universal" means at signup). */
  active(
    context: CallContext,
  ): Promise<Result<readonly CultureInfo[], CultureDirectoryUnavailable>>;
}

export const CULTURE_DIRECTORY = Symbol('CULTURE_DIRECTORY');
