import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** One stored address: the sealed content and the clear facts beside it. */
export interface AddressRecord {
  readonly id: Id<'CustomerAddress'>;
  readonly accountId: Id<'Account'>;
  /** The address as ciphertext under the account's subject key (never read here). */
  readonly sealed: string;
  readonly countryCode: string;
  readonly isDefault: boolean;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

/**
 * The address book (`customers.addresses`). Every method runs inside the caller's unit of work,
 * is scoped by the Market and names the owning account in its `where`, so one customer never
 * reads or changes another's address. At most one default address per account (a unique index).
 */
export interface AddressRepository {
  /**
   * Takes the account's address-book lock (`customers.lock-address-book`) until the unit ends,
   * so writers of one book run one after the other. Call it first in every write unit, before
   * any read.
   */
  lockBook(market: MarketContext, accountId: Id<'Account'>): Promise<void>;
  /** Newest first. */
  list(market: MarketContext, accountId: Id<'Account'>): Promise<readonly AddressRecord[]>;
  find(
    market: MarketContext,
    accountId: Id<'Account'>,
    id: Id<'CustomerAddress'>,
  ): Promise<AddressRecord | null>;
  insert(market: MarketContext, record: AddressRecord): Promise<void>;
  /** Replaces the sealed content; false when the account has no such address. */
  update(
    market: MarketContext,
    record: Pick<AddressRecord, 'id' | 'accountId' | 'sealed' | 'updatedAt'>,
  ): Promise<boolean>;
  /** Makes one address the default; the caller has cleared the old default first. */
  markDefault(
    market: MarketContext,
    accountId: Id<'Account'>,
    id: Id<'CustomerAddress'>,
    updatedAt: Temporal.Instant,
  ): Promise<boolean>;
  /** Clears the account's default flag, whichever address holds it. */
  clearDefault(
    market: MarketContext,
    accountId: Id<'Account'>,
    updatedAt: Temporal.Instant,
  ): Promise<void>;
  remove(
    market: MarketContext,
    accountId: Id<'Account'>,
    id: Id<'CustomerAddress'>,
  ): Promise<boolean>;
  /** Deletes every address of the account (account deletion); answers how many. Safe to repeat. */
  removeAllOf(market: MarketContext, accountId: Id<'Account'>): Promise<number>;
}

export const ADDRESS_REPOSITORY = Symbol('ADDRESS_REPOSITORY');
