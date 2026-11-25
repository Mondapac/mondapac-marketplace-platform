'use client';

import { SidePanel } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useState } from 'react';
import { ReviewDetail, subjectId, subjectName, type Decision, type Subject } from './detail.tsx';

/**
 * The decision drawer: one held Offer from the queue in a right-hand panel (full screen on a
 * phone; a native modal dialog, so focus is trapped, Escape closes it and focus goes back to the
 * row that opened it). Closing with a note or a reason typed asks first.
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
  const close = useCallback(() => {
    if (dirty && !window.confirm(t('discard'))) return;
    setDirty(false);
    onClose();
  }, [dirty, onClose, t]);
  return (
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
  );
}
