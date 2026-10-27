'use client';

import { Button, Menu, type MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SlideApproveDialog } from './slide-approve-dialog.tsx';
import { SlideCopyDialog } from './slide-copy-dialog.tsx';
import { CommandProblemView, SlideConfirmDialog, type ConfirmKind } from './slide-dialogs.tsx';
import { isServed, type SlideDetail, type SlideGates } from './slide-types.ts';
import { useSlideCommand } from './use-slide-command.ts';

type Asking = ConfirmKind | 'approve' | 'copy' | null;

/** Which commands the header offers for a slide in this state, for a holder of these keys. */
export function actionsFor(slide: SlideDetail, gates: SlideGates) {
  const archived = slide.status === 'archived';
  return {
    submit: gates.edit && !archived && slide.draft !== null && !slide.pending,
    review: gates.publish && !archived && slide.pending && slide.draft !== null,
    pause: gates.pause && isServed(slide.status),
    resume: gates.publish && slide.status === 'paused',
    copy: gates.edit,
    archive: gates.edit && !archived,
  };
}

/**
 * The buttons at the top of a slide's editor: Send for approval, Review (a platform admin, for a
 * slide that is waiting) and the More menu with Pause, Resume…, Copy to another Market… and
 * Archive. A control is absent without its key; the API checks every command again.
 */
export function SlideHeaderActions({
  slide,
  gates,
  csrfToken,
  zone,
  unsaved,
  startReview,
  onChange,
  onDone,
}: {
  readonly slide: SlideDetail;
  readonly gates: SlideGates;
  readonly csrfToken: string;
  readonly zone: string;
  /** The form has changes that are not saved to the draft yet. */
  readonly unsaved: boolean;
  /** Open the approval dialog at once (the list's Review link). */
  readonly startReview: boolean;
  readonly onChange: (detail: SlideDetail) => void;
  /** Said once a command has worked. */
  readonly onDone: (message: string) => void;
}) {
  const t = useTranslations('content.slides.actions');
  const router = useRouter();
  const can = actionsFor(slide, gates);
  const [asking, setAsking] = useState<Asking>(startReview && can.review ? 'approve' : null);
  const submit = useSlideCommand(csrfToken);
  const name = slide.internalName;
  const placements = (slide.draft ?? slide.live)?.placements ?? [];

  async function send() {
    const detail = await submit.run(slide.id, 'submit', {}, slide.draft?.placements ?? []);
    if (detail === null) return;
    onChange(detail);
    onDone(t('done.submit', { name }));
  }

  const finished = (kind: 'pause' | 'resume' | 'archive' | 'approve') => (detail: SlideDetail) => {
    setAsking(null);
    onChange(detail);
    onDone(t(`done.${kind}`, { name }));
  };
  const stale = () => router.refresh();

  const items: MenuItem[] = [];
  if (can.pause) {
    items.push({ id: 'pause', label: t('pause'), onSelect: () => setAsking('pause') });
  }
  if (can.resume) {
    items.push({ id: 'resume', label: t('resume'), onSelect: () => setAsking('resume') });
  }
  if (can.copy) {
    items.push({ id: 'copy', label: t('copy'), onSelect: () => setAsking('copy') });
  }
  if (can.archive) {
    items.push({
      id: 'archive',
      label: t('archive'),
      tone: 'critical',
      onSelect: () => setAsking('archive'),
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {can.review ? <Button onClick={() => setAsking('approve')}>{t('review')}</Button> : null}
        {can.submit ? (
          <Button
            variant={can.review ? 'secondary' : 'primary'}
            loading={submit.pending}
            disabled={unsaved}
            title={unsaved ? t('submit-unsaved') : undefined}
            onClick={() => void send()}
          >
            {t('submit')}
          </Button>
        ) : null}
        {items.length === 0 ? null : <Menu label={t('more')} items={items} />}
      </div>
      {submit.problem === null ? null : (
        <div className="basis-full">
          <CommandProblemView problem={submit.problem} />
        </div>
      )}
      {can.pause ? (
        <SlideConfirmDialog
          kind="pause"
          open={asking === 'pause'}
          slide={{ id: slide.id, name }}
          placements={placements}
          csrfToken={csrfToken}
          onClose={() => setAsking(null)}
          onDone={finished('pause')}
          onStale={stale}
        />
      ) : null}
      {can.resume ? (
        <SlideConfirmDialog
          kind="resume"
          open={asking === 'resume'}
          slide={{ id: slide.id, name }}
          placements={slide.live?.placements ?? []}
          csrfToken={csrfToken}
          onClose={() => setAsking(null)}
          onDone={finished('resume')}
          onStale={stale}
        />
      ) : null}
      {can.archive ? (
        <SlideConfirmDialog
          kind="archive"
          open={asking === 'archive'}
          slide={{ id: slide.id, name }}
          placements={placements}
          csrfToken={csrfToken}
          onClose={() => setAsking(null)}
          onDone={finished('archive')}
          onStale={stale}
        />
      ) : null}
      {can.review ? (
        <SlideApproveDialog
          open={asking === 'approve'}
          slide={slide}
          zone={zone}
          csrfToken={csrfToken}
          onClose={() => setAsking(null)}
          onDone={finished('approve')}
          onStale={stale}
        />
      ) : null}
      {can.copy ? (
        <SlideCopyDialog
          open={asking === 'copy'}
          slide={{ id: slide.id, name }}
          onClose={() => setAsking(null)}
        />
      ) : null}
    </>
  );
}
