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
 * The change buttons are shown here too (off for a reader, as on the wide view); they need the tree
 * (for the order among siblings and the languages), so it is read beside the category. Without it
 * the category is still shown.
 */
export function CategoryPageView({
  id,
  canEdit,
  canRestructure = false,
  csrfToken = '',
}: {
  readonly id: string;
  readonly canEdit: boolean;
  /** `catalog.category-tree.restructure`: Move, Merge and Archive. */
  readonly canRestructure?: boolean;
  readonly csrfToken?: string;
}) {
  const t = useTranslations('categories');
  const router = useRouter();
  const [tree, setTree] = useState<TreeBody | null>(null);
  const [version, setVersion] = useState(0);
  const latest = useRef(0);
  // What the last write says; focus goes to this line after a write, because the buttons that
  // started it are gone with the remounted details.
  const [note, setNote] = useState<string | null>(null);
  const noteLine = useRef<HTMLParagraphElement>(null);
  const focusNote = useRef(false);

  const fetchTree = useCallback(async () => {
    const ticket = ++latest.current;
    const result = await callApi<TreeBody>('GET', API_CATEGORIES);
    if (ticket !== latest.current) return;
    if (!result.ok && result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setTree(result.ok ? result.body : null);
  }, []);

  useEffect(() => {
    void fetchTree();
  }, [fetchTree]);

  useEffect(() => {
    if (!focusNote.current || note === null) return;
    focusNote.current = false;
    noteLine.current?.focus();
  }, [note, version]);

  return (
    <div className="flex flex-col gap-4">
      <p>
        <a className="font-medium text-link underline" href={CATEGORIES_PATH}>
          {t('back')}
        </a>
      </p>
      {canEdit ? null : <Banner tone="info">{t('view-only')}</Banner>}
      <p ref={noteLine} role="status" tabIndex={-1} className="m-0 min-h-5 text-sm text-fg-muted">
        {note}
      </p>
      <CategoryDetails
        key={version}
        id={id}
        tree={tree}
        canEdit={canEdit}
        canRestructure={canRestructure}
        csrfToken={csrfToken}
        onChanged={(message) => {
          setNote(message ?? null);
          focusNote.current = message !== undefined;
          setVersion((n) => n + 1);
          void fetchTree();
        }}
        onCreated={(newId) => router.push(`${CATEGORIES_PATH}/${newId}`)}
      />
    </div>
  );
}
