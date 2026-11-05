import { err, ok, parsePlainText } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import type { CategoryStatus } from './platform-category';

// The pure rules of the category tree editor (categories package C3a; plan sections 4 and 8a).
// Nothing here reads a store or a clock: the use cases load the tree, ask these functions what to
// write, and write it.

export const CATEGORY_SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LOCALE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2}|-[0-9]{3})?$/;
export const CATEGORY_NAME_MAX = 120;
export const CATEGORY_SHORT_DESCRIPTION_MAX = 300;
export const CATEGORY_KEYWORDS_MAX = 20;
export const CATEGORY_KEYWORD_MAX = 40;
export const CATEGORY_SEO_TITLE_MAX = 60;
export const CATEGORY_SEO_DESCRIPTION_MAX = 160;
/** The most categories one Hide or Show may touch in one unit. */
export const CATEGORY_CASCADE_MAX = 500;

/** The text of a category in one locale (plan decision 14: name, short description, keywords). */
export interface CategoryText {
  readonly locale: string;
  readonly name: string;
  readonly shortDescription: string | null;
  readonly keywords: readonly string[];
}

/** The English-only search-result fields of a category (plan decision 14). */
export interface CategorySeo {
  readonly title: string | null;
  readonly description: string | null;
  readonly noindex: boolean;
}

/** One category as the editor sees it: the root row plus the texts of its current revision. */
export interface EditableCategory {
  readonly id: Id<'Category'>;
  readonly parentId: Id<'Category'> | null;
  readonly slug: string;
  readonly status: CategoryStatus;
  /** The category whose Hide cascaded to this one; null when hidden on its own. */
  readonly hiddenById: Id<'Category'> | null;
  readonly position: number;
  readonly version: number;
  readonly revisionNo: number;
  readonly createdByKind: 'seed' | 'admin';
  readonly showInMenu: boolean;
  readonly imageId: string | null;
  readonly seo: CategorySeo;
  readonly texts: readonly CategoryText[];
}

export interface FieldIssue {
  readonly path: string;
  readonly code: string;
}

/** Why an edit was refused: a stable code, never the text. */
export type CategoryEditRefusal =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'category.not-found' }
  | { readonly code: 'category.not-editable' }
  | { readonly code: 'category.slug-taken' }
  | { readonly code: 'category.slug-unchanged' }
  | { readonly code: 'category.depth-exceeded'; readonly max: number }
  | { readonly code: 'category.parent-not-found' }
  | { readonly code: 'category.sibling-name-taken'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'category.required-locale-missing'; readonly fields: readonly FieldIssue[] }
  | { readonly code: 'category.already-hidden' }
  | { readonly code: 'category.not-hidden' }
  | { readonly code: 'category.parent-hidden' }
  | { readonly code: 'category.cascade-too-large'; readonly max: number }
  | { readonly code: 'category.reorder-edge' }
  | { readonly code: 'category.not-discardable' };

const invalid = (path: string, code: string): Result<never, CategoryEditRefusal> =>
  err({ code: 'validation.failed', fields: [{ path, code }] });

const CONTROL = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
/**
 * The search-result fields and the slug are English (decision 14), so they must be written in the
 * Latin script: a letter of any other script is refused. Digits, punctuation, symbols and spaces
 * (script Common) pass. This is what makes the English claim vocabulary enough to check them.
 */
const NON_ENGLISH = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;
/** The locale whose vocabulary checks the search-result fields and the slug. */
export const SEARCH_TEXT_LOCALE = 'en';

const lengthOf = (value: string): number => [...value].length;

function plainText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    lengthOf(value) >= 1 &&
    lengthOf(value) <= max &&
    !CONTROL.test(value) &&
    parsePlainText(value).ok
  );
}

/** A slug of the address: lower-case words with single hyphens, 2 to 80 characters. */
export const isCategorySlug = (value: unknown): value is string =>
  typeof value === 'string' && CATEGORY_SLUG.test(value) && value.length >= 2 && value.length <= 80;

/**
 * The texts of a request (pure): an object keyed by locale. Every key must be a supported locale;
 * the required locales must each carry a name. A locale with no name at all is left out (it is
 * "Missing"), a locale with a description or keywords but no name is refused. Keywords are
 * trimmed by the caller, not here: a keyword with outer space is refused so that what is stored
 * is what was checked.
 */
export function parseCategoryTexts(
  raw: unknown,
  rules: { readonly supported: readonly string[]; readonly required: readonly string[] },
): Result<readonly CategoryText[], CategoryEditRefusal> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return invalid('texts', 'type');
  const issues: FieldIssue[] = [];
  const texts: CategoryText[] = [];
  const record = raw as Record<string, unknown>;
  for (const locale of Object.keys(record).sort()) {
    if (!LOCALE.test(locale) || !rules.supported.includes(locale)) {
      issues.push({ path: `texts.${locale.slice(0, 16)}`, code: 'locale-unsupported' });
      continue;
    }
    const entry = record[locale];
    const base = `texts.${locale}`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      issues.push({ path: base, code: 'type' });
      continue;
    }
    const body = entry as Record<string, unknown>;
    for (const key of Object.keys(body)) {
      if (!['name', 'shortDescription', 'keywords'].includes(key)) {
        issues.push({ path: `${base}.${key.slice(0, 32)}`, code: 'unknown' });
      }
    }
    const { name, shortDescription, keywords } = body;
    const empty =
      (name === undefined || name === null) &&
      (shortDescription === undefined || shortDescription === null) &&
      (keywords === undefined || (Array.isArray(keywords) && keywords.length === 0));
    if (empty) continue;
    if (name === undefined || name === null) {
      issues.push({ path: `${base}.name`, code: 'required' });
      continue;
    }
    if (!plainText(name, CATEGORY_NAME_MAX)) issues.push({ path: `${base}.name`, code: 'format' });
    if (
      shortDescription !== undefined &&
      shortDescription !== null &&
      !plainText(shortDescription, CATEGORY_SHORT_DESCRIPTION_MAX)
    ) {
      issues.push({ path: `${base}.shortDescription`, code: 'format' });
    }
    let list: readonly string[] = [];
    if (keywords !== undefined && keywords !== null) {
      if (!Array.isArray(keywords) || keywords.length > CATEGORY_KEYWORDS_MAX) {
        issues.push({ path: `${base}.keywords`, code: 'format' });
      } else {
        const seen = new Set<string>();
        keywords.forEach((keyword: unknown, index) => {
          if (!plainText(keyword, CATEGORY_KEYWORD_MAX)) {
            issues.push({ path: `${base}.keywords.${index}`, code: 'format' });
            return;
          }
          const key = keyword.normalize('NFKC').toLowerCase();
          if (seen.has(key)) issues.push({ path: `${base}.keywords.${index}`, code: 'repeated' });
          seen.add(key);
        });
        list = keywords as readonly string[];
      }
    }
    if (typeof name === 'string') {
      texts.push({
        locale,
        name,
        shortDescription: typeof shortDescription === 'string' ? shortDescription : null,
        keywords: list,
      });
    }
  }
  if (issues.length > 0) return err({ code: 'validation.failed', fields: issues });
  const missing = rules.required
    .filter((locale) => !texts.some((entry) => entry.locale === locale))
    .map((locale) => ({ path: `texts.${locale}.name`, code: 'required' }));
  if (missing.length > 0) return err({ code: 'category.required-locale-missing', fields: missing });
  return ok(texts);
}

/** The search-result fields (pure): English only, 60 and 160 characters; absent means cleared. */
export function parseCategorySeo(raw: unknown): Result<CategorySeo, CategoryEditRefusal> {
  if (raw === undefined || raw === null)
    return ok({ title: null, description: null, noindex: false });
  if (typeof raw !== 'object' || Array.isArray(raw)) return invalid('seo', 'type');
  const body = raw as Record<string, unknown>;
  const issues: FieldIssue[] = [];
  for (const key of Object.keys(body)) {
    if (!['title', 'description', 'noindex'].includes(key)) {
      issues.push({ path: `seo.${key.slice(0, 32)}`, code: 'unknown' });
    }
  }
  const text = (key: 'title' | 'description', max: number): string | null => {
    const value = body[key];
    if (value === undefined || value === null) return null;
    if (!plainText(value, max)) {
      issues.push({ path: `seo.${key}`, code: 'format' });
      return null;
    }
    if (NON_ENGLISH.test(value)) issues.push({ path: `seo.${key}`, code: 'english-only' });
    return value;
  };
  const title = text('title', CATEGORY_SEO_TITLE_MAX);
  const description = text('description', CATEGORY_SEO_DESCRIPTION_MAX);
  const noindex = body['noindex'] ?? false;
  if (typeof noindex !== 'boolean') issues.push({ path: 'seo.noindex', code: 'type' });
  if (issues.length > 0) return err({ code: 'validation.failed', fields: issues });
  return ok({ title, description, noindex: noindex === true });
}

/** Whether a status can still be edited: only `active` and `hidden` categories are live nodes. */
export const isEditable = (status: CategoryStatus): boolean =>
  status === 'active' || status === 'hidden';

/** The depth of a category, 1 for a department (root). Throws on a loop or a missing parent. */
export function levelOf(byId: ReadonlyMap<string, EditableCategory>, id: string | null): number {
  let level = 0;
  let next = id;
  while (next !== null) {
    const node = byId.get(next);
    if (node === undefined) throw new Error('category tree: missing ancestor');
    level += 1;
    if (level > 64) throw new Error('category tree: loop');
    next = node.parentId;
  }
  return level;
}

const nameKey = (value: string): string => value.normalize('NFKC').trim().toLowerCase();

/**
 * Two live siblings may not share a name in one locale (plan section 3); the same name under
 * different parents is fine. `self` is left out so a category keeps its own name.
 */
export function siblingNameClashes(
  nodes: readonly EditableCategory[],
  parentId: Id<'Category'> | null,
  self: string | null,
  texts: readonly CategoryText[],
): readonly FieldIssue[] {
  const issues: FieldIssue[] = [];
  const siblings = nodes.filter(
    (node) => node.parentId === parentId && node.id !== self && isEditable(node.status),
  );
  for (const text of texts) {
    const key = nameKey(text.name);
    const clash = siblings.some((node) =>
      node.texts.some((other) => other.locale === text.locale && nameKey(other.name) === key),
    );
    if (clash) issues.push({ path: `texts.${text.locale}.name`, code: 'sibling-name-taken' });
  }
  return issues;
}

/** Every descendant of `id` (children, grandchildren, ...), any status. */
export function descendantsOf(
  nodes: readonly EditableCategory[],
  id: string,
): readonly EditableCategory[] {
  const children = new Map<string, EditableCategory[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const found: EditableCategory[] = [];
  const stack = [...(children.get(id) ?? [])];
  while (stack.length > 0) {
    const node = stack.pop()!;
    found.push(node);
    stack.push(...(children.get(node.id) ?? []));
    if (found.length > 5000) throw new Error('category tree: too large');
  }
  return found;
}

/** What one Hide or Show writes: the node and the state it gets. */
export interface HiddenChange {
  readonly id: Id<'Category'>;
  readonly status: 'active' | 'hidden';
  readonly hiddenById: Id<'Category'> | null;
}

/**
 * Hide (plan decision 6): the category and every `active` descendant become `hidden`. A
 * descendant that is already hidden (on its own or by another cascade) keeps its own marker, so
 * Show restores only what this Hide hid. Merged and archived nodes are left alone.
 */
export function planHide(
  nodes: readonly EditableCategory[],
  target: EditableCategory,
): Result<readonly HiddenChange[], CategoryEditRefusal> {
  if (target.status === 'hidden') return err({ code: 'category.already-hidden' });
  if (target.status !== 'active') return err({ code: 'category.not-editable' });
  const changes: HiddenChange[] = [{ id: target.id, status: 'hidden', hiddenById: null }];
  for (const node of descendantsOf(nodes, target.id)) {
    if (node.status === 'active') {
      changes.push({ id: node.id, status: 'hidden', hiddenById: target.id });
    }
  }
  if (changes.length > CATEGORY_CASCADE_MAX) {
    return err({ code: 'category.cascade-too-large', max: CATEGORY_CASCADE_MAX });
  }
  return ok(changes);
}

/**
 * Show: the category becomes `active` again, and so does every descendant this category's Hide
 * hid. It cannot be shown under a parent that is not `active`.
 */
export function planShow(
  nodes: readonly EditableCategory[],
  target: EditableCategory,
): Result<readonly HiddenChange[], CategoryEditRefusal> {
  if (target.status === 'active') return err({ code: 'category.not-hidden' });
  if (target.status !== 'hidden') return err({ code: 'category.not-editable' });
  if (target.hiddenById !== null) return err({ code: 'category.parent-hidden' });
  const parent = nodes.find((node) => node.id === target.parentId);
  if (target.parentId !== null && parent?.status !== 'active') {
    return err({ code: 'category.parent-hidden' });
  }
  const changes: HiddenChange[] = [{ id: target.id, status: 'active', hiddenById: null }];
  for (const node of descendantsOf(nodes, target.id)) {
    if (node.status === 'hidden' && node.hiddenById === target.id) {
      changes.push({ id: node.id, status: 'active', hiddenById: null });
    }
  }
  if (changes.length > CATEGORY_CASCADE_MAX) {
    return err({ code: 'category.cascade-too-large', max: CATEGORY_CASCADE_MAX });
  }
  return ok(changes);
}

/** Move up or down: the neighbour this category swaps places with. */
export function planReorder(
  nodes: readonly EditableCategory[],
  target: EditableCategory,
  direction: 'up' | 'down',
): Result<EditableCategory, CategoryEditRefusal> {
  if (!isEditable(target.status)) return err({ code: 'category.not-editable' });
  const ordered = nodes
    .filter((node) => node.parentId === target.parentId && isEditable(node.status))
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  const index = ordered.findIndex((node) => node.id === target.id);
  const neighbour = ordered[direction === 'up' ? index - 1 : index + 1];
  if (index < 0 || neighbour === undefined) return err({ code: 'category.reorder-edge' });
  return ok(neighbour);
}

/**
 * Discard (plan section 4): only a category an admin created, never showed, with no child and no
 * product revision that ever named it. `productRevisions` is the count the store read.
 */
export function canDiscard(
  nodes: readonly EditableCategory[],
  target: EditableCategory,
  facts: { readonly everShown: boolean; readonly productRevisions: number },
): boolean {
  return (
    target.status === 'hidden' &&
    target.createdByKind === 'admin' &&
    !facts.everShown &&
    facts.productRevisions === 0 &&
    !nodes.some((node) => node.parentId === target.id)
  );
}
