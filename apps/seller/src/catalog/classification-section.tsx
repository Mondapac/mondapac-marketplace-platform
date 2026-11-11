'use client';

import { Card, CheckboxRow, Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { pickLabel } from './draft-content.ts';
import type { FormCategory } from './types.ts';

function depthOf(category: FormCategory, byId: ReadonlyMap<string, FormCategory>): number {
  let depth = 0;
  let parent = category.parentId;
  while (parent !== null && depth < 8) {
    depth += 1;
    parent = byId.get(parent)?.parentId ?? null;
  }
  return depth;
}

/** Where the product is filed (platform categories), its tax category and, below them, its tags. */
export function ClassificationSection({
  categories,
  taxCategoryCodes,
  categoryIds,
  taxCategoryCode,
  defaultLocale,
  onCategories,
  onTax,
  children,
}: {
  readonly categories: readonly FormCategory[];
  readonly taxCategoryCodes: readonly string[];
  readonly categoryIds: readonly string[];
  readonly taxCategoryCode: string;
  readonly defaultLocale: string;
  readonly onCategories: (ids: string[]) => void;
  readonly onTax: (code: string) => void;
  /** The optional fields that follow the tax category (the tags). */
  readonly children?: ReactNode;
}) {
  const t = useTranslations();
  const byId = new Map(categories.map((category) => [category.categoryId, category]));
  return (
    <Card title={t('catalog.edit.classification')}>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-fg">{t('catalog.edit.categories')}</legend>
        {categories.length === 0 ? (
          <p className="text-sm text-fg-muted">{t('catalog.edit.categories-none')}</p>
        ) : (
          categories.map((category) => (
            <div
              key={category.categoryId}
              style={{ paddingInlineStart: `${depthOf(category, byId) * 1.25}rem` }}
            >
              <CheckboxRow
                name={`category.${category.categoryId}`}
                label={pickLabel(category.names, defaultLocale, category.categoryId)}
                checked={categoryIds.includes(category.categoryId)}
                onChange={(event) =>
                  onCategories(
                    event.target.checked
                      ? [...categoryIds, category.categoryId]
                      : categoryIds.filter((id) => id !== category.categoryId),
                  )
                }
              />
            </div>
          ))
        )}
      </fieldset>
      <Select
        name="taxCategoryCode"
        label={t('catalog.edit.tax-category')}
        placeholder={t('catalog.edit.attribute.unset')}
        options={taxCategoryCodes.map((code) => ({ value: code, label: code }))}
        value={taxCategoryCode}
        onChange={(event) => onTax(event.target.value)}
      />
      {children}
    </Card>
  );
}
