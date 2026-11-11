import type { CallContext } from '@mondapac/shared-kernel';
import type { NamedCategory } from '../../domain/scope-counts';

/**
 * The live platform category tree with public names (catalog's public tree, caller's context).
 * `null` when it cannot be read; the caller then leaves the counts out or throws (a sync).
 */
export interface CategoryTreeSource {
  tree(context: CallContext): Promise<readonly NamedCategory[] | null>;
}

export const CATEGORY_TREE_SOURCE = Symbol('CATEGORY_TREE_SOURCE');
