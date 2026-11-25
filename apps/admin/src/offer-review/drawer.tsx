'use client';

import { Button, Dialog, SidePanel } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useRef, useState } from 'react';
import { ReviewDetail, subjectId, subjectName, type Decision, type Subject } from './detail.tsx';

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
  readonly subject: Subject | null;
  readonly csrfToken: string;
  readonly zone: string;
  readonly canDecide: boolean;
  readonly viewerKeys: readonly string[];
  readonly onClose: () => void;
  readonly onDecided: (subject: Subject, decided: Decision) => void;
  readonly onReload: (subject: Subject) => void;
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
        description={subject === null ? undefined : subjectName(subject)}
        closeLabel={t('close')}
      >
        {subject === null ? null : (
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
