import { UTS39_CONFUSABLES, UTS39_VERSION } from './generated/uts39-confusables';

// The generated table (issue #133) is the whole UTS #39 confusables.txt of the pinned version:
// regenerate it with apps/api/scripts/generate-confusables.mjs, never edit it.
describe('UTS #39 confusables table', () => {
  it('is the pinned version, complete', () => {
    expect(UTS39_VERSION).toBe('17.0.0');
    expect(UTS39_CONFUSABLES.size).toBe(6565);
  });

  it('holds known rows of the source file', () => {
    expect(UTS39_CONFUSABLES.get('а')).toBe('a'); // Cyrillic а
    expect(UTS39_CONFUSABLES.get('ɩ')).toBe('i'); // ɩ
    expect(UTS39_CONFUSABLES.get('Ꭵ')).toBe('i'); // Cherokee Ꭵ
    expect(UTS39_CONFUSABLES.get('m')).toBe('rn');
  });

  it('maps one code point to a non-empty prototype', () => {
    for (const [from, to] of UTS39_CONFUSABLES) {
      expect([...from]).toHaveLength(1);
      expect(to.length).toBeGreaterThan(0);
    }
  });
});
