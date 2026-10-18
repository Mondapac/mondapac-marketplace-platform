import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import type { SubjectKeyService } from '../../../platform/subject-keys/subject-key-service';
import type { ShipTo } from '../domain/order';
import { shipToFromJson, SubjectKeyShipToCipher } from './subject-key-ship-to-cipher';

// The order's address is sealed as its canonical JSON under the customer account (the subject)
// and the `ordering.order.ship-to` label; a destroyed key is passed on, never read as an address.

const ACCOUNT = '01990000-0000-7000-8000-0000000000a1' as Id<'Account'>;
const SHIP_TO: ShipTo = {
  recipientFirstName: 'Aisha',
  recipientLastName: 'Rahman',
  phone: '0412345678',
  line1: '12 Example Street',
  line2: null,
  suburb: 'Sunnybank',
  region: 'QLD',
  postcode: '4109',
  deliveryNotes: 'Leave at the door',
  countryCode: 'AU',
};

describe('SubjectKeyShipToCipher', () => {
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
  const cipher = new SubjectKeyShipToCipher(keys);

  beforeEach(() => {
    calls.length = 0;
    destroyed = false;
  });

  it('seals and opens under the account and the ship-to label', async () => {
    const sealed = await cipher.seal(market, ACCOUNT, SHIP_TO);
    if (!sealed.ok) throw new Error('seal');
    expect(await cipher.open(market, ACCOUNT, sealed.value)).toEqual(ok(SHIP_TO));
    expect(calls).toEqual([
      { op: 'encrypt', subject: ACCOUNT, label: 'ordering.order.ship-to' },
      { op: 'decrypt', subject: ACCOUNT, label: 'ordering.order.ship-to' },
    ]);
  });

  it('passes on a destroyed key', async () => {
    destroyed = true;
    expect(await cipher.seal(market, ACCOUNT, SHIP_TO)).toEqual(
      err({ code: 'subject-key.destroyed' }),
    );
    expect(await cipher.open(market, ACCOUNT, 'v1.x')).toEqual(
      err({ code: 'subject-key.destroyed' }),
    );
  });

  it('refuses a stored address of the wrong shape instead of guessing', () => {
    expect(() => shipToFromJson('[]')).toThrow('ordering.stored-ship-to-invalid');
    expect(() => shipToFromJson(JSON.stringify({ ...SHIP_TO, phone: null }))).toThrow(
      'ordering.stored-ship-to-invalid',
    );
  });
});
