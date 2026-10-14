import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { NOTIFICATIONS_SUPPORT_CONTACT_MANAGE } from '../../contracts/permissions';
import type { NotificationsDependencies } from '../notifications-dependencies';
import {
  setSupportContact,
  type SupportContactFailure,
  type SupportContactView,
} from '../support-contact-flow';

interface Input {
  readonly email: unknown;
}

/** `notifications.set-support-contact`: an admin changes the Market's support email (protected key). */
export class SetSupportContact extends UseCase<Input, SupportContactView, SupportContactFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.set-support-contact',
    rule: { kind: 'permissions', allOf: [NOTIFICATIONS_SUPPORT_CONTACT_MANAGE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: NotificationsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext, input: Input) {
    return setSupportContact(this.deps, context, input);
  }
}
