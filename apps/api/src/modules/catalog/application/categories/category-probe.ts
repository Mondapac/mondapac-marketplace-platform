import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';

export type CategoryProbeFailure = { readonly code: 'access.denied' };

export type CategoryProbeAnswer = { readonly held: true };

/**
 * Probes for the allowed-actions part of the category reads (categories package C1; catalog design
 * 9.2a). Each asks the gate whether the caller holds one key and reads and writes nothing, like
 * `saved-filter.share-check`: the key is decided by the gate, in one place. `access.denied` means
 * "no". Admin population only.
 */
export const adminOnly = (
  context: CallContext,
): Result<CategoryProbeAnswer, CategoryProbeFailure> => {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
    return err({ code: 'access.denied' });
  }
  return ok({ held: true });
};
