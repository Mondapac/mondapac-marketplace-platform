import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuthorisationCheck } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SavedFilterStore, StoredFilter, ListPopulation } from '../../contracts';
import { inTabOrder } from '../../domain/saved-filter-rules';
import {
  callerOf,
  storeOf,
  canShareOf,
  holds,
  viewOf,
  type AccessRefusal,
  type ListRegistry,
  type SavedFilterView,
  type ValidationFailure,
} from '../saved-filter-shared';

export interface SavedFiltersListInput {
  readonly listKey?: unknown;
}

export interface SavedFiltersListOutput {
  readonly listKey: string;
  readonly items: readonly SavedFilterView[];
  /** Whether the caller holds the list's share key. */
  readonly canShare: boolean;
}

export type SavedFiltersListFailure = AccessRefusal | ValidationFailure;

export interface SavedFiltersListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: SavedFilterStore;
  readonly registry: ListRegistry;
  readonly authorisation: AuthorisationCheck;
}

const KEYS = new Set(['listKey']);

/**
 * `lists.saved-filters-list` (super list B0-1b): the saved filters of an admin list the caller can
 * use, their own first and then the ones shared with everyone. Rule: an authenticated admin; the
 * list's own view key is then asked through the authorisation port, and a denial or an
 * unavailable answer refuses the call before anything is read.
 */
export class SavedFiltersList extends UseCase<
  SavedFiltersListInput,
  SavedFiltersListOutput,
  SavedFiltersListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.saved-filters-list',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedFiltersListDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SavedFiltersListInput,
  ): Promise<Result<SavedFiltersListOutput, SavedFiltersListFailure>> {
    return handleSavedFiltersList('admin', this.deps, context, input);
  }
}

/**
 * The body of the use case for one population: the admin class and the seller class of
 * `seller-saved-filters` run it with their own population, so the rules stay in one place.
 */
export async function handleSavedFiltersList(
  population: ListPopulation,
  deps: SavedFiltersListDependencies,
  context: CallContext,
  input: SavedFiltersListInput,
): Promise<Result<SavedFiltersListOutput, SavedFiltersListFailure>> {
  const caller = callerOf(context, population);
  if (!caller.ok) return caller;
  const member = caller.value;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err({ code: 'validation.failed', fields: [{ path: 'query', code: 'type' }] });
  }
  for (const key of Object.keys(input)) {
    if (!KEYS.has(key))
      return err({ code: 'validation.failed', fields: [{ path: key, code: 'unknown' }] });
  }
  const list = deps.registry.lookup(input.listKey, population);
  if (!list.ok) return list;
  const sellerId = storeOf(member, list.value);
  const viewed = await holds(
    deps.authorisation,
    context,
    'lists.saved-filters-list-view',
    list.value.viewKey,
  );
  if (!viewed.ok) return viewed;
  const canShare = await canShareOf(
    deps.authorisation,
    context,
    'lists.saved-filters-list',
    list.value,
  );
  if (!canShare.ok) return canShare;

  const { market } = context;
  const read = await deps.unitOfWork.run<readonly StoredFilter[], never>(
    market,
    async () =>
      ok(await deps.store.visibleTo(market, sellerId, list.value.listKey, member.accountId)),
    { readOnly: true },
  );
  if (!read.ok) return read;
  // A saved document the list no longer reads (its vocabulary moved on) is left out, so the
  // panel never opens a tab it cannot apply.
  const usable = read.value.filter((filter) => list.value.parsePayload(filter.payload).ok);
  return ok({
    listKey: list.value.listKey,
    items: inTabOrder(usable, member.accountId).map((filter) =>
      viewOf(filter, member.accountId, canShare.value),
    ),
    canShare: canShare.value,
  });
}
