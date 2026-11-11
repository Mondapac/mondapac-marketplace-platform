import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_TOPIC_MANAGE } from '../../contracts/permissions';
import {
  TOPIC_SLUG_MAX,
  isTopicSlug,
  newTopic,
  parseTopicContent,
  suggestTopicSlug,
} from '../../domain/topic';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { TopicRepository } from '../ports/topic.repository';
import { termsTakenElsewhere, type TopicTermTaken } from '../topics/topic-terms';
import {
  adminAccountOf,
  closedInput,
  invalid,
  invalidFields,
  refuseTopicClaimWords,
  viewOf,
  type TopicClaimWordFailure,
  type TopicView,
  type ValidationFailure,
} from '../topics/topic-views';

export interface TopicCreateInput {
  readonly slug?: unknown;
  readonly group?: unknown;
  readonly names?: unknown;
  readonly synonyms?: unknown;
  readonly intro?: unknown;
}

export type TopicCreateFailure =
  | TopicClaimWordFailure
  | TopicTermTaken
  | { readonly code: 'access.denied' }
  | { readonly code: 'topic.slug-taken' | 'topic.term-taken' }
  | ValidationFailure;

export interface TopicCreateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly topics: TopicRepository;
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const CREATE_KEYS = ['slug', 'group', 'names', 'synonyms', 'intro'] as const;
const MAX_SLUG_PROBES = 50;

/**
 * `topic.create` (product tags package T1): an admin adds a topic to the Market's curated list,
 * active at once. Rule: the key `catalog.topic.manage` and the admin population. The name in the
 * Market's default locale is required; a name, synonym or intro that asserts a certification is
 * refused (claim words, john 24 Oct), and so is a slug that does. A term another topic already uses is refused by field. The
 * slug is the one given (which must be free) or derived from the default-locale name; it never
 * changes.
 */
export class TopicCreate extends UseCase<
  TopicCreateInput,
  { readonly topic: TopicView },
  TopicCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.topic-create',
    rule: { kind: 'permissions', allOf: [CATALOG_TOPIC_MANAGE.key] },
  };

  readonly #logger = new Logger('TopicCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: TopicCreateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TopicCreateInput,
  ): Promise<Result<{ readonly topic: TopicView }, TopicCreateFailure>> {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.topic-create',
      code: result.ok ? 'created' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: TopicCreateInput,
  ): Promise<Result<{ readonly topic: TopicView }, TopicCreateFailure>> {
    const accountId = adminAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, CREATE_KEYS);
    if (!body.ok) return body;
    const { market } = context;
    const locales = this.deps.policy.locales(market);
    const content = parseTopicContent(body.value, {
      required: locales.default,
      supported: locales.supported,
    });
    if (!content.ok) return invalidFields(content.error);
    const givenSlug = body.value['slug'];
    if (givenSlug !== undefined && givenSlug !== null && !isTopicSlug(givenSlug)) {
      return invalid('slug', 'format');
    }
    const name = content.value.terms.find(
      (term) => term.locale === locales.default && term.kind === 'name',
    )!;
    const { topics } = this.deps;

    // First the slug that will be saved (as given, or the free form the name suggests) and the
    // terms other topics use, in a read-only unit; then the claim check of every text including
    // that exact slug, with no unit open (the matcher opens its own); then the write. A slug or
    // term taken in between is refused by the unique indexes.
    const planned = await this.deps.unitOfWork.run<string, TopicCreateFailure>(
      market,
      async () => {
        const taken = await termsTakenElsewhere(market, content.value.terms, topics, null);
        if (taken !== null) return err(taken);
        if (typeof givenSlug === 'string') {
          return (await topics.slugTaken(market, givenSlug))
            ? err({ code: 'topic.slug-taken' } as const)
            : ok(givenSlug);
        }
        const base = suggestTopicSlug(name.text);
        for (let n = 1; n <= MAX_SLUG_PROBES; n += 1) {
          const suffix = n === 1 ? '' : `-${n}`;
          const candidate = `${base.slice(0, TOPIC_SLUG_MAX - suffix.length).replace(/-+$/u, '')}${suffix}`;
          if (!(await topics.slugTaken(market, candidate))) return ok(candidate);
        }
        return ok(
          `${base.slice(0, 31).replace(/-+$/u, '')}-${this.deps.ids.next<'Topic'>().slice(-8)}`,
        );
      },
      { readOnly: true },
    );
    if (!planned.ok) return planned;
    const slug = planned.value;
    const claim = await refuseTopicClaimWords(
      this.deps,
      context,
      content.value,
      locales.default,
      slug,
    );
    if (claim !== null) return err(claim);

    return this.deps.unitOfWork.run<{ readonly topic: TopicView }, TopicCreateFailure>(
      market,
      async () => {
        const state = newTopic({
          id: this.deps.ids.next<'Topic'>(),
          slug,
          content: content.value,
          createdBy: accountId,
          now: this.deps.clock.now(),
        });
        const added = await topics.add(market, state);
        if (added !== null) return err({ code: added } as const);
        return ok({ topic: viewOf(state) });
      },
    );
  }
}
