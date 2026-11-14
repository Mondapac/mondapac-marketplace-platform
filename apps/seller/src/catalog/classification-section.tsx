'use client';

import {
  Card,
  CategoryChooser,
  Select,
  choiceLabel,
  type CategoryChooserLabels,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { useCategoryChoices } from './category-choices.ts';
import type { CategoryIssues } from './category-issues.ts';
import { pickLabel } from './draft-content.ts';
import type { FormCategory } from './types.ts';

/** Where the product is filed (platform categories), its tax category and, below them, its tags. */
export function ClassificationSection({
  categories,
  taxCategoryCodes,
  categoryIds,
  taxCategoryCode,
  defaultLocale,
  categoryIssues,
  onCategories,
  onTax,
  children,
}: {
  /** Every category of the Market (names only): a chosen one the picker no longer offers is named from it. */
  readonly categories: readonly FormCategory[];
  readonly taxCategoryCodes: readonly string[];
  /** The first id is the primary category. */
  readonly categoryIds: readonly string[];
  readonly taxCategoryCode: string;
  readonly defaultLocale: string;
  /** What the last refused submit said about the categories. */
  readonly categoryIssues?: CategoryIssues | undefined;
  readonly onCategories: (ids: string[]) => void;
  readonly onTax: (code: string) => void;
  /** The optional fields that follow the tax category (the tags). */
  readonly children?: ReactNode;
}) {
  const t = useTranslations('catalog.edit');
  const { choices, load } = useCategoryChoices();
  const [announcement, setAnnouncement] = useState('');
  const byId = new Map(categories.map((category) => [category.categoryId, category]));
  const labels: CategoryChooserLabels = {
    legend: t('categories'),
    hint: t('categories-hint'),
    general: t('categories-general'),
    generalHint: t('categories-general-hint'),
    primary: t('categories-primary'),
    hidden: t('categories-hidden'),
    makePrimary: (name) => t('categories-make-primary-for', { name }),
    makePrimaryText: t('categories-make-primary'),
    remove: (name) => t('categories-remove-for', { name }),
    removeText: t('categories-remove'),
    add: t('categories-add'),
    addPlaceholder: t('categories-add-placeholder'),
    empty: t('categories-empty'),
    limitReached: t('categories-limit'),
    loading: t('categories-loading'),
    loadError: t('categories-load-error'),
    retry: t('categories-retry'),
    search: t('categories-search'),
    noResults: t('categories-no-results'),
    added: (name) => t('categories-added', { name }),
    removed: (name) => t('categories-removed', { name }),
    madePrimary: (name) => t('categories-made-primary', { name }),
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
  const choiceList = choices.state === 'ready' ? choices.choices : [];
  const labelOf = (id: string) => {
    const choice = choiceList.find((item) => item.id === id);
    return choice === undefined ? nameOf(id) : choiceLabel(choice, labels.general);
  };
  const issueText = (code: string) => t(`categories-error.${code}`);
  return (
    <Card title={t('classification')}>
      <CategoryChooser
        choices={choiceList}
        value={categoryIds}
        labels={labels}
        loading={choices.state === 'loading'}
        failed={choices.state === 'failed'}
        onRetry={load}
        onOpen={load}
        nameOf={nameOf}
        error={categoryIssues?.list === undefined ? undefined : issueText(categoryIssues.list)}
        itemErrors={Object.fromEntries(
          Object.entries(categoryIssues?.items ?? {}).map(([index, code]) => [
            index,
            issueText(code),
          ]),
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
          onCategories(ids);
        }}
      />
      <Select
        name="taxCategoryCode"
        label={t('tax-category')}
        placeholder={t('attribute.unset')}
        options={taxCategoryCodes.map((code) => ({ value: code, label: code }))}
        value={taxCategoryCode}
        onChange={(event) => onTax(event.target.value)}
      />
      {children}
    </Card>
  );
}
