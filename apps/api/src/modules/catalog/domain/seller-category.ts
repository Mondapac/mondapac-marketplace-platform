import type { Id, Temporal } from '@mondapac/shared-kernel';

/**
 * Seller shelves and category proposals (categories C9a; catalog design 4.7, CAT-51..54; data
 * design 3.22). A shelf groups a seller's own Offers on the seller's shop page. It is never a
 * platform category: never in navigation, filters, search facets, badge decisions or a product
 * revision (CAT-52).
 */

export type ProposalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';
export type ShelfStatus = 'active' | 'promoted' | 'merged' | 'archived';

/** The prepared reasons of a rejection (FP8 row 4): codes only, never free text. */
export const PROPOSAL_REJECT_REASONS = [
  'already-exists',
  'too-narrow',
  'too-broad',
  'misleading',
  'not-sold-here',
  'other',
] as const;
export type ProposalRejectReason = (typeof PROPOSAL_REJECT_REASONS)[number];

/** Why a proposal was cancelled: by the seller, or when SEL-26 was switched off (CAT-51). */
export type ProposalCancelReason = 'seller-cancelled' | 'permission-revoked';

/** One locale of a proposal or a shelf: a name and an optional description. */
export interface ShelfText {
  readonly locale: string;
  readonly name: string;
  readonly description: string | null;
}

export interface CategoryProposalView {
  readonly id: Id<'CategoryProposal'>;
  readonly sellerId: Id<'Seller'>;
  readonly platformParentId: Id<'Category'>;
  readonly texts: readonly ShelfText[];
  readonly status: ProposalStatus;
  readonly reasonCode: string | null;
  readonly createdSellerCategoryId: Id<'SellerCategory'> | null;
  readonly decidedAt: Temporal.Instant | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

export interface ShelfView {
  readonly id: Id<'SellerCategory'>;
  readonly sellerId: Id<'Seller'>;
  readonly platformParentId: Id<'Category'>;
  readonly slug: string;
  readonly status: ShelfStatus;
  readonly mergedIntoId: Id<'Category'> | null;
  readonly texts: readonly ShelfText[];
  readonly version: number;
}

/** The default pending cap (CAT-54) when the Market sets none. */
export const DEFAULT_MAX_PENDING_PROPOSALS = 5;

/** Persian and Arabic letters that look alike and are typed either way. */
const LETTER_FOLDS: ReadonlyMap<string, string> = new Map([
  ['ي', 'ی'], // Arabic yeh → Persian yeh
  ['ى', 'ی'], // Alef maksura → Persian yeh
  ['ك', 'ک'], // Arabic kaf → keheh
]);

/**
 * The comparison key of a proposal name (C9 brief): NFKC, case folded, Persian and Arabic yeh and
 * kaf unified, inner white space collapsed. Two names with the same key under the same parent are
 * the same proposal.
 */
export function normaliseShelfName(name: string): string {
  const folded = name.normalize('NFKC').toLocaleLowerCase('und');
  let out = '';
  for (const char of folded) out += LETTER_FOLDS.get(char) ?? char;
  return out.replace(/\s+/gu, ' ').trim();
}

/**
 * A slug for a new shelf (unique per seller): the default-locale name in lower-case Latin words,
 * or `shelf` when the name has none (a Persian or Arabic name), and a number when taken.
 */
export function shelfSlugBase(name: string): string {
  const latin = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return latin.length >= 2 ? latin : 'shelf';
}
