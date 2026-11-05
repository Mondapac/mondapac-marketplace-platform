import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { NOTIFICATIONS_SUPPORT_CONTACT_VIEW } from '../../contracts/permissions';
import type { NotificationsDependencies } from '../notifications-dependencies';
import {
  SUPPORT_CONTACT_CHANGES,
  viewSupportContact,
  type SupportContactFailure,
  type SupportContactPage,
} from '../support-contact-flow';

/** `notifications.view-support-contact`: an admin reads the Market's support email. */
export class ViewSupportContact extends UseCase<
  Record<string, never>,
  SupportContactPage,
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

  protected async handle(
    context: CallContext,
  ): Promise<Result<SupportContactPage, SupportContactFailure>> {
    const view = await viewSupportContact(this.deps, context);
    if (!view.ok) return view;
    const lastChanged = await this.deps.trail.lastChanged(context, SUPPORT_CONTACT_CHANGES);
    return ok({ ...view.value, lastChanged });
  }
}
