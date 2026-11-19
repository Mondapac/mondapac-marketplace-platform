import { ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { mayManage, type SavedFilter, type SavedFilterVisibility } from '../../domain/saved-filter';
import { invalid, type ValidationFailure } from '../own-reads/own-reads.shared';
import {
  sellerSavedFilterListOf,
  type SellerSavedFilterListDefinition,
} from './seller-saved-filter-lists';

// What the seller saved-filter use cases share: the member of the call, the list a request names
// and the answer of one filter. The closed pieces of a request that are the same for admins (name,
// visibility, filter id, the share probe) come from `saved-filter-shared.ts`.

/** The member the call acts for: the signed-in seller account and the store it works in. */
export interface SellerMember {
  readonly accountId: Id<'Account'>;
  readonly sellerId: Id<'Seller'>;
}

/** The member of a seller call, or null for any other population (the gate has checked the key). */
export function memberOf(context: CallContext): SellerMember | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller') return null;
  if (actor.sellerId === null) return null;
  return { accountId: actor.accountId, sellerId: actor.sellerId };
}

export function sellerListOf(
  value: unknown,
  path = 'listKey',
): Result<SellerSavedFilterListDefinition, ValidationFailure> {
  if (value === undefined || value === null || value === '') return invalid(path, 'required');
  const list = sellerSavedFilterListOf(value);
  return list === null ? invalid(path, 'value') : ok(list);
}

/** A filter as the seller API answers it (no product count: the list answers its own counts). */
export interface OwnSavedFilterView {
  readonly id: string;
  readonly listKey: string;
  readonly name: string;
  readonly visibility: SavedFilterVisibility;
  readonly payload: unknown;
  /** True for the caller's own filter. */
  readonly ownedByMe: boolean;
  /** Whether the caller may rename, change the visibility of or delete it. */
  readonly canManage: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function ownViewOf(
  filter: SavedFilter,
  actorAccountId: Id<'Account'>,
  canShare: boolean,
): OwnSavedFilterView {
  return {
    id: filter.id,
    listKey: filter.listKey,
    name: filter.name,
    visibility: filter.visibility,
    payload: filter.payload,
    ownedByMe: filter.ownerAccountId === actorAccountId,
    canManage: mayManage(filter, actorAccountId, canShare),
    createdAt: filter.createdAt.toString(),
    updatedAt: filter.updatedAt.toString(),
  };
}
