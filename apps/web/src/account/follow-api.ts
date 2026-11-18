import { call, isRecord, text, type ApiResult } from './customer-api.ts';

// The buyer's store follows and invite link, as the browser calls them through the same-origin
// relay (customers management phases 3 and 4a; engagement and customers controllers). Bodies are
// untrusted: anything not the expected shape is `failed`, never shown in part.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const isSellerId = (value: string | undefined): value is string =>
  value !== undefined && UUID.test(value);

export interface FollowState {
  readonly following: boolean;
  readonly followedAt: string | null;
}

function followOf(json: Record<string, unknown>): FollowState | undefined {
  if (typeof json.following !== 'boolean') return undefined;
  return { following: json.following, followedAt: text(json.followedAt) ?? null };
}

const path = (sellerId: string) => `customers/me/followed-stores/${sellerId}`;

export const readFollow = (sellerId: string): Promise<ApiResult<FollowState>> =>
  call('GET', path(sellerId), undefined, followOf);

export const followStore = (sellerId: string): Promise<ApiResult<FollowState>> =>
  call('PUT', path(sellerId), undefined, followOf);

export const unfollowStore = (sellerId: string): Promise<ApiResult<FollowState>> =>
  call('DELETE', path(sellerId), undefined, followOf);

export interface FollowedStore {
  readonly sellerId: string;
  /** null while the store is not public. */
  readonly slug: string | null;
  readonly followedAt: string;
}

export interface FollowedStoresPage {
  readonly items: readonly FollowedStore[];
  readonly total: number;
  readonly nextCursor: string | null;
}

/** `GET customers/me/followed-stores`, newest first, at most 50 per page. */
export function readFollowedStores(cursor: string | null): Promise<ApiResult<FollowedStoresPage>> {
  const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  return call('GET', `customers/me/followed-stores${query}`, undefined, (json) => {
    if (!Array.isArray(json.items) || typeof json.total !== 'number') return undefined;
    const items: FollowedStore[] = [];
    for (const row of json.items as unknown[]) {
      if (!isRecord(row)) return undefined;
      const slug = row.slug;
      if (
        typeof row.sellerId !== 'string' ||
        !UUID.test(row.sellerId) ||
        typeof row.followedAt !== 'string' ||
        !(slug === null || (typeof slug === 'string' && SLUG.test(slug)))
      )
        return undefined;
      items.push({ sellerId: row.sellerId, slug, followedAt: row.followedAt });
    }
    return { items, total: json.total, nextCursor: text(json.nextCursor) ?? null };
  });
}

export interface PublicStoreName {
  readonly name: string;
  /** The picture id of the logo, if the store has one. */
  readonly logoId: string | null;
}

/** `GET sellers/stores/:slug` (public): the name and logo My stores shows. */
export function readStoreName(slug: string): Promise<ApiResult<PublicStoreName>> {
  return call('GET', `sellers/stores/${slug}`, undefined, (json) => {
    const name = text(json.name);
    if (name === undefined || name.trim() === '') return undefined;
    const logo = isRecord(json.logo) ? text(json.logo.id) : undefined;
    return { name, logoId: logo !== undefined && UUID.test(logo) ? logo : null };
  });
}

export interface FollowGift {
  readonly name: string;
  readonly reward:
    | { readonly kind: 'PERCENT'; readonly bps: number }
    | { readonly kind: 'FIXED'; readonly amountMinor: number };
  readonly currency: string;
  readonly minSpendMinor: number | null;
  /** An ISO instant, or null. */
  readonly endsAt: string | null;
}

/** `GET promotions/stores/:sellerId/follow-gift`: at most 5 live offers for followers. */
export function readFollowGift(sellerId: string): Promise<ApiResult<readonly FollowGift[]>> {
  return call('GET', `promotions/stores/${sellerId}/follow-gift`, undefined, (json) => {
    if (!Array.isArray(json.gifts)) return undefined;
    const gifts: FollowGift[] = [];
    for (const row of (json.gifts as unknown[]).slice(0, 5)) {
      if (!isRecord(row) || typeof row.name !== 'string' || typeof row.currency !== 'string')
        return undefined;
      const reward = row.reward;
      if (!isRecord(reward)) return undefined;
      let parsed: FollowGift['reward'];
      if (reward.kind === 'PERCENT' && typeof reward.bps === 'number') {
        parsed = { kind: 'PERCENT', bps: reward.bps };
      } else if (reward.kind === 'FIXED' && /^[0-9]{1,15}$/.test(String(reward.amountMinor))) {
        parsed = { kind: 'FIXED', amountMinor: Number(reward.amountMinor) };
      } else return undefined;
      const min = row.minSpendMinor;
      gifts.push({
        name: row.name,
        reward: parsed,
        currency: row.currency,
        minSpendMinor: typeof min === 'string' && /^[0-9]{1,15}$/.test(min) ? Number(min) : null,
        endsAt: text(row.endsAt) ?? null,
      });
    }
    return gifts;
  });
}

/** `GET customers/me/store-invitation`: the store joined through (its address), or null. */
export function readOwnInvitation(): Promise<ApiResult<{ readonly slug: string | null } | null>> {
  return call('GET', 'customers/me/store-invitation', undefined, (json) => {
    if (json.store === null) return null;
    if (!isRecord(json.store)) return undefined;
    const { slug } = json.store;
    return { slug: typeof slug === 'string' && SLUG.test(slug) ? slug : null };
  });
}

/** `POST customers/me/store-invitation`: `following` is true when the store is now followed. */
export function joinStore(
  token: string,
): Promise<ApiResult<{ readonly following: boolean; readonly slug: string | null }>> {
  return call('POST', 'customers/me/store-invitation', { token }, (json) =>
    typeof json.following === 'boolean'
      ? {
          following: json.following,
          slug: typeof json.slug === 'string' && SLUG.test(json.slug) ? json.slug : null,
        }
      : undefined,
  );
}
