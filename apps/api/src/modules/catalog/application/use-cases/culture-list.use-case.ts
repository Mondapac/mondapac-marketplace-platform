import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CULTURE_READ } from '../../contracts/permissions';
import {
  CULTURE_SEARCH_MAX,
  adminAccountOf,
  closedInput,
  invalid,
  statusOf,
  viewOf,
  type CultureView,
  type ValidationFailure,
} from '../cultures/culture-views';
import type { CultureReader } from '../ports/culture.reader';

export interface CultureListInput {
  readonly status?: unknown;
  readonly search?: unknown;
}

export interface CultureListOutput {
  readonly items: readonly CultureView[];
}

export type CultureListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface CultureListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly cultureReader: CultureReader;
}

/**
 * `culture.list` (multi-culture package 1): the cultures of the Market for the admin Cultures page,
 * by display order then code. `status` filters and `search` matches a name in any locale or the
 * code. Not paged (a Market holds at most 200). The seller and product counts the page will show
 * are not in the answer yet: they arrive with packages 2 and 3, which own those facts. Rule: the key
 * `catalog.culture.read` and the admin population. One read-only unit.
 */
export class CultureList extends UseCase<CultureListInput, CultureListOutput, CultureListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.culture-list',
    rule: { kind: 'permissions', allOf: [CATALOG_CULTURE_READ.key] },
  };

  readonly #logger = new Logger('CultureList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CultureListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CultureListInput,
  ): Promise<Result<CultureListOutput, CultureListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.culture-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: CultureListInput,
  ): Promise<Result<CultureListOutput, CultureListFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['status', 'search']);
    if (!body.ok) return body;
    let status = null;
    if (body.value['status'] !== undefined && body.value['status'] !== null) {
      const parsed = statusOf(body.value['status'], 'status');
      if (!parsed.ok) return parsed;
      status = parsed.value;
    }
    let search: string | null = null;
    const rawSearch = body.value['search'];
    if (rawSearch !== undefined && rawSearch !== null) {
      if (typeof rawSearch !== 'string') return invalid('search', 'type');
      const tidy = rawSearch.trim();
      if (tidy.length > CULTURE_SEARCH_MAX) return invalid('search', 'too-long');
      search = tidy === '' ? null : tidy;
    }
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.cultureReader.list(market, { status, search })),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({ items: read.value.map(viewOf) });
  }
}
