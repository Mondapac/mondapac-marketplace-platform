import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { DEFAULT_ASSISTANT_SETTINGS } from '../../domain/assistant-settings';
import { retentionDaysOf } from '../../domain/conversation';
import type { AssistantDependencies } from '../assistant-dependencies';

/** Conversations one unit deletes at most, and units one run takes at most. */
export const PURGE_BATCH_SIZE = 200;
export const MAX_PURGE_BATCHES_PER_RUN = 20;

export type PurgeConversationsFailure =
  { readonly code: 'access.denied' } | { readonly code: 'assistant.purge-failed' };

/**
 * `assistant.purge-conversations`: the nightly purge of plan section 4 (rule `system`). A
 * conversation is deleted with its messages and its key once its last message is older than its
 * retention, or than the Market's current setting when that is shorter (plan section 11: a lower
 * setting shortens the next purge). Batches of 200, at most 20 per run; a failed batch makes the
 * run fail visibly.
 */
export class PurgeConversations extends UseCase<
  Record<string, never>,
  { readonly conversations: number },
  PurgeConversationsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'assistant.purge-conversations',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('PurgeConversations');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AssistantDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<{ readonly conversations: number }, PurgeConversationsFailure>> {
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { market } = context;
    const { unitOfWork, settings, conversations, clock } = this.deps;
    let purged = 0;
    try {
      const latest = await unitOfWork.run(
        market,
        async () => ok((await settings.latest(market))?.settings ?? DEFAULT_ASSISTANT_SETTINGS),
        { readOnly: true },
      );
      if (!latest.ok) throw new Error('settings unreadable');
      const currentDays = {
        customer: retentionDaysOf(latest.value.retention, 'customer'),
        guest: retentionDaysOf(latest.value.retention, 'guest'),
      };
      const now = clock.now();
      for (let batch = 0; batch < MAX_PURGE_BATCHES_PER_RUN; batch += 1) {
        const done = await unitOfWork.run(market, async () =>
          ok(await conversations.purgeExpired(market, now, currentDays, PURGE_BATCH_SIZE)),
        );
        if (!done.ok) throw new Error('purge batch failed');
        purged += done.value;
        if (done.value < PURGE_BATCH_SIZE) break;
      }
    } catch {
      this.#logger.warn({
        msg: 'assistant.purge-conversations.failed',
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'assistant.purge-failed' });
    }
    return ok({ conversations: purged });
  }
}
