import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';

// Culture marks on the shared category tree (multi-culture package 1; ADR-0047 decisions 4 and 5).
// A culture sees a branch unless an admin hides it, and for a culture with a required certification
// type a branch is "required" (an Offer needs the tag) unless an admin marks it "neutral".
//
// A row says, for one culture and one category: `visible` (hide, show, or `null` = inherit) and
// `certificationMark` (`null` means "inherit"). With no row anywhere up the tree the default is
// visible and required. The mark is resolved by the nearest row up the chain (the category itself,
// then its parent, and so on) that has a mark. Visibility is not overridable downwards (ADR-0048
// security review M2): a category is hidden when any row on its chain says hidden, so a hidden
// ancestor hides the whole branch; else it is shown by the nearest row that says shown, or by the
// default. A row made only to set a mark leaves `visible` null.

export const CERTIFICATION_MARKS = ['required', 'neutral'] as const;
export type CertificationMark = (typeof CERTIFICATION_MARKS)[number];

export const DEFAULT_CATEGORY_VISIBLE = true;
export const DEFAULT_CERTIFICATION_MARK: CertificationMark = 'required';

export const isCertificationMark = (value: unknown): value is CertificationMark =>
  typeof value === 'string' && (CERTIFICATION_MARKS as readonly string[]).includes(value);

/** One stored row of a culture and a category. */
export interface CultureCategoryRow {
  readonly categoryId: Id<'Category'>;
  /** `null`: inherit (a row made only to set a mark). */
  readonly visible: boolean | null;
  readonly certificationMark: CertificationMark | null;
}

/** Where an effective value came from: the default, a row of the category itself, or an ancestor's. */
export type MarkSource =
  | { readonly kind: 'default' }
  | { readonly kind: 'own' }
  | { readonly kind: 'inherited'; readonly fromCategoryId: Id<'Category'> };

export interface EffectiveCategoryMarks {
  readonly visible: boolean;
  readonly certificationMark: CertificationMark;
  readonly visibleSource: MarkSource;
  readonly markSource: MarkSource;
}

/**
 * The effective visibility and mark of a category (pure). `chain` is the category first, then its
 * parent, up to the root; `rows` are the culture's rows (any categories, extra ones are ignored).
 */
export function resolveEffectiveMarks(
  chain: readonly Id<'Category'>[],
  rows: readonly CultureCategoryRow[],
): EffectiveCategoryMarks {
  const byCategory = new Map(rows.map((row) => [row.categoryId as string, row] as const));
  const sourceOf = (index: number): MarkSource =>
    index === 0 ? { kind: 'own' } : { kind: 'inherited', fromCategoryId: chain[index]! };
  let visible: boolean = DEFAULT_CATEGORY_VISIBLE;
  let visibleSource: MarkSource = { kind: 'default' };
  let certificationMark: CertificationMark = DEFAULT_CERTIFICATION_MARK;
  let markSource: MarkSource = { kind: 'default' };
  let shownFound = false;
  let hiddenFound = false;
  let markFound = false;
  // The whole chain is walked: a hidden row anywhere above wins over a shown row below.
  for (let index = 0; index < chain.length && !(hiddenFound && markFound); index += 1) {
    const row = byCategory.get(chain[index]!);
    if (row === undefined) continue;
    if (row.visible === false && !hiddenFound) {
      visible = false;
      visibleSource = sourceOf(index);
      hiddenFound = true;
    } else if (row.visible === true && !shownFound && !hiddenFound) {
      visibleSource = sourceOf(index);
      shownFound = true;
    }
    if (!markFound && row.certificationMark !== null) {
      certificationMark = row.certificationMark;
      markSource = sourceOf(index);
      markFound = true;
    }
  }
  return { visible, certificationMark, visibleSource, markSource };
}

/** A category of the tree as the resolution needs it. */
export interface MarkedCategoryNode {
  readonly id: Id<'Category'>;
  readonly parentId: Id<'Category'> | null;
}

/** The longest chain walked; a tree deeper than this (or a loop) is refused by the caller. */
const MAX_CHAIN = 64;

/**
 * The effective marks of every category of a tree (pure). A parent missing from `nodes` ends the
 * chain there, as does a loop or a chain deeper than 64, so a damaged tree never hangs the call.
 */
export function resolveTreeMarks(
  nodes: readonly MarkedCategoryNode[],
  rows: readonly CultureCategoryRow[],
): ReadonlyMap<Id<'Category'>, EffectiveCategoryMarks> {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parentId] as const));
  const answer = new Map<Id<'Category'>, EffectiveCategoryMarks>();
  for (const node of nodes) {
    const chain: Id<'Category'>[] = [];
    const seen = new Set<string>();
    let next: Id<'Category'> | null = node.id;
    while (next !== null && !seen.has(next) && chain.length < MAX_CHAIN) {
      seen.add(next);
      chain.push(next);
      next = parentOf.get(next) ?? null;
    }
    answer.set(node.id, resolveEffectiveMarks(chain, rows));
  }
  return answer;
}

/**
 * Validates the body of "set a mark": `visible` and the mark (`null` = inherit). With a mark and no
 * `visible` (or `visible: null`), visibility is left to inherit (ADR-0048 M2); with neither, the row
 * says shown (an explicit show, as before), so a row always states something.
 */
export function parseCategoryMark(input: {
  readonly visible?: unknown;
  readonly certificationMark?: unknown;
}): Result<
  { readonly visible: boolean | null; readonly certificationMark: CertificationMark | null },
  readonly { readonly path: string; readonly code: string }[]
> {
  const problems: { path: string; code: string }[] = [];
  let visible: boolean | null = null;
  if (input.visible !== undefined && input.visible !== null) {
    if (typeof input.visible === 'boolean') visible = input.visible;
    else problems.push({ path: 'visible', code: 'type' });
  }
  let certificationMark: CertificationMark | null = null;
  if (input.certificationMark !== undefined && input.certificationMark !== null) {
    if (isCertificationMark(input.certificationMark)) certificationMark = input.certificationMark;
    else problems.push({ path: 'certificationMark', code: 'unknown' });
  }
  if (problems.length > 0) return err(problems);
  return ok({
    visible: visible === null && certificationMark === null ? DEFAULT_CATEGORY_VISIBLE : visible,
    certificationMark,
  });
}
