import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  rowOfArea,
  type ServiceAreaNamesListRow,
  type ServiceAreaRowAction,
} from '../service-areas/area-name-views';
import type { OnboardingAreas } from '../ports/seller-market-formats';
import type { AreaNameSource } from '../ports/service-area-names.repository';
import { AREA_NAME_DEFAULT_LANGUAGE, languagesOf } from '../../domain/area-name-languages';
import { heldKeys, type PermissionProbe } from '../../../../platform/list-query';
import { SELLERS_SELLER_VIEW, SELLERS_SERVICE_AREA_EDIT } from '../../contracts/permissions';

export interface ServiceAreaNamesPage {
  readonly defaultLanguage: string;
  readonly languages: readonly string[];
  readonly areas: readonly ServiceAreaNamesListRow[];
}

export interface ServiceAreaNamesListDependencies {
  readonly onboardingAreas: OnboardingAreas;
  readonly areaNames: AreaNameSource;
  /** Says whether the caller may edit names; a list under 50 rows still names its row actions. */
  readonly editProbe: PermissionProbe;
}

/**
 * `sellers.service-area-names-list` (ADR-0041): the service areas of the Market with their names in
 * every language the Market supports, marking which are edited. Rule `permissions
 * [sellers.seller.view]`. Reads configuration and the cached edited names; no unit of its own. Each row names its actions (Edit names… for a holder
 * of `sellers.service-area.edit`, asked once through `sellers.service-area-edit-probe`).
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
    const held =
      configured.length === 0
        ? new Set<string>()
        : await heldKeys(context, { [SELLERS_SERVICE_AREA_EDIT.key]: this.deps.editProbe });
    const actions: readonly ServiceAreaRowAction[] = held.has(SELLERS_SERVICE_AREA_EDIT.key)
      ? ['edit-names']
      : [];
    return ok({
      defaultLanguage: AREA_NAME_DEFAULT_LANGUAGE,
      languages,
      areas: configured.map((area) => ({ ...rowOfArea(area, edited, languages), actions })),
    });
  }
}
