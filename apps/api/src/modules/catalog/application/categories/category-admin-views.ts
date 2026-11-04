import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import { isActingAsSession } from '../acting-as';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { AdminCategoryRow, CategoryCounts } from '../../domain/category-admin-tree';
import type { CategoryName, CategoryStatus } from '../../domain/platform-category';

/** The time the counts of one answer may take before they are given as "at least" (catalog 9.2a). */
export const CATEGORY_COUNT_BUDGET_MS = 10_000;
/** The most revisions the detail lists. */
export const CATEGORY_HISTORY_LIMIT = 200;

/**
 * The locales a category must have a name in (plan section 8a, decision 13): the Market's default
 * locale plus every locale published for buyers. The buyer language registry does not exist on the
 * API yet, so only the default locale is required; this is the one seam to change when it lands.
 */
export function requiredCategoryLocales(
  market: MarketContext,
  policy: CatalogMarketPolicy,
): readonly string[] {
  return [policy.locales(market).default];
}

export interface ValidationFailure {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

export const invalid = (path: string, code: string): { ok: false; error: ValidationFailure } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: ValidationFailure;
  };

export function categoryIdOf(raw: unknown): Result<Id<'Category'>, { code: 'category.not-found' }> {
  const parsed = typeof raw === 'string' ? parseId<'Category'>(raw) : null;
  if (parsed === null || !parsed.ok) return err({ code: 'category.not-found' });
  return ok(parsed.value);
}

export function closedInput(
  input: unknown,
  allowed: readonly string[],
): Result<Record<string, unknown>, ValidationFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('body', 'type');
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record).sort()) {
    if (!allowed.includes(key)) return invalid(key.slice(0, 64), 'unknown');
  }
  return ok(record);
}

/** The result of one allowed-action check (catalog design 9.2a; the ID 8.6 pattern). */
export interface ActionAnswer {
  readonly allowed: boolean;
  readonly denial?:
    'access.permission-missing' | 'access.acting-as-refused' | 'category.not-active';
}

export type ActionMap = Readonly<Record<string, ActionAnswer>>;

/** What the reads need of a key probe: its `execute` and nothing else. */
export interface AccessProbe {
  execute(context: CallContext, input: Record<string, never>): Promise<Result<unknown, unknown>>;
}

export interface CategoryActionProbes {
  readonly edit: AccessProbe;
  readonly restructure: AccessProbe;
  readonly importing: AccessProbe;
}

const EDIT_ACTIONS = [
  'platform-category.create',
  'platform-category.rename',
  'platform-category.reorder',
  'platform-category.hide',
  'platform-category.show',
  'platform-category.change-slug',
] as const;
const RESTRUCTURE_ACTIONS = [
  'platform-category.move',
  'platform-category.merge',
  'platform-category.archive',
  'platform-category.move-products',
] as const;
const IMPORT_ACTIONS = ['platform-category.import', 'platform-category.export'] as const;

async function holds(probe: AccessProbe, context: CallContext): Promise<boolean> {
  const answer = await probe.execute(context, {});
  return answer.ok;
}

/**
 * The actions of the page and of one category for the calling admin. Each is allowed when the
 * caller holds the key (checked by the gate, through a probe) and is not in an acting-as session;
 * a category that is not `active` allows none of the edits. Advisory: every write checks again.
 * `status` is null for the page-level actions (create at the top, import, export).
 */
export async function categoryActions(
  context: CallContext,
  probes: CategoryActionProbes,
  status: CategoryStatus | null,
): Promise<ActionMap> {
  const actingAs = isActingAsSession(context.actor);
  const [canEdit, canRestructure, canImport] = await Promise.all([
    holds(probes.edit, context),
    holds(probes.restructure, context),
    holds(probes.importing, context),
  ]);
  const answer = (held: boolean, stateOk: boolean): ActionAnswer => {
    if (!held) return { allowed: false, denial: 'access.permission-missing' };
    if (actingAs) return { allowed: false, denial: 'access.acting-as-refused' };
    if (!stateOk) return { allowed: false, denial: 'category.not-active' };
    return { allowed: true };
  };
  const active = status === null || status === 'active';
  const actions: Record<string, ActionAnswer> = {};
  if (status === null) {
    actions['platform-category.create'] = answer(canEdit, true);
  } else {
    for (const code of EDIT_ACTIONS) actions[code] = answer(canEdit, active);
    for (const code of RESTRUCTURE_ACTIONS) actions[code] = answer(canRestructure, active);
  }
  if (status === null) for (const code of IMPORT_ACTIONS) actions[code] = answer(canImport, true);
  return actions;
}

/** A category row as the admin routes show it. */
export interface CategoryRowView {
  readonly id: string;
  readonly parentId: string | null;
  readonly slug: string;
  readonly status: CategoryStatus;
  readonly mergedIntoId: string | null;
  readonly names: readonly CategoryName[];
  readonly depth: number;
  readonly position: number;
  readonly version: number;
  readonly counts: CategoryCounts;
}

export const rowViewOf = (row: AdminCategoryRow): CategoryRowView => ({
  id: row.id,
  parentId: row.parentId,
  slug: row.slug,
  status: row.status,
  mergedIntoId: row.mergedIntoId,
  names: row.names,
  depth: row.depth,
  position: row.position,
  version: row.version,
  counts: row.counts,
});
