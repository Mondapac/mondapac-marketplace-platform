import {
  HANDOVER_CODE_LENGTH,
  HANDOVER_MAX_FAILED_ATTEMPTS,
  handoverCodeFromRandom,
  normaliseHandoverCode,
} from './handover-code';

describe('handover code (ADR-0045 decision 2)', () => {
  it('carries at least 40 random bits in base32 (5 bits per character)', () => {
    expect(HANDOVER_CODE_LENGTH * 5).toBeGreaterThanOrEqual(40);
    const code = handoverCodeFromRandom(
      Uint8Array.from({ length: HANDOVER_CODE_LENGTH }, (_, i) => i * 7),
    );

    expect(code.replace('-', '')).toMatch(/^[A-Z2-7]{10}$/);
  });

  it('maps every random byte to one character without bias (256 is a multiple of 32)', () => {
    const counts = new Map<string, number>();
    for (let byte = 0; byte < 256; byte += 1) {
      const code = handoverCodeFromRandom(new Uint8Array(HANDOVER_CODE_LENGTH).fill(byte));
      counts.set(code[0]!, (counts.get(code[0]!) ?? 0) + 1);
    }

    expect(counts.size).toBe(32);
    expect(new Set(counts.values())).toEqual(new Set([8]));
  });

  it('refuses fewer random bytes than the code needs', () => {
    expect(() => handoverCodeFromRandom(new Uint8Array(HANDOVER_CODE_LENGTH - 1))).toThrow(
      RangeError,
    );
  });

  it('is shown in two groups and read back whatever the case, spacing or hyphen', () => {
    const shown = handoverCodeFromRandom(new Uint8Array(HANDOVER_CODE_LENGTH).fill(1));

    expect(shown).toBe('BBBBB-BBBBB');
    for (const typed of ['bbbbb-bbbbb', ' BBBBB BBBBB ', 'bbbbbbbbbb', 'BBBBB-BBBBB']) {
      expect(normaliseHandoverCode(typed)).toBe('BBBBBBBBBB');
    }
  });

  it.each(['', 'BBBBB-BBBB', 'BBBBB-BBBBBB', 'BBBBB-BBBB1', 'BBBBB-BBBB8', 'BBBBB-BBBBÜ', 7, null])(
    'rejects %p as malformed',
    (typed) => {
      expect(normaliseHandoverCode(typed)).toBeNull();
    },
  );

  it('voids the code from the fifth failed attempt', () => {
    expect(HANDOVER_MAX_FAILED_ATTEMPTS).toBe(5);
  });
});
