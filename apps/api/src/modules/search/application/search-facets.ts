import type { Id } from '@mondapac/shared-kernel';
import {
  facetCode,
  matchesChoices,
  splitFacet,
  type ChoiceFilter,
  type ParsedFilters,
  type RangeFilter,
} from '../domain/search-filter';
import type { FacetRow, NumberRow } from './ports/offer-facet.reader';
import type { FilterDefinition } from './ports/search-filters';

/** Only the filters catalog offers for this listing, with merged option codes mapped to their target. */
export interface EffectiveSelection {
  readonly choices: readonly ChoiceFilter[];
  readonly ranges: readonly RangeFilter[];
}

export const NO_SELECTION: EffectiveSelection = { choices: [], ranges: [] };

/**
 * Narrows what the visitor asked to what the listing offers (pure): an attribute that is not one of
 * the listing's filters is dropped, a value list goes to the attribute's kind (a yes switch takes
 * only `true`, a range filter only a range), and a merged option's old code becomes its target's
 * (attributes A8, read-time mapping). Dropping is silent on purpose: a link from before an admin
 * removed a filter still shows the unfiltered list.
 */
export function effectiveSelection(
  asked: ParsedFilters,
  definitions: ReadonlyMap<string, FilterDefinition>,
): EffectiveSelection {
  const choices: ChoiceFilter[] = [];
  for (const choice of asked.choices) {
    const definition = definitions.get(choice.attr);
    if (definition === undefined || definition.kind === 'range') continue;
    if (definition.kind === 'toggle') {
      if (choice.values.includes('true')) choices.push({ attr: choice.attr, values: ['true'] });
      continue;
    }
    const values = [...new Set(choice.values.map((value) => definition.redirects[value] ?? value))];
    choices.push({ attr: choice.attr, values });
  }
  const ranges = asked.ranges.filter((range) => definitions.get(range.attr)?.kind === 'range');
  return { choices, ranges };
}

/** The facet strings of each choice group, for the narrowed query. */
export const choiceGroups = (selection: EffectiveSelection): string[][] =>
  selection.choices.map((choice) => choice.values.map((value) => facetCode(choice.attr, value)));

/** One option of a choice filter with the number of products it would show. */
export interface FacetOptionView {
  readonly code: string;
  readonly label: string;
  /** Null when the counts were cut (a scope larger than the counting limit). */
  readonly count: number | null;
  readonly selected: boolean;
}

export interface FacetFilterView {
  readonly code: string;
  readonly name: string;
  readonly kind: FilterDefinition['kind'];
  /** Choice: the values to pick from (zero-count values left out unless picked). Toggle: one `true`. */
  readonly options: readonly FacetOptionView[];
  /** Range: the lowest and highest stored number of the scope, decimal text; null when none. */
  readonly bounds: { readonly min: string; readonly max: string } | null;
  /** Range: what the visitor picked. */
  readonly picked: { readonly min: string | null; readonly max: string | null } | null;
}

/** Products per `attribute=value`, ignoring the attribute's own filter (pure). */
export function countFacets(
  rows: readonly Pick<FacetRow, 'productId' | 'facets'>[],
  choices: readonly ChoiceFilter[],
  attrs: readonly string[],
): ReadonlyMap<string, number> {
  const products = new Map<string, Set<Id<'Product'>>>();
  const wanted = new Set(attrs);
  for (const row of rows) {
    for (const attr of wanted) {
      if (!matchesChoices(row.facets, choices, attr)) continue;
      for (const facet of row.facets) {
        const split = splitFacet(facet);
        if (split === null || split.attr !== attr) continue;
        const set = products.get(facet) ?? new Set<Id<'Product'>>();
        set.add(row.productId);
        products.set(facet, set);
      }
    }
  }
  return new Map([...products].map(([facet, set]) => [facet, set.size]));
}

/** The lowest and highest number per attribute (pure). */
export function numberBounds(
  rows: readonly NumberRow[],
): ReadonlyMap<string, { min: string; max: string }> {
  const bounds = new Map<string, { min: number; max: number }>();
  for (const row of rows) {
    const value = Number(row.value);
    if (!Number.isFinite(value)) continue;
    const current = bounds.get(row.attr);
    bounds.set(
      row.attr,
      current === undefined
        ? { min: value, max: value }
        : { min: Math.min(current.min, value), max: Math.max(current.max, value) },
    );
  }
  const text = (value: number): string => String(Number(value.toFixed(9)));
  return new Map([...bounds].map(([attr, b]) => [attr, { min: text(b.min), max: text(b.max) }]));
}

/**
 * The filter views of a listing (pure). Options keep the definition's order; a value with no
 * product is hidden unless the visitor picked it (so a picked value can be unpicked). With
 * `counted` false the counts are null and nothing is hidden by count.
 */
export function buildFilterViews(input: {
  readonly definitions: readonly FilterDefinition[];
  readonly selection: EffectiveSelection;
  readonly counts: ReadonlyMap<string, number>;
  readonly counted: boolean;
  readonly bounds: ReadonlyMap<string, { min: string; max: string }>;
}): FacetFilterView[] {
  const views: FacetFilterView[] = [];
  for (const definition of input.definitions) {
    const picked = new Set(
      input.selection.choices.find((choice) => choice.attr === definition.code)?.values ?? [],
    );
    if (definition.kind === 'range') {
      const bounds = input.bounds.get(definition.code) ?? null;
      const range = input.selection.ranges.find((r) => r.attr === definition.code);
      if (bounds === null && range === undefined) continue;
      views.push({
        code: definition.code,
        name: definition.name,
        kind: 'range',
        options: [],
        bounds,
        picked: range === undefined ? null : { min: range.min, max: range.max },
      });
      continue;
    }
    const options: FacetOptionView[] = [];
    const candidates =
      definition.kind === 'toggle'
        ? [{ code: 'true', label: definition.name }]
        : definition.options;
    for (const option of candidates) {
      const count = input.counted
        ? (input.counts.get(facetCode(definition.code, option.code)) ?? 0)
        : null;
      const selected = picked.has(option.code);
      if (count === 0 && !selected) continue;
      options.push({ code: option.code, label: option.label, count, selected });
    }
    if (options.length === 0) continue;
    views.push({
      code: definition.code,
      name: definition.name,
      kind: definition.kind,
      options,
      bounds: null,
      picked: null,
    });
  }
  return views;
}
