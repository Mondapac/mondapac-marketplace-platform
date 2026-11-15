import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  MAX_SAVED_FILTERS_PER_OWNER,
  MAX_SHARED_SAVED_FILTERS,
  inTabOrder,
  isVisibleTo,
  mayManage,
  type SavedFilter,
} from '../../domain/saved-view';
import {
  SavedFilterChangedAudit,
  SavedFilterRemovedAudit,
  SavedFilterSharedAudit,
} from '../../domain/audit';
import { invalid, type ValidationFailure } from './saved-view-lists';
import {
  auditListOf,
  callerOf,
  canShareOf,
  filterIdOf,
  listOf,
  nameOf,
  viewOf,
  visibilityOf,
  type Population,
  type SavedFilterView,
  type SavedViewDependencies,
} from './saved-view-shared';

// The work of the saved-filter use cases, one function each. The admin and seller
// use cases are thin classes (their own key and name) that call these with their population.

type Denied = { readonly code: 'access.denied' };
type Unavailable = { readonly code: 'access.unavailable' };
type NotFound = { readonly code: 'saved-filter.not-found' };
type NameTaken = { readonly code: 'saved-filter.name-taken' };
type LimitReached = { readonly code: 'saved-filter.limit-reached'; readonly max: number };
type SharedLimitReached = {
  readonly code: 'saved-filter.shared-limit-reached';
  readonly max: number;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ---- list ---------------------------------------------------------------------------------

export interface SavedFiltersListOutput {
  readonly items: readonly SavedFilterView[];
  /** Whether the caller may save a filter for everyone (always false for the seller list). */
  readonly canShare: boolean;
  readonly limits: { readonly perOwner: number; readonly shared: number };
}
export type SavedFiltersListFailure = Denied | Unavailable | ValidationFailure;

export async function listSavedFilters(
  deps: SavedViewDependencies,
  population: Population,
  context: CallContext,
  input: unknown,
): Promise<Result<SavedFiltersListOutput, SavedFiltersListFailure>> {
  const caller = callerOf(context, population);
  if (caller === null) return err({ code: 'access.denied' });
  if (!isRecord(input)) return invalid('query', 'type');
  for (const key of Object.keys(input)) if (key !== 'listKey') return invalid(key, 'unknown');
  const list = listOf(input['listKey'], population);
  if (!list.ok) return list;
  const canShare = await canShareOf(list.value.shareable ? deps.shareCheck : null, context);
  if (!canShare.ok) return canShare;

  const { market } = context;
  const read = await deps.unitOfWork.run(
    market,
    async () => {
      const rows = await deps.savedFilters.visibleTo(market, list.value.key, caller.accountId);
      const usable: SavedFilter[] = [];
      for (const filter of inTabOrder(rows, caller.accountId)) {
        const payload = list.value.parsePayload(filter.payload);
        if (payload.ok) usable.push({ ...filter, payload: payload.value });
      }
      return ok(usable);
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  return ok({
    items: read.value.map((filter) => viewOf(filter, caller.accountId, canShare.value)),
    canShare: canShare.value,
    limits: { perOwner: MAX_SAVED_FILTERS_PER_OWNER, shared: MAX_SHARED_SAVED_FILTERS },
  });
}

// ---- create -------------------------------------------------------------------------------

export type SavedFilterCreateFailure =
  Denied | Unavailable | NameTaken | LimitReached | SharedLimitReached | ValidationFailure;

export async function createSavedFilter(
  deps: SavedViewDependencies,
  population: Population,
  context: CallContext,
  input: unknown,
): Promise<Result<SavedFilterView, SavedFilterCreateFailure>> {
  const caller = callerOf(context, population);
  if (caller === null) return err({ code: 'access.denied' });
  if (!isRecord(input)) return invalid('body', 'type');
  for (const key of Object.keys(input)) {
    if (!['listKey', 'name', 'visibility', 'payload'].includes(key)) return invalid(key, 'unknown');
  }
  const list = listOf(input['listKey'], population);
  if (!list.ok) return list;
  const name = nameOf(input['name']);
  if (!name.ok) return name;
  const visibility = visibilityOf(input['visibility'], list.value);
  if (!visibility.ok) return visibility;
  const payload = list.value.parsePayload(input['payload']);
  if (!payload.ok) return payload;

  const canShare = await canShareOf(list.value.shareable ? deps.shareCheck : null, context);
  if (!canShare.ok) return canShare;
  if (visibility.value === 'everyone' && !canShare.value) return err({ code: 'access.denied' });

  const { market } = context;
  const listKey = list.value.key;
  const written = await deps.unitOfWork.run<SavedFilter, SavedFilterCreateFailure>(
    market,
    async () => {
      if (
        (await deps.savedFilters.countOwnedBy(market, listKey, caller.accountId)) >=
        MAX_SAVED_FILTERS_PER_OWNER
      ) {
        return err({ code: 'saved-filter.limit-reached', max: MAX_SAVED_FILTERS_PER_OWNER });
      }
      if (
        visibility.value === 'everyone' &&
        (await deps.savedFilters.countShared(market, listKey)) >= MAX_SHARED_SAVED_FILTERS
      ) {
        return err({ code: 'saved-filter.shared-limit-reached', max: MAX_SHARED_SAVED_FILTERS });
      }
      const now = deps.clock.now();
      const filter: SavedFilter = {
        id: deps.ids.next<'SavedFilter'>(),
        listKey,
        ownerAccountId: caller.accountId,
        visibility: visibility.value,
        name: name.value,
        payload: payload.value,
        position: await deps.savedFilters.nextPosition(market, listKey, caller.accountId),
        createdAt: now,
        updatedAt: now,
      };
      if ((await deps.savedFilters.add(market, filter)) === 'name-taken') {
        return err({ code: 'saved-filter.name-taken' });
      }
      if (filter.visibility === 'everyone') {
        await deps.audit.record(
          context,
          SavedFilterSharedAudit.entry(filter.id, {
            after: { listKey: auditListOf(filter.listKey), visibility: 'everyone' },
          }),
        );
      }
      return ok(filter);
    },
    { isolation: 'serializable' },
  );
  if (!written.ok) return written;
  return ok(viewOf(written.value, caller.accountId, canShare.value));
}

// ---- update -------------------------------------------------------------------------------

export type SavedFilterUpdateFailure =
  Denied | Unavailable | NotFound | NameTaken | SharedLimitReached | ValidationFailure;

export async function updateSavedFilter(
  deps: SavedViewDependencies,
  population: Population,
  context: CallContext,
  input: unknown,
): Promise<Result<SavedFilterView, SavedFilterUpdateFailure>> {
  const caller = callerOf(context, population);
  if (caller === null) return err({ code: 'access.denied' });
  if (!isRecord(input)) return invalid('body', 'type');
  for (const key of Object.keys(input)) {
    if (!['id', 'name', 'visibility'].includes(key)) return invalid(key, 'unknown');
  }
  const name = nameOf(input['name']);
  if (!name.ok) return name;
  const id = filterIdOf(input['id']);
  if (id === null) return err({ code: 'saved-filter.not-found' });
  // The visibility is checked against the list of the stored filter, once it is read.
  const requested = input['visibility'];

  const probe = population === 'admin' ? deps.shareCheck : null;
  const canShare = await canShareOf(probe, context);
  if (!canShare.ok) return canShare;

  const { market } = context;
  const written = await deps.unitOfWork.run<SavedFilter, SavedFilterUpdateFailure>(
    market,
    async () => {
      const found = await deps.savedFilters.find(market, id);
      if (found === null || !isVisibleTo(found, caller.accountId)) {
        return err({ code: 'saved-filter.not-found' });
      }
      const list = listOf(found.listKey, population);
      if (!list.ok) return err({ code: 'saved-filter.not-found' });
      const visibility = visibilityOf(requested, list.value);
      if (!visibility.ok) return visibility;
      if (!mayManage(found, caller.accountId, canShare.value))
        return err({ code: 'access.denied' });
      const renamed = found.name !== name.value;
      const moved = found.visibility !== visibility.value;
      if (moved && visibility.value === 'everyone') {
        if (!canShare.value) return err({ code: 'access.denied' });
        if (
          (await deps.savedFilters.countShared(market, found.listKey)) >= MAX_SHARED_SAVED_FILTERS
        ) {
          return err({ code: 'saved-filter.shared-limit-reached', max: MAX_SHARED_SAVED_FILTERS });
        }
      }
      if (!renamed && !moved) return ok(found);
      const changed: SavedFilter = {
        ...found,
        name: name.value,
        visibility: visibility.value,
        updatedAt: deps.clock.now(),
      };
      const outcome = await deps.savedFilters.change(market, changed);
      if (outcome === 'gone') return err({ code: 'saved-filter.not-found' });
      if (outcome === 'name-taken') return err({ code: 'saved-filter.name-taken' });
      if (found.visibility === 'everyone' || changed.visibility === 'everyone') {
        await deps.audit.record(
          context,
          SavedFilterChangedAudit.entry(changed.id, {
            before: { visibility: found.visibility },
            after: {
              listKey: auditListOf(changed.listKey),
              visibility: changed.visibility,
              renamed,
              ownedByActor: changed.ownerAccountId === caller.accountId,
            },
          }),
        );
      }
      return ok(changed);
    },
    { isolation: 'serializable' },
  );
  if (!written.ok) return written;
  return ok(viewOf(written.value, caller.accountId, canShare.value));
}

// ---- delete -------------------------------------------------------------------------------

export interface SavedFilterDeleteOutput {
  readonly id: string;
}
export type SavedFilterDeleteFailure = Denied | Unavailable | NotFound | ValidationFailure;

export async function deleteSavedFilter(
  deps: SavedViewDependencies,
  population: Population,
  context: CallContext,
  input: unknown,
): Promise<Result<SavedFilterDeleteOutput, SavedFilterDeleteFailure>> {
  const caller = callerOf(context, population);
  if (caller === null) return err({ code: 'access.denied' });
  if (!isRecord(input)) return invalid('body', 'type');
  for (const key of Object.keys(input)) if (key !== 'id') return invalid(key, 'unknown');
  const id = filterIdOf(input['id']);
  if (id === null) return err({ code: 'saved-filter.not-found' });
  const canShare = await canShareOf(population === 'admin' ? deps.shareCheck : null, context);
  if (!canShare.ok) return canShare;

  const { market } = context;
  return deps.unitOfWork.run<SavedFilterDeleteOutput, SavedFilterDeleteFailure>(
    market,
    async () => {
      const found = await deps.savedFilters.find(market, id);
      if (
        found === null ||
        !isVisibleTo(found, caller.accountId) ||
        !listOf(found.listKey, population).ok
      ) {
        return err({ code: 'saved-filter.not-found' });
      }
      if (!mayManage(found, caller.accountId, canShare.value))
        return err({ code: 'access.denied' });
      if (!(await deps.savedFilters.remove(market, id))) {
        return err({ code: 'saved-filter.not-found' });
      }
      if (found.visibility === 'everyone') {
        await deps.audit.record(
          context,
          SavedFilterRemovedAudit.entry(id, {
            before: { listKey: auditListOf(found.listKey), visibility: 'everyone' },
            after: { ownedByActor: found.ownerAccountId === caller.accountId },
          }),
        );
      }
      return ok({ id });
    },
  );
}
