'use client';

import { Button, Dialog, SidePanel } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { ReviewDetail, subjectId, subjectName, type Decision, type Subject } from './detail.tsx';
import { PostReviewDetail, type PostDecision } from './post-review-detail.tsx';
import {
  POST_APPROVE_PERMISSION,
  TAKE_DOWN_PERMISSIONS,
  postReviewName,
  type PostReviewRow,
} from './post-review-types.ts';

/** What the drawer shows: a held Offer of the queue, or a row of the post-publication review. */
export type DrawerSubject = Subject | { readonly kind: 'after'; readonly row: PostReviewRow };
export type DrawerDecision = Decision | PostDecision;

export const drawerSubjectId = (subject: DrawerSubject): string =>
  subject.kind === 'after' ? subject.row.id : subjectId(subject);
export const drawerSubjectName = (subject: DrawerSubject): string =>
  subject.kind === 'after' ? postReviewName(subject.row) : subjectName(subject);

/**
 * The decision drawer: one held Offer from the queue in a right-hand panel (full screen on a
 * phone; a native modal dialog, so focus is trapped, Escape closes it and focus goes back to the
 * row that opened it). Closing with a note or a reason typed asks first, in the library's confirm
 * Dialog (Keep editing takes the focus, so Enter never throws the text away).
 */
export function DecisionDrawer({
  subject,
  csrfToken,
  zone,
  canDecide,
  viewerKeys,
  onClose,
  onDecided,
  onReload,
}: {
  readonly subject: DrawerSubject | null;
  readonly csrfToken: string;
  readonly zone: string;
  readonly canDecide: boolean;
  readonly viewerKeys: readonly string[];
  readonly onClose: () => void;
  readonly onDecided: (subject: DrawerSubject, decided: DrawerDecision) => void;
  readonly onReload: (subject: DrawerSubject) => void;
}) {
  const t = useTranslations('offer-review.drawer');
  const [dirty, setDirty] = useState(false);
  const [asking, setAsking] = useState(false);
  const keep = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    if (dirty) {
      setAsking(true);
      return;
    }
    onClose();
  }, [dirty, onClose]);
  const discard = useCallback(() => {
    setAsking(false);
    setDirty(false);
    onClose();
  }, [onClose]);
  return (
    <>
      <SidePanel
        open={subject !== null}
        onClose={close}
        title={t('title')}
        description={subject === null ? undefined : drawerSubjectName(subject)}
        closeLabel={t('close')}
      >
        {subject === null ? null : subject.kind === 'after' ? (
          <PostReviewDetail
            key={subject.row.id}
            row={subject.row}
            csrfToken={csrfToken}
            zone={zone}
            canApprove={viewerKeys.includes(POST_APPROVE_PERMISSION)}
            canTakeDown={TAKE_DOWN_PERMISSIONS.every((key) => viewerKeys.includes(key))}
            onDirtyChange={setDirty}
            onDecided={(decided) => {
              setDirty(false);
              onDecided(subject, decided);
            }}
            onReload={() => onReload(subject)}
          />
        ) : (
          <ReviewDetail
            key={subjectId(subject)}
            subject={subject}
            csrfToken={csrfToken}
            zone={zone}
            canDecide={canDecide}
            viewerKeys={viewerKeys}
            onDirtyChange={setDirty}
            onDecided={(decided) => {
              setDirty(false);
              onDecided(subject, decided);
            }}
            onReload={() => onReload(subject)}
          />
        )}
      </SidePanel>
      <Dialog
        open={asking}
        title={t('discard')}
        onClose={() => setAsking(false)}
        initialFocus={keep}
        actions={
          <>
            <Button ref={keep} variant="secondary" onClick={() => setAsking(false)}>
              {t('discard-keep')}
            </Button>
            <Button variant="destructive-solid" onClick={discard}>
              {t('discard-confirm')}
            </Button>
          </>
        }
      >
        <p className="text-sm">{t('discard-body')}</p>
      </Dialog>
    </>
  );
}
