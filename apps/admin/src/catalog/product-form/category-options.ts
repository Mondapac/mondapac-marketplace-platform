import type { SearchSelectOption } from '@mondapac/ui';
import { pickLabel } from './draft-content.ts';
import type { FormCategory } from './types.ts';

/** Every category as an option named by its full path (`Pantry › Rice and grains › Basmati`). */
export function categoryOptions(
  categories: readonly FormCategory[],
  locale: string,
): SearchSelectOption[] {
  const byId = new Map(categories.map((category) => [category.categoryId, category]));
  const pathOf = (category: FormCategory): string => {
    const names: string[] = [];
    let current: FormCategory | undefined = category;
    for (let depth = 0; current !== undefined && depth < 8; depth += 1) {
      names.unshift(pickLabel(current.names, locale, current.categoryId));
      current = current.parentId === null ? undefined : byId.get(current.parentId);
    }
    return names.join(' › ');
  };
  return categories
    .map((category) => ({ value: category.categoryId, label: pathOf(category) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
