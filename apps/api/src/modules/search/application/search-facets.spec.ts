import type { Id } from '@mondapac/shared-kernel';
import {
  buildFilterViews,
  choiceGroups,
  countFacets,
  effectiveSelection,
  numberBounds,
} from './search-facets';
import type { FilterDefinition } from './ports/search-filters';

const product = (n: number) => `0199-product-${n}` as unknown as Id<'Product'>;
const rows = [
  { productId: product(1), facets: ['diet=halal', 'diet=vegan', 'size=s'] },
  { productId: product(2), facets: ['diet=halal', 'size=m'] },
  { productId: product(3), facets: ['diet=vegan', 'size=m'] },
  { productId: product(1), facets: ['diet=halal', 'size=s'] }, // a second Offer of product 1
];

const diet: FilterDefinition = {
  code: 'diet',
  name: 'Diet',
  kind: 'choice',
  options: [
    { code: 'halal', label: 'Halal' },
    { code: 'vegan', label: 'Vegan' },
    { code: 'kosher', label: 'Kosher' },
  ],
  redirects: { 'old-halal': 'halal' },
};
const size: FilterDefinition = {
  code: 'size',
  name: 'Size',
  kind: 'choice',
  options: [
    { code: 's', label: 'Small' },
    { code: 'm', label: 'Medium' },
  ],
  redirects: {},
};
const organic: FilterDefinition = {
  code: 'organic',
  name: 'Organic',
  kind: 'toggle',
  options: [],
  redirects: {},
};
const weight: FilterDefinition = {
  code: 'weight',
  name: 'Weight',
  kind: 'range',
  options: [],
  redirects: {},
};
const definitions = new Map([diet, size, organic, weight].map((d) => [d.code, d]));

describe('effectiveSelection', () => {
  it('keeps only the filters the listing offers, by kind, and maps merged options to their target', () => {
    const selection = effectiveSelection(
      {
        choices: [
          { attr: 'diet', values: ['old-halal', 'halal', 'vegan'] },
          { attr: 'unknown', values: ['x'] },
          { attr: 'organic', values: ['true'] },
          { attr: 'weight', values: ['x'] },
        ],
        ranges: [
          { attr: 'weight', min: '1', max: null },
          { attr: 'diet', min: '1', max: '2' },
        ],
      },
      definitions,
    );
    expect(selection).toEqual({
      choices: [
        { attr: 'diet', values: ['halal', 'vegan'] },
        { attr: 'organic', values: ['true'] },
      ],
      ranges: [{ attr: 'weight', min: '1', max: null }],
    });
    expect(choiceGroups(selection)).toEqual([['diet=halal', 'diet=vegan'], ['organic=true']]);
  });

  it('takes a yes switch only for true', () => {
    expect(
      effectiveSelection(
        { choices: [{ attr: 'organic', values: ['false'] }], ranges: [] },
        definitions,
      ).choices,
    ).toEqual([]);
  });
});

describe('countFacets', () => {
  it('counts products, not Offers', () => {
    const counts = countFacets(rows, [], ['diet', 'size']);
    expect(counts.get('diet=halal')).toBe(2);
    expect(counts.get('diet=vegan')).toBe(2);
    expect(counts.get('size=s')).toBe(1);
    expect(counts.get('size=m')).toBe(2);
  });

  it("ignores an attribute's own filter but applies the others", () => {
    const choices = [
      { attr: 'diet', values: ['halal'] },
      { attr: 'size', values: ['m'] },
    ];
    const counts = countFacets(rows, choices, ['diet', 'size']);
    // diet counts see size=m only: product 2 (halal) and product 3 (vegan).
    expect(counts.get('diet=halal')).toBe(1);
    expect(counts.get('diet=vegan')).toBe(1);
    // size counts see diet=halal only: products 1 and 2.
    expect(counts.get('size=s')).toBe(1);
    expect(counts.get('size=m')).toBe(1);
  });
});

describe('numberBounds', () => {
  it('reads the lowest and highest number per attribute and ignores junk', () => {
    expect(
      numberBounds([
        { attr: 'weight', value: '250.000000000' },
        { attr: 'weight', value: '1000.500000000' },
        { attr: 'weight', value: 'x' },
        { attr: 'cups', value: '2.000000000' },
      ]),
    ).toEqual(
      new Map([
        ['weight', { min: '250', max: '1000.5' }],
        ['cups', { min: '2', max: '2' }],
      ]),
    );
  });
});

describe('buildFilterViews', () => {
  const counts = countFacets(rows, [], ['diet', 'size', 'organic']);
  const base = {
    definitions: [diet, size, organic, weight],
    counts,
    counted: true,
    bounds: new Map(),
  };

  it('hides zero-count values and filters with nothing to offer', () => {
    const views = buildFilterViews({ ...base, selection: { choices: [], ranges: [] } });
    expect(views.map((v) => v.code)).toEqual(['diet', 'size']);
    expect(views[0]?.options.map((o) => [o.code, o.count])).toEqual([
      ['halal', 2],
      ['vegan', 2],
    ]);
  });

  it('keeps a picked value even with no product, so it can be unpicked', () => {
    const views = buildFilterViews({
      ...base,
      selection: { choices: [{ attr: 'diet', values: ['kosher'] }], ranges: [] },
    });
    const kosher = views[0]?.options.find((o) => o.code === 'kosher');
    expect(kosher).toEqual({ code: 'kosher', label: 'Kosher', count: 0, selected: true });
  });

  it('shows a range with its bounds and picked values, and no counts when the scope was cut', () => {
    const views = buildFilterViews({
      definitions: [weight, diet],
      selection: { choices: [], ranges: [{ attr: 'weight', min: '5', max: null }] },
      counts: new Map(),
      counted: false,
      bounds: new Map([['weight', { min: '1', max: '9' }]]),
    });
    expect(views[0]).toMatchObject({
      code: 'weight',
      kind: 'range',
      bounds: { min: '1', max: '9' },
      picked: { min: '5', max: null },
    });
    expect(views[1]?.options.every((o) => o.count === null)).toBe(true);
    expect(views[1]?.options).toHaveLength(3);
  });

  it('turns a yes switch into one option when some product is yes', () => {
    const views = buildFilterViews({
      definitions: [organic],
      selection: { choices: [], ranges: [] },
      counts: new Map([['organic=true', 4]]),
      counted: true,
      bounds: new Map(),
    });
    expect(views[0]?.options).toEqual([
      { code: 'true', label: 'Organic', count: 4, selected: false },
    ]);
  });
});
