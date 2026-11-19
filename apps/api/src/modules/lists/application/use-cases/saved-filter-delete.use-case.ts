import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AuthorisationCheck } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SavedFilterStore, ListPopulation } from '../../contracts';
import { ListsFilterRemovedAudit } from '../../domain/audit';
import { isVisibleTo, mayManage } from '../../domain/saved-filter-rules';
import {
  callerOf,
  storeOf,
  auditListOf,
  canShareOf,
  filterIdOf,
  holds,
  invalid,
  type AccessRefusal,
  type ListRegistry,
  type ValidationFailure,
} from '../saved-filter-shared';

export interface SavedFilterDeleteInput {
  readonly id?: unknown;
  readonly listKey?: unknown;
}

export interface SavedFilterDeleteOutput {
  readonly id: string;
}

export type SavedFilterDeleteFailure =
  AccessRefusal | ValidationFailure | { readonly code: 'saved-filter.not-found' };

export interface SavedFilterDeleteDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: SavedFilterStore;
  readonly registry: ListRegistry;
  readonly authorisation: AuthorisationCheck;
  readonly audit: AuditWriter;
}

const KEYS = new Set(['id', 'listKey']);

/**
 * `lists.saved-filter-delete` (super list B0-1b): deletes a saved filter. Rule as for the update:
 * an authenticated admin, the named list's view key, a filter of that list only; the owner may
 * always, anybody with the share key may delete one shared with everyone. Deleting a shared
 * filter is audited (codes only).
 */
export class SavedFilterDelete extends UseCase<
  SavedFilterDeleteInput,
  SavedFilterDeleteOutput,
  SavedFilterDeleteFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.saved-filter-delete',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: SavedFilterDeleteDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: SavedFilterDeleteInput,
  ): Promise<Result<SavedFilterDeleteOutput, SavedFilterDeleteFailure>> {
    return handleSavedFilterDelete('admin', this.deps, context, input);
  }
}

/**
 * The body of the use case for one population: the admin class and the seller class of
 * `seller-saved-filters` run it with their own population, so the rules stay in one place.
 */
export async function handleSavedFilterDelete(
  population: ListPopulation,
  deps: SavedFilterDeleteDependencies,
  context: CallContext,
  input: SavedFilterDeleteInput,
): Promise<Result<SavedFilterDeleteOutput, SavedFilterDeleteFailure>> {
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
  const id = filterIdOf(input.id);
  if (id === null) return err({ code: 'saved-filter.not-found' });

  const viewed = await holds(
    deps.authorisation,
    context,
    'lists.saved-filter-delete-view',
    list.value.viewKey,
  );
  if (!viewed.ok) return viewed;
  const canShare = await canShareOf(
    deps.authorisation,
    context,
    'lists.saved-filter-delete',
    list.value,
  );
  if (!canShare.ok) return canShare;

  const { market } = context;
  const listKey = list.value.listKey;
  return deps.unitOfWork.run<SavedFilterDeleteOutput, SavedFilterDeleteFailure>(
    market,
    async () => {
      const found = await deps.store.find(market, sellerId, [listKey], id);
      if (found === null || !isVisibleTo(found, member.accountId)) {
        return err({ code: 'saved-filter.not-found' });
      }
      if (!mayManage(found, member.accountId, canShare.value)) {
        return err({ code: 'access.denied' });
      }
      if (!(await deps.store.remove(market, sellerId, [listKey], id))) {
        return err({ code: 'saved-filter.not-found' });
      }
      if (found.visibility === 'everyone') {
        await deps.audit.record(
          context,
          ListsFilterRemovedAudit.entry(id, {
            before: { listKey: auditListOf(found.listKey), visibility: 'everyone' },
            after: { ownedByActor: found.ownerAccountId === member.accountId },
          }),
        );
      }
      return ok({ id });
    },
    { isolation: 'serializable' },
  );
}
