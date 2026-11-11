import { definitionRecord } from '../../../../../test/support/catalog-attribute-admin-fakes';
import { readImportFile } from '../../domain/platform-import/import-file';
import { readColumns, headerOf } from './file-layout';
import { planAttributes, planValues, countPlan } from './import-plan';

// The diff of an attribute import file (attributes package A9), with no I/O: the columns, then what
// each row would do against the attributes of the Market, and what a file may never change.

const EN = 'en-AU';
const FA = 'fa-AU';
const locales = { default: EN, supported: [EN, FA] };
const ID = (n: number): string => `01990000-0000-7000-8000-${String(n).padStart(12, '0')}`;

async function table(text: string) {
  const read = await readImportFile(Buffer.from(text, 'utf8'));
  if (!read.ok) throw new Error(`file refused: ${read.error.code}`);
  return read.value;
}

const ATTRIBUTE_HEADER = headerOf('attributes', [EN, FA]).slice(0, -2).join(',');
const attrRow = (cells: Record<string, string>): string =>
  headerOf('attributes', [EN, FA])
    .slice(0, -2)
    .map((column) => cells[column] ?? '')
    .join(',');

async function planOf(kind: 'attributes' | 'values', csv: string, env = environment()) {
  const parsed = await table(csv);
  const columns = readColumns(parsed.header, locales.supported);
  if (!columns.ok) throw new Error(`columns refused: ${columns.error.code}`);
  expect(columns.value.kind).toBe(kind);
  return kind === 'attributes'
    ? planAttributes(parsed.rows, columns.value, env)
    : planValues(parsed.rows, columns.value, env);
}

function environment() {
  return {
    locales,
    definitions: [
      definitionRecord(ID(1), 'origin-note', {
        dataType: 'text',
        names: { [EN]: 'Origin note' },
      }),
      definitionRecord(ID(2), 'pack-size', {
        dataType: 'select',
        names: { [EN]: 'Pack size', [FA]: 'اندازه' },
        values: [
          { code: 'g500', labels: { [EN]: '500 g' }, active: true, position: 0 },
          { code: 'kg1', labels: { [EN]: '1 kg', [FA]: '۱ کیلو' }, active: true, position: 1 },
        ],
      }),
      definitionRecord(ID(3), 'old-thing', { dataType: 'text', status: 'archived' }),
      definitionRecord(ID(4), 'material-of', { dataType: 'text', material: true }),
    ],
  };
}

describe('readColumns', () => {
  it('tells an attributes file from a values file and reads language columns without regard to case', () => {
    const attributes = readColumns(
      ['Code', 'TYPE', 'name[EN-au]', 'help[fa-AU]', 'products'],
      [EN, FA],
    );
    expect(attributes.ok && attributes.value.kind).toBe('attributes');
    if (attributes.ok) {
      expect(attributes.value.languages.get('name')?.get(EN)).toBe(2);
      expect(attributes.value.languages.get('help')?.get(FA)).toBe(3);
      expect(attributes.value.ignored).toEqual([]);
    }
    const values = readColumns(['attribute_code', 'value_code', 'label[fa-AU]'], [EN, FA]);
    expect(values.ok && values.value.kind).toBe('values');
  });

  it('ignores unknown headers and languages of no Market, and refuses duplicates and unknown files', () => {
    const read = readColumns(['code', 'type', 'name[de-DE]', 'colour', 'x\u0007y'], [EN, FA]);
    expect(read.ok && read.value.ignored).toEqual(['name[de-DE]', 'colour', 'x y']);
    expect(readColumns(['code', 'type', 'code'], [EN])).toEqual({
      ok: false,
      error: { code: 'columns.duplicate', columns: ['code'] },
    });
    expect(readColumns(['name[en-AU]'], [EN])).toEqual({
      ok: false,
      error: { code: 'columns.kind-unknown' },
    });
  });
});

describe('planAttributes', () => {
  it('creates a new attribute from its type and names, as a draft input of the editor', async () => {
    const plan = await planOf(
      'attributes',
      [
        ATTRIBUTE_HEADER,
        attrRow({ code: 'cut', type: 'text', [`name[${EN}]`]: 'Cut', [`name[${FA}]`]: 'برش' }),
      ].join('\n'),
    );
    expect(plan.rows).toEqual([
      expect.objectContaining({ rowNumber: 2, key: 'cut', action: 'create', issues: [] }),
    ]);
    expect(plan.writes).toEqual([
      expect.objectContaining({
        kind: 'create',
        input: <unknown>expect.objectContaining({
          code: 'cut',
          dataType: 'text',
          localizable: false,
          names: { [EN]: 'Cut', [FA]: 'برش' },
          showOnProductPage: true,
          searchable: false,
          canBeFilter: false,
        }),
      }),
    ]);
  });

  it('plans an update of a name and keeps everything else of the stored revision', async () => {
    const plan = await planOf(
      'attributes',
      [
        ATTRIBUTE_HEADER,
        attrRow({
          code: 'pack-size',
          type: 'select',
          [`name[${EN}]`]: 'Pack size',
          [`name[${FA}]`]: 'بسته',
          searchable: 'yes',
        }),
      ].join('\n'),
    );
    expect(plan.rows[0]).toMatchObject({
      action: 'update',
      changes: [
        { field: `name[${FA}]`, before: 'اندازه', after: 'بسته' },
        { field: 'searchable', before: 'no', after: 'yes' },
      ],
    });
    const write = plan.writes[0]!;
    expect(write).toMatchObject({
      kind: 'edit',
      code: 'pack-size',
      attributeId: ID(2),
      version: 1,
    });
    expect(write.kind === 'edit' && write.input).toMatchObject({
      attributeId: ID(2),
      version: 1,
      names: { [EN]: 'Pack size', [FA]: 'بسته' },
      material: false,
      isVariantOption: false,
      searchable: true,
      options: [
        { code: 'g500', labels: { [EN]: '500 g' }, active: true },
        { code: 'kg1', labels: { [EN]: '1 kg', [FA]: '۱ کیلو' }, active: true },
      ],
    });
  });

  it('treats a blank cell as no change: a filled file round trips, a Missing file never clears', async () => {
    const plan = await planOf(
      'attributes',
      [
        ATTRIBUTE_HEADER,
        attrRow({
          code: 'pack-size',
          type: 'select',
          localizable: 'no',
          status: 'active',
          material: 'no',
          [`name[${EN}]`]: 'Pack size',
          [`name[${FA}]`]: '',
        }),
        attrRow({ code: 'origin-note', [`name[${EN}]`]: 'Origin note' }),
      ].join('\n'),
    );
    expect(plan.rows.map((row) => row.action)).toEqual(['unchanged', 'unchanged']);
    expect(plan.writes).toEqual([]);
  });

  it('refuses a cell that would change a code, type, localizable flag, status, material or variant flag', async () => {
    const plan = await planOf(
      'attributes',
      [
        ATTRIBUTE_HEADER,
        attrRow({ code: 'origin-note', type: 'integer', [`name[${EN}]`]: 'Origin note' }),
        attrRow({
          code: 'pack-size',
          localizable: 'yes',
          status: 'draft',
          material: 'yes',
          variant_option: 'yes',
          [`name[${EN}]`]: 'Pack size',
        }),
        attrRow({ code: 'material-of', material: 'no', [`name[${EN}]`]: 'Material of' }),
        attrRow({ code: 'old-thing', [`name[${EN}]`]: 'Old' }),
      ].join('\n'),
    );
    expect(plan.rows.map((row) => row.issues)).toEqual([
      [{ column: 'type', code: 'locked' }],
      [
        { column: 'localizable', code: 'locked' },
        { column: 'status', code: 'locked' },
        { column: 'material', code: 'locked' },
        { column: 'variant_option', code: 'locked' },
      ],
      [{ column: 'material', code: 'locked' }],
      [{ column: 'code', code: 'archived' }],
    ]);
    expect(plan.writes).toEqual([]);
    expect(countPlan(plan.rows).errors).toBe(4);
  });

  it('makes an empty default-language cell a row error, on a new and on an existing attribute', async () => {
    const plan = await planOf(
      'attributes',
      [
        ATTRIBUTE_HEADER,
        attrRow({ code: 'cut', type: 'text', [`name[${EN}]`]: '', [`name[${FA}]`]: 'برش' }),
        attrRow({ code: 'origin-note', [`name[${EN}]`]: '  ' }),
      ].join('\n'),
    );
    expect(plan.rows.map((row) => row.issues)).toEqual([
      [{ column: `name[${EN}]`, code: 'required' }],
      [{ column: `name[${EN}]`, code: 'required' }],
    ]);
  });

  it('refuses a bad code, a repeated code, an unknown type and a flag that is no flag', async () => {
    const plan = await planOf(
      'attributes',
      [
        ATTRIBUTE_HEADER,
        attrRow({ code: 'Bad Code', type: 'text' }),
        attrRow({ code: 'cut', type: 'text', [`name[${EN}]`]: 'Cut' }),
        attrRow({ code: 'cut', type: 'text', [`name[${EN}]`]: 'Cut' }),
        attrRow({ code: 'cut2', type: 'colour', [`name[${EN}]`]: 'Cut' }),
        attrRow({ code: 'cut3', type: 'text', searchable: 'maybe', [`name[${EN}]`]: 'Cut' }),
      ].join('\n'),
    );
    expect(
      plan.rows.map((row) => [row.action, row.issues.map((i) => `${i.column}:${i.code}`)]),
    ).toEqual([
      ['error', ['code:format']],
      ['create', []],
      ['error', ['code:repeated']],
      ['error', ['type:unknown']],
      ['error', ['searchable:format']],
    ]);
  });

  it('does not let a new attribute be material, a variant option or published, and needs unit settings for a measure', async () => {
    const plan = await planOf(
      'attributes',
      [
        ATTRIBUTE_HEADER,
        attrRow({ code: 'a1', type: 'text', material: 'yes', [`name[${EN}]`]: 'A' }),
        attrRow({ code: 'a2', type: 'text', status: 'active', [`name[${EN}]`]: 'A' }),
        attrRow({ code: 'a3', type: 'measure', [`name[${EN}]`]: 'Weight' }),
        attrRow({
          code: 'a4',
          type: 'measure',
          measure_dimension: 'mass',
          measure_units: 'g; kg',
          measure_default_unit: 'g',
          measure_decimals: '1',
          min: '0',
          [`name[${EN}]`]: 'Weight',
        }),
        attrRow({ code: 'a5', type: 'text', measure_units: 'g', [`name[${EN}]`]: 'A' }),
      ].join('\n'),
    );
    expect(plan.rows.map((row) => row.issues.map((i) => `${i.column}:${i.code}`))).toEqual([
      ['material:locked'],
      ['status:locked'],
      [
        'measure_dimension:required',
        'measure_units:required',
        'measure_default_unit:required',
        'measure_decimals:required',
      ],
      [],
      ['measure_dimension:not-measure'],
    ]);
    expect(plan.writes).toHaveLength(1);
    expect(plan.writes[0]).toMatchObject({
      kind: 'create',
      input: {
        bounds: {
          min: 0,
          measure: { dimension: 'mass', units: ['g', 'kg'], defaultUnit: 'g', decimals: 1 },
        },
      },
    });
  });

  it('refuses a measure setting that differs from the stored one', async () => {
    const env = environment();
    const measure = definitionRecord(ID(9), 'net-weight', {
      dataType: 'measure',
      names: { [EN]: 'Net weight' },
    });
    const withMeasure = {
      ...measure,
      revision: {
        ...measure.revision,
        bounds: {
          measure: {
            dimension: 'mass' as const,
            units: ['g', 'kg'],
            defaultUnit: 'g',
            decimals: 1,
          },
        },
      },
    };
    const plan = await planOf(
      'attributes',
      [
        ATTRIBUTE_HEADER,
        attrRow({
          code: 'net-weight',
          type: 'measure',
          measure_dimension: 'mass',
          measure_units: 'kg; g',
          measure_default_unit: 'g',
          measure_decimals: '1',
          [`name[${EN}]`]: 'Net weight',
        }),
        attrRow({
          code: 'net-weight',
          type: 'measure',
          measure_units: 'g',
          [`name[${EN}]`]: 'Net weight',
        }),
      ].join('\n'),
      { ...env, definitions: [...env.definitions, withMeasure] },
    );
    expect(plan.rows[0]!.action).toBe('unchanged');
    expect(plan.rows[1]!.issues).toEqual([
      { column: 'code', code: 'repeated' },
      { column: 'measure_units', code: 'locked' },
    ]);
  });
});

describe('planValues', () => {
  const header = 'attribute_code,value_code,active,position,label[en-AU],label[fa-AU]';

  it('adds a value, renames one and turns one off, in one revision of the attribute', async () => {
    const plan = await planOf(
      'values',
      [
        header,
        'pack-size,g250,yes,,250 g,۲۵۰ گرم',
        'pack-size,g500,,,500 g,۵۰۰ گرم',
        'pack-size,kg1,no,,1 kg,',
      ].join('\n'),
    );
    expect(plan.rows.map((row) => [row.action, row.changes.map((c) => c.field)])).toEqual([
      ['create', ['value', `label[${EN}]`, `label[${FA}]`]],
      ['update', [`label[${FA}]`]],
      ['update', ['active']],
    ]);
    expect(plan.writes).toHaveLength(1);
    const write = plan.writes[0]!;
    expect(write.kind === 'edit' && write.rowNumbers).toEqual([2, 3, 4]);
    expect(write.kind === 'edit' && write.input['options']).toEqual([
      { code: 'g500', labels: { [EN]: '500 g', [FA]: '۵۰۰ گرم' }, active: true },
      { code: 'kg1', labels: { [EN]: '1 kg', [FA]: '۱ کیلو' }, active: false },
      { code: 'g250', labels: { [EN]: '250 g', [FA]: '۲۵۰ گرم' }, active: true },
    ]);
    expect(write.kind === 'edit' && [...write.optionRows]).toEqual([
      [2, 2],
      [0, 3],
      [1, 4],
    ]);
  });

  it('writes nothing for a row that changes nothing', async () => {
    const plan = await planOf(
      'values',
      [header, 'pack-size,g500,yes,0,500 g,', 'pack-size,kg1,yes,1,1 kg,۱ کیلو'].join('\n'),
    );
    expect(plan.rows.map((row) => row.action)).toEqual(['unchanged', 'unchanged']);
    expect(plan.writes).toEqual([]);
  });

  it('refuses an unknown or non-select attribute, an archived one, a bad or repeated value code, and a blank default label', async () => {
    const plan = await planOf(
      'values',
      [
        header,
        'nothing,v1,yes,,V,',
        'origin-note,v1,yes,,V,',
        'old-thing,v1,yes,,V,',
        'pack-size,,yes,,V,',
        'pack-size,Bad Code,yes,,V,',
        'pack-size,g250,yes,,250 g,',
        'pack-size,g250,yes,,250 g,',
        'pack-size,g100,yes,,,',
        'pack-size,g500,maybe,,500 g,',
      ].join('\n'),
    );
    expect(plan.rows.map((row) => row.issues.map((i) => `${i.column}:${i.code}`))).toEqual([
      ['attribute_code:unknown'],
      ['attribute_code:not-select'],
      ['attribute_code:not-select'],
      ['value_code:required'],
      ['value_code:format'],
      [],
      ['value_code:repeated'],
      ['label[en-AU]:required'],
      ['active:format'],
    ]);
  });
});
