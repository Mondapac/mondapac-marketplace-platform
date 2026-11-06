import { parseFilters } from './search-filter';

const value = (request: Parameters<typeof parseFilters>[0]) => {
  const result = parseFilters(request);
  if (!result.ok) throw new Error(`refused: ${result.error.path} ${result.error.code}`);
  return result.value;
};
const refused = (request: Parameters<typeof parseFilters>[0]) => {
  const result = parseFilters(request);
  return result.ok ? null : result.error;
};
const many = (n: number, build: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => build(i));

describe('parseFilters', () => {
  it('reads choices, a yes switch and ranges, one parameter per attribute', () => {
    expect(
      value({
        filter: ['pack-size:kg1,kg5', 'organic:true', 'brand:al-safa'],
        range: 'weight:100..500',
      }),
    ).toEqual({
      choices: [
        { attr: 'pack-size', values: ['kg1', 'kg5'] },
        { attr: 'organic', values: ['true'] },
        { attr: 'brand', values: ['al-safa'] },
      ],
      ranges: [{ attr: 'weight', min: '100', max: '500' }],
    });
  });

  it('accepts a single string, an absent parameter and one open end of a range', () => {
    expect(value({})).toEqual({ choices: [], ranges: [] });
    expect(value({ filter: 'a:b' }).choices).toHaveLength(1);
    expect(value({ range: ['w:..5.5', 'x:-2.25..'] }).ranges).toEqual([
      { attr: 'w', min: null, max: '5.5' },
      { attr: 'x', min: '-2.25', max: null },
    ]);
  });

  it('collapses repeated values and refuses a repeated attribute', () => {
    expect(value({ filter: 'a:b,b,c' }).choices[0]?.values).toEqual(['b', 'c']);
    expect(refused({ filter: ['a:b', 'a:c'] })).toEqual({ path: 'filter', code: 'repeated' });
    expect(refused({ filter: 'a:b', range: 'a:1..2' })).toEqual({
      path: 'range',
      code: 'repeated',
    });
  });

  it.each([
    ['no colon', { filter: 'abc' }, 'filter'],
    ['upper case attribute', { filter: 'Abc:x' }, 'filter'],
    ['empty value', { filter: 'a:' }, 'filter'],
    ['a label with a space', { filter: 'a:Dry Goods' }, 'filter'],
    ['a facet separator in a value', { filter: 'a:b=c' }, 'filter'],
    ['a range without dots', { range: 'a:5' }, 'range'],
    ['an empty range', { range: 'a:..' }, 'range'],
    ['text in a range', { range: 'a:1..x' }, 'range'],
    ['an exponent', { range: 'a:1e5..2e5' }, 'range'],
    ['a reversed range', { range: 'a:5..1' }, 'range'],
  ])('refuses %s', (_name, request, path) => {
    expect(refused(request)?.path).toBe(path);
  });

  it('caps the number of filters, ranges and values', () => {
    expect(refused({ filter: many(9, (i) => `a${i}:x`) })).toEqual({
      path: 'filter',
      code: 'too-many',
    });
    expect(refused({ range: many(4, (i) => `a${i}:1..2`) })).toEqual({
      path: 'range',
      code: 'too-many',
    });
    expect(refused({ filter: `a:${many(51, (i) => `v${i}`).join(',')}` })).toEqual({
      path: 'filter',
      code: 'too-many',
    });
    expect(refused({ filter: many(21, (i) => `a${i}:x`) })?.code).toBe('too-many');
  });

  it('refuses a parameter that is not a string', () => {
    expect(refused({ filter: [1] as unknown as string[] })).toEqual({
      path: 'filter',
      code: 'format',
    });
    expect(refused({ filter: { a: 'b' } as unknown as string })).toEqual({
      path: 'filter',
      code: 'format',
    });
  });
});
