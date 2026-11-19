// The seller's Earnings › Payouts super list (super list phase 4, list 33): its sorts, row
// actions and optional export columns.

export const OWN_PAYOUT_SORT_KEYS = ['created', 'amount', 'slot'] as const;
export const OWN_PAYOUT_ROW_ACTIONS = ['open'] as const;
export type OwnPayoutRowAction = (typeof OWN_PAYOUT_ROW_ACTIONS)[number];
export const OWN_PAYOUT_EXPORT_COLUMNS = ['gross', 'netted', 'slot', 'updated'] as const;
export type OwnPayoutExportColumn = (typeof OWN_PAYOUT_EXPORT_COLUMNS)[number];
