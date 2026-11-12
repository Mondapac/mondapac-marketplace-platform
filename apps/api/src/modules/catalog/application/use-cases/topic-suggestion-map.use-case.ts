import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_TOPIC_SUGGESTION_REVIEW } from '../../contracts/permissions';
import { TopicSuggestionDecidedAudit } from '../../domain/audit';
import type { TopicRepository } from '../ports/topic.repository';
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
import { closedInput, topicIdOf, type ValidationFailure } from '../topics/topic-views';

export interface TopicSuggestionMapInput {
  readonly [key: string]: unknown;
}

export interface TopicSuggestionMapDependencies extends SuggestionDecideDependencies {
  readonly topics: TopicRepository;
}

export type TopicSuggestionMapFailure =
  SuggestionDecisionFailure | { readonly code: 'access.denied' } | ValidationFailure;

/**
 * `topic-suggestion.map` (product tags package T5): an admin closes a suggestion by pointing it
 * at a topic the list already has. The topic must exist and be active (`suggestion.topic-invalid`).
 * Rule: the key `catalog.topic-suggestion.review`, the admin population, no acting-as session; the
 * request names the version the admin saw. No topic is written, and nothing is added to the
 * product. One audit row; the seller is told by one mail afterwards.
 */
export class TopicSuggestionMap extends UseCase<
  TopicSuggestionMapInput,
  { readonly suggestion: SuggestionDecisionView },
  TopicSuggestionMapFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.topic-suggestion-map',
    rule: { kind: 'permissions', allOf: [CATALOG_TOPIC_SUGGESTION_REVIEW.key] },
  };

  readonly #logger = new Logger('TopicSuggestionMap');

  constructor(
    gate: UseCaseGate,
    private readonly deps: TopicSuggestionMapDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TopicSuggestionMapInput,
  ): Promise<Result<{ readonly suggestion: SuggestionDecisionView }, TopicSuggestionMapFailure>> {
    const result = await this.#map(context, input);
    this.#logger.log({
      msg: 'catalog.topic-suggestion-map',
      code: result.ok ? 'mapped' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #map(
    context: CallContext,
    input: TopicSuggestionMapInput,
  ): Promise<Result<{ readonly suggestion: SuggestionDecisionView }, TopicSuggestionMapFailure>> {
    const accountId = deciderOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['suggestionId', 'version', 'topicId']);
    if (!body.ok) return body;
    const id = suggestionIdOf(body.value['suggestionId']);
    if (id === null) return err({ code: 'suggestion.not-found' });
    const version = suggestionVersionOf(body.value['version']);
    if (!version.ok) return version;
    const topicId = topicIdOf(body.value['topicId'], 'topicId');
    if (!topicId.ok) return topicId;
    const { market } = context;
    try {
      return await this.deps.unitOfWork.run<
        { readonly suggestion: SuggestionDecisionView },
        TopicSuggestionMapFailure
      >(market, async () => {
        const loaded = await loadOpenSuggestion(
          this.deps.topicSuggestions,
          market,
          id,
          version.value,
        );
        if (!loaded.ok) return err(loaded.error);
        const suggestion = loaded.value;
        const topic = await this.deps.topics.findById(market, topicId.value);
        if (topic === null || topic.status !== 'active') {
          return err({ code: 'suggestion.topic-invalid' } as const);
        }
        const decided = suggestion.map({
          accountId,
          topicId: topicId.value,
          now: this.deps.clock.now(),
        });
        if (!decided.ok) return err(decided.error);
        await this.deps.topicSuggestions.saveDecision(market, decided.value);
        await this.deps.audit.record(
          context,
          TopicSuggestionDecidedAudit.entry(suggestion.state.id, {
            before: { status: 'open' },
            after: {
              status: 'mapped',
              topicId: topicId.value,
              sellerId: suggestion.state.sellerId,
            },
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
