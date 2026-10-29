// The runtime switch of promotions in one Market: `off` (the default; no row means off) or
// `active`. It decides whether the module reads, writes or calculates at all; turning it off
// deletes nothing, and the calculation then returns no discount.

export const PROMOTIONS_STATUSES = ['off', 'active'] as const;
export type PromotionsStatus = (typeof PROMOTIONS_STATUSES)[number];

export const isPromotionsStatus = (value: unknown): value is PromotionsStatus =>
  typeof value === 'string' && (PROMOTIONS_STATUSES as readonly string[]).includes(value);
