import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_TOPIC_READ } from '../../contracts/permissions';
import { TOPIC_GROUPS, TOPIC_SYNONYMS_MAX } from '../../domain/topic';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { TopicReader } from '../ports/topic.reader';
import {
  TOPIC_PAGE_DEFAULT,
  TOPIC_PAGE_MAX,
  TOPIC_SEARCH_MAX,
  adminAccountOf,
  closedInput,
  invalid,
  topicGroupOf,
  topicIdOf,
  topicStatusOf,
  viewOf,
  type TopicView,
  type ValidationFailure,
} from '../topics/topic-views';

export interface TopicListInput {
  readonly status?: unknown;
  readonly group?: unknown;
  readonly search?: unknown;
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

export interface TopicListOutput {
  readonly items: readonly TopicView[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
  /** The Market's locales: the language dropdown of the form offers the supported ones. */
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
  /** The groups a topic may sit in and the most synonyms per locale, for the form. */
  readonly groups: readonly string[];
  readonly maxSynonyms: number;
}

export type TopicListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface TopicListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly topicReader: TopicReader;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `topic.list` (product tags package T1): the topics of the Market for the admin panel and its
 * searchable pickers, by slug, keyset-paged; `status` and `group` filter and `search` matches a
 * name or synonym in any locale or the slug. Rule: the key `catalog.topic.read` and the admin
 * population. One read-only unit.
 */
export class TopicList extends UseCase<TopicListInput, TopicListOutput, TopicListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.topic-list',
    rule: { kind: 'permissions', allOf: [CATALOG_TOPIC_READ.key] },
  };

  readonly #logger = new Logger('TopicList');

  constructor(
    gate: UseCaseGate,
    private readonly deps: TopicListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TopicListInput,
  ): Promise<Result<TopicListOutput, TopicListFailure>> {
    const result = await this.#list(context, input);
    this.#logger.log({
      msg: 'catalog.topic-list',
      code: result.ok ? 'listed' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #list(
    context: CallContext,
    input: TopicListInput,
  ): Promise<Result<TopicListOutput, TopicListFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['status', 'group', 'search', 'afterId', 'limit']);
    if (!body.ok) return body;
    let status = null;
    if (body.value['status'] !== undefined && body.value['status'] !== null) {
      const parsed = topicStatusOf(body.value['status'], 'status');
      if (!parsed.ok) return parsed;
      status = parsed.value;
    }
    let group = null;
    if (body.value['group'] !== undefined && body.value['group'] !== null) {
      const parsed = topicGroupOf(body.value['group'], 'group');
      if (!parsed.ok) return parsed;
      group = parsed.value;
    }
    let search: string | null = null;
    const rawSearch = body.value['search'];
    if (rawSearch !== undefined && rawSearch !== null) {
      if (typeof rawSearch !== 'string') return invalid('search', 'type');
      const tidy = rawSearch.trim();
      if (tidy.length > TOPIC_SEARCH_MAX) return invalid('search', 'too-long');
      search = tidy === '' ? null : tidy;
    }
    let afterId = null;
    if (body.value['afterId'] !== undefined && body.value['afterId'] !== null) {
      const parsed = topicIdOf(body.value['afterId'], 'afterId');
      if (!parsed.ok) return parsed;
      afterId = parsed.value;
    }
    let limit = TOPIC_PAGE_DEFAULT;
    const rawLimit = body.value['limit'];
    if (rawLimit !== undefined && rawLimit !== null) {
      if (
        typeof rawLimit !== 'number' ||
        !Number.isInteger(rawLimit) ||
        rawLimit < 1 ||
        rawLimit > TOPIC_PAGE_MAX
      ) {
        return invalid('limit', 'range');
      }
      limit = rawLimit;
    }
    const { market } = context;
    const read = await this.deps.unitOfWork.run(
      market,
      async () =>
        ok(await this.deps.topicReader.list(market, { status, group, search, afterId, limit })),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const locales = this.deps.policy.locales(market);
    return ok({
      items: read.value.items.map(viewOf),
      nextAfterId: read.value.nextAfterId,
      locales: { default: locales.default, supported: [...locales.supported] },
      groups: [...TOPIC_GROUPS],
      maxSynonyms: TOPIC_SYNONYMS_MAX,
    });
  }
}
