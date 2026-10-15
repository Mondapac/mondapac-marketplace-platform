import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { NotificationsDependencies } from '../notifications-dependencies';
import { viewPublicSupportContact, type PublicSupportContact } from '../support-contact-flow';

/**
 * `notifications.view-public-support-contact`: the sign-in pages show the Market's support email
 * to a visitor who has no session. It answers the address only, never the version.
 */
export class ViewPublicSupportContact extends UseCase<
  Record<string, never>,
  PublicSupportContact,
  never
> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.view-public-support-contact',
    rule: { kind: 'anonymous' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: NotificationsDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return viewPublicSupportContact(this.deps, context);
  }
}
