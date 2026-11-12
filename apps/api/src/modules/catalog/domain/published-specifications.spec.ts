import {
  buildPublishedSpecifications,
  type SpecificationDefinition,
  type SpecificationOption,
} from './published-specifications';

// The product page's specifications from a published revision (attributes A6): what is shown,
// in what order, in which locale, and what is never shown.

const LOCALES = { requested: 'fa-IR', fallback: 'en-AU' };

const def = (over: Partial<SpecificationDefinition> = {}): SpecificationDefinition => ({
  dataType: 'text',
  localizable: false,
  status: 'active',
  showOnProductPage: true,
  names: { 'en-AU': 'Name' },
  options: new Map(),
  ...over,
});
const entry = (code: string, isVariantOption = false) => ({
  code,
  required: false,
  isVariantOption,
});

function build(
  values: Record<string, unknown>,
  definitions: Record<string, SpecificationDefinition>,
  groups = [{ groupCode: 'details', attributes: Object.keys(definitions).map((c) => entry(c)) }],
) {
  return buildPublishedSpecifications({
    groups,
    values,
    definitions: new Map(Object.entries(definitions)),
    locales: LOCALES,
  });
}

describe('buildPublishedSpecifications', () => {
  it('lists values by family group and attribute order, with the name in the fallback locale', () => {
    const out = build(
      { origin: 'Iran', roast: 'dark' },
      {
        origin: def({ names: { 'en-AU': 'Country of origin' } }),
        roast: def({
          dataType: 'select',
          names: { 'en-AU': 'Roast', 'fa-IR': 'برشته' },
          options: new Map([
            ['dark', { labels: { 'en-AU': 'Dark', 'fa-IR': 'تیره' }, mergedInto: null }],
          ]),
        }),
      },
      [
        { groupCode: 'details', attributes: [entry('roast')] },
        { groupCode: 'general', attributes: [entry('origin')] },
      ],
    );
    expect(out).toEqual([
      {
        groupCode: 'details',
        specifications: [{ code: 'roast', name: 'برشته', value: { kind: 'text', text: 'تیره' } }],
      },
      {
        groupCode: 'general',
        specifications: [
          { code: 'origin', name: 'Country of origin', value: { kind: 'text', text: 'Iran' } },
        ],
      },
    ]);
  });

  it('leaves out drafts, attributes hidden from the product page, brand, long text and variant options', () => {
    const out = build(
      { a: 'x', b: 'x', brand: 'Acme', d: 'long', e: 'x', f: 'x' },
      {
        a: def({ status: 'draft' }),
        b: def({ showOnProductPage: false }),
        brand: def(),
        d: def({ dataType: 'long-text' }),
        e: def(),
        f: def({ names: { 'en-AU': 'Shown' } }),
      },
      [
        {
          groupCode: 'g',
          attributes: [
            entry('a'),
            entry('b'),
            entry('brand'),
            entry('d'),
            entry('e', true),
            entry('f'),
          ],
        },
      ],
    );
    expect(out.flatMap((group) => group.specifications.map((s) => s.code))).toEqual(['f']);
  });

  it('keeps an archived attribute on a live product, and leaves out a code with no definition', () => {
    const out = build({ old: 'x', ghost: 'x' }, { old: def({ status: 'archived' }) }, [
      { groupCode: 'g', attributes: [entry('old'), entry('ghost')] },
    ]);
    expect(out[0]?.specifications.map((s) => s.code)).toEqual(['old']);
  });

  it('omits empty values and groups with no row', () => {
    const out = build(
      { a: '  ', b: null, c: [], d: 'x' },
      {
        a: def(),
        b: def(),
        c: def({ dataType: 'multi-select' }),
        d: def(),
      },
      [
        { groupCode: 'empty', attributes: [entry('a'), entry('b'), entry('c')] },
        { groupCode: 'full', attributes: [entry('d')] },
      ],
    );
    expect(out.map((group) => group.groupCode)).toEqual(['full']);
  });

  it('picks a localizable value in the asked locale, else the fallback, never another locale', () => {
    const definition = def({ localizable: true });
    expect(
      build({ a: { 'fa-IR': 'ایران', 'en-AU': 'Iran' } }, { a: definition })[0]?.specifications[0]
        ?.value,
    ).toEqual({ kind: 'text', text: 'ایران' });
    expect(
      build({ a: { 'en-AU': 'Iran' } }, { a: definition })[0]?.specifications[0]?.value,
    ).toEqual({ kind: 'text', text: 'Iran' });
    expect(build({ a: { 'ar-AE': 'إيران' } }, { a: definition })).toEqual([]);
    // A plain text where a per-locale object is expected is not shown.
    expect(build({ a: 'Iran' }, { a: definition })).toEqual([]);
  });

  it('types numbers, booleans and dates, and drops values of the wrong type', () => {
    const out = build(
      { n: '2.50', i: 3, b: false, d: '2026-11-03', bad: 'abc', badDate: '3 Nov', badBool: 'yes' },
      {
        n: def({ dataType: 'decimal' }),
        i: def({ dataType: 'integer' }),
        b: def({ dataType: 'boolean' }),
        d: def({ dataType: 'date' }),
        bad: def({ dataType: 'integer' }),
        badDate: def({ dataType: 'date' }),
        badBool: def({ dataType: 'boolean' }),
      },
    );
    expect(out[0]?.specifications.map((s) => s.value)).toEqual([
      { kind: 'number', value: '2.50' },
      { kind: 'number', value: '3' },
      { kind: 'boolean', value: false },
      { kind: 'date', value: '2026-11-03' },
    ]);
  });

  it('shows option labels, follows a merge, and never shows a raw option code', () => {
    const options = new Map<string, SpecificationOption>([
      ['old', { labels: { 'en-AU': 'Old' }, mergedInto: 'new' }],
      ['new', { labels: { 'en-AU': 'New' }, mergedInto: null }],
      ['mute', { labels: { 'ar-AE': 'x' }, mergedInto: null }],
    ]);
    const definition = def({ dataType: 'multi-select', options });
    const out = build({ a: ['old', 'new', 'gone', 'mute'] }, { a: definition });
    expect(out[0]?.specifications[0]?.value).toEqual({ kind: 'list', items: ['New'] });
    expect(build({ a: 'gone' }, { a: def({ dataType: 'select', options }) })).toEqual([]);
  });
  it('reads the single code of a select that became a multi-select as a list of one', () => {
    const options = new Map<string, SpecificationOption>([
      ['hot', { labels: { 'en-AU': 'Hot' }, mergedInto: null }],
    ]);
    const out = build({ a: 'hot' }, { a: def({ dataType: 'multi-select', options }) });
    expect(out[0]?.specifications[0]?.value).toEqual({ kind: 'list', items: ['Hot'] });
  });
  describe('a merged attribute (attributes A8)', () => {
    const label = (text: string): SpecificationOption => ({
      labels: { 'en-AU': text },
      mergedInto: null,
    });
    const target = def({
      dataType: 'select',
      names: { 'en-AU': 'Container' },
      options: new Map([
        ['tin', label('Tin')],
        ['jar', label('Jar')],
      ]),
    });
    const source = def({
      dataType: 'select',
      status: 'archived',
      names: { 'en-AU': 'Pack type' },
      options: new Map([['can', label('Can')]]),
      mergedInto: { code: 'container', options: new Map([['can', 'tin']]) },
    });

    it('shows the value under the target: its name, its label, its code', () => {
      const out = build({ pack: 'can' }, { pack: source, container: target });
      expect(out).toEqual([
        {
          groupCode: 'details',
          specifications: [
            { code: 'container', name: 'Container', value: { kind: 'text', text: 'Tin' } },
          ],
        },
      ]);
    });

    it("lets the target's own value win when the product has both", () => {
      const out = build({ pack: 'can', container: 'jar' }, { pack: source, container: target });
      expect(out[0]?.specifications).toEqual([
        { code: 'container', name: 'Container', value: { kind: 'text', text: 'Jar' } },
      ]);
    });

    it('leaves out a value the map does not know and a target that is not active', () => {
      expect(build({ pack: 'bottle' }, { pack: source, container: target })).toEqual([]);
      const gone = def({ ...target, status: 'archived' });
      expect(build({ pack: 'can' }, { pack: source, container: gone })).toEqual([]);
    });

    it('maps each value of a list and keeps a type without values as it is', () => {
      const many = def({
        dataType: 'multi-select',
        status: 'archived',
        options: new Map([['can', label('Can')]]),
        mergedInto: { code: 'container', options: new Map([['can', 'tin']]) },
      });
      const list = def({ dataType: 'multi-select', options: target.options });
      expect(
        build({ pack: ['can', 'x'] }, { pack: many, container: list })[0]?.specifications[0]?.value,
      ).toEqual({ kind: 'list', items: ['Tin'] });
      const note = def({ status: 'archived', mergedInto: { code: 'remark', options: new Map() } });
      expect(
        build({ note: 'Fresh' }, { note, remark: def({ names: { 'en-AU': 'Remark' } }) })[0]
          ?.specifications[0],
      ).toEqual({ code: 'remark', name: 'Remark', value: { kind: 'text', text: 'Fresh' } });
    });
  });

  it('lists at most 60 rows and 20 list values', () => {
    const codes = Array.from({ length: 70 }, (_, i) => `a${i}`);
    const many = build(
      Object.fromEntries(codes.map((code) => [code, 'x'])),
      Object.fromEntries(codes.map((code) => [code, def()])),
    );
    expect(many.flatMap((group) => group.specifications)).toHaveLength(60);
    const options = new Map<string, SpecificationOption>(
      Array.from({ length: 25 }, (_, i): [string, SpecificationOption] => [
        `o${i}`,
        { labels: { 'en-AU': `Option ${i}` }, mergedInto: null },
      ]),
    );
    const list = build(
      { a: Array.from({ length: 25 }, (_, i) => `o${i}`) },
      { a: def({ dataType: 'multi-select', options }) },
    );
    expect(list[0]?.specifications[0]?.value).toMatchObject({ kind: 'list' });
    const value = list[0]?.specifications[0]?.value;
    expect(value?.kind === 'list' ? value.items : []).toHaveLength(20);
  });

  it('survives odd stored data: localizable non-object, a merge cycle, a name in no locale', () => {
    // A localizable value that is not a per-locale object is not shown; false is a real value.
    expect(build({ a: 'plain' }, { a: def({ localizable: true }) })).toEqual([]);
    expect(
      build({ a: { 'en-AU': false } }, { a: def({ localizable: true, dataType: 'boolean' }) })[0]
        ?.specifications[0]?.value,
    ).toEqual({ kind: 'boolean', value: false });
    // A cycle of merges ends after the hop cap instead of looping; the option it lands on has a label.
    const cycle = new Map<string, SpecificationOption>([
      ['a', { labels: { 'en-AU': 'A' }, mergedInto: 'b' }],
      ['b', { labels: { 'en-AU': 'B' }, mergedInto: 'a' }],
    ]);
    expect(
      build({ x: 'a' }, { x: def({ dataType: 'select', options: cycle }) })[0]?.specifications[0]
        ?.value,
    ).toEqual({ kind: 'text', text: expect.any(String) as string });
    // An attribute with no name in the asked or fallback locale is left out.
    expect(build({ a: 'x' }, { a: def({ names: { 'ar-AE': 'س' } }) })).toEqual([]);
  });
});
