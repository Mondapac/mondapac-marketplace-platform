import { TEST_CODE_PEPPER } from '../../../../test/support/test-config';
import { CryptoBatchCodeCrypto } from './crypto-batch-code-crypto';

describe('CryptoBatchCodeCrypto', () => {
  const crypto = new CryptoBatchCodeCrypto(TEST_CODE_PEPPER);
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  it('draws codes of the asked length from the alphabet only', () => {
    for (let i = 0; i < 200; i++) {
      const code = crypto.generate(ALPHABET, 12);
      expect(code).toHaveLength(12);
      expect([...code].every((ch) => ALPHABET.includes(ch))).toBe(true);
    }
  });

  it('does not repeat in a large sample and uses the whole alphabet evenly enough', () => {
    const seen = new Set<string>();
    const counts = new Map<string, number>();
    for (let i = 0; i < 4000; i++) {
      const code = crypto.generate(ALPHABET, 12);
      seen.add(code);
      for (const ch of code) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(seen.size).toBe(4000);
    expect(counts.size).toBe(ALPHABET.length);
    // 48 000 characters over 32 symbols is 1 500 each; far outside this band would be a bias.
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(1200);
      expect(count).toBeLessThan(1800);
    }
  });

  it('hashes with HMAC-SHA256 keyed by the pepper, in lower-case hex', () => {
    // HMAC-SHA256 of "ABC" under the test pepper (computed independently).
    expect(crypto.hash('ABC')).toBe(
      'aa3dc81361d3961c12b8f197a90590f814857c45e0e4a65c0acfc5ea7d828baa',
    );
    expect(crypto.hash('ABC')).toMatch(/^[0-9a-f]{64}$/);
    expect(crypto.hash('ABC')).toBe(crypto.hash('ABC'));
    expect(crypto.hash('ABC')).not.toBe(crypto.hash('ABD'));
  });

  it('gives another hash under another pepper, so the table alone cannot test guesses', () => {
    const other = new CryptoBatchCodeCrypto(`${TEST_CODE_PEPPER}-other`);
    expect(other.hash('ABC')).not.toBe(crypto.hash('ABC'));
    // The unkeyed SHA-256 of "ABC" is not what is stored.
    expect(crypto.hash('ABC')).not.toBe(
      'b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78',
    );
  });

  it('is unavailable without a long enough pepper, and then refuses to hash', () => {
    for (const pepper of [null, '', 'short', 'x'.repeat(31)]) {
      const none = new CryptoBatchCodeCrypto(pepper);
      expect(none.available).toBe(false);
      expect(() => none.hash('ABC')).toThrow();
    }
    expect(new CryptoBatchCodeCrypto('x'.repeat(32)).available).toBe(true);
    expect(crypto.available).toBe(true);
  });
});
