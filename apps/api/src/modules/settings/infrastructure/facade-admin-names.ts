import { Logger } from '@nestjs/common';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { IdentityFacade } from '../../identity';
import type { AdminNames } from '../application/ports/admin-names';

/**
 * {@link AdminNames} over identity's `changeActors` (an admin asking gets each admin's display
 * name). A refusal or a throw answers no names: the banner then shows no name, never an error.
 */
export class FacadeAdminNames implements AdminNames {
  readonly #logger = new Logger('SettingsAdminNames');

  constructor(private readonly identity: IdentityFacade) {}

  async namesOf(
    context: CallContext,
    accountIds: readonly string[],
  ): Promise<ReadonlyMap<string, string>> {
    const requested = [...new Set(accountIds)].slice(0, 100) as Id<'Account'>[];
    if (requested.length === 0) return new Map();
    try {
      const answer = await this.identity.changeActors(context, requested);
      if (!answer.ok) return new Map();
      return new Map(
        answer.value
          .filter((label) => typeof label.displayName === 'string' && label.displayName !== '')
          .map((label) => [label.accountId, label.displayName as string]),
      );
    } catch (error) {
      this.#logger.warn({
        msg: 'admin names unavailable',
        error: error instanceof Error ? error.name : 'unknown',
      });
      return new Map();
    }
  }
}
