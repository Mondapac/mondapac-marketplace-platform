import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CatalogValidationFailed } from '../../contracts/catalog.facade';
import type { CatalogCultureSummary } from '../../contracts/catalog-cultures.facade';
import type { CultureReader } from '../ports/culture.reader';
import { summaryOf } from './cultures-by-ids.use-case';

export interface ActiveCulturesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly cultureReader: CultureReader;
}

/**
 * `activeCultures` (ADR-0048): every ACTIVE culture of the Market. Rule `anonymous`: nothing is
 * taken from the caller; a short summary per culture comes back. One read-only unit.
 */
export class ActiveCulturesQuery extends UseCase<
  Record<string, never>,
  readonly CatalogCultureSummary[],
  CatalogValidationFailed
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.active-cultures',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ActiveCulturesDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
  ): Promise<Result<readonly CatalogCultureSummary[], CatalogValidationFailed>> {
    return this.deps.unitOfWork.run<readonly CatalogCultureSummary[], CatalogValidationFailed>(
      context.market,
      async () =>
        ok(
          (
            await this.deps.cultureReader.list(context.market, { status: 'active', search: null })
          ).map(summaryOf),
        ),
      { readOnly: true },
    );
  }
}
