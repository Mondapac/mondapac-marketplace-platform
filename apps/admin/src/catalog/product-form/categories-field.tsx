'use client';

import { CategoryChooser, choiceLabel, type CategoryChooserLabels } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useCategoryChoices } from './category-choices.ts';
import type { CategoryIssues } from './category-issues.ts';
import { pickLabel } from './draft-content.ts';
import type { FormCategory } from './types.ts';

/** The "Product category" field of the platform product form: path, General, Primary, up to 3. */
export function CategoriesField({
  categories,
  categoryIds,
  defaultLocale,
  issues,
  onChange,
}: {
  /** Every category of the Market (names only): a chosen one the picker does not offer is named from it. */
  readonly categories: readonly FormCategory[];
  /** The first id is the primary category. */
  readonly categoryIds: readonly string[];
  readonly defaultLocale: string;
  /** What the last refused submit said about the categories. */
  readonly issues?: CategoryIssues | undefined;
  readonly onChange: (ids: string[]) => void;
}) {
  const t = useTranslations('catalog.productForm.categories-field');
  const { choices, load } = useCategoryChoices();
  const [announcement, setAnnouncement] = useState('');
  const byId = new Map(categories.map((category) => [category.categoryId, category]));
  const labels: CategoryChooserLabels = {
    legend: t('legend'),
    hint: t('hint'),
    general: t('general'),
    primary: t('primary'),
    hidden: t('hidden'),
    makePrimary: (name) => t('make-primary-for', { name }),
    makePrimaryText: t('make-primary'),
    remove: (name) => t('remove-for', { name }),
    removeText: t('remove'),
    add: t('add'),
    addPlaceholder: t('add-placeholder'),
    empty: t('empty'),
    limitReached: t('limit'),
    loading: t('loading'),
    loadError: t('load-error'),
    retry: t('retry'),
    search: t('search'),
    noResults: t('no-results'),
    added: (name) => t('added', { name }),
    removed: (name) => t('removed', { name }),
    madePrimary: (name) => t('made-primary', { name }),
  };
  // Before the picker is read, a chosen category is named by its path from the form's own list.
  const nameOf = (id: string) => {
    const names: string[] = [];
    let cursor = byId.get(id);
    for (let depth = 0; cursor !== undefined && depth < 8; depth += 1) {
      names.unshift(pickLabel(cursor.names, defaultLocale, cursor.categoryId));
      cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId);
    }
    return names.length === 0 ? id : names.join(' › ');
  };
  const list = choices.state === 'ready' ? choices.choices : [];
  const labelOf = (id: string) => {
    const choice = list.find((item) => item.id === id);
    return choice === undefined ? nameOf(id) : choiceLabel(choice, labels.general);
  };
  return (
    <CategoryChooser
      choices={list}
      value={categoryIds}
      labels={labels}
      loading={choices.state === 'loading'}
      failed={choices.state === 'failed'}
      onRetry={load}
      onOpen={load}
      nameOf={nameOf}
      error={issues?.list === undefined ? undefined : t(`error.${issues.list}`)}
      itemErrors={Object.fromEntries(
        Object.entries(issues?.items ?? {}).map(([index, code]) => [index, t(`error.${code}`)]),
      )}
      announcement={announcement}
      onChange={(ids) => {
        const added = ids.find((id) => !categoryIds.includes(id));
        const removed = categoryIds.find((id) => !ids.includes(id));
        setAnnouncement(
          added !== undefined
            ? labels.added(labelOf(added))
            : removed !== undefined
              ? labels.removed(labelOf(removed))
              : labels.madePrimary(labelOf(ids[0] ?? '')),
        );
        onChange(ids);
      }}
    />
  );
}
