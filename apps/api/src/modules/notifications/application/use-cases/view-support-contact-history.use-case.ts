import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type {
  ChangeHistoryFailure,
  ChangeHistoryInput,
  ChangeHistoryPage,
} from '../../../../platform/audit/change-trail';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { NOTIFICATIONS_SUPPORT_CONTACT_VIEW } from '../../contracts/permissions';
import type { NotificationsDependencies } from '../notifications-dependencies';
import { SUPPORT_CONTACT_CHANGES } from '../support-contact-flow';

/**
 * `notifications.view-support-contact-history`: the changes of the Market's support email, newest
 * first, from the `notifications.support-contact.changed` audit rows: when, who (a display name)
 * and the field names that changed. Never the addresses. Same gate as the page it explains.
 */
export class ViewSupportContactHistory extends UseCase<
  ChangeHistoryInput,
  ChangeHistoryPage,
  ChangeHistoryFailure | { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.view-support-contact-history',
    rule: { kind: 'permissions', allOf: [NOTIFICATIONS_SUPPORT_CONTACT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: NotificationsDependencies,
  ) {
    super(gate);
  }

  protected handle(
    context: CallContext,
    input: ChangeHistoryInput,
  ): Promise<Result<ChangeHistoryPage, ChangeHistoryFailure | { readonly code: 'access.denied' }>> {
    // As the page it explains: an admin session only, whatever keys another population holds.
    if (context.actor.kind !== 'authenticated' || context.actor.population !== 'admin') {
      return Promise.resolve(err({ code: 'access.denied' } as const));
    }
    return this.deps.trail.history(context, SUPPORT_CONTACT_CHANGES, input ?? {});
  }
}
