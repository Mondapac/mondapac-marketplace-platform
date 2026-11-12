import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_VARIANT_VIEW } from '../../../catalog';
import type { VariantStockReader } from '../ports/variant-stock.reader';
import { validationFailed, type ValidationFailed } from '../source-use-case-support';

export const DEFAULT_OUT_OF_STOCK_PAGE = 100;
export const MAX_OUT_OF_STOCK_PAGE = 500;

export interface AdminOutOfStockVariantsInput {
  readonly limit?: unknown;
  /** The `nextCursor` of the previous page: the last Variant id. */
  readonly cursor?: unknown;
}

export interface AdminOutOfStockVariantsView {
  readonly variantIds: readonly Id<'Variant'>[];
  readonly nextCursor: string | null;
  /** All Variants of the Market that are out of stock everywhere (the chip count). */
  readonly total: number;
}

export type AdminOutOfStockVariantsFailure = ValidationFailed | { readonly code: 'access.denied' };

export interface AdminOutOfStockVariantsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly variantStock: VariantStockReader;
}

/**
 * `inventory.admin-out-of-stock-variants` (admin Catalogue > Variants, "Out of stock everywhere"):
 * the ids of the Market's Variants that have a live sell unit and whose every sell unit is `out`,
 * ascending by id, with the total. Catalog may not import inventory (ADR-0024 decision 5), so the
 * admin server composes these ids with catalog's variant rows. The key is catalog's
 * `catalog.variant.view`: the same people see the same page. Read-only: one read-only unit
 * (ADR-0025).
 */
export class AdminOutOfStockVariants extends UseCase<
  AdminOutOfStockVariantsInput,
  AdminOutOfStockVariantsView,
  AdminOutOfStockVariantsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'inventory.admin-out-of-stock-variants',
    rule: { kind: 'permissions', allOf: [CATALOG_VARIANT_VIEW.key] },
  };

  readonly #logger = new Logger('AdminOutOfStockVariants');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminOutOfStockVariantsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminOutOfStockVariantsInput,
  ): Promise<Result<AdminOutOfStockVariantsView, AdminOutOfStockVariantsFailure>> {
    const actor = context.actor;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const fields: { path: string; code: string }[] = [];
    let limit = DEFAULT_OUT_OF_STOCK_PAGE;
    if (input?.limit !== undefined) {
      if (
        typeof input.limit === 'number' &&
        Number.isSafeInteger(input.limit) &&
        input.limit >= 1 &&
        input.limit <= MAX_OUT_OF_STOCK_PAGE
      ) {
        limit = input.limit;
      } else fields.push({ path: 'limit', code: 'range' });
    }
    let after: Id<'Variant'> | null = null;
    if (input?.cursor !== undefined) {
      const parsed = typeof input.cursor === 'string' ? parseId<'Variant'>(input.cursor) : null;
      if (parsed?.ok === true) after = parsed.value;
      else fields.push({ path: 'cursor', code: 'format' });
    }
    if (fields.length > 0) return validationFailed(fields);

    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => {
        const rows = await this.deps.variantStock.listOutOfStockEverywhere(market, {
          limit: limit + 1,
          after,
        });
        const total = await this.deps.variantStock.countOutOfStockEverywhere(market);
        return ok({ rows, total });
      },
      { readOnly: true },
    );
    if (!read.ok) throw new Error('inventory.admin-out-of-stock-variants: a read-only unit failed');
    const variantIds = read.value.rows.slice(0, limit);
    this.#logger.log({
      msg: 'inventory.admin-out-of-stock-variants.done',
      items: variantIds.length,
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return ok({
      variantIds,
      nextCursor:
        read.value.rows.length > limit ? (variantIds[variantIds.length - 1] ?? null) : null,
      total: read.value.total,
    });
  }
}
