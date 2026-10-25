import { createHmac } from 'node:crypto';
import { ok, err } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { FieldLabel, HashPurpose } from '../../../platform/subject-keys/labels';
import type { Keyed, SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type { SealedStoreProfileContent } from '../application/ports/store-profile-content.repository';
import { contentOf } from '../domain/store-profile-content';
import { SubjectKeyStoreProfileContentSealer } from './subject-key-store-profile-content-sealer';

// The sealer of store profile content (data design 3.8, 4.2) on a fake key service that records
// the label and purpose it was given. The real key service is exercised against PostgreSQL in
// test/db/sellers-business-file-revisions.db-spec.ts.

const SELLER = '01928a3c-0000-7000-8000-000000000001' as Id<'Seller'>;

class FakeKeys implements SubjectKeyService {
  readonly labels: string[] = [];
  readonly purposes: string[] = [];
  destroyed = false;

  createKey(): Promise<void> {
    return Promise.resolve();
  }

  encrypt(market: MarketContext, subject: Id, field: FieldLabel, plain: string): Keyed<string> {
    this.labels.push(field);
    if (this.destroyed) return Promise.resolve(err({ code: 'subject-key.destroyed' }));
    return Promise.resolve(
      ok(
        `v1.${Buffer.from(`${market.marketId}|${subject}|${field}|${plain}`).toString('base64url')}`,
      ),
    );
  }

  decrypt(market: MarketContext, subject: Id, field: FieldLabel, cipher: string): Keyed<string> {
    this.labels.push(field);
    if (this.destroyed) return Promise.resolve(err({ code: 'subject-key.destroyed' }));
    const plain = Buffer.from(cipher.slice(3), 'base64url').toString();
    const prefix = `${market.marketId}|${subject}|${field}|`;
    if (!plain.startsWith(prefix)) throw new Error('does not authenticate');
    return Promise.resolve(ok(plain.slice(prefix.length)));
  }

  hmac(market: MarketContext, subject: Id, purpose: HashPurpose, data: Uint8Array): Keyed<string> {
    this.purposes.push(purpose);
    if (this.destroyed) return Promise.resolve(err({ code: 'subject-key.destroyed' }));
    return Promise.resolve(
      ok(
        createHmac('sha256', `${market.marketId}|${subject}|${purpose}`).update(data).digest('hex'),
      ),
    );
  }

  destroyKey(): Promise<void> {
    this.destroyed = true;
    return Promise.resolve();
  }
}

describe.each(TEST_MARKETS)('SubjectKeyStoreProfileContentSealer in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', PLATFORM_TENANT_ID);
  const about = { 'en-AU': 'Fresh bread every morning', 'ja-JP': '毎朝焼きたて' };

  it('seals under the store profile label, hashes under its purpose, and opens it again', async () => {
    const keys = new FakeKeys();
    const sealer = new SubjectKeyStoreProfileContentSealer(keys);

    const sealed = await sealer.seal(market, SELLER, contentOf(about));

    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(keys.labels).toEqual(['sellers.store-profile-revision.content']);
    expect(keys.purposes).toEqual(['sellers.store-profile.content']);
    expect(sealed.value.contentHash).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(sealed.value.ciphertext.startsWith('v1.')).toBe(true);
    expect(await sealer.open(market, SELLER, sealed.value.ciphertext)).toEqual(
      ok(contentOf(about)),
    );
  });

  it('gives the same hash for the same texts and another for other texts, per Market and seller', async () => {
    const sealer = new SubjectKeyStoreProfileContentSealer(new FakeKeys());

    const a = await sealer.seal(market, SELLER, contentOf(about));
    const b = await sealer.seal(
      market,
      SELLER,
      contentOf({ 'ja-JP': about['ja-JP'], 'en-AU': about['en-AU'] }),
    );
    const c = await sealer.seal(market, SELLER, contentOf({ 'en-AU': 'Other' }));
    const d = await sealer.seal(other, SELLER, contentOf(about));

    const hash = (r: typeof a) => (r.ok ? r.value.contentHash : null);
    expect(hash(a)).toEqual(hash(b));
    expect(hash(a)).not.toEqual(hash(c));
    expect(hash(a)).not.toEqual(hash(d));
  });

  it('answers subject-key.destroyed for an erased seller, on seal and on open', async () => {
    const keys = new FakeKeys();
    const sealer = new SubjectKeyStoreProfileContentSealer(keys);
    const sealed = await sealer.seal(market, SELLER, contentOf(about));
    if (!sealed.ok) throw new Error('fixture failed');
    await keys.destroyKey();

    expect(await sealer.seal(market, SELLER, contentOf(about))).toEqual({
      ok: false,
      error: { code: 'subject-key.destroyed' },
    });
    expect(await sealer.open(market, SELLER, sealed.value.ciphertext)).toEqual({
      ok: false,
      error: { code: 'subject-key.destroyed' },
    });
  });

  it('reads a stored content of another shape as invalid, never as a value', async () => {
    const keys = new FakeKeys();
    const sealer = new SubjectKeyStoreProfileContentSealer(keys);
    const wrong = await keys.encrypt(
      market,
      SELLER,
      'sellers.store-profile-revision.content' as FieldLabel,
      '{"schemaVersion":1}',
    );
    if (!wrong.ok) throw new Error('fixture failed');

    expect(await sealer.open(market, SELLER, wrong.value as SealedStoreProfileContent)).toEqual({
      ok: false,
      error: { code: 'store-profile-content.invalid' },
    });
  });
});
