import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { MAX_PREFERRED_COLUMNS, type ListPopulation } from '../../contracts';
import { callerOf, holds, invalid, storeOf } from '../saved-filter-shared';
import {
  bodyOf,
  columnListOf,
  type ColumnPreferenceDependencies,
  type ColumnPreferenceFailure,
  type ColumnPreferenceView,
} from '../column-preference-shared';

const SAVE_KEYS = new Set(['listKey', 'columns']);

export interface ColumnPreferenceSaveDependencies extends ColumnPreferenceDependencies {
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * `lists.column-preference-save`: replaces the caller's columns of a list. `columns` is an array
 * of at most 32 ids of the list's vocabulary, each once, in the order to show; an empty array
 * shows none of the optional columns.
 */
export class ColumnPreferenceSave extends UseCase<
  { readonly listKey?: unknown; readonly columns?: unknown },
  ColumnPreferenceView,
  ColumnPreferenceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.column-preference-save',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ColumnPreferenceSaveDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly listKey?: unknown; readonly columns?: unknown },
  ): Promise<Result<ColumnPreferenceView, ColumnPreferenceFailure>> {
    return handleColumnPreferenceSave('admin', this.deps, context, input);
  }
}

/** The body of the use case for one population (the seller class runs it as `seller`). */
export async function handleColumnPreferenceSave(
  population: ListPopulation,
  deps: ColumnPreferenceSaveDependencies,
  context: CallContext,
  input: { readonly listKey?: unknown; readonly columns?: unknown },
): Promise<Result<ColumnPreferenceView, ColumnPreferenceFailure>> {
  const caller = callerOf(context, population);
  if (!caller.ok) return caller;
  const member = caller.value;
  const body = bodyOf(input, SAVE_KEYS);
  if (!body.ok) return body;
  const list = columnListOf(deps.registry, body.value['listKey'], population);
  if (!list.ok) return list;
  const sellerId = storeOf(member, list.value.definition);
  const viewed = await holds(
    deps.authorisation,
    context,
    'lists.column-preference-save-view',
    list.value.definition.viewKey,
  );
  if (!viewed.ok) return viewed;

  const raw = body.value['columns'];
  if (!Array.isArray(raw)) return invalid('columns', 'type');
  const given: unknown[] = raw;
  if (given.length > MAX_PREFERRED_COLUMNS) return invalid('columns', 'length');
  const columns: string[] = [];
  for (const id of given) {
    if (typeof id !== 'string' || !list.value.available.includes(id)) {
      return invalid('columns', 'value');
    }
    if (columns.includes(id)) return invalid('columns', 'duplicate');
    columns.push(id);
  }
  const { market } = context;
  const listKey = list.value.definition.listKey;
  const now = deps.clock.now();
  const written = await deps.unitOfWork.run<null, never>(
    market,
    async () => {
      await deps.store.put(market, {
        id: deps.ids.next<'ColumnPreference'>(),
        listKey,
        ownerAccountId: member.accountId,
        sellerId,
        columns,
        createdAt: now,
        updatedAt: now,
      });
      return ok(null);
    },
    { isolation: 'serializable' },
  );
  if (!written.ok) return written;
  return ok({ listKey, columns, available: list.value.available });
}
