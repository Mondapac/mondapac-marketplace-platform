import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CATEGORY_TREE_IMPORT } from '../../contracts/permissions';
import { levelOf, type EditableCategory } from '../../domain/category-edit';
import { MAX_TREE_NODES } from '../../domain/category-tree';
import { CATEGORY_STATUSES, type CategoryStatus } from '../../domain/platform-category';
import { csvChunks, textRows, type ExportCell } from '../products/products-csv';
import { closedInput, invalid, type ValidationFailure } from '../categories/category-admin-views';
import type { CategoryEditStore } from '../ports/category-edit.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import { XLSX_CONTENT_TYPE, type SheetWriter } from '../ports/sheet-writer';
import { editorAccountOf } from '../categories/category-editor';

export interface CategoryTreeExportInput {
  readonly [key: string]: unknown;
}

export interface CategoryTreeExportOutput {
  readonly filename: string;
  readonly contentType: string;
  readonly chunks: AsyncIterable<string | Uint8Array>;
}

export type CategoryTreeExportFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | ValidationFailure;

export interface CategoryTreeExportDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: CategoryEditStore;
  readonly policy: CatalogMarketPolicy;
  readonly sheetWriter: SheetWriter;
  readonly clock: Clock;
}

const KEYS = ['format', 'status', 'q'] as const;
/** Rows written per chunk while the file streams. */
const CHUNK = 500;
/** The statuses an export holds when the request names none: the ones an import can read back. */
const DEFAULT_STATUSES: readonly CategoryStatus[] = ['active', 'hidden'];

/** The header of the file, in the order of the columns. */
export function exportHeader(locales: readonly string[]): readonly string[] {
  return [
    'id',
    'parent_id',
    'level',
    'position',
    'status',
    'slug',
    'parent_slug',
    'show_in_menu',
    ...locales.flatMap((locale) => [
      `name[${locale}]`,
      `short_description[${locale}]`,
      `keywords[${locale}]`,
    ]),
    'seo_title',
    'seo_description',
  ];
}

/** Depth first, siblings by position, so a parent always comes before its children. */
function orderedTree(nodes: readonly EditableCategory[]): readonly EditableCategory[] {
  const children = new Map<string | null, EditableCategory[]>();
  for (const node of nodes) {
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  for (const list of children.values()) {
    list.sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  }
  const out: EditableCategory[] = [];
  const visit = (parent: string | null, depth: number): void => {
    if (depth > 64) throw new Error('category tree: loop');
    for (const node of children.get(parent) ?? []) {
      out.push(node);
      visit(node.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

/**
 * `category-tree.export` (categories package C7a): the category tree as one CSV or XLSX file that
 * the import reads back. Columns: id, parent_id, level, position, status (for the reader; the
 * import ignores them), slug, parent_slug, show_in_menu, then per supported locale `name[...]`,
 * `short_description[...]` and `keywords[...]` (keywords separated by `; `), and the English
 * `seo_title` and `seo_description`. Filters as on the tree page: `status` (comma-separated
 * `active`, `hidden`, `merged`, `archived`; default `active,hidden`, the categories an import
 * can read back) and `q` (part of a slug or of a name in any language). A filtered-out parent
 * still names its child's `parent_slug`. The answer streams: the tree is read once, in a read-only
 * unit, and the rows leave in chunks of {@link CHUNK}. CSV: a text a spreadsheet would run as a
 * formula (`=`, `+`, `-`, `@`, tab or carriage return at the start) gets a leading quote, which the
 * import takes off. XLSX: every cell is a string value, never a formula. Rule: the protected key
 * `catalog.category-tree.import` (the same key as the import, as the page's actions are), the
 * admin population.
 */
export class CategoryTreeExport extends UseCase<
  CategoryTreeExportInput,
  CategoryTreeExportOutput,
  CategoryTreeExportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-tree-export',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_TREE_IMPORT.key] },
  };

  readonly #logger = new Logger('CategoryTreeExport');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryTreeExportDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CategoryTreeExportInput,
  ): Promise<Result<CategoryTreeExportOutput, CategoryTreeExportFailure>> {
    const result = await this.#run(context, input);
    this.#logger.log({
      msg: 'catalog.category-tree-export',
      code: result.ok ? 'exported' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #run(
    context: CallContext,
    input: CategoryTreeExportInput,
  ): Promise<Result<CategoryTreeExportOutput, CategoryTreeExportFailure>> {
    if (editorAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input ?? {}, KEYS);
    if (!body.ok) return body;
    const format = body.value['format'] ?? 'csv';
    if (format !== 'csv' && format !== 'xlsx') return invalid('format', 'value');
    let statuses: readonly CategoryStatus[] = DEFAULT_STATUSES;
    const rawStatus = body.value['status'];
    if (rawStatus !== undefined && rawStatus !== '') {
      if (typeof rawStatus !== 'string') return invalid('status', 'type');
      const parts = rawStatus.split(',');
      if (parts.some((part) => !(CATEGORY_STATUSES as readonly string[]).includes(part))) {
        return invalid('status', 'value');
      }
      statuses = [...new Set(parts)] as CategoryStatus[];
    }
    const rawQuery = body.value['q'];
    if (rawQuery !== undefined && typeof rawQuery !== 'string') return invalid('q', 'type');
    if (typeof rawQuery === 'string' && [...rawQuery].length > 100) return invalid('q', 'length');
    const needle = typeof rawQuery === 'string' ? rawQuery.trim().toLowerCase() : '';

    const { market } = context;
    const { deps } = this;
    let locales: readonly string[];
    try {
      locales = [...deps.policy.locales(market).supported].sort();
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const nodes = await deps.store.loadAll(market, MAX_TREE_NODES + 1);
        if (nodes.length > MAX_TREE_NODES) return err({ code: 'access.unavailable' } as const);
        return ok(nodes);
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const nodes = read.value;
    const byId = new Map(nodes.map((node) => [node.id as string, node] as const));
    let ordered: readonly EditableCategory[];
    try {
      ordered = orderedTree(nodes);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const matches = (node: EditableCategory): boolean =>
      statuses.includes(node.status) &&
      (needle === '' ||
        node.slug.includes(needle) ||
        node.texts.some((text) => text.name.toLowerCase().includes(needle)));
    const picked = ordered.filter(matches);

    const rows = this.#rows(locales, picked, byId);
    const day = deps.clock.now().toString().slice(0, 10);
    if (format === 'xlsx') {
      return ok({
        filename: `category-tree-${day}.xlsx`,
        contentType: XLSX_CONTENT_TYPE,
        chunks: deps.sheetWriter.xlsx('Categories', textRows(rows)),
      });
    }
    return ok({
      filename: `category-tree-${day}.csv`,
      contentType: 'text/csv; charset=utf-8',
      chunks: csvChunks(rows),
    });
  }

  async *#rows(
    locales: readonly string[],
    picked: readonly EditableCategory[],
    byId: ReadonlyMap<string, EditableCategory>,
  ): AsyncGenerator<readonly (readonly ExportCell[])[]> {
    yield [exportHeader(locales)];
    for (let start = 0; start < picked.length; start += CHUNK) {
      yield picked.slice(start, start + CHUNK).map((node): readonly ExportCell[] => [
        node.id,
        node.parentId ?? '',
        levelOf(byId, node.id),
        node.position,
        node.status,
        node.slug,
        node.parentId === null ? '' : (byId.get(node.parentId)?.slug ?? ''),
        node.showInMenu ? 'true' : 'false',
        ...locales.flatMap((locale): ExportCell[] => {
          const text = node.texts.find((entry) => entry.locale === locale);
          return [
            text?.name ?? '',
            text?.shortDescription ?? '',
            (text?.keywords ?? []).join('; '),
          ];
        }),
        node.seo.title ?? '',
        node.seo.description ?? '',
      ]);
      await Promise.resolve();
    }
  }
}
