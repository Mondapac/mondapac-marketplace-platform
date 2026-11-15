import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { IdentityFacade } from '../../identity';
import type { AdminNames } from '../application/ports/admin-names';

/** identity's batch limit. */
const MAX_ID_BATCH = 100;

/**
 * {@link AdminNames} over identity's `changeActors`: an admin asking gets the display name of each
 * admin account. The caller's `CallContext` goes through unchanged. A refusal is not an error of
 * the page: the alert is shown without names.
 */
export class FacadeAdminNames implements AdminNames {
  constructor(private readonly identity: IdentityFacade) {}

  async namesOf(
    context: CallContext,
    accountIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const requested = [...new Set(accountIds)];
    const names = new Map<string, string>();
    for (let start = 0; start < requested.length; start += MAX_ID_BATCH) {
      const batch = requested.slice(start, start + MAX_ID_BATCH) as Id<'Account'>[];
      const answer = await this.identity.changeActors(context, batch);
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
