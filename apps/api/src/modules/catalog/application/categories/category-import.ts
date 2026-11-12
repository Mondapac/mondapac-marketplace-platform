import { createHash } from 'node:crypto';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { MAX_UNIT_TIMEOUT_MS } from '../../../../platform/unit-of-work/unit-of-work';
import { CategoryTreeImportedAudit } from '../../domain/audit';
import {
  importFileTargetId,
  parseImportTable,
  planImport,
  type ColumnsRefusal,
  type ImportPlan,
  type ParsedImport,
  type ParsedImportRow,
} from '../../domain/category-import';
import type { EditableCategory, FieldIssue } from '../../domain/category-edit';
import { MAX_TREE_NODES } from '../../domain/category-tree';
import { readImportFile, type FileRefusal } from '../../domain/platform-import/import-file';
import { IMPORT_LIMITS, type ImportLimits } from '../../domain/platform-import/limits';
import type { AdminCategoryReader } from '../ports/admin-category.reader';
import type { ImportFileParsers } from '../ports/import-file-parsers';
import {
  editorAccountOf,
  invalid,
  refuseClaimTexts,
  requiredCategoryLocales,
  runStructural,
  type CategoryWriteDependencies,
  type CategoryWriteFailure,
} from './category-editor';
import { createCategoryInUnit, editDetailsInUnit } from './category-write-core';
import type { ValidationFailure } from './category-admin-views';

// The shared run of the category tree import (categories package C7a; plan decision 12; review
// amendments 4 Nov 2026). The dry run and the apply read the file the same way; the apply writes
// every row through the editor's own in-unit functions (`category-write-core.ts`), in one
// structural unit with one `category_trees.version` raise.
//
// Order: the actor and the request; the file (size, content sniff, rows, columns); the text checks
// of every cell (content filter, then the claim-text check, fail closed per locale) with no unit
// open; the plan against the tree; and, for the apply, the unit. The checks read only the file, so
// the unit never has to ask the certification module anything.

export interface CategoryImportDependencies extends CategoryWriteDependencies {
  readonly importParsers: ImportFileParsers;
  /** The read-only tree version: the repository's own read ensures the row, a write. */
  readonly adminCategoryReader: Pick<AdminCategoryReader, 'treeVersion'>;
}

export type CategoryImportFailure =
  | CategoryWriteFailure
  | FileRefusal
  | ColumnsRefusal
  | ValidationFailure
  | { readonly code: 'import.file-changed' }
  | {
      readonly code: 'import.has-errors';
      readonly errors: number;
    };

export interface ImportCounts {
  readonly create: number;
  readonly update: number;
  readonly unchanged: number;
  readonly error: number;
}

export interface Prepared {
  readonly accountId: Id<'Account'>;
  readonly format: 'csv' | 'xlsx';
  readonly sha256: string;
  readonly parsed: ParsedImport;
  readonly rules: PlanRules;
}

export interface PlanRules {
  readonly supported: readonly string[];
  readonly required: readonly string[];
  readonly maxDepth: number;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** The text checks of one row's cells, as the place the check names. */
function placesOf(row: ParsedImportRow, index: number) {
  const places: { path: string; locale: string; text: string }[] = [];
  const add = (path: string, locale: string, text: string | null): void => {
    if (text !== null && text !== '') places.push({ path: `${index}|${path}`, locale, text });
  };
  for (const [locale, entry] of Object.entries(row.texts)) {
    add(`texts.${locale}.name`, locale, entry.name);
    add(`texts.${locale}.shortDescription`, locale, entry.shortDescription);
    entry.keywords.forEach((keyword, at) => add(`texts.${locale}.keywords.${at}`, locale, keyword));
  }
  add('seo.title', 'en', row.seo?.title ?? null);
  add('seo.description', 'en', row.seo?.description ?? null);
  add('slug', 'en', row.slug);
  return places;
}

/**
 * Reads the request and the file and checks every cell's text. Nothing is written and no unit is
 * open. A cell with a blocked term or a claim word, or in a locale the claim vocabulary does not
 * cover, makes its row an error; an unreadable vocabulary refuses the whole request (fail closed).
 */
export async function prepareImport(
  deps: CategoryImportDependencies,
  context: CallContext,
  data: unknown,
): Promise<Result<Prepared, CategoryImportFailure>> {
  const accountId = editorAccountOf(context);
  if (accountId === null) return err({ code: 'access.denied' });
  const { market } = context;
  let maxBytes: number;
  let maxRows: number;
  let locales: { readonly default: string; readonly supported: readonly string[] };
  let rules: PlanRules;
  try {
    maxBytes = deps.policy.maxCategoryImportBytes(market);
    maxRows = deps.policy.maxCategoryImportRows(market);
    locales = deps.policy.locales(market);
    rules = {
      supported: locales.supported,
      required: requiredCategoryLocales(market, deps.policy),
      maxDepth: deps.policy.maxCategoryDepth(market),
    };
  } catch {
    return err({ code: 'access.unavailable' });
  }
  if (typeof data !== 'string' || data.length === 0) return invalid('data', 'required');
  // The size of the text first: nothing is decoded or hashed above the limit.
  if (data.length > Math.ceil((maxBytes * 4) / 3) + 4) {
    return err({ code: 'file.too-large', maxBytes });
  }
  if (data.length % 4 !== 0 || !BASE64.test(data)) return invalid('data', 'format');
  const bytes = Buffer.from(data, 'base64');
  const table = await readImportFile(
    bytes,
    // The Market's caps, never above the platform ceilings (the config schema holds them).
    { ...IMPORT_LIMITS, fileBytes: maxBytes, rows: maxRows } as ImportLimits,
    deps.importParsers,
  );
  if (!table.ok) return table;
  const read = parseImportTable(table.value.header, table.value.rows, {
    defaultLocale: locales.default,
    supported: locales.supported,
  });
  if (!read.ok) return read;

  // The content filter, then the claim-text check of every cell, per row.
  const extra = new Map<number, FieldIssue[]>();
  const note = (index: number, issue: FieldIssue): void => {
    const list = extra.get(index) ?? [];
    list.push(issue);
    extra.set(index, list);
  };
  const rows = read.value.rows;
  const asked: { path: string; locale: string; text: string }[] = [];
  rows.forEach((row, index) => {
    if (row.issues.length > 0) return;
    for (const place of placesOf(row, index)) {
      const path = place.path.slice(place.path.indexOf('|') + 1);
      if (path !== 'slug' && deps.contentFilter.isBlocked(market, place.text)) {
        note(index, { path, code: 'blocked-term' });
      } else {
        asked.push(place);
      }
    }
  });
  // Every place is checked; a place of a locale the vocabulary does not cover is an error of its
  // row, and the rest are still sent to the matcher so the preview shows a claim word too.
  let remaining = asked;
  for (let pass = 0; pass < 2; pass += 1) {
    const claim = await refuseClaimTexts(deps, context, remaining);
    if (claim === null) break;
    if (!('fields' in claim && Array.isArray(claim.fields) && claim.code.startsWith('category.'))) {
      return err(claim);
    }
    const flagged = new Set<string>();
    for (const field of claim.fields as readonly FieldIssue[]) {
      const bar = field.path.indexOf('|');
      note(Number(field.path.slice(0, bar)), { path: field.path.slice(bar + 1), code: field.code });
      flagged.add(field.path);
    }
    if (claim.code !== 'category.locale-uncheckable') break;
    remaining = remaining.filter((place) => !flagged.has(place.path));
    if (remaining.length === 0) break;
  }
  const parsed: ParsedImport = {
    locales: read.value.locales,
    rows: rows.map((row, index) =>
      extra.has(index) ? { ...row, issues: [...row.issues, ...extra.get(index)!] } : row,
    ),
  };
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return ok({ accountId, format: table.value.format, sha256, parsed, rules });
}

export interface TreeSnapshot {
  readonly nodes: readonly EditableCategory[];
  readonly treeVersion: number;
  /** The new slugs a retired-slug hold or a lock refuses. */
  readonly parsed: ParsedImport;
}

/**
 * The tree as one read-only unit sees it, and the file's rows with `slug.taken` added to a new
 * slug that another category used in the last 12 months. The apply checks that again in its unit,
 * under the tree lock, when it creates the category.
 */
export async function readSnapshot(
  deps: CategoryImportDependencies,
  market: MarketContext,
  parsed: ParsedImport,
): Promise<Result<TreeSnapshot, CategoryImportFailure>> {
  const read = await deps.unitOfWork.run(
    market,
    async () => {
      // The version is read before the nodes: a read-only unit has no shared snapshot, so a write that
      // commits between the two reads can only make the version too old (a stale refusal at apply),
      // never newer than the tree shown.
      // A Market whose tree row does not exist yet reads 0; the first structural write creates it at 1.
      const treeVersion = Math.max(1, await deps.adminCategoryReader.treeVersion(market));
      const nodes = await deps.store.loadAll(market, MAX_TREE_NODES + 1);
      if (nodes.length > MAX_TREE_NODES) return err({ code: 'access.unavailable' } as const);
      const known = new Set(nodes.map((node) => node.slug));
      const now = deps.clock.now();
      const fresh = parsed.rows
        .filter((row) => row.issues.length === 0 && !known.has(row.slug))
        .map((row) => row.slug);
      const taken = new Set(await deps.store.unavailableSlugs(market, fresh, now));
      return ok({ nodes, treeVersion, taken });
    },
    { readOnly: true },
  );
  if (!read.ok) return err({ code: 'access.unavailable' });
  const { nodes, treeVersion, taken } = read.value;
  return ok({
    nodes,
    treeVersion,
    parsed: {
      locales: parsed.locales,
      rows: parsed.rows.map((row) =>
        taken.has(row.slug)
          ? { ...row, issues: [...row.issues, { path: 'slug', code: 'slug.taken' }] }
          : row,
      ),
    },
  });
}

export function planOf(snapshot: TreeSnapshot, rules: PlanRules): ImportPlan {
  return planImport(snapshot.parsed, snapshot.nodes, rules);
}

export interface Applied {
  readonly treeVersion: number;
  readonly counts: ImportCounts;
}

/**
 * Writes a clean plan: one structural unit, the tree version the dry run named raised once, every
 * row through the editor's own in-unit create and edit, then the import's own audit entry. The
 * plan is made again on the locked tree; a row that is now an error refuses the whole file and
 * nothing is written.
 */
export async function applyImport(
  deps: CategoryImportDependencies,
  context: CallContext,
  prepared: Prepared,
  snapshot: TreeSnapshot,
  expectedTreeVersion: number,
): Promise<Result<Applied, CategoryImportFailure>> {
  const { market } = context;
  return runStructural<Applied, CategoryImportFailure>(
    deps,
    market,
    expectedTreeVersion,
    async (locked, nextTreeVersion) => {
      const plan = planImport({ ...snapshot.parsed }, locked, prepared.rules);
      if (plan.counts.error > 0) {
        return err({ code: 'import.has-errors', errors: plan.counts.error } as const);
      }
      let nodes: readonly EditableCategory[] = locked;
      const idBySlug = new Map<string, Id<'Category'>>();
      for (const operation of plan.operations) {
        if (operation.kind === 'create') {
          let parentId: Id<'Category'> | null = null;
          if (operation.parentSlug !== null) {
            parentId =
              idBySlug.get(operation.parentSlug) ??
              nodes.find((node) => node.slug === operation.parentSlug)?.id ??
              null;
            if (parentId === null) return err({ code: 'category.parent-not-found' } as const);
          }
          const created = await createCategoryInUnit(
            deps,
            context,
            prepared.accountId,
            nodes,
            {
              parentId,
              slug: operation.row.slug,
              texts: operation.texts,
              seo: operation.seo,
              showInMenu: operation.showInMenu,
              maxDepth: prepared.rules.maxDepth,
              slugsLocked: true,
            },
            nextTreeVersion,
          );
          if (!created.ok) return created;
          idBySlug.set(operation.row.slug, created.value.node.id);
          nodes = [...nodes, created.value.node];
        } else {
          const edited = await editDetailsInUnit(
            deps,
            context,
            prepared.accountId,
            nodes,
            operation.target.id,
            {
              texts: operation.texts,
              seo: operation.seo,
              showInMenu: operation.showInMenu,
              version: null,
            },
            nextTreeVersion,
          );
          if (!edited.ok) return edited;
          nodes = nodes.map((node) =>
            node.id === edited.value.node.id ? edited.value.node : node,
          );
        }
      }
      await deps.audit.record(
        context,
        CategoryTreeImportedAudit.entry(importFileTargetId(prepared.sha256), {
          after: {
            format: prepared.format,
            rows: prepared.parsed.rows.length,
            created: plan.counts.create,
            updated: plan.counts.update,
            unchanged: plan.counts.unchanged,
            treeVersion: nextTreeVersion,
          },
        }),
      );
      return ok({ treeVersion: nextTreeVersion, counts: plan.counts });
    },
    { timeoutMs: MAX_UNIT_TIMEOUT_MS },
  );
}
