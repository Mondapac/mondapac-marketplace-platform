// Permission keys and access of the Exclusive perks page. Plain module, no 'use client': the page
// (a server component) reads these, and a value exported by a client module is only a reference on
// the server (calling it throws; a constant is not its string).
import { EARNINGS_VIEW_PERMISSION } from '../earnings/types.ts';

export const PROMOTION_VIEW_PERMISSION = 'promotions.promotion.view';
export const PROMOTION_MANAGE_PERMISSION = 'promotions.promotion.manage';

/** Which perks cards a seller may see, from the permission keys of the session. */
export function perkAccessOf(permissionKeys: readonly string[]): {
  readonly showPromotions: boolean;
  readonly showCommission: boolean;
} {
  return {
    showPromotions: [PROMOTION_VIEW_PERMISSION, PROMOTION_MANAGE_PERMISSION].some((key) =>
      permissionKeys.includes(key),
    ),
    showCommission: permissionKeys.includes(EARNINGS_VIEW_PERMISSION),
  };
}
