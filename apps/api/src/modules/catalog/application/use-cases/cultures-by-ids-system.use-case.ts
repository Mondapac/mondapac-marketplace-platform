import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CatalogValidationFailed } from '../../contracts/catalog.facade';
import type { CatalogCultureSummary } from '../../contracts/catalog-cultures.facade';
import {
  culturesByIds,
  type CulturesByIdsDependencies,
  type CulturesByIdsInput,
} from './cultures-by-ids.use-case';

/**
 * `catalog.cultures-by-ids-system`: the same answer for the system actor (multi-culture package 3a:
 * sellers' certificate re-check and search's re-index run as the system actor, which the
 * `anonymous` rule never admits).
 */
export class CulturesByIdsSystemQuery extends UseCase<
  CulturesByIdsInput,
  readonly CatalogCultureSummary[],
  CatalogValidationFailed
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.cultures-by-ids-system',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CulturesByIdsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: CulturesByIdsInput,
  ): Promise<Result<readonly CatalogCultureSummary[], CatalogValidationFailed>> {
    return culturesByIds(this.deps, context, input);
  }
}
