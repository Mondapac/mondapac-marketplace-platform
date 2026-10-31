import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BRAND_READ } from '../../contracts/permissions';
import {
  BRAND_PAGE_DEFAULT,
  BRAND_PAGE_MAX,
  BRAND_SEARCH_MAX,
  brandIdOf,
  closedInput,
  invalid,
  statusFilterOf,
  viewOf,
  type BrandView,
  type ValidationFailure,
} from '../brands/brand-views';
import type { BrandReader } from '../ports/brand.reader';

export interface BrandListInput {
  readonly status?: unknown;
  readonly search?: unknown;
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

export interface BrandListOutput {
  readonly items: readonly BrandView[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
}

export type BrandListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface BrandListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly brandReader: BrandReader;
}

/**
 * `brand.list` (catalog brand package): the brands for the admin panel, by name, keyset-paged,
 * filtered by status and by a search text that matches the name, the slug or an alias. Rule: the key
 * `catalog.brand.read` and the admin population. One read-only unit.
 */
export class BrandList extends UseCase<BrandListInput, BrandListOutput, BrandListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.brand-list',
    rule: { kind: 'permissions', allOf: [CATALOG_BRAND_READ.key] },
  };

  readonly #logger = new Logger('BrandList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BrandListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BrandListInput,
  ): Promise<Result<BrandListOutput, BrandListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.brand-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: BrandListInput,
  ): Promise<Result<BrandListOutput, BrandListFailure>> {
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const body = closedInput(input, ['status', 'search', 'afterId', 'limit']);
    if (!body.ok) return body;
    const status = statusFilterOf(body.value['status']);
    if (!status.ok) return status;
    let search: string | null = null;
    const rawSearch = body.value['search'];
    if (rawSearch !== undefined && rawSearch !== null) {
      if (typeof rawSearch !== 'string') return invalid('search', 'type');
      const tidy = rawSearch.trim();
      if (tidy.length > BRAND_SEARCH_MAX) return invalid('search', 'too-long');
      search = tidy === '' ? null : tidy;
    }
    let afterId = null;
    if (body.value['afterId'] !== undefined && body.value['afterId'] !== null) {
      const parsed = brandIdOf(body.value['afterId'], 'afterId');
      if (!parsed.ok) return parsed;
      afterId = parsed.value;
    }
    let limit = BRAND_PAGE_DEFAULT;
    const rawLimit = body.value['limit'];
    if (rawLimit !== undefined && rawLimit !== null) {
      if (
        typeof rawLimit !== 'number' ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > BRAND_PAGE_MAX
      ) {
        return invalid('limit', 'range');
      }
      limit = rawLimit;
    }
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(
          await this.deps.brandReader.list(market, {
            status: status.value,
            search,
            afterId,
            limit,
          }),
        ),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({ items: read.value.items.map(viewOf), nextAfterId: read.value.nextAfterId });
  }
}
