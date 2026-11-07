import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_VARIANT_VIEW } from '../../contracts/permissions';
import type { VariantIssue } from '../ports/variant-admin.reader';
import {
  closedQuery,
  isAdmin,
  localesOf,
  parseFilter,
  type AdminReadFailure,
} from '../variants/variant-admin.shared';
import type { AdminVariantsDependencies } from '../variants/variant-views';

/**
 * `admin-variants.issue-counts` (variants V6): how many live variants each ready-made filter holds
 * (the chips of the Variants tab), for all variant types or the one `typeCode` names. Rule: the
 * key `catalog.variant.view` and the admin population. One read-only unit.
 */
export class AdminVariantIssueCounts extends UseCase<
  Record<string, unknown>,
  { readonly counts: Readonly<Record<VariantIssue, number>> },
  AdminReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-variant-issue-counts',
    rule: { kind: 'permissions', allOf: [CATALOG_VARIANT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminVariantsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, unknown>,
  ): Promise<
    Result<{ readonly counts: Readonly<Record<VariantIssue, number>> }, AdminReadFailure>
  > {
    if (!isAdmin(context)) return err({ code: 'access.denied' });
    const query = closedQuery(input, ['typeCode']);
    if (!query.ok) return query;
    const filter = parseFilter(query.value);
    if (!filter.ok) return filter;
    const locales = localesOf(this.deps.policy, context);
    if (!locales.ok) return locales;
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await this.deps.variantAdminReader.issueCounts(market, {
            typeCode: filter.value.typeCode,
            locales: locales.value.supported,
          }),
        ),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({ counts: read.value });
  }
}
