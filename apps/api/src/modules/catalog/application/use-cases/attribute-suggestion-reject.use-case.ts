import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_SUGGESTION_DECIDE } from '../../contracts/permissions';
import { AttributeValueSuggestionDecidedAudit } from '../../domain/audit';
import { closedInput, invalid, type ValidationFailure } from '../attributes/attribute-editor';
import {
  decisionViewOf,
  deciderOf,
  loadOpenSuggestion,
  suggestionIdOf,
  suggestionVersionOf,
  type SuggestionDecideDependencies,
  type SuggestionDecisionFailure,
  type SuggestionDecisionView,
} from '../attributes/attribute-suggestions';

export interface AttributeSuggestionRejectInput {
  readonly [key: string]: unknown;
}

export type AttributeSuggestionRejectFailure =
  SuggestionDecisionFailure | { readonly code: 'access.denied' } | ValidationFailure;

/**
 * `attribute-suggestion.reject` (attributes plan, package A5): an admin closes a suggestion by
 * pointing it at a value the attribute already has. The value must exist and be active. Rule: the
 * key `catalog.attribute-suggestion.decide`, the admin population, no acting-as session; the
 * request names the version the admin saw. No attribute revision is written; the reason is kept on the suggestion and never in the audit row. One audit row; the
 * seller is told by one mail afterwards.
 */
export class AttributeSuggestionReject extends UseCase<
  AttributeSuggestionRejectInput,
  { readonly suggestion: SuggestionDecisionView },
  AttributeSuggestionRejectFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-suggestion-reject',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_SUGGESTION_DECIDE.key] },
  };

  readonly #logger = new Logger('AttributeSuggestionReject');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SuggestionDecideDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeSuggestionRejectInput,
  ): Promise<
    Result<{ readonly suggestion: SuggestionDecisionView }, AttributeSuggestionRejectFailure>
  > {
    const result = await this.#reject(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-suggestion-reject',
      code: result.ok ? 'rejected' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #reject(
    context: CallContext,
    input: AttributeSuggestionRejectInput,
  ): Promise<
    Result<{ readonly suggestion: SuggestionDecisionView }, AttributeSuggestionRejectFailure>
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
        AttributeSuggestionRejectFailure
      >(market, async () => {
        const loaded = await loadOpenSuggestion(this.deps, market, id, version.value);
        if (!loaded.ok) return err(loaded.error);
        const { suggestion, definition } = loaded.value;
        const decided = suggestion.reject({
          accountId,
          reason,
          now: this.deps.clock.now(),
        });
        if (!decided.ok) return err(decided.error);
        await this.deps.suggestions.saveDecision(market, decided.value);
        await this.deps.audit.record(
          context,
          AttributeValueSuggestionDecidedAudit.entry(suggestion.state.id, {
            before: { status: 'open' },
            after: {
              status: 'rejected',
              definitionId: definition.state.id,
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
