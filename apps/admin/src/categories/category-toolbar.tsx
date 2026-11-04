'use client';

import { Button } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import {
  ChangeSlugDialog,
  ConfirmCategoryDialog,
  CreateCategoryDialog,
  EditDetailsDialog,
  type ConfirmKind,
} from './category-dialogs.tsx';
import { useCategoryCall } from './use-category-call.ts';
import { CategoryProblemBanner } from './category-problem.tsx';
import { API_CATEGORIES, type DetailBody, type WriteWrap } from './types.ts';

type Open = 'edit' | 'add-child' | 'slug' | ConfirmKind | null;

/** What an admin may do to the picked category: edit, add a child, move, hide or show, rename its URL, discard. */
export function CategoryToolbar({
  body,
  canEdit,
  csrfToken,
  supportedLocales,
  firstSibling,
  lastSibling,
  hasChildren,
  descendants,
  title,
  onChanged,
  onCreated,
}: {
  readonly body: DetailBody;
  readonly canEdit: boolean;
  readonly csrfToken: string;
  readonly supportedLocales: readonly string[];
  readonly firstSibling: boolean;
  readonly lastSibling: boolean;
  readonly hasChildren: boolean;
  readonly descendants: number;
  readonly title: string;
  /** A write is done (or the page read old data): read the tree and the category again. */
  readonly onChanged: (note?: string, focusId?: string) => void;
  /** A child was added: the owner opens the parent and picks the new one. */
  readonly onCreated: (id: string, parentId: string) => void;
}) {
  const t = useTranslations('categories.toolbar');
  const [open, setOpen] = useState<Open>(null);
  const move = useCategoryCall(csrfToken);
  const { category } = body;
  // A hidden category is edited like an active one; the API refuses an archived or merged one.
  const editable = category.status === 'active' || category.status === 'hidden';
  const isHidden = category.status === 'hidden';
  const closeAndRefresh = (note?: string) => {
    setOpen(null);
    onChanged(note);
  };
  // A dialog that closes (saved or cancelled) hands focus back to the category's row in the tree;
  // where there is no tree beside the details (a narrow screen) the dialog's own return stands.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open !== null) {
      wasOpen.current = true;
      return;
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    document.querySelector<HTMLElement>(`[data-row-id="${category.id}"]`)?.focus();
  }, [open, category.id]);

  async function reorder(direction: 'up' | 'down') {
    const answer = await move.run<WriteWrap>('POST', `${API_CATEGORIES}/${category.id}/reorder`, {
      direction,
      treeVersion: body.treeVersion,
    });
    // A refusal stays in view with a button to read again; reading at once would clear it.
    if (answer.ok) onChanged(t(direction === 'up' ? 'note-up' : 'note-down'), category.id);
  }

  if (!canEdit) return null;
  // The action map marks only `active` categories as allowed, and a hidden one is edited too, so
  // the buttons follow the permission and the status; the API checks both again on every write.
  const rename = editable;
  const canDiscard = isHidden && category.counts.liveProducts === 0 && !hasChildren;
  // Why a Move button is off, shown as a line and linked to both buttons.
  const moveReason =
    firstSibling && lastSibling
      ? 'reason-only'
      : firstSibling
        ? 'reason-first'
        : lastSibling
          ? 'reason-last'
          : null;

  return (
    <div className="flex flex-col gap-2">
      <CategoryProblemBanner problem={move.problem} />
      {move.problem?.reload === true ? (
        <div>
          <Button variant="secondary" onClick={() => onChanged()}>
            {t('reload')}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('label')}>
        <Button variant="secondary" disabled={!rename} onClick={() => setOpen('edit')}>
          {t('edit')}
        </Button>
        <Button variant="secondary" disabled={!rename} onClick={() => setOpen('add-child')}>
          {t('add-child')}
        </Button>
        <Button
          variant="secondary"
          disabled={!rename || firstSibling || move.pending}
          aria-describedby={moveReason === null ? undefined : 'category-move-reason'}
          onClick={() => void reorder('up')}
        >
          {t('move-up')}
        </Button>
        <Button
          variant="secondary"
          disabled={!rename || lastSibling || move.pending}
          aria-describedby={moveReason === null ? undefined : 'category-move-reason'}
          onClick={() => void reorder('down')}
        >
          {t('move-down')}
        </Button>
        {isHidden ? (
          <Button variant="secondary" disabled={!rename} onClick={() => setOpen('show')}>
            {t('show')}
          </Button>
        ) : (
          <Button variant="secondary" disabled={!rename} onClick={() => setOpen('hide')}>
            {t('hide')}
          </Button>
        )}
        <Button variant="secondary" disabled={!rename} onClick={() => setOpen('slug')}>
          {t('change-slug')}
        </Button>
        {canDiscard ? (
          <Button variant="destructive" onClick={() => setOpen('discard')}>
            {t('discard')}
          </Button>
        ) : null}
      </div>
      {moveReason === null || !rename ? null : (
        <p id="category-move-reason" className="m-0 text-sm text-fg-muted">
          {t(moveReason)}
        </p>
      )}
      {open === 'edit' ? (
        <EditDetailsDialog
          body={body}
          supportedLocales={supportedLocales}
          csrfToken={csrfToken}
          onClose={() => setOpen(null)}
          onSaved={() => closeAndRefresh(t('note-edit'))}
          onReload={() => closeAndRefresh()}
        />
      ) : null}
      {open === 'add-child' ? (
        <CreateCategoryDialog
          parent={category.id}
          parentName={title}
          treeVersion={body.treeVersion}
          supportedLocales={supportedLocales}
          requiredLocales={body.requiredLocales}
          csrfToken={csrfToken}
          onClose={() => setOpen(null)}
          onCreated={(id) => {
            setOpen(null);
            onCreated(id, category.id);
          }}
          onReload={() => closeAndRefresh()}
        />
      ) : null}
      {open === 'slug' ? (
        <ChangeSlugDialog
          body={body}
          csrfToken={csrfToken}
          onClose={() => setOpen(null)}
          onSaved={() => closeAndRefresh(t('note-slug'))}
          onReload={() => closeAndRefresh()}
        />
      ) : null}
      {open === 'hide' || open === 'show' || open === 'discard' ? (
        <ConfirmCategoryDialog
          kind={open}
          body={body}
          name={title}
          descendants={descendants}
          csrfToken={csrfToken}
          onClose={() => setOpen(null)}
          onDone={() => closeAndRefresh(t(`note-${open}`))}
          onReload={() => closeAndRefresh()}
        />
      ) : null}
    </div>
  );
}
