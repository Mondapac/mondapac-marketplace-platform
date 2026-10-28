import { CryptoBatchCodeCrypto } from './crypto-batch-code-crypto';

describe('CryptoBatchCodeCrypto', () => {
  const crypto = new CryptoBatchCodeCrypto();
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

  it('hashes with SHA-256 in lower-case hex, the same code to the same hash', () => {
    // SHA-256 of "ABC".
    expect(crypto.hash('ABC')).toBe(
      'b5d4045c3f466fa91fe2cc6abe79232a1a57cdf104f7a26e716e0a1e2789df78',
    );
    expect(crypto.hash('ABC')).toBe(crypto.hash('ABC'));
    expect(crypto.hash('ABC')).not.toBe(crypto.hash('ABD'));
  });
});
