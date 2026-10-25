import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import { LocalKeyWrapper } from '../../../platform/subject-keys/local-key-wrapper';
import { NodeSubjectKeyService } from '../../../platform/subject-keys/node-subject-key-service';
import {
  SubjectKeyExistsError,
  SubjectKeyMissingError,
} from '../../../platform/subject-keys/subject-key-service';
import type {
  NewSubjectKey,
  StoredSubjectKey,
  SubjectKeyStore,
} from '../../../platform/subject-keys/subject-key-store';
import { hashesMatch } from '../domain/pickup-code';
import { SubjectKeyPickupCodeVault } from './subject-key-pickup-code-vault';

// The real vault on the real subject-key service (an in-memory key table), on both Market
// fixtures: the code is random and four digits, the hash is keyed and bound to the account, the
// seller order and the Market, and the sealed copy opens for its own seller order only.

class MemoryStore implements SubjectKeyStore {
  readonly rows = new Map<string, StoredSubjectKey & { marketId: string }>();
  insert(market: MarketContext, key: NewSubjectKey): Promise<void> {
    if (this.rows.has(key.subjectId)) return Promise.reject(new SubjectKeyExistsError());
    this.rows.set(key.subjectId, { ...key, marketId: market.marketId, destroyedAt: null });
    return Promise.resolve();
  }
  find(market: MarketContext, subjectId: Id): Promise<StoredSubjectKey | null> {
    const row = this.rows.get(subjectId);
    return Promise.resolve(row?.marketId === market.marketId ? row : null);
  }
  destroy(market: MarketContext, subjectId: Id, destroyedAt: Temporal.Instant): Promise<void> {
    const row = this.rows.get(subjectId);
    if (row?.marketId !== market.marketId) return Promise.reject(new SubjectKeyMissingError());
    if (row.destroyedAt === null)
      this.rows.set(subjectId, { ...row, wrappedKey: null, destroyedAt });
    return Promise.resolve();
  }
}

describe.each(TEST_MARKETS)('SubjectKeyPickupCodeVault in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const clock = new FixedClock(Temporal.Instant.from('2026-10-25T00:00:00Z'));
  const ids = new SequenceIdGenerator(clock);
  let keys: NodeSubjectKeyService;
  let vault: SubjectKeyPickupCodeVault;
  let account: Id<'Account'>;
  let sellerOrder: Id<'SellerOrder'>;

  beforeEach(async () => {
    keys = new NodeSubjectKeyService(
      new MemoryStore(),
      new LocalKeyWrapper({ nodeEnv: 'test', nodeEnvExplicit: true }),
      clock,
    );
    vault = new SubjectKeyPickupCodeVault(keys);
    account = ids.next<'Account'>();
    sellerOrder = ids.next<'SellerOrder'>();
    await keys.createKey(market, account);
  });

  const issue = async (order = sellerOrder) => {
    const issued = await vault.issue(market, account, order);
    if (!issued.ok) throw new Error('expected a code');
    return issued.value;
  };

  it('issues a four-digit code, and never stores it in the clear', async () => {
    const issued = await issue();

    expect(issued.code).toMatch(/^[0-9]{4}$/);
    expect(issued.hash).not.toContain(issued.code);
    expect(issued.sealed).not.toContain(issued.code);
    expect(issued.hash.length).toBeGreaterThan(20);
  });

  it('draws codes from the random source over the whole range', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 300; i += 1) seen.add((await issue()).code);
    // 300 uniform draws from 10,000 codes: far more than a handful of distinct values.
    expect(seen.size).toBeGreaterThan(250);
    // The default source is the platform CSPRNG: the vault takes a stand-in only for tests.
    const fixed = new SubjectKeyPickupCodeVault(keys, () => 42);
    const issued = await fixed.issue(market, account, sellerOrder);
    expect(issued.ok && issued.value.code).toBe('0042');
  });

  it('hashes the typed code to the stored hash, and a wrong code to another one', async () => {
    const issued = await issue();

    const same = await vault.digest(market, account, sellerOrder, issued.code);
    const other = await vault.digest(
      market,
      account,
      sellerOrder,
      issued.code === '0000' ? '0001' : '0000',
    );

    expect(same.ok && hashesMatch(same.value, issued.hash)).toBe(true);
    expect(other.ok && hashesMatch(other.value, issued.hash)).toBe(false);
  });

  it('binds the hash to the seller order and to the account', async () => {
    const issued = await issue();
    const otherOrder = ids.next<'SellerOrder'>();
    const elsewhere = await vault.digest(market, account, otherOrder, issued.code);
    expect(elsewhere.ok && elsewhere.value).not.toBe(issued.hash);

    const stranger = ids.next<'Account'>();
    await keys.createKey(market, stranger);
    const foreign = await vault.digest(market, stranger, sellerOrder, issued.code);
    expect(foreign.ok && foreign.value).not.toBe(issued.hash);
  });

  it('opens the sealed copy for its own seller order only', async () => {
    const issued = await issue();

    const opened = await vault.reveal(market, account, sellerOrder, issued.sealed);
    expect(opened).toEqual({ ok: true, value: issued.code });
    await expect(
      vault.reveal(market, account, ids.next<'SellerOrder'>(), issued.sealed),
    ).rejects.toThrow();
  });

  it('answers key destroyed once the account was erased', async () => {
    const issued = await issue();
    await keys.destroyKey(market, account);

    const destroyed = { ok: false, error: { code: 'subject-key.destroyed' } };
    expect(await vault.issue(market, account, sellerOrder)).toEqual(destroyed);
    expect(await vault.digest(market, account, sellerOrder, '0000')).toEqual(destroyed);
    expect(await vault.reveal(market, account, sellerOrder, issued.sealed)).toEqual(destroyed);
  });
});
