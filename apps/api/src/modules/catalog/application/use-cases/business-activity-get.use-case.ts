import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BUSINESS_ACTIVITY_READ } from '../../contracts/permissions';
import {
  activityIdOf,
  adminAccountOf,
  viewOf,
  type BusinessActivityView,
} from '../business-activities/business-activity-views';
import type { BusinessActivityRepository } from '../ports/business-activity.repository';

export interface BusinessActivityGetInput {
  readonly activityId?: unknown;
}

export type BusinessActivityGetFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'business-activity.not-found' };

export interface BusinessActivityGetDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly activities: BusinessActivityRepository;
}

/**
 * `business-activity.get` (catalog business-activity package): one activity for the admin editor.
 * Rule: the key `catalog.business-activity.read` and the admin population. One read-only unit.
 */
export class BusinessActivityGet extends UseCase<
  BusinessActivityGetInput,
  { readonly activity: BusinessActivityView },
  BusinessActivityGetFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.business-activity-get',
    rule: { kind: 'permissions', allOf: [CATALOG_BUSINESS_ACTIVITY_READ.key] },
  };

  readonly #logger = new Logger('BusinessActivityGet');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BusinessActivityGetDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BusinessActivityGetInput,
  ): Promise<Result<{ readonly activity: BusinessActivityView }, BusinessActivityGetFailure>> {
    const result = await this.#get(context, input);
    this.#logger.log({
      msg: 'catalog.business-activity-get',
      code: result.ok ? 'read' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #get(
    context: CallContext,
    input: BusinessActivityGetInput,
  ): Promise<Result<{ readonly activity: BusinessActivityView }, BusinessActivityGetFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const id = activityIdOf(input.activityId, 'activityId');
    if (!id.ok) return err({ code: 'business-activity.not-found' });
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.activities.findById(market, id.value)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'business-activity.not-found' });
    return ok({ activity: viewOf(read.value) });
  }
}
