import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { AttributeDefinition } from './attribute-definition';

const NOW = Temporal.Instant.from('2026-10-08T00:00:00Z');
const input = (overrides: Partial<Parameters<typeof AttributeDefinition.create>[0]> = {}) => ({
  id: 'd1' as Id<'AttributeDefinition'>,
  revisionId: 'r1' as Id<'AttributeDefinitionRevision'>,
  marketId: 'ZZ' as MarketId,
  code: 'colour',
  dataType: 'select',
  localizable: false,
  material: false,
  isVariantOption: true,
  bounds: {},
  names: { xx: 'Colour' },
  options: [{ code: 'red', labels: { xx: 'Red' }, active: true, position: 0 }],
  createdByKind: 'seed' as const,
  now: NOW,
  ...overrides,
});

describe('AttributeDefinition.create', () => {
  it('builds an active definition at version 1, revision 1', () => {
    const result = AttributeDefinition.create(input());
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.state).toMatchObject({
      status: 'active',
      version: 1,
      revisionNo: 1,
      material: false,
      isVariantOption: true,
    });
  });

  it('accepts a textual and a numeric definition without options', () => {
    expect(
      AttributeDefinition.create(
        input({
          code: 'brand',
          dataType: 'text',
          isVariantOption: false,
          bounds: { maxLength: 80 },
          options: [],
        }),
      ).ok,
    ).toBe(true);
    expect(
      AttributeDefinition.create(
        input({
          code: 'weight',
          dataType: 'integer',
          isVariantOption: false,
          bounds: { min: 1, max: 9 },
          options: [],
        }),
      ).ok,
    ).toBe(true);
  });

  const bad = { dataType: 'text', isVariantOption: false, options: [] };
  it.each([
    ['an upper-case code', { code: 'Colour' }, 'attribute-definition.code-invalid'],
    ['an unknown data type', { dataType: 'blob' }, 'attribute-definition.data-type-invalid'],
    ['no name', { names: {} }, 'attribute-definition.name-required'],
    ['a malformed locale', { names: { XX: 'A' } }, 'attribute-definition.locale-invalid'],
    ['outer spaces in a name', { names: { xx: ' A' } }, 'attribute-definition.text-invalid'],
    ['a bidi control in a name', { names: { xx: 'A‮B' } }, 'attribute-definition.text-invalid'],
    ['a select with no options', { options: [] }, 'attribute-definition.options-required'],
    [
      'options on a text attribute',
      { ...bad, options: [{ code: 'a1', labels: { xx: 'A' }, active: true, position: 0 }] },
      'attribute-definition.options-not-allowed',
    ],
    [
      'a repeated option code',
      {
        options: [
          { code: 'red', labels: { xx: 'Red' }, active: true, position: 0 },
          { code: 'red', labels: { xx: 'Red2' }, active: true, position: 1 },
        ],
      },
      'attribute-definition.option-repeated',
    ],
    [
      'an option with no label',
      { options: [{ code: 'red', labels: {}, active: true, position: 0 }] },
      'attribute-definition.option-invalid',
    ],
    [
      'a variant option that is not a select',
      { ...bad, isVariantOption: true },
      'attribute-definition.variant-option-needs-select',
    ],
    [
      'max length on a number',
      { ...bad, dataType: 'integer', bounds: { maxLength: 5 } },
      'attribute-definition.bounds-invalid',
    ],
    [
      'a fractional bound on an integer',
      { ...bad, dataType: 'integer', bounds: { min: 1.5 } },
      'attribute-definition.bounds-invalid',
    ],
    [
      'min above max',
      { ...bad, dataType: 'integer', bounds: { min: 5, max: 1 } },
      'attribute-definition.bounds-invalid',
    ],
    [
      'a zero max length',
      { ...bad, bounds: { maxLength: 0 } },
      'attribute-definition.bounds-invalid',
    ],
  ] as const)('refuses %s', (_label, overrides, code) => {
    const result = AttributeDefinition.create(input(overrides));
    expect(result.ok ? null : result.error.code).toBe(code);
  });
});

describe('AttributeDefinition drafts and revisions (attributes A2)', () => {
  const LATER = Temporal.Instant.from('2026-11-02T00:00:00Z');
  const display = {
    helpText: { xx: 'As printed on the pack' },
    showOnProductPage: true,
    searchable: true,
    canBeFilter: false,
    internalNote: 'Asked by the grocery team',
    position: 3,
  };
  const draft = (
    overrides: Partial<Parameters<typeof AttributeDefinition.createDraft>[0]> = {},
  ) => {
    const created = AttributeDefinition.createDraft({
      ...input(),
      code: 'heat',
      isVariantOption: false,
      options: [],
      display,
      ...overrides,
    });
    if (!created.ok) throw new Error(created.error.code);
    return created.value;
  };
  const revise = (
    definition: AttributeDefinition,
    overrides: Partial<Parameters<AttributeDefinition['revise']>[0]> = {},
  ) => {
    const { state } = definition;
    return definition.revise({
      revisionId: `r${state.revisionNo + 1}` as Id<'AttributeDefinitionRevision'>,
      names: state.names,
      material: state.material,
      isVariantOption: state.isVariantOption,
      bounds: state.bounds,
      options: state.options,
      display: state.display,
      now: LATER,
      ...overrides,
    });
  };
  const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }) => {
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };
  const mild = { code: 'mild', labels: { xx: 'Mild' }, active: true, position: 0 };
  const hot = { code: 'hot', labels: { xx: 'Hot' }, active: true, position: 1 };

  it('starts a draft by an admin, a select type without values, with its display settings', () => {
    expect(draft().state).toMatchObject({
      status: 'draft',
      createdByKind: 'admin',
      version: 1,
      revisionNo: 1,
      options: [],
      display,
    });
  });

  it('refuses bad help text, note and position, and more than 200 values', () => {
    const refused = (overrides: Partial<Parameters<typeof AttributeDefinition.createDraft>[0]>) => {
      const result = AttributeDefinition.createDraft({
        ...input(),
        isVariantOption: false,
        display,
        ...overrides,
      });
      return result.ok ? null : result.error.code;
    };
    expect(refused({ display: { ...display, helpText: { xx: ' padded ' } } })).toBe(
      'attribute-definition.help-invalid',
    );
    expect(refused({ display: { ...display, helpText: { xx: 'x'.repeat(301) } } })).toBe(
      'attribute-definition.help-invalid',
    );
    expect(refused({ display: { ...display, internalNote: '' } })).toBe(
      'attribute-definition.note-invalid',
    );
    expect(refused({ display: { ...display, position: -1 } })).toBe(
      'attribute-definition.position-invalid',
    );
    const many = Array.from({ length: 201 }, (_, n) => ({
      code: `v${n}`,
      labels: { xx: `V ${n}` },
      active: true,
      position: n,
    }));
    expect(refused({ options: many })).toBe('attribute-definition.options-too-many');
  });

  it('revises into a new revision and version, keeping code, type and the merged-into link', () => {
    const first = draft({ options: [mild] });
    const next = value(
      revise(first, {
        names: { xx: 'Heat level', yy: 'Hitze' },
        options: [{ ...mild, labels: { xx: 'Gentle' } }, hot],
      }),
    );
    expect(next.state).toMatchObject({
      code: 'heat',
      dataType: 'select',
      revisionNo: 2,
      version: 2,
      revisionId: 'r2',
      names: { xx: 'Heat level', yy: 'Hitze' },
      revisedAt: LATER,
      createdAt: NOW,
    });
    expect(next.state.options.map((option) => [option.code, option.mergedInto])).toEqual([
      ['mild', null],
      ['hot', null],
    ]);
  });

  it('never removes a value: it is deactivated instead', () => {
    const first = draft({ options: [mild, hot] });
    expect(revise(first, { options: [mild] })).toEqual({
      ok: false,
      error: { code: 'attribute-definition.option-removed', option: 'hot' },
    });
    expect(
      value(revise(first, { options: [mild, { ...hot, active: false }] })).state.options,
    ).toHaveLength(2);
  });

  it('publishes a draft only with the default name and an active, labelled value', () => {
    expect(draft().publish('xx')).toEqual({
      ok: false,
      error: { code: 'attribute-definition.active-option-required' },
    });
    expect(draft({ options: [{ ...mild, labels: { yy: 'Mild' } }] }).publish('xx')).toEqual({
      ok: false,
      error: { code: 'attribute-definition.default-label-required', locale: 'xx', option: 'mild' },
    });
    expect(draft({ names: { yy: 'Hitze' }, options: [mild] }).publish('xx')).toEqual({
      ok: false,
      error: { code: 'attribute-definition.default-name-required', locale: 'xx' },
    });
    const published = value(draft({ options: [mild] }).publish('xx'));
    expect(published.state).toMatchObject({ status: 'active', version: 2, revisionNo: 1 });
    expect(published.publish('xx')).toEqual({
      ok: false,
      error: { code: 'attribute-definition.not-draft' },
    });
  });

  it('fixes the variant flag and keeps material on once published; a draft may change both', () => {
    const published = value(draft({ options: [mild], material: true }).publish('xx'));
    expect(revise(published, { isVariantOption: true })).toEqual({
      ok: false,
      error: { code: 'attribute-definition.variant-locked' },
    });
    expect(revise(published, { material: false })).toEqual({
      ok: false,
      error: { code: 'attribute-definition.material-relaxation-required' },
    });
    expect(value(revise(published, { material: true })).state.material).toBe(true);
    const unpublished = draft({ options: [mild], material: true });
    expect(
      value(revise(unpublished, { material: false, isVariantOption: true })).state,
    ).toMatchObject({ material: false, isVariantOption: true });
    expect(revise(published, { options: [] })).toEqual({
      ok: false,
      error: { code: 'attribute-definition.option-removed', option: 'mild' },
    });
  });

  it('discards only a draft, as archived, and refuses to revise an archived one', () => {
    const discarded = value(draft().discard());
    expect(discarded.state).toMatchObject({ status: 'archived', version: 2 });
    expect(discarded.discard()).toEqual({
      ok: false,
      error: { code: 'attribute-definition.not-draft' },
    });
    expect(revise(discarded)).toEqual({
      ok: false,
      error: { code: 'attribute-definition.archived' },
    });
  });
});

describe('a measure definition (attributes A3)', () => {
  const settings = {
    dimension: 'mass',
    units: ['g', 'kg'],
    defaultUnit: 'g',
    decimals: 2,
  } as const;
  const measure = (overrides: Partial<Parameters<typeof AttributeDefinition.create>[0]> = {}) =>
    input({
      code: 'net-weight',
      dataType: 'measure',
      isVariantOption: false,
      options: [],
      bounds: { min: 1, max: 5000, measure: settings },
      ...overrides,
    });
  const code = (result: ReturnType<typeof AttributeDefinition.create>) =>
    result.ok ? 'ok' : result.error.code;

  it('is accepted with unit settings and bounds in base units', () => {
    const result = AttributeDefinition.create(measure());
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.state.bounds.measure).toEqual(settings);
  });

  it.each([
    ['no unit settings', { bounds: { min: 1 } }],
    ['an unknown dimension', { bounds: { measure: { ...settings, dimension: 'speed' } } }],
    ['no unit', { bounds: { measure: { ...settings, units: [] } } }],
    ['a unit of another dimension', { bounds: { measure: { ...settings, units: ['g', 'ml'] } } }],
    ['an unknown unit', { bounds: { measure: { ...settings, units: ['g', 'oz'] } } }],
    ['a repeated unit', { bounds: { measure: { ...settings, units: ['g', 'g'] } } }],
    [
      'a default unit that is not offered',
      { bounds: { measure: { ...settings, defaultUnit: 'ml' } } },
    ],
    ['negative decimal places', { bounds: { measure: { ...settings, decimals: -1 } } }],
    ['more than 6 decimal places', { bounds: { measure: { ...settings, decimals: 7 } } }],
    ['fractional decimal places', { bounds: { measure: { ...settings, decimals: 1.5 } } }],
  ] as [string, Partial<Parameters<typeof AttributeDefinition.create>[0]>][])(
    'refuses %s',
    (_name, overrides) => {
      expect(code(AttributeDefinition.create(measure(overrides)))).toBe(
        'attribute-definition.measure-invalid',
      );
    },
  );

  it('refuses a negative min or max, and min above max', () => {
    for (const bounds of [
      { min: -1, measure: settings },
      { max: -1, measure: settings },
      { min: 10, max: 1, measure: settings },
    ]) {
      expect(code(AttributeDefinition.create(measure({ bounds })))).toBe(
        'attribute-definition.bounds-invalid',
      );
    }
  });

  it('refuses unit settings on any other type', () => {
    expect(
      code(
        AttributeDefinition.create(
          input({
            dataType: 'decimal',
            isVariantOption: false,
            options: [],
            bounds: { measure: settings },
          }),
        ),
      ),
    ).toBe('attribute-definition.measure-invalid');
  });

  it('is never a variant option (only a select can be)', () => {
    expect(code(AttributeDefinition.create(measure({ isVariantOption: true })))).toBe(
      'attribute-definition.variant-option-needs-select',
    );
  });

  describe('once published', () => {
    const published = () => {
      const created = AttributeDefinition.createDraft({
        ...measure(),
        display: {
          helpText: {},
          showOnProductPage: true,
          searchable: false,
          canBeFilter: false,
          internalNote: null,
          position: 0,
        },
      });
      if (!created.ok) throw new Error(created.error.code);
      const live = created.value.publish('xx');
      if (!live.ok) throw new Error(live.error.code);
      return live.value;
    };
    const revise = (bounds: Parameters<AttributeDefinition['revise']>[0]['bounds']) =>
      published().revise({
        revisionId: 'r2' as Id<'AttributeDefinitionRevision'>,
        names: { xx: 'Net weight' },
        material: false,
        isVariantOption: false,
        bounds,
        options: [],
        display: published().state.display,
        now: NOW,
      });

    it('may add a unit, change places and tighten bounds', () => {
      const next = revise({
        min: 5,
        max: 100,
        measure: { ...settings, decimals: 0, units: ['g', 'kg'] },
      });
      expect(next.ok).toBe(true);
    });

    it('keeps its dimension', () => {
      const next = revise({
        measure: { dimension: 'volume', units: ['ml'], defaultUnit: 'ml', decimals: 0 },
      });
      expect(next.ok ? 'ok' : next.error.code).toBe('attribute-definition.measure-locked');
    });

    it('never drops a unit that stored values may use', () => {
      const next = revise({ measure: { ...settings, units: ['g'] } });
      expect(next.ok ? 'ok' : next.error.code).toBe('attribute-definition.measure-locked');
    });
  });
});

describe('AttributeDefinition.addOption', () => {
  const published = () => {
    const result = AttributeDefinition.create(
      input({
        code: 'pack',
        isVariantOption: false,
        options: [{ code: 'small', labels: { xx: 'Small' }, active: true, position: 0 }],
      }),
    );
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };
  const add = (definition: AttributeDefinition, code: string, labels = { xx: 'Large' }) =>
    definition.addOption({
      revisionId: 'r2' as Id<'AttributeDefinitionRevision'>,
      code,
      labels,
      now: NOW,
    });

  it('writes the next revision with the value last and active, the others untouched', () => {
    const result = add(published(), 'large');
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.state).toMatchObject({ revisionNo: 2, version: 2, status: 'active' });
    expect(result.value.state.options).toMatchObject([
      { code: 'small', labels: { xx: 'Small' }, active: true, position: 0 },
      { code: 'large', labels: { xx: 'Large' }, active: true, position: 1 },
    ]);
  });

  it('refuses a repeated code and a value with no label', () => {
    expect(add(published(), 'small')).toEqual({
      ok: false,
      error: { code: 'attribute-definition.option-repeated' },
    });
    expect(add(published(), 'large', {} as never)).toMatchObject({
      ok: false,
      error: { code: 'attribute-definition.option-invalid' },
    });
  });
});

describe('AttributeDefinition.convertType (attributes A8)', () => {
  const make = (overrides: Partial<Parameters<typeof AttributeDefinition.create>[0]> = {}) => {
    const result = AttributeDefinition.create(
      input({ code: 'pack', isVariantOption: false, options: [], ...overrides }),
    );
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };
  const convert = (definition: AttributeDefinition, to: string) =>
    definition.convertType({
      revisionId: 'r2' as Id<'AttributeDefinitionRevision'>,
      to,
      now: NOW,
    });

  it('turns a whole number into a decimal as the next revision, bounds kept', () => {
    const result = convert(make({ dataType: 'integer', bounds: { min: 0, max: 99 } }), 'decimal');
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.state).toMatchObject({
      dataType: 'decimal',
      revisionNo: 2,
      version: 2,
      status: 'active',
      bounds: { min: 0, max: 99 },
    });
  });

  it('turns a select into a multi-select, values untouched', () => {
    const options = [
      { code: 'mild', labels: { xx: 'Mild' }, active: true, position: 0 },
      { code: 'hot', labels: { xx: 'Hot' }, active: false, position: 1 },
    ];
    const result = convert(make({ dataType: 'select', options }), 'multi-select');
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value.state).toMatchObject({ dataType: 'multi-select', options });
  });

  it('allows only the listed paths', () => {
    for (const [from, to] of [
      ['decimal', 'integer'],
      ['multi-select', 'select'],
      ['integer', 'integer'],
      ['integer', 'select'],
      ['text', 'select'],
    ] as const) {
      const options =
        from === 'multi-select'
          ? [{ code: 'a', labels: { xx: 'A' }, active: true, position: 0 }]
          : [];
      expect(convert(make({ dataType: from, options }), to)).toEqual({
        ok: false,
        error: { code: 'attribute-definition.convert-invalid' },
      });
    }
  });

  it('refuses a variant option, a material attribute and an archived one', () => {
    const options = [{ code: 'red', labels: { xx: 'Red' }, active: true, position: 0 }];
    expect(
      convert(make({ dataType: 'select', options, isVariantOption: true }), 'multi-select'),
    ).toEqual({ ok: false, error: { code: 'attribute-definition.convert-variant' } });
    expect(convert(make({ dataType: 'integer', material: true }), 'decimal')).toEqual({
      ok: false,
      error: { code: 'attribute-definition.convert-material' },
    });
    const archived = make({ dataType: 'integer' }).archive();
    if (!archived.ok) throw new Error(archived.error.code);
    expect(convert(archived.value, 'decimal')).toEqual({
      ok: false,
      error: { code: 'attribute-definition.archived' },
    });
  });
});
