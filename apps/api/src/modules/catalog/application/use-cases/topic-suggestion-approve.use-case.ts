import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_TOPIC_MANAGE, CATALOG_TOPIC_SUGGESTION_REVIEW } from '../../contracts/permissions';
import { TopicSuggestionDecidedAudit } from '../../domain/audit';
import { isTopicSlug, newTopic, parseTopicContent } from '../../domain/topic';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { TopicRepository } from '../ports/topic.repository';
import { freeTopicSlug } from '../topics/topic-slug';
import {
  decisionViewOf,
  deciderOf,
  loadOpenSuggestion,
  suggestionIdOf,
  suggestionVersionOf,
  type SuggestionDecideDependencies,
  type SuggestionDecisionFailure,
  type SuggestionDecisionView,
} from '../topics/topic-suggestions';
import { termsTakenElsewhere, type TopicTermTaken } from '../topics/topic-terms';
import {
  closedInput,
  invalid,
  invalidFields,
  refuseTopicClaimWords,
  type TopicClaimWordFailure,
  type ValidationFailure,
} from '../topics/topic-views';

export interface TopicSuggestionApproveInput {
  readonly [key: string]: unknown;
}

export interface TopicSuggestionApproveDependencies extends SuggestionDecideDependencies {
  readonly topics: TopicRepository;
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
  readonly ids: IdGenerator;
}

export type TopicSuggestionApproveFailure =
  | SuggestionDecisionFailure
  | TopicClaimWordFailure
  | TopicTermTaken
  | { readonly code: 'access.denied' }
  | { readonly code: 'topic.slug-taken' | 'topic.term-taken' }
  | ValidationFailure;

const KEYS = ['suggestionId', 'version', 'group', 'name', 'slug'] as const;

/**
 * `topic-suggestion.approve` (product tags package T5): an admin creates a topic from a
 * suggestion, active at once, and the suggestion is closed as approved. Rule: the keys
 * `catalog.topic-suggestion.review` and `catalog.topic.manage` together (the review key never
 * lets anyone create a topic) and the admin population, no acting-as session. The request names
 * the version the admin saw, the group, and optionally the name (default: the seller's text) and
 * a slug (default: the free form the name suggests). The name and slug pass the same claim-word
 * check and the same term-taken check as `topic.create`, fail closed. In one unit: the topic, the
 * decision and its audit row. Nothing is added to the product: the seller picks the tag
 * themselves, and the change goes to review like every tag change (john, 24 Oct 2026). The seller
 * is told by one mail afterwards.
 */
export class TopicSuggestionApprove extends UseCase<
  TopicSuggestionApproveInput,
  { readonly suggestion: SuggestionDecisionView },
  TopicSuggestionApproveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.topic-suggestion-approve',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_TOPIC_SUGGESTION_REVIEW.key, CATALOG_TOPIC_MANAGE.key],
    },
  };

  readonly #logger = new Logger('TopicSuggestionApprove');

  constructor(
    gate: UseCaseGate,
    private readonly deps: TopicSuggestionApproveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TopicSuggestionApproveInput,
  ): Promise<
    Result<{ readonly suggestion: SuggestionDecisionView }, TopicSuggestionApproveFailure>
  > {
    const result = await this.#approve(context, input);
    this.#logger.log({
      msg: 'catalog.topic-suggestion-approve',
      code: result.ok ? 'approved' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #approve(
    context: CallContext,
    input: TopicSuggestionApproveInput,
  ): Promise<
    Result<{ readonly suggestion: SuggestionDecisionView }, TopicSuggestionApproveFailure>
  > {
    const accountId = deciderOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = suggestionIdOf(body.value['suggestionId']);
    if (id === null) return err({ code: 'suggestion.not-found' });
    const version = suggestionVersionOf(body.value['version']);
    if (!version.ok) return version;
    const givenSlug = body.value['slug'];
    if (givenSlug !== undefined && givenSlug !== null && !isTopicSlug(givenSlug)) {
      return invalid('slug', 'format');
    }
    const rawName = body.value['name'];
    if (rawName !== undefined && rawName !== null && typeof rawName !== 'string') {
      return invalid('name', 'type');
    }
    const { market } = context;
    let locales: { readonly default: string; readonly supported: readonly string[] };
    try {
      locales = this.deps.policy.locales(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const { topics, topicSuggestions: suggestions } = this.deps;

    // The seller's text is the default name; read it first, in a read-only unit.
    const seen = await this.deps.unitOfWork.run<string, SuggestionDecisionFailure>(
      market,
      async () => {
        const loaded = await loadOpenSuggestion(suggestions, market, id, version.value);
        return loaded.ok ? ok(loaded.value.state.label) : err(loaded.error);
      },
      { readOnly: true },
    );
    if (!seen.ok) return seen;
    const content = parseTopicContent(
      {
        group: body.value['group'],
        names: { [locales.default]: typeof rawName === 'string' ? rawName : seen.value },
      },
      { required: locales.default, supported: locales.supported },
    );
    if (!content.ok) return invalidFields(content.error);
    const name = content.value.terms[0]!;

    // The slug that will be saved and the terms other topics use, in a read-only unit; then the
    // claim check with no unit open (the matcher opens its own); then the write.
    const planned = await this.deps.unitOfWork.run<string, TopicSuggestionApproveFailure>(
      market,
      async () => {
        const taken = await termsTakenElsewhere(market, content.value.terms, topics, null);
        if (taken !== null) return err(taken);
        const free = await freeTopicSlug(
          market,
          topics,
          this.deps.ids,
          typeof givenSlug === 'string' ? givenSlug : null,
          name.text,
        );
        return free === null ? err({ code: 'topic.slug-taken' } as const) : ok(free);
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

    try {
      return await this.deps.unitOfWork.run<
        { readonly suggestion: SuggestionDecisionView },
        TopicSuggestionApproveFailure
      >(market, async () => {
        const loaded = await loadOpenSuggestion(suggestions, market, id, version.value);
        if (!loaded.ok) return err(loaded.error);
        const suggestion = loaded.value;
        const now = this.deps.clock.now();
        const state = newTopic({
          id: this.deps.ids.next<'Topic'>(),
          slug,
          content: content.value,
          createdBy: accountId,
          now,
        });
        const decided = suggestion.approve({ accountId, topicId: state.id, now });
        if (!decided.ok) return err(decided.error);
        const added = await topics.add(market, state);
        if (added !== null) return err({ code: added } as const);
        await suggestions.saveDecision(market, decided.value);
        await this.deps.audit.record(
          context,
          TopicSuggestionDecidedAudit.entry(suggestion.state.id, {
            before: { status: 'open' },
            after: { status: 'approved', topicId: state.id, sellerId: suggestion.state.sellerId },
          }),
        );
        return ok({ suggestion: decisionViewOf(decided.value) });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'suggestion.stale' });
      throw error;
    }
  }
}
