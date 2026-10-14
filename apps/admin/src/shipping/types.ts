// Answers of the admin flat shipping fee routes (apps/api flat-fee.controller.ts).

export const FEE_VIEW_PERMISSION = 'shipping.flat-fee.view';
export const FEE_MANAGE_PERMISSION = 'shipping.flat-fee.manage';

/** The fee of one seller; `amount` is null while none is set (checkout is closed until then). */
export interface FlatFee {
  readonly sellerId: string;
  /** Minor units as a decimal string, or null when no fee was set yet. */
  readonly amount: string | null;
  readonly currency: string;
}
