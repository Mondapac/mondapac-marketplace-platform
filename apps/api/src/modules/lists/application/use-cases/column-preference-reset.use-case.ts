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
      'lists.column-preference-reset-view',
      list.value.definition.viewKey,
    );
    if (!viewed.ok) return viewed;

    const { market } = context;
    const listKey = list.value.definition.listKey;
    const done = await deps.unitOfWork.run<null, never>(market, async () => {
      await deps.store.remove(market, null, listKey, admin.accountId);
      return ok(null);
    });
    if (!done.ok) return done;
    return ok({ listKey, columns: null, available: list.value.available });
  }
}
