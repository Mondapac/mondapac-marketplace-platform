import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';

/** One conversation as the customer page shows it: its dates only, never a message. */
export interface AdminConversationDates {
  /** ISO instants. */
  readonly startedAt: string;
  readonly lastMessageAt: string;
}

export interface AdminConversationsRequest {
  readonly accountId: Id<'Account'>;
  readonly direction: 'asc' | 'desc';
  readonly window: { readonly offset: number; readonly limit: number };
}

export type CustomerConversationsFailure = AccessDenied | { readonly code: 'access.unavailable' };

/**
 * The admin's read of one customer's assistant conversations (customers management phase 2b):
 * the count (always) and a page of their dates, by start. Behind
 * `assistant.customer-conversation.view`, for a platform admin not acting as anyone. No text,
 * card, turn count or model output ever leaves through it; the caller's `CallContext` is passed
 * unchanged.
 */
export interface CustomerConversationsFacade {
  adminCustomerConversations(
    context: CallContext,
    request: AdminConversationsRequest,
  ): Promise<
    Result<
      { readonly rows: readonly AdminConversationDates[]; readonly total: number },
      CustomerConversationsFailure
    >
  >;
}

export const CUSTOMER_CONVERSATIONS_FACADE = Symbol('CUSTOMER_CONVERSATIONS_FACADE');
