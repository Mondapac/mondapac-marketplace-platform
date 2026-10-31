import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BUSINESS_ACTIVITY_EDIT } from '../../contracts/permissions';
import {
  isActivityCode,
  newActivity,
  parseActivityContent,
  suggestActivityCode,
} from '../../domain/business-activity';
import { checkLinkedCategories } from '../business-activities/activity-categories';
import {
  adminAccountOf,
  closedInput,
  invalid,
  invalidFields,
  refuseClaimWords,
  viewOf,
  type BusinessActivityView,
  type ClaimWordFailure,
  type ValidationFailure,
} from '../business-activities/business-activity-views';
import type { BusinessActivityRepository } from '../ports/business-activity.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';

export interface BusinessActivityCreateInput {
  readonly code?: unknown;
  readonly names?: unknown;
  readonly description?: unknown;
  readonly categoryIds?: unknown;
}

export type BusinessActivityCreateFailure =
  | ClaimWordFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'business-activity.code-taken' }
  | { readonly code: 'business-activity.name-taken' }
  | ValidationFailure;

export interface BusinessActivityCreateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly activities: BusinessActivityRepository;
  readonly treeReader: CategoryTreeReader;
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const CREATE_KEYS = ['code', 'names', 'description', 'categoryIds'] as const;
const MAX_CODE_PROBES = 50;

/**
 * `business-activity.create` (catalog business-activity package): an admin defines a business
 * activity of the Market, active at once. Rule: the key `catalog.business-activity.edit` and the
 * admin population. The name in the Market's default locale is required, other supported locales are
 * optional; a name or description that asserts a certification is refused. The code is the one
 * given (which must be free) or derived from the default-locale name; it never changes. Each linked
 * category must be live and on level 1 or 2.
 */
export class BusinessActivityCreate extends UseCase<
  BusinessActivityCreateInput,
  { readonly activity: BusinessActivityView },
  BusinessActivityCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.business-activity-create',
    rule: { kind: 'permissions', allOf: [CATALOG_BUSINESS_ACTIVITY_EDIT.key] },
  };

  readonly #logger = new Logger('BusinessActivityCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BusinessActivityCreateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BusinessActivityCreateInput,
  ): Promise<Result<{ readonly activity: BusinessActivityView }, BusinessActivityCreateFailure>> {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.business-activity-create',
      code: result.ok ? 'created' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: BusinessActivityCreateInput,
  ): Promise<Result<{ readonly activity: BusinessActivityView }, BusinessActivityCreateFailure>> {
    const accountId = adminAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, CREATE_KEYS);
    if (!body.ok) return body;
    const { market } = context;
    const locales = this.deps.policy.locales(market);
    const content = parseActivityContent(body.value, {
      required: locales.default,
      supported: locales.supported,
    });
    if (!content.ok) return invalidFields(content.error);
    const givenCode = body.value['code'];
    if (givenCode !== undefined && givenCode !== null && !isActivityCode(givenCode)) {
      return invalid('code', 'format');
    }
    const claim = await refuseClaimWords(this.deps.matcher, context, content.value);
    if (claim !== null) return err(claim);

    return this.deps.unitOfWork.run<
      { readonly activity: BusinessActivityView },
      BusinessActivityCreateFailure
    >(market, async () => {
      const categories = await checkLinkedCategories(market, content.value.categoryIds, this.deps);
      if (!categories.ok) return categories;
      const { activities } = this.deps;
      let code: string;
      if (typeof givenCode === 'string') {
        if (await activities.codeTaken(market, givenCode)) {
          return err({ code: 'business-activity.code-taken' } as const);
        }
        code = givenCode;
      } else {
        const defaultName = content.value.names.find((entry) => entry.locale === locales.default)!;
        const base = suggestActivityCode(defaultName.name);
        let free: string | null = null;
        for (let n = 1; n <= MAX_CODE_PROBES && free === null; n += 1) {
          const candidate = n === 1 ? base : `${base}-${n}`.slice(0, 40);
          if (!(await activities.codeTaken(market, candidate))) free = candidate;
        }
        code = free ?? `${base.slice(0, 31)}-${this.deps.ids.next<'BusinessActivity'>().slice(-8)}`;
      }
      const state = newActivity({
        id: this.deps.ids.next<'BusinessActivity'>(),
        code,
        content: content.value,
        createdBy: accountId,
        now: this.deps.clock.now(),
      });
      const added = await activities.add(market, state);
      if (added !== null) return err({ code: added } as const);
      return ok({ activity: viewOf(state) });
    });
  }
}
