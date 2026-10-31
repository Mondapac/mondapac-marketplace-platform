import type { LastChangedValue } from '@mondapac/ui';

// Answers of the admin support contact routes (apps/api support-contact.controller.ts).

export const SUPPORT_VIEW_PERMISSION = 'notifications.support-contact.view';
export const SUPPORT_MANAGE_PERMISSION = 'notifications.support-contact.manage';

/** The support address in force; `email` is null when none was ever set. */
export interface SupportContact {
  readonly email: string | null;
  /** 0 while the Market default is in force, then 1, 2, ... per change. */
  readonly version: number;
  /** The newest change, from the audit log; null while it was never changed. */
  readonly lastChanged?: LastChangedValue | null;
}
