import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AttributeDefinition } from '../../domain/attribute-definition';
import type {
  AttributeValueSuggestion,
  SuggestionRefusal,
} from '../../domain/attribute-value-suggestion';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { AttributeValueSuggestionStore } from '../ports/attribute-value-suggestion.store';
import { editorAccountOf, invalid, type ValidationFailure } from './attribute-editor';

// What the use cases of the value suggestions share (attributes plan, package A5): the id of a
// suggestion from a request, the admin of a decision, the refusals every decision has, and the
// check that a definition may take a seller's suggestion at all.

/** The refusals of a decision on a suggestion, besides access and the shape of the request. */
export type SuggestionDecisionFailure =
  | SuggestionRefusal
  | { readonly code: 'suggestion.not-found' }
  | { readonly code: 'suggestion.stale' }
  | { readonly code: 'suggestion.attribute-unavailable' }
  | { readonly code: 'suggestion.attribute-protected' };

export function suggestionIdOf(raw: unknown): Id<'AttributeValueSuggestion'> | null {
  const parsed = typeof raw === 'string' ? parseId<'AttributeValueSuggestion'>(raw) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/** The version the admin saw, as a suggestion version. */
export function suggestionVersionOf(raw: unknown): Result<number, ValidationFailure> {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 2_147_483_647) {
    return invalid('version', 'type');
  }
  return ok(raw);
}

/** The admin who decides: an authenticated admin, never in an acting-as session. */
export const deciderOf = editorAccountOf;

/**
 * Whether a published definition takes values from sellers: a select or multi-select that is not
 * `material`. A variant option (colour, size) takes them too (john, 5 Nov 2026), so a seller can
 * ask for the option a variant needs; an approved value is a new option like any other.
 */
export function takesSellerValues(definition: AttributeDefinition): boolean {
  const state = definition.state;
  return (
    state.status === 'active' &&
    (state.dataType === 'select' || state.dataType === 'multi-select') &&
    !state.material
  );
}

/**
 * The open suggestion of the request and the published definition it is about, read in the open
 * unit. A missing or other-Market suggestion is `suggestion.not-found`; one that changed since the
 * admin saw it is `suggestion.stale`; one decided before is `suggestion.not-open`. A definition
 * that no longer takes seller values (archived, turned `material`) is refused, so a decision never
 * changes a protected attribute.
 */
export async function loadOpenSuggestion(
  deps: {
    readonly suggestions: AttributeValueSuggestionStore;
    readonly attributeStore: AttributeDefinitionStore;
  },
  market: MarketContext,
  id: Id<'AttributeValueSuggestion'>,
  version: number,
): Promise<
  Result<
    { readonly suggestion: AttributeValueSuggestion; readonly definition: AttributeDefinition },
    SuggestionDecisionFailure
  >
> {
  const suggestion = await deps.suggestions.findById(market, id);
  if (suggestion === null) return err({ code: 'suggestion.not-found' });
  if (suggestion.state.version !== version) return err({ code: 'suggestion.stale' });
  if (suggestion.state.status !== 'open') return err({ code: 'suggestion.not-open' });
  const definition = await deps.attributeStore.findById(market, suggestion.state.definitionId);
  if (definition === null) return err({ code: 'suggestion.attribute-unavailable' });
  if (definition.state.material) return err({ code: 'suggestion.attribute-protected' });
  if (!takesSellerValues(definition)) return err({ code: 'suggestion.attribute-unavailable' });
  return ok({ suggestion, definition });
}

/** What a decision answers: the new state of the suggestion. */
export interface SuggestionDecisionView {
  readonly id: string;
  readonly status: 'approved' | 'mapped' | 'rejected';
  readonly version: number;
  readonly optionCode: string | null;
}

export function decisionViewOf(suggestion: AttributeValueSuggestion): SuggestionDecisionView {
  const { id, status, version, optionCode } = suggestion.state;
  if (status === 'open') throw new Error('decisionViewOf: the suggestion is still open');
  return { id, status, version, optionCode };
}

export type { CallContext };

/** What every decision on a suggestion reads and writes. */
export interface SuggestionDecideDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributeStore: AttributeDefinitionStore;
  readonly suggestions: AttributeValueSuggestionStore;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}
