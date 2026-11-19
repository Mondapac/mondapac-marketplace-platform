import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_TOPIC_SUGGESTION_REVIEW } from '../../contracts/permissions';
import { TOPIC_GROUPS } from '../../domain/topic';
import { parseBulkItems, runBulkDecide } from '../lists/bulk-decide';
import type { TopicSuggestionApprove } from './topic-suggestion-approve.use-case';
import type { TopicSuggestionReject } from './topic-suggestion-reject.use-case';
import {
  adminOnly,
  closed,
  refuse,
  type BulkDecideOutput,
  type BulkDecideRefusal,
} from '../lists/bulk-decide-shared';

export interface TopicSuggestionBulkDecideDependencies {
  readonly topicApprove: TopicSuggestionApprove;
  readonly topicReject: TopicSuggestionReject;
}

/**
 * `topic-suggestion.bulk-decide`: create the tags as the sellers wrote them in one group (name and
 * slug as the single approval derives them), or reject with one reason, up to 50 suggestions.
 */
export class TopicSuggestionBulkDecide extends UseCase<
  unknown,
  BulkDecideOutput,
  BulkDecideRefusal
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.topic-suggestion-bulk-decide',
    rule: { kind: 'permissions', allOf: [CATALOG_TOPIC_SUGGESTION_REVIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TopicSuggestionBulkDecideDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<BulkDecideOutput, BulkDecideRefusal>> {
    if (!adminOnly(context)) return err({ code: 'access.denied' });
    const body = closed(input, ['action', 'items', 'reason', 'group']);
    if (!body.ok) return body;
    const items = parseBulkItems(body.value['items']);
    if (!items.ok) return items;
    const action = body.value['action'];
    if (action === 'approve') {
      if (body.value['reason'] !== undefined) return refuse('reason', 'unknown');
      const group = body.value['group'];
      if (typeof group !== 'string') return refuse('group', 'required');
      if (!(TOPIC_GROUPS as readonly string[]).includes(group)) return refuse('group', 'value');
      const done = await runBulkDecide(items.value, (item) =>
        this.deps.topicApprove.execute(context, {
          suggestionId: item.id,
          version: item.version,
          group,
        }),
      );
      return ok({ action, ...done });
    }
    if (action === 'reject') {
      if (body.value['group'] !== undefined) return refuse('group', 'unknown');
      const reason = body.value['reason'];
      if (typeof reason !== 'string' || reason.trim() === '') return refuse('reason', 'required');
      const done = await runBulkDecide(items.value, (item) =>
        this.deps.topicReject.execute(context, {
          suggestionId: item.id,
          version: item.version,
          reason,
        }),
      );
      return ok({ action, ...done });
    }
    return refuse('action', 'value');
  }
}
