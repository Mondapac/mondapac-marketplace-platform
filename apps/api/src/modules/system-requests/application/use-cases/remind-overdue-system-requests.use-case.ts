import type { CallContext } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  remindOverdue,
  type OverdueReminderDependencies,
  type OverdueReminderResult,
} from '../overdue-reminder-flow';

type Input = Record<string, never>;

/**
 * `system-requests.remind-overdue-system-requests` (rule `system`, run by the worker job for each
 * hosted Market): writes the overdue reminders of the Market that are due today.
 */
export class RemindOverdueSystemRequests extends UseCase<
  Input,
  OverdueReminderResult,
  { readonly code: 'access.denied' }
> {
  static override readonly access: AccessDeclaration = {
    name: 'system-requests.remind-overdue-system-requests',
    rule: { kind: 'system' },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OverdueReminderDependencies,
  ) {
    super(gate);
  }

  protected handle(context: CallContext) {
    return remindOverdue(this.deps, context);
  }
}
