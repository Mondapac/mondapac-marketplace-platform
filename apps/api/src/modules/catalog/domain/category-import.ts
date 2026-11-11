import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import { unguardCell } from '@mondapac/platform-import';
import {
  isCategorySlug,
  isEditable,
  levelOf,
  parseCategorySeo,
  parseCategoryTexts,
  siblingNameClashes,
  type CategorySeo,
  type CategoryText,
  type EditableCategory,
  type FieldIssue,
} from './category-edit';
import { MAX_TREE_NODES } from './category-tree';

// The pure rules of the category tree import and export file (categories package C7a; plan
// decision 12; review amendments 4 Nov 2026, C7). Nothing here reads a store or a clock: the use
// cases read the file and the tree, ask these functions what each row means, and write it through
// the editor's own functions (no second write path).
//
// One row is one category. Rows match by `slug` and `parent_slug`. A row whose slug is not in the
// tree is created (hidden, last among its siblings, like the editor's Add); a row whose slug is a
// live category is updated (its details); a row that changes nothing is `unchanged`. The file never
// merges, archives, moves or shows/hides anything. A row that names another parent than the
// category has is refused (`move.not-supported`): a move goes through the restructure dialog of
// C4 (reason note, certificate check), not through a file.

/** Columns the export writes for the reader and the import ignores. */
export const INFO_COLUMNS = ['id', 'parent_id', 'level', 'position', 'status'] as const;

const TEXT_COLUMN = /^(name|short_description|keywords)\[([A-Za-z0-9-]{2,16})\]$/i;

/** What the file carries for one locale: only the locales that have columns are touched. */
export interface ImportRowTexts {
  readonly name: string | null;
  readonly shortDescription: string | null;
  readonly keywords: readonly string[];
}

/** One data row of the file, read but not yet checked against the tree. */
export interface ParsedImportRow {
  readonly rowNumber: number;
  readonly slug: string;
  readonly parentSlug: string | null;
  /** Null: the cell was blank (keep on update, yes on create). */
  readonly showInMenu: boolean | null;
  readonly texts: Readonly<Record<string, ImportRowTexts>>;
  /** Null: the file has neither SEO column. */
  readonly seo: { readonly title: string | null; readonly description: string | null } | null;
  /** Problems found while reading the cells (the plan adds the rest). */
  readonly issues: readonly FieldIssue[];
}

export interface ParsedImport {
  /** The locales the file has columns for. */
  readonly locales: readonly string[];
  readonly rows: readonly ParsedImportRow[];
}

/** Why the header was refused: codes and column positions, never a value. */
export interface ColumnsRefusal {
  readonly code: 'import.columns-invalid';
  readonly fields: readonly FieldIssue[];
}

const sanitize = (cell: string | undefined): string => unguardCell(cell ?? '').trim();

/** `true`/`false`, `yes`/`no`, `1`/`0` (any case). Blank is null; anything else is undefined. */
function flagOf(cell: string): boolean | null | undefined {
  if (cell === '') return null;
  const value = cell.toLowerCase();
  if (['true', 'yes', '1'].includes(value)) return true;
  if (['false', 'no', '0'].includes(value)) return false;
  return undefined;
}

/**
 * Reads the table: the header first (known columns only, no repeats, every locale supported, the
 * default locale's name present), then each row's cells. A cell's guard quote is taken off and the
 * cell trimmed (a leading tab or carriage return goes with the trim), so a file written by the
 * export reads back as it was written.
 */
export function parseImportTable(
  header: readonly string[],
  rows: readonly { readonly rowNumber: number; readonly cells: readonly string[] }[],
  rules: { readonly defaultLocale: string; readonly supported: readonly string[] },
): Result<ParsedImport, ColumnsRefusal> {
  const issues: FieldIssue[] = [];
  const at = new Map<string, number>();
  const textAt = new Map<string, { name?: number; shortDescription?: number; keywords?: number }>();
  header.forEach((raw, index) => {
    const label = unguardCell(raw).trim();
    const path = `columns.${index + 1}`;
    if (label === '') {
      issues.push({ path, code: 'column.blank' });
      return;
    }
    const lower = label.toLowerCase();
    const text = TEXT_COLUMN.exec(label);
    if (text !== null) {
      const kind = text[1]!.toLowerCase();
      const locale = text[2]!;
      if (!rules.supported.includes(locale)) {
        issues.push({ path, code: 'locale-unsupported' });
        return;
      }
      const slot = textAt.get(locale) ?? {};
      const key = kind === 'name' ? 'name' : kind === 'keywords' ? 'keywords' : 'shortDescription';
      if (slot[key] !== undefined) {
        issues.push({ path, code: 'column.duplicate' });
        return;
      }
      slot[key] = index;
      textAt.set(locale, slot);
      return;
    }
    if (
      ![
        'slug',
        'parent_slug',
        'show_in_menu',
        'seo_title',
        'seo_description',
        ...INFO_COLUMNS,
      ].includes(lower)
    ) {
      issues.push({ path, code: 'column.unknown' });
      return;
    }
    if (at.has(lower)) {
      issues.push({ path, code: 'column.duplicate' });
      return;
    }
    at.set(lower, index);
  });
  if (!at.has('slug')) issues.push({ path: 'columns.slug', code: 'column.missing' });
  if (!at.has('parent_slug')) issues.push({ path: 'columns.parent_slug', code: 'column.missing' });
  if (textAt.get(rules.defaultLocale)?.name === undefined) {
    issues.push({ path: `columns.name[${rules.defaultLocale}]`, code: 'column.missing' });
  }
  for (const [locale, slot] of textAt) {
    if (slot.name === undefined) {
      issues.push({ path: `columns.name[${locale}]`, code: 'column.missing' });
    }
  }
  if (issues.length > 0)
    return err({ code: 'import.columns-invalid', fields: issues.slice(0, 50) });

  const locales = [...textAt.keys()].sort();
  const seoColumns = at.has('seo_title') || at.has('seo_description');
  const parsed = rows.map((row): ParsedImportRow => {
    const cell = (index: number | undefined): string =>
      index === undefined ? '' : sanitize(row.cells[index]);
    const rowIssues: FieldIssue[] = [];
    const slug = cell(at.get('slug'));
    if (!isCategorySlug(slug)) rowIssues.push({ path: 'slug', code: 'slug.invalid' });
    const parentCell = cell(at.get('parent_slug'));
    if (parentCell !== '' && !isCategorySlug(parentCell)) {
      rowIssues.push({ path: 'parent_slug', code: 'parent.invalid' });
    }
    const flag = flagOf(cell(at.get('show_in_menu')));
    if (flag === undefined) rowIssues.push({ path: 'show_in_menu', code: 'show-in-menu.invalid' });
    const texts: Record<string, ImportRowTexts> = {};
    for (const locale of locales) {
      const slot = textAt.get(locale)!;
      const keywords = cell(slot.keywords)
        .split(';')
        .map((keyword) => keyword.trim())
        .filter((keyword) => keyword !== '');
      const name = cell(slot.name);
      const shortDescription = cell(slot.shortDescription);
      texts[locale] = {
        name: name === '' ? null : name,
        shortDescription: shortDescription === '' ? null : shortDescription,
        keywords,
      };
    }
    const title = cell(at.get('seo_title'));
    const description = cell(at.get('seo_description'));
    return {
      rowNumber: row.rowNumber,
      slug,
      parentSlug: parentCell === '' ? null : parentCell,
      showInMenu: flag === undefined ? null : flag,
      texts,
      seo: seoColumns
        ? {
            title: title === '' ? null : title,
            description: description === '' ? null : description,
          }
        : null,
      issues: rowIssues,
    };
  });
  return ok({ locales, rows: parsed });
}

export type ImportAction = 'create' | 'update' | 'unchanged' | 'error';

/** The answer for one row of the dry run: codes only, never a cell. */
export interface ImportRowResult {
  readonly rowNumber: number;
  /** The row's slug when it is a valid slug, else an empty string (a cell is never echoed). */
  readonly slug: string;
  readonly action: ImportAction;
  /** The first issue's code when the row is an error. */
  readonly code: string | null;
  readonly issues: readonly FieldIssue[];
}

/** What a clean row writes: create it under `parentSlug`, or replace the details of `target`. */
export type ImportOperation =
  | {
      readonly kind: 'create';
      readonly row: ParsedImportRow;
      readonly parentSlug: string | null;
      readonly texts: readonly CategoryText[];
      readonly seo: CategorySeo;
      readonly showInMenu: boolean;
    }
  | {
      readonly kind: 'update';
      readonly row: ParsedImportRow;
      readonly target: EditableCategory;
      readonly texts: readonly CategoryText[];
      readonly seo: CategorySeo;
      readonly showInMenu: boolean;
    };

export interface ImportPlan {
  readonly results: readonly ImportRowResult[];
  /** The writes, parents before children. */
  readonly operations: readonly ImportOperation[];
  readonly counts: {
    readonly create: number;
    readonly update: number;
    readonly unchanged: number;
    readonly error: number;
  };
}

const sortedTexts = (texts: readonly CategoryText[]): readonly CategoryText[] =>
  [...texts].sort((a, b) => (a.locale < b.locale ? -1 : 1));

/**
 * What each row of the file means against the tree. Pure and repeatable: the dry run calls it on a
 * read snapshot, the apply calls it again on the locked tree. A row is an error when it cannot be
 * written whole; the rest of the file is still planned, so one run shows every problem.
 *
 * The tree is simulated as the rows are applied (a created category is a parent and a name clash
 * for the rows after it), so the plan is exactly what the apply writes.
 */
export function planImport(
  parsed: ParsedImport,
  nodes: readonly EditableCategory[],
  rules: {
    readonly supported: readonly string[];
    readonly required: readonly string[];
    readonly maxDepth: number;
  },
): ImportPlan {
  const results = new Map<number, ImportRowResult>();
  const operations: ImportOperation[] = [];
  const fail = (row: ParsedImportRow, issues: readonly FieldIssue[]): void => {
    results.set(row.rowNumber, {
      rowNumber: row.rowNumber,
      slug: row.slug,
      action: 'error',
      code: issues[0]?.code ?? 'row.invalid',
      issues,
    });
  };

  // Rows with a problem of their own, and a slug named twice, are out before anything else.
  const firstOfSlug = new Map<string, number>();
  const candidates: ParsedImportRow[] = [];
  for (const row of parsed.rows) {
    if (row.issues.length > 0) {
      fail(row, row.issues);
      continue;
    }
    const seen = firstOfSlug.get(row.slug);
    if (seen !== undefined) {
      fail(row, [{ path: 'slug', code: 'slug.duplicate' }]);
      continue;
    }
    firstOfSlug.set(row.slug, row.rowNumber);
    candidates.push(row);
  }

  const live = new Map<string, EditableCategory>();
  const bySlugAny = new Map<string, EditableCategory>();
  for (const node of nodes) {
    bySlugAny.set(node.slug, node);
    if (isEditable(node.status)) live.set(node.slug, node);
  }
  // The simulated tree: the live categories, grown by each created row.
  let tree: readonly EditableCategory[] = nodes;
  const byId = (): ReadonlyMap<string, EditableCategory> =>
    new Map(tree.map((node) => [node.id as string, node] as const));
  const rowsBySlug = new Map(candidates.map((row) => [row.slug, row] as const));
  const created = new Map<string, EditableCategory>();
  const slugOfId = (id: Id<'Category'> | null): string | null =>
    id === null ? null : (tree.find((node) => node.id === id)?.slug ?? null);

  // Order: a row waits for its parent when the parent is a new row of the file.
  const done = new Set<string>();
  const ordered: ParsedImportRow[] = [];
  const visiting = new Set<string>();
  const visit = (row: ParsedImportRow): boolean => {
    if (done.has(row.slug)) return true;
    if (visiting.has(row.slug)) return false;
    visiting.add(row.slug);
    const parent = row.parentSlug === null ? undefined : rowsBySlug.get(row.parentSlug);
    const waits = parent !== undefined && !live.has(row.slug) && !live.has(parent.slug);
    const ready = !waits || visit(parent);
    visiting.delete(row.slug);
    if (!ready) return false;
    done.add(row.slug);
    ordered.push(row);
    return true;
  };
  const cyclic: ParsedImportRow[] = [];
  for (const row of candidates) if (!visit(row)) cyclic.push(row);
  for (const row of cyclic) fail(row, [{ path: 'parent_slug', code: 'parent.not-found' }]);

  const nextPosition = (parentId: Id<'Category'> | null): number =>
    tree
      .filter((node) => node.parentId === parentId)
      .reduce((most, node) => Math.max(most, node.position), 0) + 1;

  for (const row of ordered) {
    if (results.has(row.rowNumber)) continue;
    const existing = live.get(row.slug);
    if (existing === undefined && bySlugAny.has(row.slug)) {
      // A merged, archived or discarded category keeps its slug (its address redirects).
      fail(row, [{ path: 'slug', code: 'slug.taken' }]);
      continue;
    }

    // The parent the row names.
    let parent: EditableCategory | null = null;
    if (row.parentSlug !== null) {
      parent = created.get(row.parentSlug) ?? live.get(row.parentSlug) ?? null;
      if (parent === null) {
        fail(row, [{ path: 'parent_slug', code: 'parent.not-found' }]);
        continue;
      }
    }

    if (existing !== undefined) {
      const current = slugOfId(existing.parentId);
      if (current !== row.parentSlug) {
        fail(row, [{ path: 'parent_slug', code: 'move.not-supported' }]);
        continue;
      }
    }

    // The texts: the locales the file has columns for replace the category's; the others stay.
    const kept = (existing?.texts ?? []).filter((text) => !(text.locale in row.texts));
    const body: Record<string, unknown> = {};
    for (const text of kept) {
      body[text.locale] = {
        name: text.name,
        shortDescription: text.shortDescription,
        keywords: text.keywords,
      };
    }
    for (const [locale, entry] of Object.entries(row.texts)) {
      body[locale] = {
        name: entry.name,
        shortDescription: entry.shortDescription,
        keywords: entry.keywords,
      };
    }
    const texts = parseCategoryTexts(body, rules);
    if (!texts.ok) {
      fail(
        row,
        'fields' in texts.error ? texts.error.fields : [{ path: 'texts', code: 'invalid' }],
      );
      continue;
    }
    const seo = parseCategorySeo(
      row.seo === null
        ? existing === undefined
          ? undefined
          : {
              title: existing.seo.title,
              description: existing.seo.description,
              noindex: existing.seo.noindex,
            }
        : {
            title: row.seo.title,
            description: row.seo.description,
            noindex: existing?.seo.noindex ?? false,
          },
    );
    if (!seo.ok) {
      fail(row, 'fields' in seo.error ? seo.error.fields : [{ path: 'seo', code: 'invalid' }]);
      continue;
    }
    const showInMenu = row.showInMenu ?? existing?.showInMenu ?? true;

    if (existing === undefined) {
      const level = levelOf(byId(), parent?.id ?? null) + 1;
      if (level > rules.maxDepth) {
        fail(row, [{ path: 'parent_slug', code: 'depth.exceeded' }]);
        continue;
      }
    }
    const clashes = siblingNameClashes(
      tree,
      existing === undefined ? (parent?.id ?? null) : existing.parentId,
      existing?.id ?? null,
      texts.value,
    );
    if (clashes.length > 0) {
      fail(row, clashes);
      continue;
    }

    if (existing !== undefined) {
      const same =
        JSON.stringify(sortedTexts(existing.texts)) === JSON.stringify(sortedTexts(texts.value)) &&
        JSON.stringify(existing.seo) === JSON.stringify(seo.value) &&
        existing.showInMenu === showInMenu;
      if (same) {
        results.set(row.rowNumber, {
          rowNumber: row.rowNumber,
          slug: row.slug,
          action: 'unchanged',
          code: null,
          issues: [],
        });
        continue;
      }
      operations.push({
        kind: 'update',
        row,
        target: existing,
        texts: texts.value,
        seo: seo.value,
        showInMenu,
      });
      tree = tree.map((node) =>
        node.id === existing.id
          ? { ...node, texts: texts.value, seo: seo.value, showInMenu }
          : node,
      );
      results.set(row.rowNumber, {
        rowNumber: row.rowNumber,
        slug: row.slug,
        action: 'update',
        code: null,
        issues: [],
      });
      continue;
    }

    // One file cannot grow the tree past the size every tree read refuses (security review M1).
    if (tree.length >= MAX_TREE_NODES) {
      fail(row, [{ path: 'row', code: 'tree.size-exceeded' }]);
      continue;
    }
    const parentId = parent?.id ?? null;
    const placeholder: EditableCategory = {
      id: `import-row-${row.rowNumber}` as Id<'Category'>,
      parentId,
      slug: row.slug,
      status: 'hidden',
      hiddenById: null,
      position: nextPosition(parentId),
      version: 1,
      revisionNo: 1,
      createdByKind: 'admin',
      showInMenu,
      imageId: null,
      seo: seo.value,
      texts: texts.value,
    };
    created.set(row.slug, placeholder);
    tree = [...tree, placeholder];
    operations.push({
      kind: 'create',
      row,
      parentSlug: row.parentSlug,
      texts: texts.value,
      seo: seo.value,
      showInMenu,
    });
    results.set(row.rowNumber, {
      rowNumber: row.rowNumber,
      slug: row.slug,
      action: 'create',
      code: null,
      issues: [],
    });
  }

  // A row that was planned and then lost its parent to a later failure cannot happen: a failed
  // parent is never added to `created`, so its children fail with `parent.not-found` above.
  const list = parsed.rows.map(
    (row) =>
      results.get(row.rowNumber) ?? {
        rowNumber: row.rowNumber,
        slug: row.slug,
        action: 'error' as const,
        code: 'row.invalid',
        issues: [{ path: 'row', code: 'row.invalid' }],
      },
  );
  // Codes only, never a cell: a slug that is not a valid slug is not echoed (security review L2).
  const shown = list.map((entry) => (isCategorySlug(entry.slug) ? entry : { ...entry, slug: '' }));
  const count = (action: ImportAction): number =>
    list.filter((entry) => entry.action === action).length;
  return {
    results: shown,
    operations,
    counts: {
      create: count('create'),
      update: count('update'),
      unchanged: count('unchanged'),
      error: count('error'),
    },
  };
}

/**
 * The audit target id of an import: the file's SHA-256 (64 hex characters) laid out as a UUID v7
 * (version and variant bits set), so the entry carries the whole file hash (122 bits) in the one
 * id field the audit vocabulary offers.
 */
export function importFileTargetId(sha256Hex: string): Id<'CategoryTreeImport'> {
  const hex = sha256Hex.toLowerCase().padEnd(32, '0').slice(0, 32).split('');
  hex[12] = '7';
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const text = hex.join('');
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}` as Id<'CategoryTreeImport'>;
}
