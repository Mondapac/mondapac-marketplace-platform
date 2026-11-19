import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_VARIANT_VIEW } from '../../contracts/permissions';
import { orderOptions } from '../../domain/variant-type-settings';
import {
  closedQuery,
  definitionIdOf,
  isAdmin,
  localesOf,
  type AdminReadFailure,
} from '../variants/variant-admin.shared';
import {
  summaryOf,
  type AdminVariantTypesDependencies,
  type VariantTypeDetail,
} from '../variants/variant-type-views';

export type AdminVariantTypeGetFailure =
  AdminReadFailure | { readonly code: 'variant-type.not-found' };

/**
 * `admin-variant-type.get` (variants V6, the details panel): one variant type with its settings and
 * its options in the order buyers see them, each with its swatch and live product count. Rule: the
 * key `catalog.variant.view` and the admin population. An id that names no variant type of the
 * caller's Market is `variant-type.not-found`, the same answer for another Market's id. One
 * read-only unit.
 */
export class AdminVariantTypeGet extends UseCase<
  { readonly id?: unknown },
  { readonly variantType: VariantTypeDetail },
  AdminVariantTypeGetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-variant-type-get',
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
    input: { readonly id?: unknown },
  ): Promise<Result<{ readonly variantType: VariantTypeDetail }, AdminVariantTypeGetFailure>> {
    if (!isAdmin(context)) return err({ code: 'access.denied' });
    const query = closedQuery(input, ['id']);
    if (!query.ok) return query;
    const id = definitionIdOf(query.value['id']);
    if (id === null) return err({ code: 'variant-type.not-found' });
    const locales = localesOf(this.deps.policy, context);
    if (!locales.ok) return locales;
    const { market } = context;
    const { variantAdminReader: reader } = this.deps;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const record = await reader.variantType(market, id);
        if (record === null) return ok(null);
        const codes = [record.code];
        const [counts, sets, optionCounts] = await Promise.all([
          reader.typeCounts(market, codes),
          reader.featureSetsUsing(market, codes),
          reader.optionProductCounts(
            market,
            record.code,
            record.options.map((option) => option.code),
          ),
        ]);
        return ok({ record, counts, sets, optionCounts });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'variant-type.not-found' });
    const { record, counts, sets, optionCounts } = read.value;
    const { default: locale, supported } = locales.value;
    const ordered = orderOptions(record.options, record.settings.optionOrder, locale, locale);
    return ok({
      variantType: {
        ...summaryOf(record, counts.get(record.code), sets.get(record.code), supported),
        optionList: ordered.map((option) => ({
          code: option.code,
          labels: option.labels,
          active: option.active,
          position: option.position,
          swatch: record.settings.swatches[option.code] ?? null,
          products: optionCounts.get(option.code) ?? 0,
        })),
        sellerHelp: record.settings.sellerHelp,
        settingsVersion: record.settingsVersion,
      },
    });
  }
}
