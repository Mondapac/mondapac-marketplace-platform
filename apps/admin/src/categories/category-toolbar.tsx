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
import { RestructureDialog } from './restructure-dialog.tsx';
import type { RestructureKind } from './restructure-model.ts';
import { useCategoryCall } from './use-category-call.ts';
import { CategoryProblemBanner } from './category-problem.tsx';
import { API_CATEGORIES, type CategoryRow, type DetailBody, type WriteWrap } from './types.ts';

type Open = 'edit' | 'add-child' | 'slug' | ConfirmKind | RestructureKind | null;

/** What an admin may do to the picked category: edit, add a child, move, hide or show, rename its URL, discard. */
export function CategoryToolbar({
  body,
  canEdit,
  canRestructure = false,
  rows = [],
  defaultLocale = '',
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
  /** `catalog.category-tree.restructure`: Move, Merge and Archive are shown only with it. */
  readonly canRestructure?: boolean;
  /** Every category of the tree (the targets of Move and Merge) and the language of its names. */
  readonly rows?: readonly CategoryRow[];
  readonly defaultLocale?: string;
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
  const closeAndRefresh = (note?: string, focusId?: string) => {
    setOpen(null);
    onChanged(note, focusId);
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

  // The action map marks only `active` categories as allowed, and a hidden one is edited too, so
  // the buttons follow the permission and the status; the API checks both again on every write.
  // A reader sees every button, all off (the page above says why); the API checks every write.
  const rename = canEdit && editable;
  const canDiscard = canEdit && isHidden && category.counts.liveProducts === 0 && !hasChildren;
  // Why a Move button is off, shown as a line and linked to both buttons.
  const moveReason =
    firstSibling && lastSibling
      ? 'reason-only'
      : firstSibling
        ? 'reason-first'
        : lastSibling
          ? 'reason-last'
          : null;
  // Why Move…, Merge… or Archive… is off, from the details read's denial code. A missing permission
  // is not explained here (the buttons are hidden without it); an unknown code gets no line.
  const REASON_ID = 'category-restructure-reason';
  const denialCopy: Record<string, string> = {
    'access.acting-as-refused': t('restructure-reason-acting-as'),
    'category.not-active': t('restructure-reason-not-active'),
  };
  const reasons = new Set<string>();
  for (const kind of ['move', 'merge', 'archive'] as const) {
    const answer = body.actions[`platform-category.${kind}`];
    if (answer === undefined || answer.allowed) continue;
    const text = answer.denial === undefined ? undefined : denialCopy[answer.denial];
    if (text !== undefined) reasons.add(text);
  }
  const restructureReason = reasons.size === 0 ? null : [...reasons].join(' ');
  const showReason = rename && moveReason !== null;

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
          aria-describedby={showReason ? 'category-move-reason' : undefined}
          onClick={() => void reorder('up')}
        >
          {t('move-up')}
        </Button>
        <Button
          variant="secondary"
          disabled={!rename || lastSibling || move.pending}
          aria-describedby={showReason ? 'category-move-reason' : undefined}
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
        {canRestructure
          ? (['move', 'merge', 'archive'] as const).map((kind) => {
              const off = body.actions[`platform-category.${kind}`]?.allowed !== true;
              return (
                <Button
                  key={kind}
                  variant="secondary"
                  disabled={off}
                  aria-describedby={off && restructureReason !== null ? REASON_ID : undefined}
                  onClick={() => setOpen(kind)}
                >
                  {t(kind)}
                </Button>
              );
            })
          : null}
        {canDiscard ? (
          <Button variant="destructive" onClick={() => setOpen('discard')}>
            {t('discard')}
          </Button>
        ) : null}
      </div>
      {canRestructure && restructureReason !== null ? (
        <p id={REASON_ID} className="m-0 text-sm text-fg-muted">
          {restructureReason}
        </p>
      ) : null}
      {!showReason || moveReason === null ? null : (
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
          onDone={() =>
            // A discarded category has no row left: focus goes to its parent's.
            closeAndRefresh(
              t(`note-${open}`),
              open === 'discard' ? (category.parentId ?? undefined) : undefined,
            )
          }
          onReload={() => closeAndRefresh()}
        />
      ) : null}
      {open === 'move' || open === 'merge' || open === 'archive' ? (
        <RestructureDialog
          kind={open}
          body={body}
          name={title}
          rows={rows}
          locale={defaultLocale}
          csrfToken={csrfToken}
          onClose={() => setOpen(null)}
          onDone={() => closeAndRefresh(t(`note-${open}`), category.id)}
          onReload={() => closeAndRefresh()}
        />
      ) : null}
    </div>
  );
}
