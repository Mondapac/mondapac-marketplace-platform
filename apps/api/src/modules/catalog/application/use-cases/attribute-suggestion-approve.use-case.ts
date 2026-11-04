import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, IdGenerator, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_SUGGESTION_DECIDE } from '../../contracts/permissions';
import type { LocalizedText } from '../../domain/attribute-definition';
import {
  AttributeDefinitionRevisedAudit,
  AttributeValueSuggestionDecidedAudit,
} from '../../domain/audit';
import {
  auditShapeOf,
  closedInput,
  codeFrom,
  domainFailureOf,
  freeCode,
  invalid,
  refuseClaimContent,
  type AttributeWriteFailure,
  type DomainFailure,
  type EditorContent,
  type ValidationFailure,
} from '../attributes/attribute-editor';
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
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';

export interface AttributeSuggestionApproveDependencies extends SuggestionDecideDependencies {
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
  readonly ids: IdGenerator;
}

export interface AttributeSuggestionApproveInput {
  readonly [key: string]: unknown;
}

export type AttributeSuggestionApproveFailure =
  SuggestionDecisionFailure | AttributeWriteFailure | DomainFailure;

const KEYS = ['suggestionId', 'version', 'labels', 'optionCode'] as const;
const LABEL_INPUT_MAX = 300;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/;

/** The labels of the new value: only the Market's locales, text only, blanks left out. */
function labelsOf(
  raw: unknown,
  supported: readonly string[],
): Result<LocalizedText, ValidationFailure> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return invalid('labels', 'type');
  const out: Record<string, string> = {};
  for (const [locale, text] of Object.entries(raw as Record<string, unknown>)) {
    if (!supported.includes(locale)) return invalid(`labels.${locale.slice(0, 16)}`, 'unsupported');
    if (typeof text !== 'string') return invalid(`labels.${locale}`, 'type');
    if ([...text].length > LABEL_INPUT_MAX) return invalid(`labels.${locale}`, 'too-long');
    if (text.trim() === '') continue;
    out[locale] = text;
  }
  return ok(out);
}

/**
 * `attribute-suggestion.approve` (attributes plan, package A5): an admin adds the suggested value
 * to the attribute, with its label in each required language, and the suggestion is closed as
 * approved. Rule: the key `catalog.attribute-suggestion.decide` (the Catalogue Moderator) and the
 * admin population; never in an acting-as session. The request names the version the admin saw
 * (`suggestion.stale` when it moved). The labels are the admin's, not the seller's text; they pass
 * the claim-text check, fail closed, with no override. In one unit: the attribute's next revision
 * (the value added last, active; audited as a revision), the decision, and the decision's audit.
 * The seller is told by one mail afterwards. Nothing is written to the product: the seller picks
 * the value themselves.
 */
export class AttributeSuggestionApprove extends UseCase<
  AttributeSuggestionApproveInput,
  { readonly suggestion: SuggestionDecisionView },
  AttributeSuggestionApproveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-suggestion-approve',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_SUGGESTION_DECIDE.key] },
  };

  readonly #logger = new Logger('AttributeSuggestionApprove');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeSuggestionApproveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeSuggestionApproveInput,
  ): Promise<
    Result<{ readonly suggestion: SuggestionDecisionView }, AttributeSuggestionApproveFailure>
  > {
    const result = await this.#approve(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-suggestion-approve',
      code: result.ok ? 'approved' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #approve(
    context: CallContext,
    input: AttributeSuggestionApproveInput,
  ): Promise<
    Result<{ readonly suggestion: SuggestionDecisionView }, AttributeSuggestionApproveFailure>
  > {
    const accountId = deciderOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, KEYS);
    if (!body.ok) return body;
    const id = suggestionIdOf(body.value['suggestionId']);
    if (id === null) return err({ code: 'suggestion.not-found' });
    const version = suggestionVersionOf(body.value['version']);
    if (!version.ok) return version;
    const { market } = context;
    let locales: { readonly default: string; readonly supported: readonly string[] };
    try {
      locales = this.deps.policy.locales(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const labels = labelsOf(body.value['labels'], locales.supported);
    if (!labels.ok) return labels;
    const rawCode = body.value['optionCode'];
    if (
      rawCode !== undefined &&
      rawCode !== null &&
      (typeof rawCode !== 'string' || !CODE.test(rawCode))
    ) {
      return invalid('optionCode', 'format');
    }
    // The default-locale label is required (the domain repeats it); named here so the form can
    // mark the field before any check runs.
    if (labels.value[locales.default] === undefined) {
      return err({
        code: 'attribute-definition.default-label-required',
        fields: [{ path: `labels.${locales.default}`, code: 'required' }],
      });
    }
    const requested = typeof rawCode === 'string' ? rawCode : null;

    // The claim check runs before the unit opens: the certification facade opens its own.
    const content: EditorContent = {
      names: {},
      material: false,
      isVariantOption: false,
      bounds: {},
      options: [
        { code: requested ?? 'new-value', labels: labels.value, active: true, position: 0 },
      ],
      display: {
        helpText: {},
        showOnProductPage: true,
        searchable: false,
        canBeFilter: false,
        internalNote: null,
        position: 0,
      },
    };
    const claim = await refuseClaimContent(this.deps, context, content);
    if (claim !== null) return err(claim);

    try {
      return await this.deps.unitOfWork.run<
        { readonly suggestion: SuggestionDecisionView },
        AttributeSuggestionApproveFailure
      >(market, async () => {
        const { attributeStore, suggestions } = this.deps;
        const loaded = await loadOpenSuggestion(this.deps, market, id, version.value);
        if (!loaded.ok) return err(loaded.error);
        const { suggestion, definition } = loaded.value;
        const taken = new Set(definition.state.options.map((option) => option.code));
        const code = requested ?? freeCode(codeFrom(labels.value[locales.default] ?? ''), taken);
        if (code === null) return err(domainCodeFailure());
        const now = this.deps.clock.now();
        const next = definition.addOption({
          revisionId: this.deps.ids.next<'AttributeDefinitionRevision'>(),
          code,
          labels: labels.value,
          now,
        });
        if (!next.ok) return err(domainFailureOf(next.error));
        const decided = suggestion.approve({ accountId, optionCode: code, now });
        if (!decided.ok) return err(decided.error);
        await attributeStore.saveRevision(market, next.value, accountId);
        await suggestions.saveDecision(market, decided.value);
        await this.deps.audit.record(
          context,
          AttributeDefinitionRevisedAudit.entry(definition.state.id, {
            before: auditShapeOf(definition),
            after: {
              ...auditShapeOf(next.value),
              relaxationRequestId: null,
              requestedByAccountId: null,
            },
          }),
        );
        await this.deps.audit.record(
          context,
          AttributeValueSuggestionDecidedAudit.entry(suggestion.state.id, {
            before: { status: 'open' },
            after: {
              status: 'approved',
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

/** No code could be derived from the label (another script): the admin names one. */
function domainCodeFailure(): ValidationFailure {
  return {
    code: 'validation.failed',
    fields: [{ path: 'optionCode', code: 'required' }],
  };
}
