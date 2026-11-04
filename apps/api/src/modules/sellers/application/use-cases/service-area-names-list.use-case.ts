import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { SELLERS_SELLER_VIEW } from '../../contracts/permissions';
import { rowOfArea, type ServiceAreaNamesRow } from '../service-areas/area-name-views';
import type { OnboardingAreas } from '../ports/seller-market-formats';
import type { AreaNameSource } from '../ports/service-area-names.repository';
import { AREA_NAME_DEFAULT_LANGUAGE, languagesOf } from '../../domain/area-name-languages';

export interface ServiceAreaNamesPage {
  readonly defaultLanguage: string;
  readonly languages: readonly string[];
  readonly areas: readonly ServiceAreaNamesRow[];
}

export interface ServiceAreaNamesListDependencies {
  readonly onboardingAreas: OnboardingAreas;
  readonly areaNames: AreaNameSource;
}

/**
 * `sellers.service-area-names-list` (ADR-0041): the service areas of the Market with their names in
 * every language the Market supports, marking which are edited. Rule `permissions
 * [sellers.seller.view]`. Reads configuration and the cached edited names; no unit of its own.
 */
export class ServiceAreaNamesList extends UseCase<
  unknown,
  ServiceAreaNamesPage,
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.service-area-names-list',
    rule: { kind: 'permissions', allOf: [SELLERS_SELLER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ServiceAreaNamesListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<ServiceAreaNamesPage, { readonly code: 'access.denied' }>> {
    const { market } = context;
    const configured = this.deps.onboardingAreas.configured(market);
    const languages = languagesOf(configured.map((area) => area.names));
    const edited = await this.deps.areaNames.edited(market);
    return ok({
      defaultLanguage: AREA_NAME_DEFAULT_LANGUAGE,
      languages,
      areas: configured.map((area) => rowOfArea(area, edited, languages)),
    });
  }
}
