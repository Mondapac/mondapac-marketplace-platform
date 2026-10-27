import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { addressFromJson, addressToJson, type AddressContent } from '../../domain/address';
import type { AddressCipher } from '../ports/address-cipher';
import type { AddressRecord, AddressRepository } from '../ports/address.repository';

// Test doubles of the address book ports: the store in memory (one default per account, as the
// unique index keeps it) and a reversible cipher bound to the Market and account.

const key = (market: MarketContext, accountId: string) => `${market.marketId}|${accountId}`;

export class InMemoryAddresses implements AddressRepository {
  readonly rows = new Map<string, AddressRecord & { readonly marketId: string }>();

  private mine(market: MarketContext, accountId: Id<'Account'>) {
    return [...this.rows.values()].filter(
      (row) => row.marketId === market.marketId && row.accountId === accountId,
    );
  }

  list(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(
      this.mine(market, accountId).sort(
        (a, b) => Temporal.Instant.compare(b.createdAt, a.createdAt) || b.id.localeCompare(a.id),
      ),
    );
  }
  find(market: MarketContext, accountId: Id<'Account'>, id: Id<'CustomerAddress'>) {
    return Promise.resolve(this.mine(market, accountId).find((row) => row.id === id) ?? null);
  }
  insert(market: MarketContext, record: AddressRecord) {
    if (record.isDefault && this.mine(market, record.accountId).some((row) => row.isDefault)) {
      return Promise.reject(new Error('unique: one default'));
    }
    this.rows.set(record.id, { ...record, marketId: market.marketId });
    return Promise.resolve();
  }
  async update(market: MarketContext, record: Parameters<AddressRepository['update']>[1]) {
    const row = await this.find(market, record.accountId, record.id);
    if (row === null) return false;
    this.rows.set(row.id, { ...row, sealed: record.sealed, updatedAt: record.updatedAt });
    return true;
  }
  async markDefault(
    market: MarketContext,
    accountId: Id<'Account'>,
    id: Id<'CustomerAddress'>,
    updatedAt: Temporal.Instant,
  ) {
    const row = await this.find(market, accountId, id);
    if (row === null) return false;
    if (this.mine(market, accountId).some((other) => other.isDefault && other.id !== id)) {
      throw new Error('unique: one default');
    }
    this.rows.set(id, { ...row, isDefault: true, updatedAt });
    return true;
  }
  clearDefault(market: MarketContext, accountId: Id<'Account'>, updatedAt: Temporal.Instant) {
    for (const row of this.mine(market, accountId)) {
      if (row.isDefault) this.rows.set(row.id, { ...row, isDefault: false, updatedAt });
    }
    return Promise.resolve();
  }
  async remove(market: MarketContext, accountId: Id<'Account'>, id: Id<'CustomerAddress'>) {
    const row = await this.find(market, accountId, id);
    return row !== null && this.rows.delete(id);
  }
  removeAllOf(market: MarketContext, accountId: Id<'Account'>) {
    const mine = this.mine(market, accountId);
    for (const row of mine) this.rows.delete(row.id);
    return Promise.resolve(mine.length);
  }
}

/**
 * Seals in the platform's shape, `v1.<base64url of market|account:json>` (not secret: a test
 * double); a destroyed account's key answers destroyed.
 */
export class ReversibleAddressCipher implements AddressCipher {
  readonly destroyed = new Set<string>();

  seal(market: MarketContext, accountId: Id<'Account'>, content: AddressContent) {
    if (this.destroyed.has(accountId)) return Promise.resolve(err(DESTROYED));
    const plain = `${key(market, accountId)}:${addressToJson(content)}`;
    return Promise.resolve(ok(`v1.${Buffer.from(plain).toString('base64url')}`));
  }
  open(market: MarketContext, accountId: Id<'Account'>, sealed: string) {
    if (this.destroyed.has(accountId)) return Promise.resolve(err(DESTROYED));
    const prefix = `${key(market, accountId)}:`;
    const plain = Buffer.from(sealed.slice('v1.'.length), 'base64url').toString();
    if (!plain.startsWith(prefix)) throw new Error('sealed for another subject');
    return Promise.resolve(ok(addressFromJson(plain.slice(prefix.length))));
  }
}

const DESTROYED = { code: 'subject-key.destroyed' } as const;
