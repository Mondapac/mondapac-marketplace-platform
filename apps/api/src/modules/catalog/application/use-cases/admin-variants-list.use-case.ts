import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_VARIANT_VIEW } from '../../contracts/permissions';
import { VARIANT_ISSUES } from '../ports/variant-admin.reader';
import {
  closedQuery,
  FILTER_KEYS,
  isAdmin,
  localesOf,
  parseAfter,
  parseFilter,
  parseLimit,
  queryOf,
  type AdminReadFailure,
} from '../variants/variant-admin.shared';
import {
  viewOf,
  type AdminVariantsDependencies,
  type AdminVariantView,
} from '../variants/variant-views';

/** The issue filters the list takes (`issue`), for the route's documentation. */
export { VARIANT_ISSUES };
export type { AdminVariantsDependencies, AdminVariantView };

export interface AdminVariantsListOutput {
  readonly items: readonly AdminVariantView[];
  /** Pass as `after` for the next page; null at the end. */
  readonly nextAfter: string | null;
}

/**
 * `admin-variants.list` (variants V6, the Variants tab; plan section 9): the variants of every live
 * product of the Market (published, paused included), newest first, with their issues. `q`
 * searches the product name (default locale), the product or variant code, the GTIN digits and
 * the sellers' SKUs; `typeCode` keeps the variants of one variant type; `issue` is one of the
 * ready-made filters. Paged by `after` (a variant id from `nextAfter`) and `limit` (1 to 100,
 * default 25). Rule: the key `catalog.variant.view` and the admin population. One read-only unit.
 */
export class AdminVariantsList extends UseCase<
  Record<string, unknown>,
  AdminVariantsListOutput,
  AdminReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-variants-list',
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
  ): Promise<Result<AdminVariantsListOutput, AdminReadFailure>> {
    if (!isAdmin(context)) return err({ code: 'access.denied' });
    const query = closedQuery(input, [...FILTER_KEYS, 'after', 'limit']);
    if (!query.ok) return query;
    const filter = parseFilter(query.value);
    if (!filter.ok) return filter;
    const after = parseAfter(query.value['after']);
    if (!after.ok) return after;
    const limit = parseLimit(query.value['limit']);
    if (!limit.ok) return limit;
    const locales = localesOf(this.deps.policy, context);
    if (!locales.ok) return locales;
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await this.deps.variantAdminReader.variantsPage(
            market,
            queryOf(filter.value, { after: after.value, limit: limit.value }, locales.value),
          ),
        ),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({
      items: read.value.rows.map((row) => viewOf(row, locales.value.default)),
      nextAfter: read.value.nextAfter,
    });
  }
}
