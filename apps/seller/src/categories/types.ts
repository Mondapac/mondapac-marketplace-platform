// The seller's category proposals and shelves (categories C9a/C9b): `GET catalog/seller/category-proposals`.
// Ids, codes and the names a seller typed; shown as text only.

export const PROPOSE_PERMISSION = 'catalog.own-category.propose';

export interface ShelfText {
  readonly locale: string;
  readonly name: string;
  readonly description: string | null;
}

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

export interface OwnProposal {
  readonly id: string;
  readonly platformParentId: string;
  readonly texts: readonly ShelfText[];
  readonly status: ProposalStatus;
  /** A rejection reason or a cancellation reason (`seller-cancelled`, `permission-revoked`). */
  readonly reasonCode: string | null;
  readonly sellerCategoryId: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly version: number;
}

export interface OwnShelf {
  readonly id: string;
  readonly platformParentId: string;
  readonly slug: string;
  readonly status: 'active' | 'promoted' | 'merged' | 'archived';
  readonly texts: readonly ShelfText[];
  readonly version: number;
}

export interface OwnProposals {
  readonly canPropose: boolean;
  readonly maxPending: number;
  readonly proposals: readonly OwnProposal[];
  readonly shelves: readonly OwnShelf[];
}

/** A platform category a seller may file a shelf under (the product form's own category list). */
export interface ParentCategory {
  readonly categoryId: string;
  readonly parentId: string | null;
  readonly names: Readonly<Record<string, string>>;
}

export interface CategoryLocales {
  readonly default: string;
  readonly supported: readonly string[];
}
