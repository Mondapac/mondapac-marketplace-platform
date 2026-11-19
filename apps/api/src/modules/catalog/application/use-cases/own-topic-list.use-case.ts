import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { MAX_TOPICS_PER_PRODUCT, type TopicGroup, type TopicState } from '../../domain/topic';
import { sellerOf } from '../own-reads/own-reads.shared';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { TopicReader } from '../ports/topic.reader';
import {
  TOPIC_PAGE_DEFAULT,
  TOPIC_PAGE_MAX,
  TOPIC_SEARCH_MAX,
  closedInput,
  invalid,
  topicIdOf,
  type ValidationFailure,
} from '../topics/topic-views';

export interface OwnTopicListInput {
  readonly search?: unknown;
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

/** An active topic as the seller's picker shows it. No synonyms, intro or status. */
export interface OwnTopicItem {
  readonly id: string;
  readonly slug: string;
  readonly group: TopicGroup;
  /** The name in the Market's default locale, else any locale; null when it has none. */
  readonly name: string | null;
  readonly names: Readonly<Record<string, string>>;
}

export interface OwnTopicListOutput {
  readonly items: readonly OwnTopicItem[];
  /** The `afterId` of the next page; null on the last page. */
  readonly nextAfterId: string | null;
  /** The most topics a product may carry. */
  readonly maxPerProduct: number;
}

export type OwnTopicListFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface OwnTopicListDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly topicReader: TopicReader;
  readonly policy: CatalogMarketPolicy;
}

function itemOf(state: TopicState, defaultLocale: string): OwnTopicItem {
  const names: Record<string, string> = {};
  for (const term of state.terms) if (term.kind === 'name') names[term.locale] = term.text;
  const first = Object.keys(names).sort()[0];
  return {
    id: state.id,
    slug: state.slug,
    group: state.group,
    name: names[defaultLocale] ?? (first === undefined ? null : (names[first] ?? null)),
    names,
  };
}

/**
 * `own-topic.list` (product tags T2): the active topics a seller may pick for a product, by slug,
 * keyset-paged; `search` matches a name or synonym in any locale or the slug. Rule: the key
 * `catalog.own-product.edit` (any seller who may edit products), as the product form that uses it;
 * allowed while the seller is not yet approved, like the draft it serves. Only the Market of the
 * request is read, and only active topics: an archived topic is offered to nobody. One read-only
 * unit (ADR-0025).
 */
export class OwnTopicList extends UseCase<
  OwnTopicListInput,
  OwnTopicListOutput,
  OwnTopicListFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-topic-list',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnTopicListDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnTopicListInput,
  ): Promise<Result<OwnTopicListOutput, OwnTopicListFailure>> {
    if (sellerOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['search', 'afterId', 'limit']);
    if (!body.ok) return body;
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
        ok(
          await this.deps.topicReader.list(market, {
            status: 'active',
            group: null,
            search,
            afterId,
            limit,
          }),
        ),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    let defaultLocale: string;
    try {
      defaultLocale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    return ok({
      items: read.value.items.map((state) => itemOf(state, defaultLocale)),
      nextAfterId: read.value.nextAfterId,
      maxPerProduct: MAX_TOPICS_PER_PRODUCT,
    });
  }
}
