import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { adminOf, holds } from '../saved-filter-shared';
import {
  bodyOf,
  columnListOf,
  type ColumnPreferenceDependencies,
  type ColumnPreferenceFailure,
  type ColumnPreferenceView,
} from '../column-preference-shared';

const READ_KEYS = new Set(['listKey']);

/** `lists.column-preference-get`: the caller's saved columns of a list, or null. */
export class ColumnPreferenceGet extends UseCase<
  { readonly listKey?: unknown },
  ColumnPreferenceView,
  ColumnPreferenceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'lists.column-preference-get',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ColumnPreferenceDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly listKey?: unknown },
  ): Promise<Result<ColumnPreferenceView, ColumnPreferenceFailure>> {
    const admin = adminOf(context);
    if (admin === null) return err({ code: 'access.denied' });
    const body = bodyOf(input, READ_KEYS);
    if (!body.ok) return body;
    const { deps } = this;
    const list = columnListOf(deps.registry, body.value['listKey']);
    if (!list.ok) return list;
    const viewed = await holds(
      deps.authorisation,
      context,
      'lists.column-preference-get-view',
      list.value.definition.viewKey,
    );
    if (!viewed.ok) return viewed;

    const { market } = context;
    const listKey = list.value.definition.listKey;
    const read = await deps.unitOfWork.run<readonly string[] | null, never>(
      market,
      async () => {
        const found = await deps.store.find(market, null, listKey, admin.accountId);
        return ok(found === null ? null : found.columns);
      },
      { readOnly: true },
    );
    if (!read.ok) return read;
    // Ids the list no longer offers are dropped, so the panel never shows a column that is gone.
    const available = list.value.available;
    const columns = read.value === null ? null : read.value.filter((id) => available.includes(id));
    return ok({ listKey, columns, available });
  }
}
