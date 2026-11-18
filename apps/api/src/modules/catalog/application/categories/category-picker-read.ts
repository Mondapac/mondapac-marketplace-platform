import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { categoryPicker, type PickerChoice } from '../../domain/category-picker';
import { MAX_TREE_NODES } from '../../domain/category-tree';
import type { AdminCategoryReader } from '../ports/admin-category.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

export interface CategoryPickerDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly adminCategoryReader: AdminCategoryReader;
  readonly policy: CatalogMarketPolicy;
}

export interface CategoryPickerAnswer {
  /** The locale the names are in (the Market default; a missing name falls back to another). */
  readonly locale: string;
  readonly choices: readonly PickerChoice[];
}

export type CategoryPickerFailure =
  { readonly code: 'access.denied' } | { readonly code: 'catalog.categories-unavailable' };

export async function readPicker(
  deps: CategoryPickerDependencies,
  context: CallContext,
  includeHidden: boolean,
): Promise<Result<CategoryPickerAnswer, CategoryPickerFailure>> {
  const { market } = context;
  let locale: string;
  let maxLevel: number;
  try {
    locale = deps.policy.locales(market).default;
    maxLevel = deps.policy.maxCategoryDepth(market);
  } catch {
    return err({ code: 'catalog.categories-unavailable' });
  }
  const read = await deps.unitOfWork.run(
    market,
    async () => ok(await deps.adminCategoryReader.categories(market, MAX_TREE_NODES + 1)),
    { readOnly: true },
  );
  // A tree larger than the cap is refused, never shown in part (fail closed).
  if (!read.ok || read.value.length > MAX_TREE_NODES) {
    return err({ code: 'catalog.categories-unavailable' });
  }
  return ok({ locale, choices: categoryPicker(read.value, locale, maxLevel, includeHidden) });
}
