// Answers of the admin category proposal and shelf routes (apps/api seller-category.dto.ts,
// categories C9a). Names and descriptions are text a seller typed: rendered as plain text only.

export const DECIDE_PERMISSION = 'catalog.category-proposal.decide';
export const PROMOTE_MERGE_PERMISSION = 'catalog.seller-category.promote-merge';
export const API_PROPOSALS = 'catalog/admin/category-proposals';
export const API_SHELVES = 'catalog/admin/shelves';
export const sellerShelvesPath = (sellerId: string): string =>
  `catalog/admin/sellers/${sellerId}/shelves`;

export const REJECT_REASONS = [
  'already-exists',
  'too-narrow',
  'too-broad',
  'misleading',
  'not-sold-here',
  'other',
] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export interface ShelfText {
  readonly locale: string;
  readonly name: string;
  readonly description: string | null;
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface Proposal {
  readonly id: string;
  readonly sellerId: string;
  readonly platformParentId: string;
  readonly texts: readonly ShelfText[];
  readonly status: ProposalStatus;
  readonly reasonCode: string | null;
  readonly sellerCategoryId: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly version: number;
  readonly storeName: string | null;
}

export interface ProposalQueue {
  readonly items: readonly Proposal[];
  readonly nextAfterId: string | null;
}

export interface ProposalDecided {
  readonly status: 'approved' | 'rejected' | 'cancelled';
  readonly version: number;
  readonly sellerCategoryId?: string;
  readonly slug?: string;
}

export type ShelfStatus = 'active' | 'promoted' | 'merged' | 'archived';

export interface Shelf {
  readonly id: string;
  readonly platformParentId: string;
  readonly slug: string;
  readonly status: ShelfStatus;
  readonly mergedIntoId: string | null;
  readonly texts: readonly ShelfText[];
  readonly version: number;
}

export interface ShelfList {
  readonly shelves: readonly Shelf[];
}

export interface ShelfPromoted {
  readonly categoryId: string;
  readonly slug: string;
  readonly status: 'hidden';
  readonly treeVersion: number;
  readonly offersCleared: number;
}

export interface ShelfMerged {
  readonly status: 'merged';
  readonly mergedIntoId: string;
  readonly offersCleared: number;
}
