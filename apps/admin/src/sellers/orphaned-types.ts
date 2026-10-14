// Answers of GET identity/admin/sellers?state=orphaned (identity design 8.6 row 8). No personal data.

export const ORPHANED_VIEW_PERMISSION = 'identity.seller-access.view';
export const ORPHANED_PAGE_SIZE = 25;

export const ORPHAN_STATES = ['pending', 'approved', 'rejected', 'suspended'] as const;

export interface InviteHint {
  readonly allowed: boolean;
  /** `access.denied` or `access.unavailable` when not allowed; other codes read as "not now". */
  readonly code: string | null;
}

export interface OrphanRow {
  readonly type: 'orphan';
  readonly sellerId: string;
  readonly state: string;
  readonly stateChangedAt: string;
  readonly createdAt: string;
  readonly actions: { readonly invite: InviteHint };
}

export interface OrphanPage {
  readonly items: readonly OrphanRow[];
  readonly next: string | null;
}

/** The seller id as the list shows it: enough to tell two sellers apart. */
export const shortSellerId = (id: string): string => id.slice(-8).toUpperCase();
