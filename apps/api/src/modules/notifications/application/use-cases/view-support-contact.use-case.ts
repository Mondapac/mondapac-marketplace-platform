import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { NOTIFICATIONS_SUPPORT_CONTACT_VIEW } from '../../contracts/permissions';
import type { NotificationsDependencies } from '../notifications-dependencies';
import {
  viewSupportContact,
  type SupportContactFailure,
  type SupportContactView,
} from '../support-contact-flow';

/** `notifications.view-support-contact`: an admin reads the Market's support email. */
export class ViewSupportContact extends UseCase<
  Record<string, never>,
  SupportContactView,
  SupportContactFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.view-support-contact',
    rule: { kind: 'permissions', allOf: [NOTIFICATIONS_SUPPORT_CONTACT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: NotificationsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewSupportContact(this.deps, context);
  }
}
