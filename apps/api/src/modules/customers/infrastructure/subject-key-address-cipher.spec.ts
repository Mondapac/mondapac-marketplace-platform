import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type { AddressContent } from '../domain/address';
import { SubjectKeyAddressCipher } from './subject-key-address-cipher';

// The address is sealed as its canonical JSON under the account (the subject) and the
// `customers.address.content` label; a destroyed key is passed on, never read as an address.

const ACCOUNT = '01990000-0000-7000-8000-0000000000a1' as Id<'Account'>;
const CONTENT: AddressContent = {
  recipientFirstName: 'Aisha',
  recipientLastName: 'Rahman',
  phone: '0412345678',
  line1: '12 Example Street',
  line2: null,
  suburb: 'Sunnybank',
  region: 'QLD',
  postcode: '4109',
  deliveryNotes: null,
};

describe('SubjectKeyAddressCipher', () => {
  const market = testMarketContext('AU', 'default');
  const calls: { op: string; subject: string; label: string }[] = [];
  let destroyed = false;
  const keys = {
    encrypt: (_m: MarketContext, subject: string, label: string, plain: string) => {
      calls.push({ op: 'encrypt', subject, label });
      return Promise.resolve(
        destroyed
          ? err({ code: 'subject-key.destroyed' })
          : ok(`v1.${Buffer.from(plain).toString('base64url')}`),
      );
    },
    decrypt: (_m: MarketContext, subject: string, label: string, cipher: string) => {
      calls.push({ op: 'decrypt', subject, label });
      return Promise.resolve(
        destroyed
          ? err({ code: 'subject-key.destroyed' })
          : ok(Buffer.from(cipher.slice(3), 'base64url').toString()),
      );
    },
  } as unknown as SubjectKeyService;
  const cipher = new SubjectKeyAddressCipher(keys);

  beforeEach(() => {
    calls.length = 0;
    destroyed = false;
  });

  it('seals and opens under the account and the address label', async () => {
    const sealed = await cipher.seal(market, ACCOUNT, CONTENT);
    if (!sealed.ok) throw new Error('seal');
    expect(await cipher.open(market, ACCOUNT, sealed.value)).toEqual(ok(CONTENT));
    expect(calls).toEqual([
      { op: 'encrypt', subject: ACCOUNT, label: 'customers.address.content' },
      { op: 'decrypt', subject: ACCOUNT, label: 'customers.address.content' },
    ]);
  });

  it('passes on a destroyed key', async () => {
    destroyed = true;
    expect(await cipher.seal(market, ACCOUNT, CONTENT)).toEqual(
      err({ code: 'subject-key.destroyed' }),
    );
    expect(await cipher.open(market, ACCOUNT, 'v1.x')).toEqual(
      err({ code: 'subject-key.destroyed' }),
    );
  });
});
