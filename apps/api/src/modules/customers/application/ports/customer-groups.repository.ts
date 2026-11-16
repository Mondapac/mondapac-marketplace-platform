import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { CustomerGroup, CustomerGroupWithCount } from '../../domain/customer-groups';

/** A change of a group's name, description or archive flag, under the version read. */
export interface GroupChange {
  readonly id: Id<'CustomerGroup'>;
  readonly expectedVersion: number;
  readonly name: string;
  readonly description: string | null;
  readonly archivedAt: Temporal.Instant | null;
  readonly updatedAt: Temporal.Instant;
}

/**
 * The admin's manual groups and their members (`customers.customer_groups`,
 * `customer_group_members`), through the Market-scoped client in the open unit of the use case.
 */
export interface CustomerGroupRepository {
  /** Every group of the Market with its member count, live ones first, newest first. */
  list(market: MarketContext): Promise<readonly CustomerGroupWithCount[]>;
  find(market: MarketContext, id: Id<'CustomerGroup'>): Promise<CustomerGroupWithCount | null>;
  /** The groups of the Market, archived ones included. */
  count(market: MarketContext): Promise<number>;
  /** `name-taken`: another group of the Market has the name, whatever its case (unique index). */
  insert(market: MarketContext, group: CustomerGroup): Promise<'ok' | 'name-taken'>;
  /** `stale` when the version moved on (a concurrent change): nothing was written. */
  update(market: MarketContext, change: GroupChange): Promise<'ok' | 'stale' | 'name-taken'>;

  /**
   * Adds the customers that have a directory row and are not yet members; answers how many were
   * added. Ids without a directory row (unknown, another Market's, erased) are skipped.
   */
  addMembers(
    market: MarketContext,
    groupId: Id<'CustomerGroup'>,
    accountIds: readonly Id<'Account'>[],
    addedBy: Id<'Account'>,
    at: Temporal.Instant,
  ): Promise<readonly Id<'Account'>[]>;
  /** Removes the given members; answers the ids that were members. */
  removeMembers(
    market: MarketContext,
    groupId: Id<'CustomerGroup'>,
    accountIds: readonly Id<'Account'>[],
  ): Promise<readonly Id<'Account'>[]>;
  /** The live and archived groups of each customer, by account. */
  groupsOf(
    market: MarketContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<
    ReadonlyMap<
      Id<'Account'>,
      readonly { id: Id<'CustomerGroup'>; name: string; archived: boolean }[]
    >
  >;
  /** Whether the customer is in the group (archived or not; the caller decides). */
  isMember(
    market: MarketContext,
    groupId: Id<'CustomerGroup'>,
    accountId: Id<'Account'>,
  ): Promise<{ readonly member: boolean; readonly archived: boolean } | null>;
}

export const CUSTOMER_GROUP_REPOSITORY = Symbol('CUSTOMER_GROUP_REPOSITORY');
