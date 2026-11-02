'use client';

import { useTranslations } from 'next-intl';
import { CategoryDetails } from './category-details.tsx';
import { CATEGORIES_PATH } from './types.ts';

/** The details of one category as a page: how a phone or a narrow window shows them. */
export function CategoryPageView({
  id,
  canEdit,
}: {
  readonly id: string;
  readonly canEdit: boolean;
}) {
  const t = useTranslations('categories');
  return (
    <div className="flex flex-col gap-4">
      <p>
        <a className="font-medium text-link underline" href={CATEGORIES_PATH}>
          {t('back')}
        </a>
      </p>
      <CategoryDetails id={id} canEdit={canEdit} />
    </div>
  );
}
