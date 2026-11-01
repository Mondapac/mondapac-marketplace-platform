import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BUSINESS_ACTIVITY_READ } from '../../contracts/permissions';
import {
  ACTIVITY_PAGE_DEFAULT,
  ACTIVITY_PAGE_MAX,
  ACTIVITY_SEARCH_MAX,
  activityIdOf,
  adminAccountOf,
  closedInput,
  invalid,
  statusOf,
  viewOf,
  type BusinessActivityView,
  type ValidationFailure,
} from '../business-activities/business-activity-views';
import type { BusinessActivityReader } from '../ports/business-activity.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

export interface BusinessActivityListInput {
  readonly status?: unknown;
  readonly search?: unknown;
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

export interface BusinessActivityListOutput {
  readonly items: readonly BusinessActivityView[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
  /** The Market's locales: the language dropdown of the form offers the supported ones. */
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
}

export type BusinessActivityListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface BusinessActivityListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly activityReader: BusinessActivityReader;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `business-activity.list` (catalog business-activity package): the activities of the Market for
 * the admin panel and its searchable pickers, by code, keyset-paged; `status` filters and `search`
 * matches a name in any locale or the code (server-side search for the dropdown, john 31 Oct).
 * Rule: the key `catalog.business-activity.read` and the admin population. One read-only unit.
 */
export class BusinessActivityList extends UseCase<
  BusinessActivityListInput,
  BusinessActivityListOutput,
  BusinessActivityListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.business-activity-list',
    rule: { kind: 'permissions', allOf: [CATALOG_BUSINESS_ACTIVITY_READ.key] },
  };

  readonly #logger = new Logger('BusinessActivityList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: BusinessActivityListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: BusinessActivityListInput,
  ): Promise<Result<BusinessActivityListOutput, BusinessActivityListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.business-activity-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: BusinessActivityListInput,
  ): Promise<Result<BusinessActivityListOutput, BusinessActivityListFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['status', 'search', 'afterId', 'limit']);
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
      if (tidy.length > ACTIVITY_SEARCH_MAX) return invalid('search', 'too-long');
      search = tidy === '' ? null : tidy;
    }
    let afterId = null;
    if (body.value['afterId'] !== undefined && body.value['afterId'] !== null) {
      const parsed = activityIdOf(body.value['afterId'], 'afterId');
      if (!parsed.ok) return parsed;
      afterId = parsed.value;
    }
    let limit = ACTIVITY_PAGE_DEFAULT;
    const rawLimit = body.value['limit'];
    if (rawLimit !== undefined && rawLimit !== null) {
      if (
        typeof rawLimit !== 'number' ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > ACTIVITY_PAGE_MAX
      ) {
        return invalid('limit', 'range');
      }
      limit = rawLimit;
    }
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(await this.deps.activityReader.list(market, { status, search, afterId, limit })),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const locales = this.deps.policy.locales(market);
    return ok({
      items: read.value.items.map(viewOf),
      nextAfterId: read.value.nextAfterId,
      locales: { default: locales.default, supported: [...locales.supported] },
    });
  }
}
