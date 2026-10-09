import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { Account } from '../../domain/account';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';

/** The ports {@link findSellerOwner} reads. */
export interface SellerOwnerDependencies {
  readonly memberships: SellerMembershipRepository;
  readonly grants: RoleGrantReader;
  readonly accounts: AccountRepository;
}

/** The Seller Owner and the seller's other active members (Staff), read in one unit. */
export interface SellerPeople {
  /** The owner's account, or null while the seller has none (an invitation not yet accepted). */
  readonly owner: Account | null;
  /** Every account with an active membership of the seller, the owner included. */
  readonly members: readonly Id<'Account'>[];
}

/**
 * The Seller Owner of a seller (identity design 2.1, 3.3; slice 9): the active member whose
 * assignment is the system role of the seller scope (R8: from `identity`'s own membership and
 * assignment rows, never another module's). Phase 2 has one owner per seller; a seller created
 * by an invitation has none until the invitation is accepted. Runs in the caller's unit; the
 * owner's account is of the seller population and this Market, or it is not the owner.
 */
export async function readSellerPeople(
  deps: SellerOwnerDependencies,
  market: MarketContext,
  sellerId: Id<'Seller'>,
): Promise<SellerPeople> {
  const members = await deps.memberships.activeMembersOf(market, sellerId);
  if (members.length === 0) return { owner: null, members };
  const grants = await deps.grants.grantsOf(market, members);
  const ownerId = members.find((accountId) => {
    const grant = grants.get(accountId);
    return grant?.kind === 'system' && grant.scope === 'seller';
  });
  if (ownerId === undefined) return { owner: null, members };
  const owner = await deps.accounts.findById(market, ownerId);
  return {
    owner: owner !== null && owner.state.population === 'seller' ? owner : null,
    members,
  };
}

/**
 * Whether `accountId` holds the Seller Owner's role (the owner-only reason, decision 9). The
 * caller has already tied the account to the seller through its active membership (the session's
 * seller), and a system role of the seller scope is held only by an owner.
 */
export async function isSellerOwner(
  deps: Pick<SellerOwnerDependencies, 'grants'>,
  market: MarketContext,
  accountId: Id<'Account'>,
): Promise<boolean> {
  const grant = (await deps.grants.grantsOf(market, [accountId])).get(accountId);
  return grant?.kind === 'system' && grant.scope === 'seller';
}
