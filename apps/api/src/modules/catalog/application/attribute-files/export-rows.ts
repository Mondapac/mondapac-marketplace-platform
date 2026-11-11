import type { AttributeDefinitionRecord, FeatureSetRecord } from '../ports/attribute-admin.reader';
import { levelOf } from '../../domain/attribute-family';
import { languageHeader, textOf, yesNo, headerOf, type AttributeFileKind } from './file-layout';

// The rows of the attribute exports (attributes package A9): pure functions from the records the
// admin reader returns to the cells of the file. Every cell is text or a count; nothing is a
// formula (the CSV writer quotes a cell that starts with = + - @, the XLSX writer writes strings).

export type Cell = string | number | null;
export type Table = {
  readonly header: readonly string[];
  readonly rows: readonly (readonly Cell[])[];
};

/** The values of a select or multi-select attribute are the only ones that have a values row. */
export const hasValues = (record: AttributeDefinitionRecord): boolean =>
  record.dataType === 'select' || record.dataType === 'multi-select';

export interface ExportInput {
  readonly locales: readonly string[];
  /** Keep only what lacks this locale (a Market locale), or null for everything. */
  readonly missing: string | null;
  readonly definitions: readonly AttributeDefinitionRecord[];
  /** Products per attribute code. */
  readonly productCounts: ReadonlyMap<string, number>;
  /** Products per `${attribute code}:${value code}`. */
  readonly valueCounts: ReadonlyMap<string, number>;
}

/** The attributes file: one row per attribute, by code. */
export function attributesTable(input: ExportInput): Table {
  const { locales, missing } = input;
  const rows: Cell[][] = [];
  for (const definition of input.definitions) {
    const { revision } = definition;
    if (missing !== null && textOf(revision.names, missing) !== '') continue;
    const bounds = revision.bounds;
    const measure = bounds.measure;
    const lacking = locales.filter((locale) => textOf(revision.names, locale) === '');
    rows.push([
      definition.code,
      definition.dataType,
      yesNo(definition.localizable),
      definition.status,
      yesNo(revision.material),
      yesNo(revision.isVariantOption),
      yesNo(revision.display.showOnProductPage),
      yesNo(revision.display.searchable),
      yesNo(revision.display.canBeFilter),
      revision.display.position,
      bounds.maxLength ?? '',
      bounds.min ?? '',
      bounds.max ?? '',
      measure?.dimension ?? '',
      measure?.units.join('; ') ?? '',
      measure?.defaultUnit ?? '',
      measure?.decimals ?? '',
      ...locales.map((locale) => textOf(revision.names, locale)),
      ...locales.map((locale) => textOf(revision.display.helpText, locale)),
      input.productCounts.get(definition.code) ?? 0,
      lacking.join('; '),
    ]);
  }
  return { header: headerOf('attributes', locales), rows };
}

/** The values file: one row per value of a select attribute, by attribute code, then position. */
export function valuesTable(input: ExportInput): Table {
  const { locales, missing } = input;
  const rows: Cell[][] = [];
  for (const definition of input.definitions) {
    if (!hasValues(definition)) continue;
    const options = [...definition.revision.options].sort((a, b) => a.position - b.position);
    for (const option of options) {
      if (missing !== null && (!option.active || textOf(option.labels, missing) !== '')) continue;
      rows.push([
        definition.code,
        option.code,
        yesNo(option.active),
        option.position,
        ...locales.map((locale) => textOf(option.labels, locale)),
        input.valueCounts.get(`${definition.code}:${option.code}`) ?? 0,
        locales.filter((locale) => textOf(option.labels, locale) === '').join('; '),
      ]);
    }
  }
  return { header: headerOf('values', locales), rows };
}

export function tableOf(kind: AttributeFileKind, input: ExportInput): Table {
  return kind === 'attributes' ? attributesTable(input) : valuesTable(input);
}

/**
 * The feature sets file: one row per attribute of each group of each feature set, with the names of
 * the set and of the group in every locale and the products of the set. A set with no attribute has
 * one row with the attribute cells empty, so it is not lost.
 */
export function featureSetsTable(input: {
  readonly locales: readonly string[];
  readonly featureSets: readonly FeatureSetRecord[];
  readonly productCounts: ReadonlyMap<string, number>;
}): Table {
  const { locales } = input;
  const header = [
    'feature_set',
    'status',
    'group',
    'attribute',
    'level',
    'variant_option',
    ...locales.map((l) => languageHeader('name', l)),
    ...locales.map((l) => languageHeader('group_name', l)),
    'products',
  ];
  const rows: Cell[][] = [];
  for (const set of input.featureSets) {
    const count = input.productCounts.get(set.id) ?? 0;
    let any = false;
    for (const group of set.groups) {
      for (const entry of group.attributes) {
        any = true;
        rows.push([
          set.code,
          set.status,
          group.groupCode,
          entry.code,
          levelOf(entry),
          yesNo(entry.isVariantOption),
          ...locales.map((locale) => textOf(set.names, locale)),
          ...locales.map((locale) => textOf(group.names ?? {}, locale)),
          count,
        ]);
      }
    }
    if (!any) {
      rows.push([
        set.code,
        set.status,
        '',
        '',
        '',
        '',
        ...locales.map((locale) => textOf(set.names, locale)),
        ...locales.map(() => ''),
        count,
      ]);
    }
  }
  return { header, rows };
}
