import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuthorisationCheck } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SavedFilterStore } from '../../contracts';
import {
  adminOf,
  filterIdOf,
  holds,
  invalid,
  type AccessRefusal,
  type ListRegistry,
  type ValidationFailure,
} from '../saved-filter-shared';

export interface SavedFiltersReorderInput {
  readonly listKey?: unknown;
  readonly ids?: unknown;
}

export interface SavedFiltersReorderOutput {
  readonly listKey: string;
  readonly ids: readonly string[];
}

export type SavedFiltersReorderFailure = AccessRefusal | ValidationFailure;

export interface SavedFiltersReorderDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: SavedFilterStore;
  readonly registry: ListRegistry;
  readonly authorisation: AuthorisationCheck;
}

const KEYS = new Set(['listKey', 'ids']);

/**
 * `lists.saved-filters-reorder` (super list B0-1b): puts the caller's own saved filters of a list
 * in the order of `ids`, which must name every one of them exactly once (a filter that was added
 * or deleted since the panel read the list makes the call `validation.failed` on `ids`, and the
 * panel reads the list again). Only the caller's own order changes: the shared filters of other
 * admins keep theirs. Rule: an authenticated admin, then the list's view key (fail closed).
 * Serializable, so two reorders of one list cannot interleave.
 */
export class SavedFiltersReorder extends UseCase<
  SavedFiltersReorderInput,
  SavedFiltersReorderOutput,
  SavedFiltersReorderFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.saved-filters-reorder',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedFiltersReorderDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SavedFiltersReorderInput,
  ): Promise<Result<SavedFiltersReorderOutput, SavedFiltersReorderFailure>> {
    const admin = adminOf(context);
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('body', 'type');
    }
    for (const key of Object.keys(input)) if (!KEYS.has(key)) return invalid(key, 'unknown');
    const { deps } = this;
    const list = deps.registry.lookup(input.listKey, 'admin');
    if (!list.ok) return list;
    if (!Array.isArray(input.ids)) return invalid('ids', 'type');
    const raw: unknown[] = input.ids;
    // At most one more than the cap: a longer list cannot be the caller's set.
    if (raw.length > 51) return invalid('ids', 'length');
    const ids: Id<'SavedFilter'>[] = [];
    for (const value of raw) {
      const id = filterIdOf(value);
      if (id === null) return invalid('ids', 'format');
      if (ids.includes(id)) return invalid('ids', 'duplicate');
      ids.push(id);
    }

    const viewed = await holds(
      deps.authorisation,
      context,
      'lists.saved-filters-reorder-view',
      list.value.viewKey,
    );
    if (!viewed.ok) return viewed;

    const { market } = context;
    const listKey = list.value.listKey;
    const done = await deps.unitOfWork.run<readonly string[], SavedFiltersReorderFailure>(
      market,
      async () => {
        const owned = await deps.store.ownedBy(market, null, listKey, admin.accountId);
        const ownedIds = new Set<string>(owned.map((filter) => filter.id));
        if (ownedIds.size !== ids.length || !ids.every((id) => ownedIds.has(id))) {
          return invalid('ids', 'set');
        }
        if (!(await deps.store.reposition(market, null, listKey, admin.accountId, ids))) {
          return invalid('ids', 'set');
        }
        return ok(ids);
      },
      { isolation: 'serializable' },
    );
    if (!done.ok) return done;
    return ok({ listKey, ids: done.value });
  }
}
