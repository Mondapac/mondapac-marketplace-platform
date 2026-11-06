import { parseId } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testMarketContext } from '@mondapac/shared-kernel/testing';
import { normaliseHandoverCode } from '../../domain/handover-code';
import { HmacHandoverCodes } from './hmac-handover-codes';

const secret = new Uint8Array(32).fill(5);
const idOf = (text: string) => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Invitation'>;
};
const FIRST = idOf('01990000-0000-7000-8000-0000000000c1');
const SECOND = idOf('01990000-0000-7000-8000-0000000000c2');

describe.each(['AU', 'ZZ'])('HmacHandoverCodes in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const codes = new HmacHandoverCodes(secret);

  it('issues a code that normalises, and a different one every time', () => {
    const first = codes.issue();
    expect(normaliseHandoverCode(first)).not.toBeNull();
    expect(codes.issue()).not.toBe(first);
  });

  it('matches only the code, the invitation and the Market it was made for', () => {
    const normalised = normaliseHandoverCode(codes.issue())!;
    const stored = codes.hmacOf(market, FIRST, normalised);

    expect(stored).toHaveLength(32);
    expect(codes.matches(market, FIRST, normalised, stored)).toBe(true);
    expect(codes.matches(market, SECOND, normalised, stored)).toBe(false);
    expect(codes.matches(market, FIRST, 'AAAAAAAAAA', stored)).toBe(false);
    const other = testMarketContext(code === 'AU' ? 'ZZ' : 'AU', 'default');
    expect(codes.matches(other, FIRST, normalised, stored)).toBe(false);
    expect(codes.matches(market, FIRST, normalised, stored.slice(1))).toBe(false);
  });

  it('is keyed: another stack secret never matches', () => {
    const stored = codes.hmacOf(market, FIRST, 'ABCDEFGHIJ');
    const elsewhere = new HmacHandoverCodes(new Uint8Array(32).fill(6));

    expect(elsewhere.matches(market, FIRST, 'ABCDEFGHIJ', stored)).toBe(false);
  });

  it('refuses a stack secret of the wrong size', () => {
    expect(() => new HmacHandoverCodes(new Uint8Array(16))).toThrow(TypeError);
  });
});
