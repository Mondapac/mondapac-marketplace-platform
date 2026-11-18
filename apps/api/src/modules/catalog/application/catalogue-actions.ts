import type { Id } from '@mondapac/shared-kernel';
import { parseId } from '@mondapac/shared-kernel';
import type { ChangeValues } from '../../system-requests';
import type { AttributeDefinition } from '../domain/attribute-definition';
import type { EditableCategory } from '../domain/category-edit';

// The values of the catalogue's actions that wait for approval (Admin Inbox › System requests,
// owner decision of 18 Nov 2026) and of the creates and moves that are reviewed after, as a
// request keeps them (plain JSON, three levels, 10 KB at most), and what reads them back. `before`
// is what the subject held when the action was asked for; the applier compares it again before it
// writes. `after` names the action and what it needs, in the shape the applier reads.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const idOf = <T extends string>(raw: unknown): Id<T> | null => {
  if (typeof raw !== 'string') return null;
  const parsed = parseId<T>(raw);
  return parsed.ok ? parsed.value : null;
};

// ---- categories ------------------------------------------------------------------------------

/** What an action on a category is compared with: its status, version and parent. */
export const categoryStateValues = (category: EditableCategory): ChangeValues => ({
  status: category.status,
  version: category.version,
  parentId: category.parentId,
});

/** Whether a category still holds the state `before` names (status, version and parent). */
export function holdsCategoryState(category: EditableCategory, before: unknown): boolean {
  if (!isRecord(before)) return false;
  return (
    before['status'] === category.status &&
    before['version'] === category.version &&
    (before['parentId'] ?? null) === category.parentId
  );
}

export type CategoryAction =
  | { readonly action: 'discard' }
  | { readonly action: 'merge'; readonly targetId: Id<'Category'>; readonly reason: string }
  | { readonly action: 'archive'; readonly reason: string };

export const categoryActionValues = (action: CategoryAction): ChangeValues => ({ ...action });

/** The action a request's `after` names; null when it is not one of ours. */
export function categoryActionOf(values: unknown): CategoryAction | null {
  if (!isRecord(values)) return null;
  const { action, reason } = values;
  if (action === 'discard') return { action };
  if (typeof reason !== 'string') return null;
  if (action === 'archive') return { action, reason };
  if (action === 'merge') {
    const targetId = idOf<'Category'>(values['targetId']);
    return targetId === null ? null : { action, targetId, reason };
  }
  return null;
}

/** Moving every product of a category to another (approval mode). */
export interface ProductsMoveAction {
  readonly action: 'move-products';
  readonly targetId: Id<'Category'>;
  readonly reason: string;
  /** The published products counted when the move was asked for (the job reads them again). */
  readonly products: number;
}

export const productsMoveValues = (action: ProductsMoveAction): ChangeValues => ({ ...action });

export function productsMoveOf(values: unknown): ProductsMoveAction | null {
  if (!isRecord(values) || values['action'] !== 'move-products') return null;
  const targetId = idOf<'Category'>(values['targetId']);
  const { reason, products } = values;
  if (targetId === null || typeof reason !== 'string' || typeof products !== 'number') return null;
  return { action: 'move-products', targetId, reason, products };
}

/** A new category (review mode): before it nothing; after it the created category's keys. */
export const categoryCreatedValues = (category: {
  readonly slug: string;
  readonly parentId: string | null;
}): ChangeValues => ({ exists: true, slug: category.slug, parentId: category.parentId });

/** A category moved (review mode): the parent before and after. */
export const categoryParentValues = (parentId: string | null): ChangeValues => ({ parentId });

/** The parent a move's values name (null: a department); undefined when they are not ours. */
export function parentOf(values: unknown): Id<'Category'> | null | undefined {
  if (!isRecord(values) || !('parentId' in values)) return undefined;
  if (values['parentId'] === null) return null;
  return idOf<'Category'>(values['parentId']) ?? undefined;
}

/** A reorder (review mode): the category's place and the sibling it swapped with. */
export interface ReorderValues {
  readonly position: number;
  readonly neighbourId: Id<'Category'>;
  readonly neighbourPosition: number;
}

export const reorderValues = (values: ReorderValues): ChangeValues => ({ ...values });

export function reorderOf(values: unknown): ReorderValues | null {
  if (!isRecord(values)) return null;
  const { position, neighbourPosition } = values;
  const neighbourId = idOf<'Category'>(values['neighbourId']);
  if (typeof position !== 'number' || typeof neighbourPosition !== 'number') return null;
  return neighbourId === null ? null : { position, neighbourId, neighbourPosition };
}

// ---- attributes ------------------------------------------------------------------------------

/** What an action on an attribute definition is compared with. */
export const attributeStateValues = (definition: AttributeDefinition): ChangeValues => ({
  code: definition.state.code,
  status: definition.state.status,
  version: definition.state.version,
  material: definition.state.material,
});

/** The most value pairs a merge proposal keeps (a request keeps lists of 100 at most). */
export const PROPOSAL_MAX_MAPPED_VALUES = 100;

export type AttributeAction =
  | { readonly action: 'discard'; readonly version: number }
  | { readonly action: 'archive'; readonly version: number }
  | {
      readonly action: 'merge-values';
      readonly version: number;
      readonly source: string;
      readonly target: string;
    }
  | {
      readonly action: 'merge';
      readonly version: number;
      readonly targetId: Id<'AttributeDefinition'>;
      readonly targetVersion: number;
      readonly options: Readonly<Record<string, string>>;
    };

/** The values of an attribute action; a merge's value map as `from=to` pairs in code order. */
export function attributeActionValues(action: AttributeAction): ChangeValues {
  if (action.action !== 'merge') return { ...action };
  return {
    action: action.action,
    version: action.version,
    targetId: action.targetId,
    targetVersion: action.targetVersion,
    options: Object.entries(action.options)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([from, to]) => `${from}=${to}`),
  };
}

const CODE = /^[a-z][a-z0-9_-]{0,63}$/;

export function attributeActionOf(values: unknown): AttributeAction | null {
  if (!isRecord(values)) return null;
  const { action, version } = values;
  if (typeof version !== 'number') return null;
  if (action === 'discard' || action === 'archive') return { action, version };
  if (action === 'merge-values') {
    const { source, target } = values;
    if (typeof source !== 'string' || !CODE.test(source)) return null;
    if (typeof target !== 'string' || !CODE.test(target)) return null;
    return { action, version, source, target };
  }
  if (action === 'merge') {
    const targetId = idOf<'AttributeDefinition'>(values['targetId']);
    const { targetVersion, options } = values;
    if (targetId === null || typeof targetVersion !== 'number' || !Array.isArray(options)) {
      return null;
    }
    const map: Record<string, string> = {};
    for (const pair of options) {
      if (typeof pair !== 'string') return null;
      const [from, to, extra] = pair.split('=');
      if (extra !== undefined || from === undefined || to === undefined) return null;
      if (!CODE.test(from) || !CODE.test(to)) return null;
      map[from] = to;
    }
    return { action, version, targetId, targetVersion, options: map };
  }
  return null;
}

/** A new attribute definition (review mode): the draft's code and the version it was made at. */
export const attributeCreatedValues = (definition: AttributeDefinition): ChangeValues => ({
  exists: true,
  code: definition.state.code,
  status: definition.state.status,
});

/** Nothing was there before a create. */
export const NOTHING_BEFORE: ChangeValues = { exists: false };
