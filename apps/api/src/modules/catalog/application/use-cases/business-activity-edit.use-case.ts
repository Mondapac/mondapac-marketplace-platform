import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BUSINESS_ACTIVITY_EDIT } from '../../contracts/permissions';
import { parseActivityContent } from '../../domain/business-activity';
import { checkLinkedCategories } from '../business-activities/activity-categories';
import {
  activityIdOf,
  adminAccountOf,
  closedInput,
  invalidFields,
  refuseClaimWords,
  statusOf,
  versionOf,
  viewOf,
  type BusinessActivityView,
  type ClaimWordFailure,
  type ValidationFailure,
} from '../business-activities/business-activity-views';
import type { BusinessActivityRepository } from '../ports/business-activity.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';

export interface BusinessActivityEditInput {
  readonly activityId?: unknown;
  /** The version the admin saw. */
  readonly version?: unknown;
  readonly status?: unknown;
  readonly names?: unknown;
  readonly description?: unknown;
  readonly categoryIds?: unknown;
}

export type BusinessActivityEditFailure =
  | ClaimWordFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'business-activity.not-found' }
  | { readonly code: 'business-activity.name-taken' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

export interface BusinessActivityEditDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly activities: BusinessActivityRepository;
  readonly treeReader: CategoryTreeReader;
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly clock: Clock;
}

const EDIT_KEYS = [
  'activityId',
  'version',
  'status',
  'names',
  'description',
  'categoryIds',
] as const;

/**
 * `business-activity.edit` (catalog business-activity package): an admin replaces the content of an
 * activity (names, description, linked category branches) and sets it active or inactive. Rule:
 * the key `catalog.business-activity.edit` and the admin population. The request is the whole
 * content (a field left out is cleared; `status` left out keeps it) and the version the admin saw;
 * a later version is `conflict.stale`. The code never changes. Claim words and category levels are
 * checked as in `business-activity.create`.
 */
export class BusinessActivityEdit extends UseCase<
  BusinessActivityEditInput,
  { readonly activity: BusinessActivityView },
  BusinessActivityEditFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.business-activity-edit',
    rule: { kind: 'permissions', allOf: [CATALOG_BUSINESS_ACTIVITY_EDIT.key] },
  };

  readonly #logger = new Logger('BusinessActivityEdit');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BusinessActivityEditDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BusinessActivityEditInput,
  ): Promise<Result<{ readonly activity: BusinessActivityView }, BusinessActivityEditFailure>> {
    const result = await this.#edit(context, input);
    this.#logger.log({
      msg: 'catalog.business-activity-edit',
      code: result.ok ? 'edited' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #edit(
    context: CallContext,
    input: BusinessActivityEditInput,
  ): Promise<Result<{ readonly activity: BusinessActivityView }, BusinessActivityEditFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, EDIT_KEYS);
    if (!body.ok) return body;
    const id = activityIdOf(body.value['activityId'], 'activityId');
    if (!id.ok) return err({ code: 'business-activity.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const { market } = context;
    const locales = this.deps.policy.locales(market);
    const content = parseActivityContent(body.value, {
      required: locales.default,
      supported: locales.supported,
    });
    if (!content.ok) return invalidFields(content.error);
    let status = null;
    if (body.value['status'] !== undefined) {
      const parsed = statusOf(body.value['status'], 'status');
      if (!parsed.ok) return parsed;
      status = parsed.value;
    }
    const claim = await refuseClaimWords(this.deps.matcher, context, content.value);
    if (claim !== null) return err(claim);
    const { activities } = this.deps;

    try {
      return await this.deps.unitOfWork.run<
        { readonly activity: BusinessActivityView },
        BusinessActivityEditFailure
      >(market, async () => {
        const found = await activities.findById(market, id.value);
        if (found === null) return err({ code: 'business-activity.not-found' } as const);
        if (found.version !== version.value) return err({ code: 'conflict.stale' } as const);
        const categories = await checkLinkedCategories(
          market,
          content.value.categoryIds,
          this.deps,
        );
        if (!categories.ok) return categories;
        const next = {
          ...found,
          status: status ?? found.status,
          description: content.value.description,
          names: content.value.names,
          categoryIds: content.value.categoryIds,
          updatedAt: this.deps.clock.now(),
          version: found.version + 1,
        };
        const saved = await activities.save(market, next, found.version);
        if (saved !== null) {
          // The code of an existing activity never changes, so only a name can collide.
          return err({ code: 'business-activity.name-taken' } as const);
        }
        return ok({ activity: viewOf(next) });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
