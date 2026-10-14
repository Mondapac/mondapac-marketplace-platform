import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { SellerAccess } from '../../domain/seller-access';
import { isSellerOwner } from '../sellers/seller-owner';
import type { AccessDecisionRepository } from '../ports/access-decision.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';

export interface SellerSignInDependencies {
  readonly memberships: SellerMembershipRepository;
  readonly sellerAccess: SellerAccessRepository;
  readonly decisions: AccessDecisionRepository;
  readonly grants: RoleGrantReader;
}

/** What step 6 of the seller sign-in decided (identity design 3.3, 6.3). */
export type SellerGate =
  | { readonly kind: 'open'; readonly seller: SellerAccess }
  | {
      readonly kind: 'refused';
      readonly code: 'membership.none' | 'seller-access.suspended';
      /** The suspension's reason, for the Seller Owner only (decision 9; slice 9). */
      readonly reason?: string;
    };

/**
 * Step 6 for the seller side (identity design 3.3): an active membership and a seller whose
 * access allows sign-in. Runs inside the caller's unit: the seller's row lock first (item H),
 * then its state. Shared by the password step (no second factor) and the code step that follows
 * a challenge, so both tell the same states, and only after full authentication.
 */
export async function resolveSellerGate(
  deps: SellerSignInDependencies,
  market: MarketContext,
  accountId: Id<'Account'>,
): Promise<SellerGate> {
  const { memberships, sellerAccess } = deps;
  const membership = await memberships.findActiveByAccount(market, accountId);
  const locked =
    membership !== null && (await sellerAccess.lockForSession(market, membership.state.sellerId));
  const seller =
    membership === null || !locked
      ? null
      : await sellerAccess.findById(market, membership.state.sellerId);
  if (seller === null) return { kind: 'refused', code: 'membership.none' };
  if (!seller.allowsSignIn) {
    const reason = await suspensionReason(deps, market, seller, accountId);
    return {
      kind: 'refused',
      code: 'seller-access.suspended',
      ...(reason === null ? {} : { reason }),
    };
  }
  return { kind: 'open', seller };
}

/**
 * The reason of the suspension a seller is in, for its Seller Owner only (identity design 3.3,
 * decision 9; slice 9): the latest decision must be that suspension, the account must hold the
 * seller system role, and the reason must still open under the seller's key. Null otherwise
 * (Staff read the state only). Never logged.
 */
async function suspensionReason(
  deps: SellerSignInDependencies,
  market: MarketContext,
  seller: SellerAccess,
  accountId: Id<'Account'>,
): Promise<string | null> {
  const { decisions, grants } = deps;
  if (!(await isSellerOwner({ grants }, market, accountId))) return null;
  const latest = await decisions.latestOf(market, seller.state.sellerId);
  return latest?.decision === 'suspended' ? latest.reason : null;
}
