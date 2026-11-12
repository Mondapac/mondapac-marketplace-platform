import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { CatalogValidationFailed } from '../../contracts/catalog.facade';
import type { CatalogCultureSummary } from '../../contracts/catalog-cultures.facade';
import { activeCultures, type ActiveCulturesDependencies } from './active-cultures.use-case';

/**
 * `catalog.active-cultures-system`: the same answer for the system actor. Sellers' signup handler
 * (`applySignupCultures`, rule `system`) asks for the active cultures; the `anonymous` rule never
 * admits the system actor, so before package 3a that call was refused and the handler retried
 * until dead-lettered.
 */
export class ActiveCulturesSystemQuery extends UseCase<
  Record<string, never>,
  readonly CatalogCultureSummary[],
  CatalogValidationFailed
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.active-cultures-system',
    rule: { kind: 'system' },
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
    return activeCultures(this.deps, context);
  }
}
