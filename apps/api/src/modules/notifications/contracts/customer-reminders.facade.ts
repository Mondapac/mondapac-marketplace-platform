import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** One abandoned-cart reminder stage taken for a customer: no mail content, no address. */
export interface AdminCartReminderSent {
  /** The cart change the reminder was about. */
  readonly cartChangedAt: string;
  /** 1 (about 4 hours idle) or 2 (about 24 hours). */
  readonly stage: 1 | 2;
  /**
   * When notifications took the stage for sending (`cart_reminders.taken_at`), not proof of
   * delivery: the claim stays when the send then failed or was skipped (no consent, no address,
   * unsubscribe or contact not configured), so the stage is never retried.
   */
  readonly sentAt: string;
}

export interface AdminCartRemindersRequest {
  readonly accountId: Id<'Account'>;
  readonly direction: 'asc' | 'desc';
  readonly window: { readonly offset: number; readonly limit: number };
  readonly withTotal: boolean;
}

/**
 * The admin's read of the reminders notifications sent one customer (customers management phase
 * 2b). Rule `permissions [notifications.customer-cart-reminder.view]`, a platform admin not acting
 * as anyone. The record is kept 30 days. notifications keeps no other per-account log of the mail
 * it sent.
 */
export interface CustomerRemindersFacade {
  adminCustomerCartReminders(
    context: CallContext,
    request: AdminCartRemindersRequest,
  ): Promise<
    Result<
      { readonly rows: readonly AdminCartReminderSent[]; readonly total: number | null },
      AccessDenied | { readonly code: 'access.unavailable' }
    >
  >;
}

/** Nest token of the {@link CustomerRemindersFacade}, provided and exported by `NotificationsModule`. */
export const CUSTOMER_REMINDERS_FACADE = Symbol('CUSTOMER_REMINDERS_FACADE');
