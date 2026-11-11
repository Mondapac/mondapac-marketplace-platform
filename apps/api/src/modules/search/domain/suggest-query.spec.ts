import { parseSuggestQuery } from './suggest-query';

const query = (q: string | undefined) => {
  const parsed = parseSuggestQuery(q);
  if (!parsed.ok || parsed.value.kind !== 'query') throw new Error('not a query');
  return parsed.value.query;
};

describe('parseSuggestQuery', () => {
  it('answers empty (not an error) for nothing, one character, blanks and no word', () => {
    for (const q of [undefined, '', ' ', 'a', ' a ', '  ', '!!', '--']) {
      expect(parseSuggestQuery(q)).toEqual({ ok: true, value: { kind: 'empty' } });
    }
  });

  it('trims, collapses white space and lowers the case', () => {
    expect(query('  Green   TEA ').text).toBe('green tea');
  });

  it('joins every word with & and makes only the last one a prefix', () => {
    expect(query('green te').tsQuery).toBe('green & te:*');
    expect(query('te').tsQuery).toBe('te:*');
    expect(query('a b c').tsQuery).toBe('a & b & c:*');
  });

  it('keeps operators, quotes and punctuation out of the tsquery text', () => {
    const { tsQuery } = query(`o'reilly & (tea | -coffee) <-> "x":* !`);
    expect(tsQuery).toBe('o & reilly & tea & coffee & x:*');
    expect(tsQuery).not.toMatch(/[|()!"'<>-]/u);
  });

  it('keeps letters of any script and digits', () => {
    expect(query('café ١٢').tsQuery).toBe('café & ١٢:*');
  });

  it('escapes LIKE wildcards in the name patterns', () => {
    const q = query('50%_off\\');
    expect(q.startsWith).toBe('50\\%\\_off\\\\%');
    expect(q.contains).toBe('%50\\%\\_off\\\\%');
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
