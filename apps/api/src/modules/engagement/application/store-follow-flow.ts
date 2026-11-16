import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  DEFAULT_MY_STORES_PAGE,
  MAX_FOLLOWS_PER_ACCOUNT,
  MAX_MY_STORES_PAGE,
  StoreFollowedEvent,
  StoreUnfollowedEvent,
  type StoreFollow,
} from '../domain/store-follow';
import type { EngagementDependencies } from './engagement-dependencies';
import type { StoreFollowCursor } from './ports/store-follow.repository';

// Store follows (customers management phase 3). The customer follows and unfollows a store from
// the storefront and sees their "My stores"; promotions asks whether the customer of a cart follows
// its sellers (the store-follower offer); customers asks which stores a customer follows (the
// seller's customers read model). Only a store the public can see now can be followed; any store
// can be unfollowed. The account always comes from the session or the system caller's input, never
// from a request body.

export type FieldProblem = { readonly path: string; readonly code: string };

export type FollowFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  /** Unknown, of another Market, or not a published store now. */
  | { readonly code: 'engagement.store-not-found' }
  /** The customer follows {@link MAX_FOLLOWS_PER_ACCOUNT} stores already. */
  | { readonly code: 'engagement.follow-limit' }
  | { readonly code: 'engagement.unavailable' };

export interface FollowState {
  readonly sellerId: Id<'Seller'>;
  readonly following: boolean;
  readonly followedAt: Temporal.Instant | null;
}

export interface MyStore {
  readonly sellerId: Id<'Seller'>;
  /** The store's address now; null when the store is no longer public (it can still be unfollowed). */
  readonly slug: string | null;
  readonly followedAt: Temporal.Instant;
}

export interface MyStoresPage {
  readonly items: readonly MyStore[];
  readonly total: number;
  /** Pass back as `cursor` for the next page; null on the last page. */
  readonly nextCursor: string | null;
}

/** The signed-in customer's own account; null for any other actor and in Login-as sessions. */
function customerOf(context: CallContext): Id<'Account'> | null {
  const actor = context.actor;
  if (actor.kind !== 'authenticated' || actor.population !== 'customer') return null;
  if (Object.hasOwn(actor, 'actingAs') && (actor as { actingAs?: unknown }).actingAs != null) {
    return null;
  }
  return actor.accountId;
}

const invalid = (path: string, code: string) =>
  err({ code: 'validation.failed' as const, fields: [{ path, code }] });

function sellerIdOf(value: unknown): Id<'Seller'> | null {
  if (typeof value !== 'string') return null;
  const parsed = parseId<'Seller'>(value);
  return parsed.ok ? parsed.value : null;
}

const stateOf = (sellerId: Id<'Seller'>, follow: StoreFollow | null): FollowState => ({
  sellerId,
  following: follow !== null,
  followedAt: follow?.followedAt ?? null,
});

/** Follows a published store. Following a store already followed changes nothing and sends no event. */
export async function followStore(
  deps: EngagementDependencies,
  context: CallContext,
  input: { readonly sellerId?: unknown },
): Promise<Result<FollowState, FollowFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) return invalid('sellerId', 'format');
  // Before any unit opens: the store must be one the public can see now.
  const published = await deps.stores.slugsOf(context, [sellerId]);
  if (!published.ok) return err({ code: 'engagement.unavailable' });
  if (!published.value.has(sellerId)) return err({ code: 'engagement.store-not-found' });
  return deps.unitOfWork.run<FollowState, FollowFailure>(context.market, async () => {
    // The account's writes run one after another, and an erasure in flight commits first.
    await deps.settings.lockAccount(context.market, accountId, 'exclusive');
    const existing = await deps.follows.find(context.market, accountId, sellerId);
    if (existing !== null) return ok(stateOf(sellerId, existing));
    if ((await deps.follows.countOf(context.market, accountId)) >= MAX_FOLLOWS_PER_ACCOUNT) {
      return err({ code: 'engagement.follow-limit' });
    }
    const follow: StoreFollow = {
      id: deps.ids.next<'StoreFollow'>(),
      accountId,
      sellerId,
      followedAt: deps.clock.now(),
    };
    if ((await deps.follows.insert(context.market, follow)) === 'exists') {
      return ok(stateOf(sellerId, await deps.follows.find(context.market, accountId, sellerId)));
    }
    await deps.outbox.append(context, [
      StoreFollowedEvent.record({
        aggregateId: follow.id,
        aggregateVersion: 1,
        occurredAt: follow.followedAt,
        payload: { accountId, sellerId },
      }),
    ]);
    return ok(stateOf(sellerId, follow));
  });
}

/** Stops following a store. A store not followed changes nothing and sends no event. */
export async function unfollowStore(
  deps: EngagementDependencies,
  context: CallContext,
  input: { readonly sellerId?: unknown },
): Promise<Result<FollowState, FollowFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) return invalid('sellerId', 'format');
  return deps.unitOfWork.run<FollowState, FollowFailure>(context.market, async () => {
    await deps.settings.lockAccount(context.market, accountId, 'exclusive');
    const existing = await deps.follows.find(context.market, accountId, sellerId);
    if (existing === null) return ok(stateOf(sellerId, null));
    if (await deps.follows.remove(context.market, accountId, existing.id)) {
      await deps.outbox.append(context, [
        StoreUnfollowedEvent.record({
          aggregateId: existing.id,
          aggregateVersion: 2,
          occurredAt: deps.clock.now(),
          payload: { accountId, sellerId },
        }),
      ]);
    }
    return ok(stateOf(sellerId, null));
  });
}

/** Whether the signed-in customer follows one store (any store id: an unknown one is "no"). */
export async function viewFollow(
  deps: EngagementDependencies,
  context: CallContext,
  input: { readonly sellerId?: unknown },
): Promise<Result<FollowState, FollowFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const sellerId = sellerIdOf(input?.sellerId);
  if (sellerId === null) return invalid('sellerId', 'format');
  return deps.unitOfWork.run<FollowState, FollowFailure>(
    context.market,
    async () => ok(stateOf(sellerId, await deps.follows.find(context.market, accountId, sellerId))),
    { readOnly: true },
  );
}

const CURSOR = /^(\d{1,16})\.([0-9a-f-]{36})$/;

function parseCursor(value: unknown): Result<StoreFollowCursor | null, FieldProblem> {
  if (value === undefined || value === null || value === '') return ok(null);
  const match = typeof value === 'string' ? CURSOR.exec(value) : null;
  const id = match === null ? null : parseId<'StoreFollow'>(match[2]!);
  if (match === null || id === null || !id.ok) return err({ path: 'cursor', code: 'format' });
  return ok({
    followedAt: Temporal.Instant.fromEpochMilliseconds(Number(match[1])),
    id: id.value,
  });
}

const cursorOf = (follow: StoreFollow): string =>
  `${follow.followedAt.epochMilliseconds}.${follow.id}`;

/** The signed-in customer's followed stores, newest first. */
export async function myStores(
  deps: EngagementDependencies,
  context: CallContext,
  input: { readonly cursor?: unknown; readonly limit?: unknown },
): Promise<Result<MyStoresPage, FollowFailure>> {
  const accountId = customerOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const cursor = parseCursor(input?.cursor);
  if (!cursor.ok) return invalid(cursor.error.path, cursor.error.code);
  let limit = DEFAULT_MY_STORES_PAGE;
  if (input?.limit !== undefined) {
    const value = Number(input.limit);
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MY_STORES_PAGE) {
      return invalid('limit', 'range');
    }
    limit = value;
  }
  const read = await deps.unitOfWork.run(
    context.market,
    async () => {
      const rows = await deps.follows.pageOf(context.market, accountId, cursor.value, limit + 1);
      const total = await deps.follows.countOf(context.market, accountId);
      return ok({ rows, total });
    },
    { readOnly: true },
  );
  if (!read.ok) return read;
  const { rows, total } = read.value;
  const page = rows.slice(0, limit);
  const slugs = await deps.stores.slugsOf(
    context,
    page.map((follow) => follow.sellerId),
  );
  if (!slugs.ok) return err({ code: 'engagement.unavailable' });
  return ok({
    items: page.map((follow) => ({
      sellerId: follow.sellerId,
      slug: slugs.value.get(follow.sellerId) ?? null,
      followedAt: follow.followedAt,
    })),
    total,
    nextCursor: rows.length > limit ? cursorOf(page[page.length - 1]!) : null,
  });
}

/** The most seller ids one `followedAmong` call may ask about. */
export const MAX_FOLLOWED_AMONG = 100;

/**
 * Which of `sellerIds` an account follows. For the system actor (any account) and for a customer
 * asking about their own account; anyone else is refused.
 */
export async function followedAmong(
  deps: EngagementDependencies,
  context: CallContext,
  input: { readonly accountId: Id<'Account'>; readonly sellerIds: readonly Id<'Seller'>[] },
): Promise<Result<readonly Id<'Seller'>[], FollowFailure>> {
  if (context.actor.kind !== 'system' && customerOf(context) !== input.accountId) {
    return err({ code: 'access.denied' });
  }
  if (!Array.isArray(input.sellerIds) || input.sellerIds.length > MAX_FOLLOWED_AMONG) {
    return invalid('sellerIds', 'size');
  }
  const sellerIds: Id<'Seller'>[] = [];
  for (const raw of new Set<unknown>(input.sellerIds)) {
    const id = sellerIdOf(raw);
    if (id === null) return invalid('sellerIds', 'format');
    sellerIds.push(id);
  }
  return deps.unitOfWork.run<readonly Id<'Seller'>[], FollowFailure>(
    context.market,
    async () => {
      const rows = await deps.follows.followedAmong(context.market, input.accountId, sellerIds);
      const followed = new Set(rows.map((row) => row.sellerId));
      return ok(sellerIds.filter((id) => followed.has(id)));
    },
    { readOnly: true },
  );
}

/** Every store an account follows, with the instant it started (system actor; customers' read model). */
export async function followsOfAccount(
  deps: EngagementDependencies,
  context: CallContext,
  input: { readonly accountId: Id<'Account'> },
): Promise<
  Result<
    readonly { readonly sellerId: Id<'Seller'>; readonly followedAt: Temporal.Instant }[],
    FollowFailure
  >
> {
  const parsed = typeof input?.accountId === 'string' ? parseId<'Account'>(input.accountId) : null;
  if (parsed === null || !parsed.ok) return invalid('accountId', 'format');
  return deps.unitOfWork.run(
    context.market,
    async () =>
      ok(
        (await deps.follows.allOf(context.market, parsed.value)).map((follow) => ({
          sellerId: follow.sellerId,
          followedAt: follow.followedAt,
        })),
      ),
    { readOnly: true },
  );
}
