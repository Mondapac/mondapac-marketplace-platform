import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { ListPopulation } from '../../contracts';
import { callerOf, holds, storeOf } from '../saved-filter-shared';
import {
  bodyOf,
  columnListOf,
  type ColumnPreferenceDependencies,
  type ColumnPreferenceFailure,
  type ColumnPreferenceView,
} from '../column-preference-shared';

const READ_KEYS = new Set(['listKey']);

/** `lists.column-preference-reset`: forgets the caller's choice, back to the list's default. */
export class ColumnPreferenceReset extends UseCase<
  { readonly listKey?: unknown },
  ColumnPreferenceView,
  ColumnPreferenceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.column-preference-reset',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ColumnPreferenceDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: { readonly listKey?: unknown },
  ): Promise<Result<ColumnPreferenceView, ColumnPreferenceFailure>> {
    return handleColumnPreferenceReset('admin', this.deps, context, input);
  }
}

/** The body of the use case for one population (the seller class runs it as `seller`). */
export async function handleColumnPreferenceReset(
  population: ListPopulation,
  deps: ColumnPreferenceDependencies,
  context: CallContext,
  input: { readonly listKey?: unknown },
): Promise<Result<ColumnPreferenceView, ColumnPreferenceFailure>> {
  const caller = callerOf(context, population);
  if (!caller.ok) return caller;
  const member = caller.value;
  const body = bodyOf(input, READ_KEYS);
  if (!body.ok) return body;
  const list = columnListOf(deps.registry, body.value['listKey'], population);
  if (!list.ok) return list;
  const sellerId = storeOf(member, list.value.definition);
  const viewed = await holds(
    deps.authorisation,
    context,
    'lists.column-preference-reset-view',
    list.value.definition.viewKey,
  );
  if (!viewed.ok) return viewed;

  const { market } = context;
  const listKey = list.value.definition.listKey;
  const done = await deps.unitOfWork.run<null, never>(market, async () => {
    await deps.store.remove(market, sellerId, listKey, member.accountId);
    return ok(null);
  });
  if (!done.ok) return done;
  return ok({ listKey, columns: null, available: list.value.available });
}
