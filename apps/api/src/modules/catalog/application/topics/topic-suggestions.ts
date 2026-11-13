import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SuggestionRefusal, TopicSuggestion } from '../../domain/topic-suggestion';
import type { TopicSuggestionStore } from '../ports/topic-suggestion.store';
import { isActingAsSession } from '../acting-as';
import { adminAccountOf, invalid, type ValidationFailure } from './topic-views';

// What the use cases of the tag suggestions share (product tags package T5): the id of a
// suggestion from a request, the admin of a decision, the refusals every decision has, and the
// load of the open suggestion a decision is about.

/** The refusals of a decision on a suggestion, besides access and the shape of the request. */
export type SuggestionDecisionFailure =
  | SuggestionRefusal
  | { readonly code: 'suggestion.not-found' }
  | { readonly code: 'suggestion.stale' };

export function suggestionIdOf(raw: unknown): Id<'TopicSuggestion'> | null {
  const parsed = typeof raw === 'string' ? parseId<'TopicSuggestion'>(raw) : null;
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
export function deciderOf(context: CallContext): Id<'Account'> | null {
  const account = adminAccountOf(context);
  return account === null || isActingAsSession(context.actor) ? null : account;
}

/**
 * The open suggestion of the request, read in the open unit. A missing or other-Market suggestion
 * is `suggestion.not-found`; one that changed since the admin saw it is `suggestion.stale`; one
 * decided before is `suggestion.not-open`.
 */
export async function loadOpenSuggestion(
  suggestions: TopicSuggestionStore,
  market: MarketContext,
  id: Id<'TopicSuggestion'>,
  version: number,
): Promise<Result<TopicSuggestion, SuggestionDecisionFailure>> {
  const suggestion = await suggestions.findById(market, id);
  if (suggestion === null) return err({ code: 'suggestion.not-found' });
  if (suggestion.state.version !== version) return err({ code: 'suggestion.stale' });
  if (suggestion.state.status !== 'open') return err({ code: 'suggestion.not-open' });
  return ok(suggestion);
}

/** What a decision answers: the new state of the suggestion. */
export interface SuggestionDecisionView {
  readonly id: string;
  readonly status: 'approved' | 'mapped' | 'rejected';
  readonly version: number;
  readonly topicId: string | null;
}

export function decisionViewOf(suggestion: TopicSuggestion): SuggestionDecisionView {
  const { id, status, version, topicId } = suggestion.state;
  if (status === 'open') throw new Error('decisionViewOf: the suggestion is still open');
  return { id, status, version, topicId };
}

/** What a decision that creates no topic reads and writes. */
export interface SuggestionDecideDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly topicSuggestions: TopicSuggestionStore;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}
