import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_OWN_SAVED_FILTER_SHARE } from '../../contracts/permissions';

export interface OwnSavedFilterShareCheckOutput {
  readonly canShare: true;
}

export type OwnSavedFilterShareCheckFailure = { readonly code: 'access.denied' };

/**
 * `own-saved-filter.share-check` (catalog design 9.2d): asks the gate whether the caller holds the
 * key `catalog.own-saved-filter.share`. It reads and writes nothing; the seller saved-filter use
 * cases call it to learn what the caller may do beyond their own filters (share a filter with the
 * store, manage a filter another member shared), so the key is checked by the gate, in one place.
 * `access.denied` means "no"; the seller population is required as for every seller use case.
 */
export class OwnSavedFilterShareCheck extends UseCase<
  Record<string, never>,
  OwnSavedFilterShareCheckOutput,
  OwnSavedFilterShareCheckFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-saved-filter-share-check',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_SAVED_FILTER_SHARE.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<OwnSavedFilterShareCheckOutput, OwnSavedFilterShareCheckFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'seller') {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    return Promise.resolve(ok({ canShare: true }));
  }
}
