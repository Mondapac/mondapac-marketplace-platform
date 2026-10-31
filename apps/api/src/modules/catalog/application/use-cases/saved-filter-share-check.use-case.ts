import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_SAVED_FILTER_SHARE } from '../../contracts/permissions';

export interface SavedFilterShareCheckOutput {
  readonly canShare: true;
}

export type SavedFilterShareCheckFailure = { readonly code: 'access.denied' };

/**
 * `saved-filter.share-check` (catalog design 9.2d): asks the gate whether the caller holds the
 * key `catalog.saved-filter.share`. It reads and writes nothing; the saved-filter use cases call
 * it to learn what the caller may do beyond their own filters (share a filter with everyone,
 * manage a filter somebody else shared), so the key is checked by the gate, in one place. The
 * answer `access.denied` means "no"; the admin population is required as for every admin use case.
 */
export class SavedFilterShareCheck extends UseCase<
  Record<string, never>,
  SavedFilterShareCheckOutput,
  SavedFilterShareCheckFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.saved-filter-share-check',
    rule: { kind: 'permissions', allOf: [CATALOG_SAVED_FILTER_SHARE.key] },
  };

  constructor(gate: UseCaseGate) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<SavedFilterShareCheckOutput, SavedFilterShareCheckFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return Promise.resolve(err({ code: 'access.denied' }));
    }
    return Promise.resolve(ok({ canShare: true }));
  }
}

/** What the saved-filter use cases need of the probe: its `execute` and nothing else. */
export type AccessProbe = Pick<SavedFilterShareCheck, 'execute'>;
