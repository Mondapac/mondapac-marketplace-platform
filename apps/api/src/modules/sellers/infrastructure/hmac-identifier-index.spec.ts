import { createHmac, hkdfSync } from 'node:crypto';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import type { NormalisedIdentifier } from '../domain/business-identifier';
import { HmacIdentifierIndex } from './hmac-identifier-index';
import { HmacRateCounterKeys } from './hmac-rate-counter-keys';

// IdentifierIndex (sellers design 8.2; data design S5, 4.4): keyed, bound to Market and scheme.

const secret = new Uint8Array(32).fill(7);
const au = testMarketContext('AU', 'default');
const zz = testMarketContext('ZZ', 'default');
const value = '51824753556' as NormalisedIdentifier;
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('HmacIdentifierIndex', () => {
  const index = new HmacIdentifierIndex(secret);

  it('is 32 bytes and deterministic', () => {
    const first = index.of(au, 'abn', value);
    expect(first).toHaveLength(32);
    expect(hex(index.of(au, 'abn', value))).toBe(hex(first));
  });

  it('collides for equal values in one Market and scheme, and only there', () => {
    const base = hex(index.of(au, 'abn', value));
    expect(hex(index.of(au, 'abn', '51824753557' as NormalisedIdentifier))).not.toBe(base);
    // The same text in another Market (AC 21) or under another scheme is another index.
    expect(hex(index.of(zz, 'abn', value))).not.toBe(base);
    expect(hex(index.of(au, 'zz-corp-no', value))).not.toBe(base);
  });

  it('cannot be reproduced without the secret, nor with another secret', () => {
    const other = new HmacIdentifierIndex(new Uint8Array(32).fill(8));
    expect(hex(other.of(au, 'abn', value))).not.toBe(hex(index.of(au, 'abn', value)));
  });

  it('uses the HKDF label sellers.identifier-index, distinct from the rate-counter key', () => {
    const derived = Buffer.from(
      hkdfSync('sha256', secret, new Uint8Array(0), 'sellers.identifier-index', 32),
    );
    const rateCounterDerived = Buffer.from(
      hkdfSync('sha256', secret, new Uint8Array(0), 'sellers.rate-counter', 32),
    );
    expect(derived.equals(rateCounterDerived)).toBe(false);
    // Computing the message by hand with the labelled key gives the index.
    const expected = createHmac('sha256', derived)
      .update(JSON.stringify(['AU', 'abn', value]))
      .digest('hex');
    expect(hex(index.of(au, 'abn', value))).toBe(expected);
    // And the rate-counter key over the same text gives something else.
    const counters = new HmacRateCounterKeys(secret);
    expect(hex(counters.keyOf(au, 'save.account.minute', value))).not.toBe(expected);
  });

  it('refuses a secret that is not 32 bytes and empty inputs', () => {
    expect(() => new HmacIdentifierIndex(new Uint8Array(31))).toThrow(TypeError);
    expect(() => index.of(au, '', value)).toThrow(TypeError);
    expect(() => index.of(au, 'abn', '' as NormalisedIdentifier)).toThrow(TypeError);
  });
});
