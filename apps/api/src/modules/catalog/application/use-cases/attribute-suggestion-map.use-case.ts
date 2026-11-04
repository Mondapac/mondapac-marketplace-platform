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

export interface AttributeSuggestionMapInput {
  readonly [key: string]: unknown;
}

export type AttributeSuggestionMapFailure =
  SuggestionDecisionFailure | { readonly code: 'access.denied' } | ValidationFailure;

/**
 * `attribute-suggestion.map` (attributes plan, package A5): an admin closes a suggestion by
 * pointing it at a value the attribute already has. The value must exist and be active. Rule: the
 * key `catalog.attribute-suggestion.decide`, the admin population, no acting-as session; the
 * request names the version the admin saw. No attribute revision is written. One audit row; the
 * seller is told by one mail afterwards.
 */
export class AttributeSuggestionMap extends UseCase<
  AttributeSuggestionMapInput,
  { readonly suggestion: SuggestionDecisionView },
  AttributeSuggestionMapFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-suggestion-map',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_SUGGESTION_DECIDE.key] },
  };

  readonly #logger = new Logger('AttributeSuggestionMap');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SuggestionDecideDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeSuggestionMapInput,
  ): Promise<
    Result<{ readonly suggestion: SuggestionDecisionView }, AttributeSuggestionMapFailure>
  > {
    const result = await this.#map(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-suggestion-map',
      code: result.ok ? 'mapped' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #map(
    context: CallContext,
    input: AttributeSuggestionMapInput,
  ): Promise<
    Result<{ readonly suggestion: SuggestionDecisionView }, AttributeSuggestionMapFailure>
  > {
    const accountId = deciderOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['suggestionId', 'version', 'optionCode']);
    if (!body.ok) return body;
    const id = suggestionIdOf(body.value['suggestionId']);
    if (id === null) return err({ code: 'suggestion.not-found' });
    const version = suggestionVersionOf(body.value['version']);
    if (!version.ok) return version;
    const optionCode = body.value['optionCode'];
    if (typeof optionCode !== 'string' || optionCode === '') return invalid('optionCode', 'type');
    const { market } = context;
    try {
      return await this.deps.unitOfWork.run<
        { readonly suggestion: SuggestionDecisionView },
        AttributeSuggestionMapFailure
      >(market, async () => {
        const loaded = await loadOpenSuggestion(this.deps, market, id, version.value);
        if (!loaded.ok) return err(loaded.error);
        const { suggestion, definition } = loaded.value;
        if (!definition.state.options.some((o) => o.code === optionCode && o.active)) {
          return err({ code: 'suggestion.option-invalid' } as const);
        }
        const decided = suggestion.map({
          accountId,
          optionCode,
          now: this.deps.clock.now(),
        });
        if (!decided.ok) return err(decided.error);
        await this.deps.suggestions.saveDecision(market, decided.value);
        await this.deps.audit.record(
          context,
          AttributeValueSuggestionDecidedAudit.entry(suggestion.state.id, {
            before: { status: 'open' },
            after: {
              status: 'mapped',
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
