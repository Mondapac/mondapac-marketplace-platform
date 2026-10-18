import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import { basisStrictness } from './claim-rule';
import { HANDLING_VALUES, type ClaimBasisRequirement, type Handling } from './claim-types';

// The `ClaimBasisPolicy` aggregate's rules (certification design 2.1, 3.7; ADR-0012 d2; CERT-42;
// slice 13). A revision is an immutable set of rows `{ selector, basis }`; a save is a new
// revision. Pure functions: the use cases bring the stored rows, the type's default and the input.

export const POLICY_BASES = [
  'SELLER_REQUIRED',
  'SELLER_OR_MANUFACTURER',
  'NOT_APPLICABLE',
] as const;

/**
 * At most this many rows in one revision: the data design plans for about 300 category rows
 * (data design 7, 12) plus one row per handling value.
 */
export const MAX_POLICY_ROWS = 304;

export type PolicySelector =
  | { readonly kind: 'platform-category'; readonly categoryId: Id<'Category'> }
  | { readonly kind: 'handling'; readonly handling: Handling };

export interface PolicyRow {
  readonly selector: PolicySelector;
  readonly basis: ClaimBasisRequirement;
}

export interface PolicyRowProblem {
  readonly path: string;
  readonly code: string;
}

/** The selector as one string: the category id or the handling value (they cannot collide). */
export function selectorKey(selector: PolicySelector): string {
  return selector.kind === 'handling' ? selector.handling : selector.categoryId;
}

const SELECTOR_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'platform-category': ['selector', 'categoryId', 'basis'],
  handling: ['selector', 'handling', 'basis'],
};

function rowIn(raw: unknown, path: string): Result<PolicyRow, PolicyRowProblem> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err({ path, code: 'type' });
  }
  const record = raw as Record<string, unknown>;
  const { selector } = record;
  if (typeof selector !== 'string' || !Object.hasOwn(SELECTOR_FIELDS, selector)) {
    return err({ path: `${path}.selector`, code: 'format' });
  }
  const allowed = SELECTOR_FIELDS[selector]!;
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      return err({ path: `${path}.${key.slice(0, 64)}`, code: 'unknown-field' });
    }
  }
  const { basis } = record;
  if (typeof basis !== 'string' || !(POLICY_BASES as readonly string[]).includes(basis)) {
    return err({ path: `${path}.basis`, code: 'format' });
  }
  if (selector === 'handling') {
    const { handling } = record;
    if (
      typeof handling !== 'string' ||
      !(HANDLING_VALUES as readonly string[]).includes(handling)
    ) {
      return err({ path: `${path}.handling`, code: 'format' });
    }
    // M1: handling can only tighten; the manufacturer basis is a category's decision.
    if (basis === 'SELLER_OR_MANUFACTURER') {
      return err({ path: `${path}.basis`, code: 'manufacturer-basis-on-handling' });
    }
    return ok({
      selector: { kind: 'handling', handling: handling as Handling },
      basis: basis as ClaimBasisRequirement,
    });
  }
  const { categoryId } = record;
  const parsed = typeof categoryId === 'string' ? parseId<'Category'>(categoryId) : null;
  if (!parsed?.ok) return err({ path: `${path}.categoryId`, code: 'format' });
  return ok({
    selector: { kind: 'platform-category', categoryId: parsed.value },
    basis: basis as ClaimBasisRequirement,
  });
}

/**
 * Parses the rows of a revision (design 2.1): each row a closed object with a closed selector and
 * basis; `SELLER_OR_MANUFACTURER` never on a handling selector (M1); at most one row per
 * selector; at most {@link MAX_POLICY_ROWS}. Whether a category exists in the Market is the use
 * case's question (`CatalogReferences`). The answer is in a canonical order (categories by id,
 * then handling values), so equal row sets compare equal.
 */
export function policyRowsIn(raw: unknown): Result<PolicyRow[], PolicyRowProblem[]> {
  if (!Array.isArray(raw)) return err([{ path: 'rows', code: 'type' }]);
  if (raw.length > MAX_POLICY_ROWS) return err([{ path: 'rows', code: 'length' }]);
  const problems: PolicyRowProblem[] = [];
  const rows: PolicyRow[] = [];
  const seen = new Set<string>();
  raw.forEach((item: unknown, index) => {
    const path = `rows[${index}]`;
    const row = rowIn(item, path);
    if (!row.ok) {
      problems.push(row.error);
      return;
    }
    const key = selectorKey(row.value.selector);
    if (seen.has(key)) {
      problems.push({ path, code: 'duplicate-selector' });
      return;
    }
    seen.add(key);
    rows.push(row.value);
  });
  if (problems.length > 0) return err(problems);
  return ok(canonical(rows));
}

/** Categories by id, then handling values in their declared order. */
export function canonical(rows: readonly PolicyRow[]): PolicyRow[] {
  const rank = (row: PolicyRow): string =>
    row.selector.kind === 'platform-category'
      ? `0:${row.selector.categoryId}`
      : `1:${HANDLING_VALUES.indexOf(row.selector.handling)}`;
  return [...rows].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0));
}

/** One changed selector between two revisions (the `diff` of design 7.6). */
export interface PolicyRowChange {
  readonly path: string;
  readonly before: ClaimBasisRequirement | null;
  readonly after: ClaimBasisRequirement | null;
  /** Why a second admin is needed (H1). */
  readonly relaxes: boolean;
}

/**
 * The selectors whose basis differs between the published revision and a proposed one, each
 * marked when it relaxes (design 3.7; Hassan C1): a basis made less strict; a removed row that
 * is not `SELLER_OR_MANUFACTURER` (its queries fall back to easier rows or the default); an added
 * row less strict than the type's default. Strictness `NOT_APPLICABLE` > `SELLER_REQUIRED` >
 * `SELLER_OR_MANUFACTURER`; an unknown value reads as the strictest, so a doubt asks for the
 * second admin.
 */
export function policyRevisionDiff(
  before: readonly PolicyRow[],
  after: readonly PolicyRow[],
  typeDefault: ClaimBasisRequirement,
): PolicyRowChange[] {
  const old = new Map(before.map((row) => [selectorKey(row.selector), row] as const));
  const next = new Map(after.map((row) => [selectorKey(row.selector), row] as const));
  const changes: PolicyRowChange[] = [];
  for (const row of canonical([
    ...before,
    ...after.filter((r) => !old.has(selectorKey(r.selector))),
  ])) {
    const key = selectorKey(row.selector);
    const was = old.get(key)?.basis ?? null;
    const now = next.get(key)?.basis ?? null;
    if (was === now) continue;
    let relaxes: boolean;
    if (was === null) {
      relaxes = basisStrictness(now!) < basisStrictness(typeDefault);
    } else if (now === null) {
      relaxes = was !== 'SELLER_OR_MANUFACTURER';
    } else {
      relaxes = basisStrictness(now) < basisStrictness(was);
    }
    changes.push({ path: `row:${key}`, before: was, after: now, relaxes });
  }
  return changes;
}

/** True when any change relaxes: the revision waits for a second admin (H1). */
export function relaxesPolicy(changes: readonly PolicyRowChange[]): boolean {
  return changes.some((change) => change.relaxes);
}
