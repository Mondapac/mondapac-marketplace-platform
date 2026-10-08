import { createHmac } from 'node:crypto';
import { ok, err } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { PLATFORM_TENANT_ID } from '../../../platform/market-context/tenant';
import type { FieldLabel, HashPurpose } from '../../../platform/subject-keys/labels';
import type { Keyed, SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import { CONTENT_SCHEMA_VERSION, type BusinessFileContent } from '../domain/business-file-revision';
import type { SealedRevisionContent } from '../domain/sealed';
import { SubjectKeyRevisionContentSealer } from './subject-key-revision-content-sealer';

// The sealer of revision content (data design 3.2, 4.2; design 2.4 rule 2) on a fake key service
// that records the label and purpose it was given. The real key service is exercised against
// PostgreSQL in test/db/sellers-business-file-revisions.db-spec.ts.

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

const content = (overrides: Partial<BusinessFileContent> = {}): BusinessFileContent => ({
  schemaVersion: CONTENT_SCHEMA_VERSION,
  storeName: 'Al Noor',
  businessName: 'Al Noor Trading',
  phone: '+61700000000',
  contactEmail: null,
  address: { street: '1 Example St', postcode: '4109' },
  registeredAddress: null,
  identifier: { scheme: 'abn', value: '51824753556' },
  registeredForIndirectTax: true,
  ...overrides,
});

describe.each(TEST_MARKETS)('SubjectKeyRevisionContentSealer in market %s', (code) => {
  const market = testMarketContext(code, PLATFORM_TENANT_ID);
  const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', PLATFORM_TENANT_ID);

  it('seals under the content label and hashes under the content purpose, then opens it again', async () => {
    const keys = new FakeKeys();
    const sealer = new SubjectKeyRevisionContentSealer(keys);

    const sealed = await sealer.seal(market, SELLER, content());

    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;
    expect(keys.labels).toEqual(['sellers.business-file-revision.content']);
    expect(keys.purposes).toEqual(['sellers.business-file.content']);
    expect(sealed.value.contentHash).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    // The ciphertext carries no clear value of the content in this fake's envelope shape either.
    expect(sealed.value.ciphertext.startsWith('v1.')).toBe(true);
    expect(await sealer.open(market, SELLER, sealed.value.ciphertext)).toEqual(ok(content()));
  });

  it('gives the same hash for the same content whatever the order of its keys, and another for another content', async () => {
    const sealer = new SubjectKeyRevisionContentSealer(new FakeKeys());
    const reversed = Object.fromEntries(
      Object.entries(content()).reverse(),
    ) as unknown as BusinessFileContent;

    const a = await sealer.hash(market, SELLER, content());
    const b = await sealer.hash(market, SELLER, reversed);
    const c = await sealer.hash(market, SELLER, content({ phone: '+61700000001' }));

    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    // The hash is keyed by Market and seller: it cannot be compared across them.
    expect(await sealer.hash(other, SELLER, content())).not.toEqual(a);
  });

  it('hashes what it sealed, so an opened content proves the recorded hash', async () => {
    const sealer = new SubjectKeyRevisionContentSealer(new FakeKeys());
    const sealed = await sealer.seal(market, SELLER, content());
    if (!sealed.ok) throw new Error('fixture failed');
    const opened = await sealer.open(market, SELLER, sealed.value.ciphertext);
    if (!opened.ok) throw new Error('fixture failed');
    expect(await sealer.hash(market, SELLER, opened.value)).toEqual(ok(sealed.value.contentHash));
  });

  it('refuses a content the encoding cannot carry, before any key is used', async () => {
    const keys = new FakeKeys();
    const sealer = new SubjectKeyRevisionContentSealer(keys);
    const result = await sealer.seal(market, SELLER, content({ storeName: '\ud800' }));
    expect(result).toEqual({ ok: false, error: { code: 'revision-content.invalid' } });
    expect(keys.labels).toEqual([]);
    expect(keys.purposes).toEqual([]);
  });

  it('reads a stored content of another shape as invalid, never as a value', async () => {
    const keys = new FakeKeys();
    const sealer = new SubjectKeyRevisionContentSealer(keys);
    const wrong = await keys.encrypt(
      market,
      SELLER,
      'sellers.business-file-revision.content' as FieldLabel,
      '{"schemaVersion":1}',
    );
    if (!wrong.ok) throw new Error('fixture failed');
    expect(await sealer.open(market, SELLER, wrong.value as SealedRevisionContent)).toEqual({
      ok: false,
      error: { code: 'revision-content.invalid' },
    });
  });

  it('answers subject-key.destroyed after the key is destroyed, for seal, open and hash', async () => {
    const keys = new FakeKeys();
    const sealer = new SubjectKeyRevisionContentSealer(keys);
    const sealed = await sealer.seal(market, SELLER, content());
    if (!sealed.ok) throw new Error('fixture failed');
    await keys.destroyKey();
    const destroyed = { ok: false, error: { code: 'subject-key.destroyed' } };
    expect(await sealer.seal(market, SELLER, content())).toEqual(destroyed);
    expect(await sealer.open(market, SELLER, sealed.value.ciphertext)).toEqual(destroyed);
    expect(await sealer.hash(market, SELLER, content())).toEqual(destroyed);
  });
});
