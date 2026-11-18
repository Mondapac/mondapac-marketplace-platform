import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  isPlatformAdminActor,
  UseCase,
  type AccessDeclaration,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type {
  AdminCartReminderSent,
  AdminCartRemindersRequest,
} from '../../contracts/customer-reminders.facade';
import { NOTIFICATIONS_CUSTOMER_CART_REMINDER_VIEW } from '../../contracts/permissions';
import type { CartReminderRepository } from '../ports/cart-reminder.repository';

type Page = { readonly rows: readonly AdminCartReminderSent[]; readonly total: number | null };
type Failure = { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface AdminCartRemindersDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly reminders: Pick<CartReminderRepository, 'pageOfAccount' | 'countOfAccount'>;
}

/**
 * `notifications.admin-customer-cart-reminders`: one page of the abandoned-cart reminders sent to
 * one customer (customers management phase 2b; the rows are kept 30 days). Rule `permissions
 * [notifications.customer-cart-reminder.view]` and a platform admin not acting as anyone. Facade
 * only.
 */
export class AdminCustomerCartReminders extends UseCase<AdminCartRemindersRequest, Page, Failure> {
  static override readonly access: AccessDeclaration = {
    name: 'notifications.admin-customer-cart-reminders',
    rule: { kind: 'permissions', allOf: [NOTIFICATIONS_CUSTOMER_CART_REMINDER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminCartRemindersDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminCartRemindersRequest,
  ): Promise<Result<Page, Failure>> {
    if (!isPlatformAdminActor(context.actor)) {
      return err({ code: 'access.denied' });
    }
    const window = {
      offset: Math.max(input.window.offset, 0),
      limit: Math.min(Math.max(input.window.limit, 0), 10_001),
    };
    const read = await this.deps.unitOfWork.run(
      context.market,
      async () => {
        const [rows, total] = await Promise.all([
          this.deps.reminders.pageOfAccount(
            context.market,
            input.accountId,
            input.direction,
            window,
          ),
          input.withTotal
            ? this.deps.reminders.countOfAccount(context.market, input.accountId)
            : Promise.resolve(null),
        ]);
        return ok({ rows, total });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    return ok({
      rows: read.value.rows.map((row) => ({
        cartChangedAt: row.cartChangedAt.toString(),
        stage: row.stage,
        sentAt: row.takenAt.toString(),
      })),
      total: read.value.total,
    });
  }
}
