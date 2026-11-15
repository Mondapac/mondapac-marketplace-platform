import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuthorisationCheck } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  MAX_SHARED_SAVED_FILTERS,
  type SavedFilterStore,
  type StoredFilter,
} from '../../contracts';
import { ListsFilterChangedAudit } from '../../domain/audit';
import { isVisibleTo, mayManage } from '../../domain/saved-filter-rules';
import {
  adminOf,
  auditListOf,
  canShareOf,
  filterIdOf,
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

export interface SavedFilterUpdateInput {
  readonly id?: unknown;
  readonly listKey?: unknown;
  readonly name?: unknown;
  readonly visibility?: unknown;
}

export type SavedFilterUpdateFailure =
  | AccessRefusal
  | ValidationFailure
  | { readonly code: 'saved-filter.not-found' }
  | { readonly code: 'saved-filter.name-taken' }
  | { readonly code: 'saved-filter.shared-limit-reached'; readonly max: number };

export interface SavedFilterUpdateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: SavedFilterStore;
  readonly registry: ListRegistry;
  readonly authorisation: AuthorisationCheck;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

const KEYS = new Set(['id', 'listKey', 'name', 'visibility']);

/**
 * `lists.saved-filter-update` (super list B0-1b): renames a saved filter and sets who can use it.
 * Rule: an authenticated admin, then the named list's view key (fail closed). The filter is looked
 * up in that list only, so an id of another list is `saved-filter.not-found`, as is another
 * admin's private filter. The owner may always; anybody who holds the list's share key may also
 * change a filter shared with everyone; making a filter `everyone` needs the share key. A change
 * to or from `everyone` is audited (codes only). The document of a filter never changes.
 */
export class SavedFilterUpdate extends UseCase<
  SavedFilterUpdateInput,
  SavedFilterView,
  SavedFilterUpdateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.saved-filter-update',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedFilterUpdateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SavedFilterUpdateInput,
  ): Promise<Result<SavedFilterView, SavedFilterUpdateFailure>> {
    const admin = adminOf(context);
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('body', 'type');
    }
    for (const key of Object.keys(input)) if (!KEYS.has(key)) return invalid(key, 'unknown');
    const { deps } = this;
    const list = deps.registry.lookup(input.listKey, 'admin');
    if (!list.ok) return list;
    const name = nameOf(input.name);
    if (!name.ok) return name;
    const visibility = visibilityOf(input.visibility);
    if (!visibility.ok) return visibility;
    const id = filterIdOf(input.id);
    if (id === null) return err({ code: 'saved-filter.not-found' });

    const viewed = await holds(
      deps.authorisation,
      context,
      'lists.saved-filter-update-view',
      list.value.viewKey,
    );
    if (!viewed.ok) return viewed;
    const canShare = await canShareOf(
      deps.authorisation,
      context,
      'lists.saved-filter-update',
      list.value,
    );
    if (!canShare.ok) return canShare;

    const { market } = context;
    const listKey = list.value.listKey;
    const written = await deps.unitOfWork.run<StoredFilter, SavedFilterUpdateFailure>(
      market,
      async () => {
        const found = await deps.store.find(market, null, [listKey], id);
        if (found === null || !isVisibleTo(found, admin.accountId)) {
          return err({ code: 'saved-filter.not-found' });
        }
        if (!mayManage(found, admin.accountId, canShare.value)) {
          return err({ code: 'access.denied' });
        }
        const renamed = found.name !== name.value;
        const moved = found.visibility !== visibility.value;
        if (moved && visibility.value === 'everyone') {
          if (!canShare.value) return err({ code: 'access.denied' });
          if ((await deps.store.countShared(market, null, listKey)) >= MAX_SHARED_SAVED_FILTERS) {
            return err({
              code: 'saved-filter.shared-limit-reached',
              max: MAX_SHARED_SAVED_FILTERS,
            });
          }
        }
        if (!renamed && !moved) return ok(found);
        const changed: StoredFilter = {
          ...found,
          name: name.value,
          visibility: visibility.value,
          updatedAt: deps.clock.now(),
        };
        const outcome = await deps.store.change(market, changed);
        if (outcome === 'gone') return err({ code: 'saved-filter.not-found' });
        if (outcome === 'name-taken') return err({ code: 'saved-filter.name-taken' });
        if (found.visibility === 'everyone' || changed.visibility === 'everyone') {
          await deps.audit.record(
            context,
            ListsFilterChangedAudit.entry(changed.id, {
              before: { visibility: found.visibility },
              after: {
                listKey: auditListOf(changed.listKey),
                visibility: changed.visibility,
                renamed,
                ownedByActor: changed.ownerAccountId === admin.accountId,
              },
            }),
          );
        }
        return ok(changed);
      },
      { isolation: 'serializable' },
    );
    if (!written.ok) return written;
    return ok(viewOf(written.value, admin.accountId, canShare.value));
  }
}
