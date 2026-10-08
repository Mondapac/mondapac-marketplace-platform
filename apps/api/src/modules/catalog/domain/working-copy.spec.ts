import { MAX_WORKING_COPY_CONTENT_BYTES, isStorableContent } from './working-copy';

describe('isStorableContent', () => {
  it('accepts a plain object', () => {
    expect(isStorableContent({ texts: { en: { name: 'Dates' } } })).toBe(true);
    expect(isStorableContent({})).toBe(true);
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'x'],
    ['a number', 1],
  ])('refuses %s', (_name, value) => {
    expect(isStorableContent(value)).toBe(false);
  });

  it('refuses what does not serialise: a BigInt and a cycle', () => {
    expect(isStorableContent({ a: 1n })).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(isStorableContent(cyclic)).toBe(false);
  });

  it('refuses U+0000 anywhere, which jsonb cannot store', () => {
    expect(isStorableContent({ a: 'x\u0000y' })).toBe(false);
    expect(isStorableContent({ 'k\u0000': 1 })).toBe(false);
    expect(isStorableContent({ a: { b: ['\u0000'] } })).toBe(false);
  });

  it('refuses an unpaired surrogate in a string or a key, and accepts a pair', () => {
    expect(isStorableContent({ a: '\ud800' })).toBe(false);
    expect(isStorableContent({ a: 'x\udc00' })).toBe(false);
    expect(isStorableContent({ '\ud800': 1 })).toBe(false);
    expect(isStorableContent({ a: '😀' })).toBe(true);
  });

  it('accepts the text of an escaped NUL (backslash, u, 0000), which is not a NUL', () => {
    expect(isStorableContent({ a: String.raw`\u0000` })).toBe(true);
  });

  it('measures the cap in UTF-8 bytes, inclusive', () => {
    const overhead = Buffer.byteLength(JSON.stringify({ t: '' }), 'utf8');
    const exact = { t: 'a'.repeat(MAX_WORKING_COPY_CONTENT_BYTES - overhead) };
    expect(isStorableContent(exact)).toBe(true);
    expect(isStorableContent({ t: `${exact.t}a` })).toBe(false);
    // 2 bytes per character: fewer characters than the cap, more bytes than it.
    const persian = { t: 'ب'.repeat(MAX_WORKING_COPY_CONTENT_BYTES / 2) };
    expect(isStorableContent(persian)).toBe(false);
  });
});
