import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuthorisationCheck } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_SAVED_FILTERS_PER_OWNER,
  MAX_SHARED_SAVED_FILTERS,
  type SavedFilterStore,
  type StoredFilter,
  type ListPopulation,
} from '../../contracts';
import { ListsFilterSharedAudit } from '../../domain/audit';
import {
  callerOf,
  storeOf,
  auditListOf,
  canShareOf,
  holds,
  invalid,
  nameOf,
  viewOf,
  visibilityOf,
  type AccessRefusal,
  type ListRegistry,
  type SavedFilterView,
  type ValidationFailure,
} from '../saved-filter-shared';

export interface SavedFilterCreateInput {
  readonly listKey?: unknown;
  readonly name?: unknown;
  readonly visibility?: unknown;
  readonly payload?: unknown;
}

export type SavedFilterCreateFailure =
  | AccessRefusal
  | ValidationFailure
  | { readonly code: 'saved-filter.name-taken' }
  | { readonly code: 'saved-filter.limit-reached'; readonly max: number }
  | { readonly code: 'saved-filter.shared-limit-reached'; readonly max: number };

export interface SavedFilterCreateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: SavedFilterStore;
  readonly registry: ListRegistry;
  readonly authorisation: AuthorisationCheck;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const KEYS = new Set(['listKey', 'name', 'visibility', 'payload']);

/**
 * `lists.saved-filter-create` (super list B0-1b): saves the tab, search, filters and sort of an
 * admin list under a name, for the caller only (`me`) or for everyone who can see the list
 * (`everyone`, which also needs the list's share key). Rule: an authenticated admin, then the
 * list's view key through the authorisation port (fail closed). The payload is read by the list
 * owner's parser and stored in its canonical form. One admin keeps at most
 * {@link MAX_SAVED_FILTERS_PER_OWNER} filters in a list and a list has at most
 * {@link MAX_SHARED_SAVED_FILTERS} shared with everyone; a name is one per owner and, among shared
 * filters, one per list, whatever its case. A filter shared with everyone is audited (codes only,
 * never the name). Serializable, so two saves racing at a cap cannot both pass.
 */
export class SavedFilterCreate extends UseCase<
  SavedFilterCreateInput,
  SavedFilterView,
  SavedFilterCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.saved-filter-create',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedFilterCreateDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SavedFilterCreateInput,
  ): Promise<Result<SavedFilterView, SavedFilterCreateFailure>> {
    return handleSavedFilterCreate('admin', this.deps, context, input);
  }
}

/**
 * The body of the use case for one population: the admin class and the seller class of
 * `seller-saved-filters` run it with their own population, so the rules stay in one place.
 */
export async function handleSavedFilterCreate(
  population: ListPopulation,
  deps: SavedFilterCreateDependencies,
  context: CallContext,
  input: SavedFilterCreateInput,
): Promise<Result<SavedFilterView, SavedFilterCreateFailure>> {
  const caller = callerOf(context, population);
  if (!caller.ok) return caller;
  const member = caller.value;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('body', 'type');
  }
  for (const key of Object.keys(input)) if (!KEYS.has(key)) return invalid(key, 'unknown');
  const list = deps.registry.lookup(input.listKey, population);
  if (!list.ok) return list;
  const sellerId = storeOf(member, list.value);
  const name = nameOf(input.name);
  if (!name.ok) return name;
  const visibility = visibilityOf(input.visibility);
  if (!visibility.ok) return visibility;

  const viewed = await holds(
    deps.authorisation,
    context,
    'lists.saved-filter-create-view',
    list.value.viewKey,
  );
  if (!viewed.ok) return viewed;
  const payload = list.value.parsePayload(input.payload);
  if (!payload.ok) return payload;
  const canShare = await canShareOf(
    deps.authorisation,
    context,
    'lists.saved-filter-create',
    list.value,
  );
  if (!canShare.ok) return canShare;
  if (visibility.value === 'everyone' && !canShare.value) return err({ code: 'access.denied' });

  const { market } = context;
  const listKey = list.value.listKey;
  const written = await deps.unitOfWork.run<StoredFilter, SavedFilterCreateFailure>(
    market,
    async () => {
      if (
        (await deps.store.countOwnedBy(market, sellerId, listKey, member.accountId)) >=
        MAX_SAVED_FILTERS_PER_OWNER
      ) {
        return err({ code: 'saved-filter.limit-reached', max: MAX_SAVED_FILTERS_PER_OWNER });
      }
      if (
        visibility.value === 'everyone' &&
        (await deps.store.countShared(market, sellerId, listKey)) >= MAX_SHARED_SAVED_FILTERS
      ) {
        return err({ code: 'saved-filter.shared-limit-reached', max: MAX_SHARED_SAVED_FILTERS });
      }
      const now = deps.clock.now();
      const filter: StoredFilter = {
        id: deps.ids.next<'SavedFilter'>(),
        listKey,
        ownerAccountId: member.accountId,
        sellerId,
        visibility: visibility.value,
        name: name.value,
        payload: payload.value,
        position: await deps.store.nextPosition(market, sellerId, listKey, member.accountId),
        createdAt: now,
        updatedAt: now,
      };
      if ((await deps.store.add(market, filter)) === 'name-taken') {
        return err({ code: 'saved-filter.name-taken' });
      }
      if (filter.visibility === 'everyone') {
        await deps.audit.record(
          context,
          ListsFilterSharedAudit.entry(filter.id, {
            after: { listKey: auditListOf(filter.listKey), visibility: 'everyone' },
          }),
        );
      }
      return ok(filter);
    },
    { isolation: 'serializable' },
  );
  if (!written.ok) return written;
  return ok(viewOf(written.value, member.accountId, canShare.value));
}
