'use client';

import { Banner } from '@mondapac/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { CategoryDetails } from './category-details.tsx';
import { API_CATEGORIES, CATEGORIES_PATH, type TreeBody } from './types.ts';

/**
 * The details of one category as a page: how a phone, a tablet or a narrow window shows them.
 * An editor also gets the change buttons here; they need the tree (for the order among siblings
 * and the languages), so it is read beside the category. Without it the category is still shown.
 */
export function CategoryPageView({
  id,
  canEdit,
  csrfToken = '',
}: {
  readonly id: string;
  readonly canEdit: boolean;
  readonly csrfToken?: string;
}) {
  const t = useTranslations('categories');
  const router = useRouter();
  const [tree, setTree] = useState<TreeBody | null>(null);
  const [version, setVersion] = useState(0);
  const latest = useRef(0);

  const fetchTree = useCallback(async () => {
    if (!canEdit) return;
    const ticket = ++latest.current;
    const result = await callApi<TreeBody>('GET', API_CATEGORIES);
    if (ticket !== latest.current) return;
    if (!result.ok && result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setTree(result.ok ? result.body : null);
  }, [canEdit]);

  useEffect(() => {
    void fetchTree();
  }, [fetchTree]);

  return (
    <div className="flex flex-col gap-4">
      <p>
        <a className="font-medium text-link underline" href={CATEGORIES_PATH}>
          {t('back')}
        </a>
      </p>
      {canEdit ? null : <Banner tone="info">{t('view-only')}</Banner>}
      <CategoryDetails
        key={version}
        id={id}
        tree={tree}
        canEdit={canEdit}
        csrfToken={csrfToken}
        onChanged={() => {
          setVersion((n) => n + 1);
          void fetchTree();
        }}
        onCreated={(newId) => router.push(`${CATEGORIES_PATH}/${newId}`)}
      />
    </div>
  );
}
