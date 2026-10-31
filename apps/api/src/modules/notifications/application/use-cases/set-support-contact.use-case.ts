import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { NOTIFICATIONS_SUPPORT_CONTACT_MANAGE } from '../../contracts/permissions';
import type { NotificationsDependencies } from '../notifications-dependencies';
import {
  SUPPORT_CONTACT_CHANGES,
  setSupportContact,
  type SupportContactFailure,
  type SupportContactPage,
} from '../support-contact-flow';

interface Input {
  readonly email: unknown;
  readonly expectedVersion: unknown;
}

/** `notifications.set-support-contact`: an admin changes the Market's support email (protected key). */
export class SetSupportContact extends UseCase<Input, SupportContactPage, SupportContactFailure> {
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

  protected async handle(
    context: CallContext,
    input: Input,
  ): Promise<Result<SupportContactPage, SupportContactFailure>> {
    const result = await setSupportContact(this.deps, context, input);
    if (result.ok || result.error.code === 'notifications.conflict') {
      // The latest change is the save just made or, on a conflict, the winning one.
      const lastChanged = await this.deps.trail.lastChanged(context, SUPPORT_CONTACT_CHANGES);
      return result.ok
        ? ok({ ...result.value, lastChanged })
        : err({ code: 'notifications.conflict', lastChanged });
    }
    return result;
  }
}
