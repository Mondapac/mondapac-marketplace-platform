import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { SELLERS_SERVICE_AREA_EDIT } from '../../contracts/permissions';
import { ServiceAreaNamesChanged } from '../../domain/audit';
import { parseAreaNamesEdit, type AreaNamesProblem } from '../../domain/service-area-names';
import { areaTargetId } from '../service-areas/area-target-id';
import { rowOfArea, type ServiceAreaNamesRow } from '../service-areas/area-name-views';
import type { OnboardingAreas } from '../ports/seller-market-formats';
import type {
  AreaNameSource,
  ServiceAreaNamesRepository,
} from '../ports/service-area-names.repository';
import { languagesOf } from '../../domain/area-name-languages';

export type ServiceAreaNamesEditFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'service-area.not-found' }
  | { readonly code: 'validation.failed'; readonly fields: readonly AreaNamesProblem[] };

export interface ServiceAreaNamesEditDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly areaNameStore: ServiceAreaNamesRepository;
  readonly onboardingAreas: OnboardingAreas;
  readonly areaNames: AreaNameSource;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * `sellers.service-area-names-edit` (ADR-0041): an admin sets the display name of one service area
 * in one or more languages, or restores the configured name of a language (null). Rule
 * `permissions [sellers.service-area.edit]` and the admin population. The area must be one the
 * Market's configuration lists. One read-write unit:
 * the names are written and an audit row `sellers.service-area.change` records how many were set
 * and restored (never a name). A request that changes nothing writes no audit row. Answers the
 * area as the page shows it. Concurrent edits of the same language: the last one wins.
 */
export class ServiceAreaNamesEdit extends UseCase<
  unknown,
  { readonly area: ServiceAreaNamesRow; readonly changed: number },
  ServiceAreaNamesEditFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.service-area-names-edit',
    rule: { kind: 'permissions', allOf: [SELLERS_SERVICE_AREA_EDIT.key] },
  };

  readonly #logger = new Logger('ServiceAreaNamesEdit');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ServiceAreaNamesEditDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<
    Result<
      { readonly area: ServiceAreaNamesRow; readonly changed: number },
      ServiceAreaNamesEditFailure
    >
  > {
    const result = await this.edit(context, input);
    this.#logger.log({
      msg: 'sellers.service-area-names-edit',
      code: result.ok ? (result.value.changed > 0 ? 'changed' : 'unchanged') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async edit(
    context: CallContext,
    input: unknown,
  ): Promise<
    Result<
      { readonly area: ServiceAreaNamesRow; readonly changed: number },
      ServiceAreaNamesEditFailure
    >
  > {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const { unitOfWork, areaNameStore, onboardingAreas, areaNames, audit, clock } = this.deps;
    const configured = onboardingAreas.configured(market);
    const languages = languagesOf(configured.map((entry) => entry.names));
    const parsed = parseAreaNamesEdit(input, languages);
    if (!parsed.ok) return err(parsed.error);
    const edit = parsed.value;
    const area = configured.find((entry) => entry.code === edit.areaCode);
    if (area === undefined) return err({ code: 'service-area.not-found' });

    const written = await unitOfWork.run<number, ServiceAreaNamesEditFailure>(market, async () => {
      const applied = await areaNameStore.apply(
        market,
        area.code,
        edit.names,
        actor.accountId,
        clock.now(),
      );
      if (applied.set + applied.restored > 0) {
        // The rows that really changed, not the entries of the request.
        await audit.record(
          context,
          ServiceAreaNamesChanged.entry(areaTargetId(market, area.code), {
            after: { namesSet: applied.set, namesRestored: applied.restored },
          }),
        );
      }
      return ok(applied.set + applied.restored);
    });
    if (!written.ok) return written;
    areaNames.forget(market);
    const edited = await areaNames.edited(market);
    return ok({ area: rowOfArea(area, edited, languages), changed: written.value });
  }
}
