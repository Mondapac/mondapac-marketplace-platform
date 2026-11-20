'use client';

import { Menu, type MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SlideConfirmDialog } from './slide-dialogs.tsx';
import {
  SLIDES_PATH,
  isServed,
  reviewPath,
  type SlideDetail,
  type SlideGates,
  type SlideSummary,
} from './slide-types.ts';

/** The one action of a list row, by what the slide is and what the signed-in admin may do. */
export type RowActionKind = 'review' | 'pause' | 'resume' | 'edit' | 'view';

export function rowActionOf(slide: SlideSummary, gates: SlideGates): RowActionKind {
  if (slide.status === 'pending' && gates.publish) return 'review';
  if (gates.pause && isServed(slide.status)) return 'pause';
  if (gates.publish && slide.status === 'paused') return 'resume';
  return gates.edit ? 'edit' : 'view';
}

/**
 * The row's Actions menu: Review… (to the editor with the approval dialog open), Pause… and
 * Resume… (each behind a confirmation) and Edit or View. An item is absent without its key; the
 * API checks it again.
 */
export function SlideRowAction({
  slide,
  gates,
  csrfToken,
  onChanged,
  onStale,
}: {
  readonly slide: SlideSummary;
  readonly gates: SlideGates;
  readonly csrfToken: string;
  /** The command worked: the slide as it is now. */
  readonly onChanged: (detail: SlideDetail) => void;
  /** The slide changed meanwhile: read the list again. */
  readonly onStale: () => void;
}) {
  const t = useTranslations('content.slides.list');
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const kind = rowActionOf(slide, gates);
  const open: RowActionKind = gates.edit ? 'edit' : 'view';
  const items: MenuItem[] = [];
  if (kind === 'review') {
    items.push({
      id: 'review',
      label: t('action.review'),
      onSelect: () => router.push(reviewPath(slide.id)),
    });
  }
  if (kind === 'pause' || kind === 'resume') {
    items.push({
      id: kind,
      label: t(`action.${kind}`),
      onSelect: () => setAsking(true),
    });
  }
  items.push({
    id: open,
    label: t(`action.${open}`),
    onSelect: () => router.push(`${SLIDES_PATH}/${slide.id}`),
  });
  return (
    <>
      <Menu label={t('actions-for', { name: slide.internalName })} items={items} />
      {kind === 'pause' || kind === 'resume' ? (
        <SlideConfirmDialog
          kind={kind}
          open={asking}
          slide={{ id: slide.id, name: slide.internalName }}
          placements={[]}
          csrfToken={csrfToken}
          onClose={() => setAsking(false)}
          onDone={(detail) => {
            setAsking(false);
            onChanged(detail);
          }}
          onStale={onStale}
        />
      ) : null}
    </>
  );
}
