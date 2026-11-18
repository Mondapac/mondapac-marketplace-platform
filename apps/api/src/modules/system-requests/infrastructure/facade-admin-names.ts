import { Logger } from '@nestjs/common';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { IdentityFacade } from '../../identity';
import type { AdminNames } from '../application/ports/admin-names';

/** identity's batch limit. */
const MAX_ID_BATCH = 100;

/**
 * {@link AdminNames} over identity's public facade (`changeActors`): an admin asking gets the
 * display name of each admin account. No table of identity is read here. A refusal or a throw is
 * not an error of the page: the queue is shown without names (and a decision that has committed
 * never turns into an error because a name could not be read).
 */
export class FacadeAdminNames implements AdminNames {
  readonly #logger = new Logger('SystemRequestsAdminNames');

  constructor(private readonly identity: IdentityFacade) {}

  async namesOf(
    context: CallContext,
    accountIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const requested = [...new Set(accountIds)];
    const names = new Map<string, string>();
    for (let start = 0; start < requested.length; start += MAX_ID_BATCH) {
      const batch = requested.slice(start, start + MAX_ID_BATCH) as Id<'Account'>[];
      let answer: Awaited<ReturnType<IdentityFacade['changeActors']>>;
      try {
        answer = await this.identity.changeActors(context, batch);
      } catch (error) {
        // Only the kind of failure and a count: never an id or a name.
        this.#logger.warn({
          msg: 'system-requests.admin-names-unavailable',
          error: error instanceof Error ? error.name : 'unknown',
          requested: requested.length,
          marketId: context.market.marketId,
          correlationId: context.correlationId,
        });
        return new Map();
      }
      if (!answer.ok) return new Map();
      for (const label of answer.value) {
        if (typeof label.displayName === 'string' && label.displayName.length > 0) {
          names.set(label.accountId, label.displayName);
        }
      }
    }
    return names;
  }
}
