import { parseSuggestQuery } from './suggest-query';

const query = (q: string | undefined) => {
  const parsed = parseSuggestQuery(q);
  if (!parsed.ok || parsed.value.kind !== 'query') throw new Error('not a query');
  return parsed.value.query;
};

describe('parseSuggestQuery', () => {
  it('answers empty (not an error) for nothing, one character, blanks and no word', () => {
    for (const q of [
      undefined,
      '',
      ' ',
      'a',
      ' a ',
      '  ',
      '!!',
      '--',
      'a-',
      'a!',
      'a\u200b',
      '-b',
      'e\u0301',
      '\u200b\u200b',
    ]) {
      expect(parseSuggestQuery(q)).toEqual({ ok: true, value: { kind: 'empty' } });
    }
  });

  it('counts letters and digits for the 2-character rule, so "a b" is a query', () => {
    expect(query('a b').tsQuery).toBe('a & b');
    expect(query('e\u0301e').text).toBe('ée');
    expect(query('a-b').words).toEqual(['a', 'b']);
  });

  it('adds the prefix only when the last word has 2 letters or digits', () => {
    expect(query('tea b').tsQuery).toBe('tea & b');
    expect(query('tea bo').tsQuery).toBe('tea & bo:*');
    expect(query('b tea').tsQuery).toBe('b & tea:*');
    expect(query('tea b').nameQuery).toBe('tea:A & b:A');
    expect(query('green te').nameQuery).toBe('green:A & te:*A');
  });

  it('normalises to NFC and keeps combining marks inside words', () => {
    expect(query('cafe\u0301').words).toEqual(['café']);
    expect(query('cafe\u0301').tsQuery).toBe('café:*');
    // Marks stay in the word (one word, never split at a mark).
    expect(query('x\u0323y\u0303').words).toEqual(['x\u0323y\u0303'.normalize('NFC')]);
  });

  it('gives the same canonical query for punctuation and case variants', () => {
    const a = query('Green  Tea');
    for (const variant of ['green-tea', ' GREEN, tea! ', 'green_tea'.replace('_', ' ')]) {
      expect(query(variant).tsQuery).toBe(a.tsQuery);
      expect(query(variant).startsWith).toBe(a.startsWith);
    }
  });

  it('trims, collapses white space and lowers the case', () => {
    expect(query('  Green   TEA ').text).toBe('green tea');
  });

  it('joins every word with & and makes only the last one a prefix', () => {
    expect(query('green te').tsQuery).toBe('green & te:*');
    expect(query('te').tsQuery).toBe('te:*');
    expect(query('a b cd').tsQuery).toBe('a & b & cd:*');
  });

  it('keeps operators, quotes and punctuation out of the tsquery text', () => {
    const { tsQuery } = query(`o'reilly & (tea | -coffee) <-> "xy":* !`);
    expect(tsQuery).toBe('o & reilly & tea & coffee & xy:*');
    expect(tsQuery).not.toMatch(/[|()!"'<>-]/u);
  });

  it('keeps letters of any script and digits', () => {
    expect(query('café ١٢').tsQuery).toBe('café & ١٢:*');
  });

  it('escapes LIKE wildcards in the name patterns', () => {
    const q = query('50%_off\\');
    expect(q.words).toEqual(['50', 'off']);
    expect(q.startsWith).toBe('50 off%');
    expect(q.firstWordStarts).toBe('50%');
    // Wildcards never reach the words, so nothing is left to escape: they are cut like punctuation.
    expect(query('x%y').contains).toBe('%x y%');
  });

  it('refuses a control character, a long text and a long chain of words', () => {
    expect(parseSuggestQuery('tea\u0000')).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'q', code: 'format' }] },
    });
    expect(parseSuggestQuery('x'.repeat(101))).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'q', code: 'too-long' }] },
    });
    expect(parseSuggestQuery('x'.repeat(100)).ok).toBe(true);
    expect(parseSuggestQuery(Array.from({ length: 9 }, (_, n) => `w${n}`).join(' '))).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'q', code: 'too-many-terms' }] },
    });
  });
});
