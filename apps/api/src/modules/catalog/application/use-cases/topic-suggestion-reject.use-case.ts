import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_TOPIC_SUGGESTION_REVIEW } from '../../contracts/permissions';
import { TopicSuggestionDecidedAudit } from '../../domain/audit';
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
import { closedInput, invalid, type ValidationFailure } from '../topics/topic-views';

export interface TopicSuggestionRejectInput {
  readonly [key: string]: unknown;
}

export type TopicSuggestionRejectFailure =
  SuggestionDecisionFailure | { readonly code: 'access.denied' } | ValidationFailure;

/**
 * `topic-suggestion.reject` (product tags package T5): an admin closes a suggestion with the words
 * the seller will read. Rule: the key `catalog.topic-suggestion.review`, the admin population, no
 * acting-as session; the request names the version the admin saw. The reason is kept on the
 * suggestion and never in the audit row. One audit row; the seller is told by one mail afterwards.
 */
export class TopicSuggestionReject extends UseCase<
  TopicSuggestionRejectInput,
  { readonly suggestion: SuggestionDecisionView },
  TopicSuggestionRejectFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.topic-suggestion-reject',
    rule: { kind: 'permissions', allOf: [CATALOG_TOPIC_SUGGESTION_REVIEW.key] },
  };

  readonly #logger = new Logger('TopicSuggestionReject');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SuggestionDecideDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TopicSuggestionRejectInput,
  ): Promise<
    Result<{ readonly suggestion: SuggestionDecisionView }, TopicSuggestionRejectFailure>
  > {
    const result = await this.#reject(context, input);
    this.#logger.log({
      msg: 'catalog.topic-suggestion-reject',
      code: result.ok ? 'rejected' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #reject(
    context: CallContext,
    input: TopicSuggestionRejectInput,
  ): Promise<
    Result<{ readonly suggestion: SuggestionDecisionView }, TopicSuggestionRejectFailure>
  > {
    const accountId = deciderOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['suggestionId', 'version', 'reason']);
    if (!body.ok) return body;
    const id = suggestionIdOf(body.value['suggestionId']);
    if (id === null) return err({ code: 'suggestion.not-found' });
    const version = suggestionVersionOf(body.value['version']);
    if (!version.ok) return version;
    const reason = body.value['reason'];
    if (typeof reason !== 'string' || [...reason].length > 1000) return invalid('reason', 'type');
    const { market } = context;
    try {
      return await this.deps.unitOfWork.run<
        { readonly suggestion: SuggestionDecisionView },
        TopicSuggestionRejectFailure
      >(market, async () => {
        const loaded = await loadOpenSuggestion(
          this.deps.topicSuggestions,
          market,
          id,
          version.value,
        );
        if (!loaded.ok) return err(loaded.error);
        const suggestion = loaded.value;
        const decided = suggestion.reject({ accountId, reason, now: this.deps.clock.now() });
        if (!decided.ok) return err(decided.error);
        await this.deps.topicSuggestions.saveDecision(market, decided.value);
        await this.deps.audit.record(
          context,
          TopicSuggestionDecidedAudit.entry(suggestion.state.id, {
            before: { status: 'open' },
            after: { status: 'rejected', topicId: null, sellerId: suggestion.state.sellerId },
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
