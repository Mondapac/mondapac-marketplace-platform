import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_VARIANT_VIEW } from '../../contracts/permissions';
import {
  closedQuery,
  isAdmin,
  localesOf,
  MAX_VARIANT_TYPES,
  type AdminReadFailure,
} from '../variants/variant-admin.shared';
import {
  summaryOf,
  type AdminVariantTypesDependencies,
  type VariantTypeSummary,
} from '../variants/variant-type-views';

export type { AdminVariantTypesDependencies, VariantTypeSummary };

/**
 * `admin-variant-types.list` (variants V6, the Variant types tab): every variant type of the Market
 * (an attribute whose published revision is a variant option, not archived) with its display
 * style, active options, live products and variants, the feature sets that offer it and the
 * language completeness of its name and labels. Rule: the key `catalog.variant.view` and the admin
 * population; the Market comes from the context. One read-only unit (ADR-0025). No query keys.
 */
export class AdminVariantTypesList extends UseCase<
  Record<string, unknown>,
  { readonly items: readonly VariantTypeSummary[] },
  AdminReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-variant-types-list',
    rule: { kind: 'permissions', allOf: [CATALOG_VARIANT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminVariantTypesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, unknown>,
  ): Promise<Result<{ readonly items: readonly VariantTypeSummary[] }, AdminReadFailure>> {
    if (!isAdmin(context)) return err({ code: 'access.denied' });
    const query = closedQuery(input, []);
    if (!query.ok) return query;
    const locales = localesOf(this.deps.policy, context);
    if (!locales.ok) return locales;
    const { market } = context;
    const { variantAdminReader: reader } = this.deps;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const types = await reader.variantTypes(market, MAX_VARIANT_TYPES);
        const codes = types.map((type) => type.code);
        const [counts, sets] = await Promise.all([
          reader.typeCounts(market, codes),
          reader.featureSetsUsing(market, codes),
        ]);
        return ok(
          types.map((type) =>
            summaryOf(type, counts.get(type.code), sets.get(type.code), locales.value.supported),
          ),
        );
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({ items: read.value });
  }
}
