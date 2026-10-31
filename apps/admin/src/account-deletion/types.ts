// Answers and keys of the buyer account deletion routes (apps/api customers module, packages 5a
// and 5c). The panel only follows what the API answers; it checks nothing the API decides.

export const SETTINGS_VIEW_PERMISSION = 'customers.account-deletion-settings.view';
export const SETTINGS_MANAGE_PERMISSION = 'customers.account-deletion-settings.manage';
export const REQUESTS_VIEW_PERMISSION = 'customers.account-deletion-requests.view';
export const BUYER_DELETE_PERMISSION = 'customers.buyer-account.delete';

export const SETTINGS_PATH = 'customers/admin/account-deletion-settings';
export const REQUESTS_PATH = 'customers/admin/deletion-requests';

export const SETTINGS_HREF = '/settings/account-deletion';
export const REQUESTS_HREF = '/settings/account-deletion/requests';

/** The API accepts 7 to 90; the screen offers these, plus the value in force if it is another. */
export const WAITING_PERIOD_CHOICES = [7, 14, 30, 60, 90] as const;

/** The list page the pending-count read and the list screen ask for (the API maximum). */
export const REQUESTS_PAGE_SIZE = 100;

/** The longest reason the API takes. */
export const REASON_MAX = 500;
/** The ticket reference pattern of the API (domain/account-deletion-request.ts). */
export const TICKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._#/-]{0,63}$/;

export interface AccountDeletionSettings {
  readonly enabled: boolean;
  readonly waitingPeriodDays: number;
}

export interface AccountDeletionSettingsAnswer {
  /** 0 while the built-in defaults are in force, then 1, 2, ... per change. */
  readonly version: number;
  readonly settings: AccountDeletionSettings;
}

export interface DeletionRequestEntry {
  readonly requestId: string;
  readonly accountId: string;
  readonly requestedAt: string;
  readonly scheduledFor: string;
  /** The list answers `pending` today; `executing` is shown as "In progress" if it ever comes. */
  readonly status: 'pending' | 'executing';
  readonly requestedBy: 'customer' | 'admin';
}

export interface DeletionRequestPage {
  readonly entries: readonly DeletionRequestEntry[];
  readonly nextCursor: string | null;
}

/** The 201 of an admin request. */
export interface AdminDeletionRequestMade {
  readonly requestId: string;
  readonly status: string;
  readonly requestedAt: string;
  readonly scheduledFor: string;
  readonly waitingPeriodDays: number;
}

export interface Blocker {
  readonly code: string;
  readonly count?: number;
}

/** What the pending count card shows. */
export type PendingCount =
  | { readonly state: 'hidden' }
  | { readonly state: 'unavailable' }
  | { readonly state: 'ok'; readonly count: number; readonly more: boolean };

/** A reason as the API takes it: 1 to 500 characters, one line, no `<` or `>`. */
export function reasonProblem(text: string): boolean {
  const reason = text.trim();
  return (
    reason.length === 0 ||
    reason.length > REASON_MAX ||
    /[<>]/.test(reason) ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f]/.test(reason)
  );
}
