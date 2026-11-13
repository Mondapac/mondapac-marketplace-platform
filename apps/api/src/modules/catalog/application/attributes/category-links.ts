import { ok, parseId } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import type { AttributeDefinitionRecord } from '../ports/attribute-admin.reader';
import type { StoredLinkFact } from '../ports/category-attribute-link.store';
import {
  FILTERABLE_DATA_TYPES,
  resolveEffective,
  type CategoryAttributeLink,
  type EffectiveAttributes,
} from '../../domain/category-attribute-link';
import { MAX_TREE_DEPTH, type StoredCategoryNode } from '../../domain/category-tree';
import { invalid, type FieldIssue, type ValidationFailure } from './attribute-editor';

export function categoryIdOf(raw: unknown): Id<'Category'> | null {
  const parsed = typeof raw === 'string' ? parseId<'Category'>(raw) : null;
  return parsed !== null && parsed.ok ? parsed.value : null;
}

/** The most links one Market's resolution reads (a link exists only for a category an admin set). */
export const CATEGORY_LINKS_LOAD_MAX = 5000;

/** What an admin sent: the feature set (null: inherit) and the filter codes in order. */
export interface ParsedCategoryLinks {
  readonly familyId: Id<'AttributeFamily'> | null;
  readonly filters: readonly string[];
}

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;
const FILTERS_INPUT_MAX = 100;

export function parseCategoryLinks(
  body: Record<string, unknown>,
): Result<ParsedCategoryLinks, ValidationFailure> {
  const rawFamily = body['featureSetId'];
  let familyId: Id<'AttributeFamily'> | null = null;
  if (rawFamily !== null && rawFamily !== undefined) {
    const parsed = typeof rawFamily === 'string' ? parseId<'AttributeFamily'>(rawFamily) : null;
    if (parsed === null || !parsed.ok) return invalid('featureSetId', 'format');
    familyId = parsed.value;
  }
  const raw = body['filters'];
  if (!Array.isArray(raw)) return invalid('filters', 'type');
  if (raw.length > FILTERS_INPUT_MAX) return invalid('filters', 'too-many');
  const filters: string[] = [];
  for (const [index, code] of (raw as readonly unknown[]).entries()) {
    if (typeof code !== 'string' || !CODE.test(code)) return invalid(`filters[${index}]`, 'format');
    filters.push(code);
  }
  return ok({ familyId, filters });
}

export type FilterRefusal =
  | { readonly code: 'category-links.filter-unknown'; readonly fields: readonly FieldIssue[] }
  | {
      readonly code: 'category-links.filter-not-filterable';
      readonly fields: readonly FieldIssue[];
    };

/**
 * Every filter must name an **active** definition that an admin allowed as a filter and whose
 * type a buyer can filter by (decision ت۸). A draft or archived attribute is not offered.
 */
export function checkFilters(
  filters: readonly string[],
  definitions: ReadonlyMap<string, AttributeDefinitionRecord>,
): FilterRefusal | null {
  const unknown: FieldIssue[] = [];
  const notFilterable: FieldIssue[] = [];
  for (const [index, code] of filters.entries()) {
    const definition = definitions.get(code);
    const path = `filters[${index}]`;
    if (definition === undefined || definition.status !== 'active') {
      unknown.push({ path, code: 'unknown' });
    } else if (
      !FILTERABLE_DATA_TYPES.includes(definition.dataType) ||
      !definition.revision.display.canBeFilter
    ) {
      notFilterable.push({ path, code: 'not-filterable' });
    }
  }
  if (unknown.length > 0) return { code: 'category-links.filter-unknown', fields: unknown };
  if (notFilterable.length > 0) {
    return { code: 'category-links.filter-not-filterable', fields: notFilterable };
  }
  return null;
}

/**
 * The category and its ancestors, the category first, following each stored parent. A category
 * missing from the tree, a loop or a chain deeper than the tree allows is `null`: nothing is
 * resolved from a tree that cannot be read (fail closed).
 */
export function chainOf(
  categoryId: string,
  nodes: readonly StoredCategoryNode[],
  /** The nodes by id, when the caller resolves many categories against one tree. */
  index?: ReadonlyMap<string, StoredCategoryNode>,
): readonly string[] | null {
  const byId = index ?? new Map(nodes.map((node) => [node.id as string, node]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = categoryId;
  while (current !== null) {
    const node = byId.get(current);
    if (node === undefined || seen.has(current) || chain.length > MAX_TREE_DEPTH) return null;
    seen.add(current);
    chain.push(current);
    current = node.parentId;
  }
  return chain;
}

export function effectiveOf(
  chain: readonly string[],
  links: readonly StoredLinkFact[],
  own?: CategoryAttributeLink | null,
  /** The links by category id, when the caller resolves many categories against one list. */
  index?: ReadonlyMap<string, StoredLinkFact>,
): EffectiveAttributes {
  const byCategory = index ?? new Map<string, StoredLinkFact>(links.map((l) => [l.categoryId, l]));
  return resolveEffective(chain, (id) => {
    if (own !== undefined && own !== null && id === own.state.categoryId) {
      return { familyId: own.state.familyId, filters: own.state.filters };
    }
    return byCategory.get(id);
  });
}
