import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_TOPIC_MANAGE } from '../../contracts/permissions';
import { parseTopicContent, type TopicState } from '../../domain/topic';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { TopicRepository } from '../ports/topic.repository';
import { termsTakenElsewhere, type TopicTermTaken } from '../topics/topic-terms';
import {
  adminAccountOf,
  closedInput,
  invalidFields,
  refuseTopicClaimWords,
  topicIdOf,
  topicStatusOf,
  versionOf,
  viewOf,
  type TopicClaimWordFailure,
  type TopicView,
  type ValidationFailure,
} from '../topics/topic-views';

export interface TopicEditInput {
  readonly topicId?: unknown;
  /** The version the admin saw. */
  readonly version?: unknown;
  readonly status?: unknown;
  readonly group?: unknown;
  readonly names?: unknown;
  readonly synonyms?: unknown;
  readonly intro?: unknown;
}

export type TopicEditFailure =
  | TopicClaimWordFailure
  | TopicTermTaken
  | { readonly code: 'access.denied' }
  | { readonly code: 'topic.not-found' }
  | { readonly code: 'topic.term-taken' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

export interface TopicEditDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly topics: TopicRepository;
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly clock: Clock;
}

const EDIT_KEYS = ['topicId', 'version', 'status', 'group', 'names', 'synonyms', 'intro'] as const;

/**
 * `topic.edit` (product tags package T1): an admin replaces the content of a topic (group, names,
 * synonyms, intro) and sets it active or archived. Rule: the key `catalog.topic.manage` and the
 * admin population. The request is the whole content (synonyms or intro left out are cleared;
 * `status` left out keeps it) and the version the admin saw; a later version is `conflict.stale`.
 * The slug never changes. Claim words and terms taken by another topic are refused as in
 * `topic.create`.
 */
export class TopicEdit extends UseCase<
  TopicEditInput,
  { readonly topic: TopicView },
  TopicEditFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.topic-edit',
    rule: { kind: 'permissions', allOf: [CATALOG_TOPIC_MANAGE.key] },
  };

  readonly #logger = new Logger('TopicEdit');

  constructor(
    gate: UseCaseGate,
    private readonly deps: TopicEditDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TopicEditInput,
  ): Promise<Result<{ readonly topic: TopicView }, TopicEditFailure>> {
    const result = await this.#edit(context, input);
    this.#logger.log({
      msg: 'catalog.topic-edit',
      code: result.ok ? 'edited' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #edit(
    context: CallContext,
    input: TopicEditInput,
  ): Promise<Result<{ readonly topic: TopicView }, TopicEditFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, EDIT_KEYS);
    if (!body.ok) return body;
    const id = topicIdOf(body.value['topicId'], 'topicId');
    if (!id.ok) return err({ code: 'topic.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const { market } = context;
    const locales = this.deps.policy.locales(market);
    const content = parseTopicContent(body.value, {
      required: locales.default,
      supported: locales.supported,
    });
    if (!content.ok) return invalidFields(content.error);
    let status = null;
    if (body.value['status'] !== undefined) {
      const parsed = topicStatusOf(body.value['status'], 'status');
      if (!parsed.ok) return parsed;
      status = parsed.value;
    }
    const claim = await refuseTopicClaimWords(
      this.deps.matcher,
      context,
      content.value,
      locales.default,
    );
    if (claim !== null) return err(claim);
    const { topics } = this.deps;

    try {
      return await this.deps.unitOfWork.run<{ readonly topic: TopicView }, TopicEditFailure>(
        market,
        async () => {
          const found = await topics.findById(market, id.value);
          if (found === null) return err({ code: 'topic.not-found' } as const);
          if (found.version !== version.value) return err({ code: 'conflict.stale' } as const);
          const taken = await termsTakenElsewhere(market, content.value.terms, topics, found.id);
          if (taken !== null) return err(taken);
          const next: TopicState = {
            ...found,
            status: status ?? found.status,
            group: content.value.group,
            terms: content.value.terms,
            intro: content.value.intro,
            updatedAt: this.deps.clock.now(),
            version: found.version + 1,
          };
          const saved = await topics.save(market, next, found.version);
          // The slug of an existing topic never changes, so only a term can collide (a race).
          if (saved !== null) return err({ code: 'topic.term-taken' } as const);
          return ok({ topic: viewOf(next) });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }
}
