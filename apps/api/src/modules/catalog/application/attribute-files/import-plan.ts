import { ATTRIBUTE_DATA_TYPES } from '@mondapac/shared-kernel';
import type { ParsedRow } from '../../domain/platform-import/import-file';
import { replaceControlCharacters } from '../../domain/platform-import/text-safety';
import type {
  AttributeBounds,
  AttributeOption,
  LocalizedText,
} from '../../domain/attribute-definition';
import type { AttributeDefinitionRecord } from '../ports/attribute-admin.reader';
import { hasValues } from './export-rows';
import { filled, flagOf, numberOf, textOf, yesNo, type FileColumns } from './file-layout';

// The diff of an import file against the attributes of the Market (attributes package A9): a pure
// function from the parsed rows to what each row would do and the inputs the editor use cases
// would get. Nothing is written here and nothing is checked that the editor checks (the claim-text
// check, the code being free when the write happens, the domain's rules): those run when the
// import runs, through `attribute-definition.create` and `attribute-definition.edit`, and a
// refusal there is reported on the row.
//
// What a file can do. Create an attribute (a draft, as in the editor) with its type, localizable
// flag, names, help texts, flags, bounds and, for a number with a unit, its unit settings. Change
// an existing attribute's names, help texts, page and search flags, position and its numeric
// bounds. Add a value to a select attribute, rename it, turn it on or off. What a file never does:
// change a code, a type or the localizable flag; set, change or clear `material`; set the variant
// flag; publish, archive, merge or convert; change unit settings of an existing attribute; reorder
// values. A cell for any of those that differs from what is stored is a row error, so a file
// exported long ago does not quietly undo a change. A blank cell never clears anything: it means
// "no change", which also lets a Missing export be filled in and imported as it is.

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const SHOWN_CHARS = 120;

export interface RowIssue {
  /** The column, as it is named in the file header, or `row`. */
  readonly column: string;
  readonly code: string;
}

export interface Change {
  readonly field: string;
  readonly before: string;
  readonly after: string;
}

export type RowAction = 'create' | 'update' | 'unchanged' | 'error';

export interface PlannedRow {
  readonly rowNumber: number;
  /** The attribute code, or `attribute/value` in a values file; cleaned and cut. */
  readonly key: string;
  readonly action: RowAction;
  readonly changes: readonly Change[];
  readonly issues: readonly RowIssue[];
}

/** An attribute to create: the input of `attribute-definition.create`. */
export interface CreateWrite {
  readonly kind: 'create';
  readonly rowNumber: number;
  readonly code: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** An attribute to revise: the input of `attribute-definition.edit`, and the rows behind it. */
export interface EditWrite {
  readonly kind: 'edit';
  readonly code: string;
  readonly attributeId: string;
  readonly version: number;
  readonly input: Readonly<Record<string, unknown>>;
  /** The rows of the file this one revision carries (one for an attribute, many for values). */
  readonly rowNumbers: readonly number[];
  /** For a values file: the position in `options` of the value each row touches. */
  readonly optionRows: ReadonlyMap<number, number>;
}

export type Write = CreateWrite | EditWrite;

export interface ImportPlan {
  readonly rows: readonly PlannedRow[];
  readonly writes: readonly Write[];
}

export interface PlanEnvironment {
  readonly locales: { readonly default: string; readonly supported: readonly string[] };
  readonly definitions: readonly AttributeDefinitionRecord[];
}

const shown = (text: string): string => {
  const chars = [...text];
  return chars.length <= SHOWN_CHARS ? text : `${chars.slice(0, SHOWN_CHARS - 1).join('')}…`;
};

/** A code or key made safe to echo: no control character, at most 130 characters. */
const safe = (text: string): string => replaceControlCharacters(text).trim().slice(0, 130);

class Reader {
  constructor(
    private readonly columns: FileColumns,
    private readonly row: ParsedRow,
  ) {}
  head(name: string): string | undefined {
    const index = this.columns.head.get(name);
    return index === undefined ? undefined : (this.row.cells[index] ?? '').trim();
  }
  has(name: string): boolean {
    return this.columns.head.has(name);
  }
  language(prefix: string): ReadonlyMap<string, string> {
    const out = new Map<string, string>();
    for (const [locale, index] of this.columns.languages.get(prefix) ?? []) {
      out.set(locale, (this.row.cells[index] ?? '').trim());
    }
    return out;
  }
  hasLanguage(prefix: string, locale: string): boolean {
    return this.columns.languages.get(prefix)?.has(locale) ?? false;
  }
}

/** Whether a cell is present and differs from the stored flag; `bad` is set for a cell that is no flag. */
function flagDiffers(cell: string | undefined, stored: boolean, bad: () => void): boolean {
  if (!filled(cell)) return false;
  const flag = flagOf(cell);
  if (flag === null) {
    bad();
    return false;
  }
  return flag !== stored;
}

/** The input of `attribute-definition.edit` for a record, with some content replaced. */
export function editInputOf(
  record: AttributeDefinitionRecord,
  replace: {
    readonly names?: LocalizedText;
    readonly helpText?: LocalizedText;
    readonly bounds?: AttributeBounds;
    readonly showOnProductPage?: boolean;
    readonly searchable?: boolean;
    readonly canBeFilter?: boolean;
    readonly position?: number;
    readonly options?: readonly { code: string; labels: LocalizedText; active: boolean }[];
  } = {},
): Record<string, unknown> {
  const { revision } = record;
  const input: Record<string, unknown> = {
    attributeId: record.id,
    version: record.version,
    names: replace.names ?? revision.names,
    material: revision.material,
    isVariantOption: revision.isVariantOption,
    bounds: replace.bounds ?? revision.bounds,
    options: (replace.options ?? revision.options.map(optionInput)).map((o) => ({ ...o })),
    helpText: replace.helpText ?? revision.display.helpText,
    showOnProductPage: replace.showOnProductPage ?? revision.display.showOnProductPage,
    searchable: replace.searchable ?? revision.display.searchable,
    canBeFilter: replace.canBeFilter ?? revision.display.canBeFilter,
    position: replace.position ?? revision.display.position,
  };
  if (revision.display.internalNote !== null) input['internalNote'] = revision.display.internalNote;
  return input;
}

const optionInput = (option: AttributeOption) => ({
  code: option.code,
  labels: option.labels,
  active: option.active,
});

function mergedTexts(
  current: LocalizedText,
  given: ReadonlyMap<string, string>,
  field: string,
  changes: Change[],
): LocalizedText {
  const next: Record<string, string> = { ...current };
  for (const [locale, text] of given) {
    if (text === '' || text === textOf(current, locale)) continue;
    changes.push({
      field: `${field}[${locale}]`,
      before: shown(textOf(current, locale)),
      after: shown(text),
    });
    next[locale] = text;
  }
  return next;
}

/** Plans an attributes file. */
export function planAttributes(
  rows: readonly ParsedRow[],
  columns: FileColumns,
  env: PlanEnvironment,
): ImportPlan {
  const byCode = new Map(env.definitions.map((record) => [record.code, record]));
  const seen = new Set<string>();
  const planned: PlannedRow[] = [];
  const writes: Write[] = [];
  const defaultLocale = env.locales.default;

  for (const row of rows) {
    const read = new Reader(columns, row);
    const issues: RowIssue[] = [];
    const issue = (column: string, code: string): void => void issues.push({ column, code });
    const code = read.head('code') ?? '';
    const key = safe(code);
    const finish = (action: RowAction, changes: readonly Change[] = []): void => {
      planned.push({
        rowNumber: row.rowNumber,
        key,
        action: issues.length > 0 ? 'error' : action,
        changes: issues.length > 0 ? [] : changes,
        issues,
      });
    };

    if (!CODE.test(code)) {
      issue('code', code === '' ? 'required' : 'format');
      finish('error');
      continue;
    }
    if (seen.has(code)) issue('code', 'repeated');
    seen.add(code);

    const existing = byCode.get(code);
    const names = read.language('name');
    const help = read.language('help');
    if (read.hasLanguage('name', defaultLocale) && names.get(defaultLocale) === '') {
      issue(`name[${defaultLocale}]`, 'required');
    }
    const bad = (column: string) => () => issue(column, 'format');
    const flags = {
      showOnProductPage: read.head('show_on_product_page'),
      searchable: read.head('searchable'),
      canBeFilter: read.head('can_be_filter'),
    };
    for (const [column, cell] of [
      ['show_on_product_page', flags.showOnProductPage],
      ['searchable', flags.searchable],
      ['can_be_filter', flags.canBeFilter],
    ] as const) {
      if (filled(cell) && flagOf(cell) === null) bad(column)();
    }
    const flagValue = (cell: string | undefined): boolean | undefined =>
      filled(cell) ? (flagOf(cell) ?? undefined) : undefined;

    const positionCell = read.head('position');
    let position: number | undefined;
    if (filled(positionCell)) {
      if (!/^\d{1,5}$/.test(positionCell) || Number(positionCell) > 32_767)
        issue('position', 'format');
      else position = Number(positionCell);
    }
    const numbers: Partial<Record<'max_length' | 'min' | 'max', number>> = {};
    for (const column of ['max_length', 'min', 'max'] as const) {
      const cell = read.head(column);
      if (!filled(cell)) continue;
      const value = numberOf(cell);
      if (value === null || (column === 'max_length' && !Number.isInteger(value))) {
        issue(column, 'format');
      } else numbers[column] = value;
    }

    if (existing !== undefined) {
      const { revision } = existing;
      if (existing.status === 'archived') issue('code', 'archived');
      const type = read.head('type');
      if (filled(type) && type.toLowerCase() !== existing.dataType) issue('type', 'locked');
      if (flagDiffers(read.head('localizable'), existing.localizable, bad('localizable'))) {
        issue('localizable', 'locked');
      }
      const status = read.head('status');
      if (filled(status) && status.toLowerCase() !== existing.status) issue('status', 'locked');
      if (flagDiffers(read.head('material'), revision.material, bad('material'))) {
        issue('material', 'locked');
      }
      if (
        flagDiffers(read.head('variant_option'), revision.isVariantOption, bad('variant_option'))
      ) {
        issue('variant_option', 'locked');
      }
      const measure = revision.bounds.measure;
      const measureCells: readonly [string, string | undefined, string][] = [
        ['measure_dimension', read.head('measure_dimension'), measure?.dimension ?? ''],
        ['measure_units', read.head('measure_units'), [...(measure?.units ?? [])].sort().join(';')],
        ['measure_default_unit', read.head('measure_default_unit'), measure?.defaultUnit ?? ''],
        [
          'measure_decimals',
          read.head('measure_decimals'),
          measure === undefined ? '' : String(measure.decimals),
        ],
      ];
      for (const [column, cell, stored] of measureCells) {
        if (!filled(cell)) continue;
        const given = column === 'measure_units' ? splitList(cell).sort().join(';') : cell;
        if (given !== stored) issue(column, 'locked');
      }
      if (issues.length > 0) {
        finish('error');
        continue;
      }

      const changes: Change[] = [];
      const nextNames = mergedTexts(revision.names, names, 'name', changes);
      const nextHelp = mergedTexts(revision.display.helpText, help, 'help', changes);
      const nextBounds: { maxLength?: number; min?: number; max?: number } = {};
      const track = (field: string, before: string, after: string): void => {
        if (before !== after) changes.push({ field, before, after });
      };
      const bounds = revision.bounds;
      const maxLength = numbers.max_length ?? bounds.maxLength;
      const min = numbers.min ?? bounds.min;
      const max = numbers.max ?? bounds.max;
      track('max_length', String(bounds.maxLength ?? ''), String(maxLength ?? ''));
      track('min', String(bounds.min ?? ''), String(min ?? ''));
      track('max', String(bounds.max ?? ''), String(max ?? ''));
      if (maxLength !== undefined) nextBounds.maxLength = maxLength;
      if (min !== undefined) nextBounds.min = min;
      if (max !== undefined) nextBounds.max = max;
      const show = flagValue(flags.showOnProductPage) ?? revision.display.showOnProductPage;
      const searchable = flagValue(flags.searchable) ?? revision.display.searchable;
      const canBeFilter = flagValue(flags.canBeFilter) ?? revision.display.canBeFilter;
      track('show_on_product_page', yesNo(revision.display.showOnProductPage), yesNo(show));
      track('searchable', yesNo(revision.display.searchable), yesNo(searchable));
      track('can_be_filter', yesNo(revision.display.canBeFilter), yesNo(canBeFilter));
      const nextPosition = position ?? revision.display.position;
      track('position', String(revision.display.position), String(nextPosition));
      if (changes.length === 0) {
        finish('unchanged');
        continue;
      }
      writes.push({
        kind: 'edit',
        code,
        attributeId: existing.id,
        version: existing.version,
        input: editInputOf(existing, {
          names: nextNames,
          helpText: nextHelp,
          bounds: { ...nextBounds, ...(measure === undefined ? {} : { measure }) },
          showOnProductPage: show,
          searchable,
          canBeFilter,
          position: nextPosition,
        }),
        rowNumbers: [row.rowNumber],
        optionRows: new Map(),
      });
      finish('update', changes);
      continue;
    }

    // A new attribute.
    const rawType = (read.head('type') ?? '').toLowerCase();
    if (!(ATTRIBUTE_DATA_TYPES as readonly string[]).includes(rawType)) {
      issue('type', rawType === '' ? 'required' : 'unknown');
    }
    const localizableCell = read.head('localizable');
    let localizable = false;
    if (filled(localizableCell)) {
      const flag = flagOf(localizableCell);
      if (flag === null) issue('localizable', 'format');
      else localizable = flag;
    }
    const status = read.head('status');
    if (filled(status) && status.toLowerCase() !== 'draft') issue('status', 'locked');
    for (const column of ['material', 'variant_option'] as const) {
      const cell = read.head(column);
      if (filled(cell)) {
        const flag = flagOf(cell);
        if (flag === null) issue(column, 'format');
        else if (flag) issue(column, 'locked');
      }
    }
    if (names.get(defaultLocale) === undefined || names.get(defaultLocale) === '') {
      if (!issues.some((i) => i.column === `name[${defaultLocale}]`)) {
        issue(`name[${defaultLocale}]`, 'required');
      }
    }
    const bounds: { maxLength?: number; min?: number; max?: number; measure?: unknown } = {};
    if (numbers.max_length !== undefined) bounds.maxLength = numbers.max_length;
    if (numbers.min !== undefined) bounds.min = numbers.min;
    if (numbers.max !== undefined) bounds.max = numbers.max;
    const measureCells = {
      dimension: read.head('measure_dimension'),
      units: read.head('measure_units'),
      defaultUnit: read.head('measure_default_unit'),
      decimals: read.head('measure_decimals'),
    };
    const anyMeasure = Object.values(measureCells).some(filled);
    if (rawType === 'measure') {
      const decimals = filled(measureCells.decimals) ? numberOf(measureCells.decimals) : null;
      if (!filled(measureCells.dimension)) issue('measure_dimension', 'required');
      if (!filled(measureCells.units)) issue('measure_units', 'required');
      if (!filled(measureCells.defaultUnit)) issue('measure_default_unit', 'required');
      if (decimals === null || !Number.isInteger(decimals)) {
        issue('measure_decimals', filled(measureCells.decimals) ? 'format' : 'required');
      }
      if (
        filled(measureCells.dimension) &&
        filled(measureCells.units) &&
        filled(measureCells.defaultUnit) &&
        decimals !== null
      ) {
        bounds.measure = {
          dimension: measureCells.dimension.toLowerCase(),
          units: splitList(measureCells.units),
          defaultUnit: measureCells.defaultUnit,
          decimals,
        };
      }
    } else if (anyMeasure) {
      issue('measure_dimension', 'not-measure');
    }
    if (issues.length > 0) {
      finish('error');
      continue;
    }
    const changes: Change[] = [
      { field: 'type', before: '', after: rawType },
      ...[...names]
        .filter(([, text]) => text !== '')
        .map(([locale, text]) => ({
          field: `name[${locale}]`,
          before: '',
          after: shown(text),
        })),
    ];
    writes.push({
      kind: 'create',
      rowNumber: row.rowNumber,
      code,
      input: {
        code,
        dataType: rawType,
        localizable,
        names: Object.fromEntries([...names].filter(([, text]) => text !== '')),
        helpText: Object.fromEntries([...help].filter(([, text]) => text !== '')),
        bounds,
        showOnProductPage: flagValue(flags.showOnProductPage) ?? true,
        searchable: flagValue(flags.searchable) ?? false,
        canBeFilter: flagValue(flags.canBeFilter) ?? false,
        position: position ?? 0,
      },
    });
    finish('create', changes);
  }
  return { rows: planned, writes };
}

const splitList = (text: string): string[] =>
  text
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter((part) => part !== '');

/** Plans a values file: the rows of one attribute become one revision of it. */
export function planValues(
  rows: readonly ParsedRow[],
  columns: FileColumns,
  env: PlanEnvironment,
): ImportPlan {
  const byCode = new Map(env.definitions.map((record) => [record.code, record]));
  const defaultLocale = env.locales.default;
  const seen = new Set<string>();
  const planned: PlannedRow[] = [];

  interface Pending {
    readonly rowNumber: number;
    readonly valueCode: string;
    readonly labels: ReadonlyMap<string, string>;
    readonly active: boolean | undefined;
  }
  const pendingBy = new Map<string, Pending[]>();

  for (const row of rows) {
    const read = new Reader(columns, row);
    const issues: RowIssue[] = [];
    const issue = (column: string, code: string): void => void issues.push({ column, code });
    const attributeCode = read.head('attribute_code') ?? '';
    const valueCode = read.head('value_code') ?? '';
    const key = safe(`${attributeCode}/${valueCode}`);
    const record = byCode.get(attributeCode);
    if (!CODE.test(attributeCode))
      issue('attribute_code', attributeCode === '' ? 'required' : 'format');
    else if (record === undefined) issue('attribute_code', 'unknown');
    else if (!hasValues(record)) issue('attribute_code', 'not-select');
    else if (record.status === 'archived') issue('attribute_code', 'archived');
    if (!CODE.test(valueCode)) issue('value_code', valueCode === '' ? 'required' : 'format');
    const pairKey = `${attributeCode}\u0000${valueCode}`;
    if (issues.length === 0) {
      if (seen.has(pairKey)) issue('value_code', 'repeated');
      seen.add(pairKey);
    }
    const labels = read.language('label');
    if (read.hasLanguage('label', defaultLocale) && labels.get(defaultLocale) === '') {
      issue(`label[${defaultLocale}]`, 'required');
    }
    const activeCell = read.head('active');
    let active: boolean | undefined;
    if (filled(activeCell)) {
      const flag = flagOf(activeCell);
      if (flag === null) issue('active', 'format');
      else active = flag;
    }
    const existingOption =
      record === undefined ? undefined : record.revision.options.find((o) => o.code === valueCode);
    const positionCell = read.head('position');
    if (existingOption !== undefined && filled(positionCell)) {
      // Reordering is the editor's job: a position that differs from the stored one is refused,
      // so an old export never quietly moves a value.
      if (!/^\d{1,5}$/.test(positionCell.trim())) issue('position', 'format');
      else if (Number(positionCell.trim()) !== existingOption.position) issue('position', 'locked');
    }
    if (existingOption === undefined && issues.length === 0) {
      if (labels.get(defaultLocale) === undefined || labels.get(defaultLocale) === '') {
        if (!issues.some((i) => i.column === `label[${defaultLocale}]`)) {
          issue(`label[${defaultLocale}]`, 'required');
        }
      }
    }
    if (issues.length > 0 || record === undefined) {
      planned.push({ rowNumber: row.rowNumber, key, action: 'error', changes: [], issues });
      continue;
    }
    // Decide now whether the row changes anything, so an unchanged row costs no revision.
    const changes: Change[] = [];
    if (existingOption === undefined) {
      changes.push({ field: 'value', before: '', after: valueCode });
      for (const [locale, text] of labels) {
        if (text !== '')
          changes.push({ field: `label[${locale}]`, before: '', after: shown(text) });
      }
    } else {
      for (const [locale, text] of labels) {
        if (text !== '' && text !== textOf(existingOption.labels, locale)) {
          changes.push({
            field: `label[${locale}]`,
            before: shown(textOf(existingOption.labels, locale)),
            after: shown(text),
          });
        }
      }
      if (active !== undefined && active !== existingOption.active) {
        changes.push({
          field: 'active',
          before: yesNo(existingOption.active),
          after: yesNo(active),
        });
      }
    }
    const action: RowAction =
      existingOption === undefined ? 'create' : changes.length > 0 ? 'update' : 'unchanged';
    planned.push({ rowNumber: row.rowNumber, key, action, changes, issues: [] });
    if (action !== 'unchanged') {
      const list = pendingBy.get(attributeCode) ?? [];
      list.push({ rowNumber: row.rowNumber, valueCode, labels, active });
      pendingBy.set(attributeCode, list);
    }
  }

  const writes: Write[] = [];
  for (const [attributeCode, pending] of pendingBy) {
    const record = byCode.get(attributeCode)!;
    const options = record.revision.options.map((o) => ({
      code: o.code,
      labels: { ...o.labels },
      active: o.active,
    }));
    const optionRows = new Map<number, number>();
    for (const item of pending) {
      let index = options.findIndex((o) => o.code === item.valueCode);
      if (index < 0) {
        options.push({ code: item.valueCode, labels: {}, active: true });
        index = options.length - 1;
      }
      const option = options[index]!;
      for (const [locale, text] of item.labels) if (text !== '') option.labels[locale] = text;
      if (item.active !== undefined) option.active = item.active;
      optionRows.set(index, item.rowNumber);
    }
    writes.push({
      kind: 'edit',
      code: attributeCode,
      attributeId: record.id,
      version: record.version,
      input: editInputOf(record, { options }),
      rowNumbers: pending.map((item) => item.rowNumber),
      optionRows,
    });
  }
  return { rows: planned, writes };
}

export interface PlanCounts {
  readonly rows: number;
  readonly create: number;
  readonly update: number;
  readonly unchanged: number;
  readonly errors: number;
}

export function countPlan(rows: readonly PlannedRow[]): PlanCounts {
  const count = (action: RowAction): number => rows.filter((row) => row.action === action).length;
  return {
    rows: rows.length,
    create: count('create'),
    update: count('update'),
    unchanged: count('unchanged'),
    errors: count('error'),
  };
}
