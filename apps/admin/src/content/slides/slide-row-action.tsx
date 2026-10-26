'use client';

import { Button, LinkButton } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
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
 * Review (to the editor with the approval dialog open), Pause and Resume… (each behind a
 * confirmation) or the link to the editor. A control is absent without its key; the API checks it
 * again.
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
  const [asking, setAsking] = useState(false);
  const kind = rowActionOf(slide, gates);
  const name = <span className="sr-only"> {slide.internalName}</span>;
  if (kind === 'pause' || kind === 'resume') {
    return (
      <>
        <Button variant="secondary" onClick={() => setAsking(true)}>
          {t(`action.${kind}`)}
          {name}
        </Button>
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
      </>
    );
  }
  const href = kind === 'review' ? reviewPath(slide.id) : `${SLIDES_PATH}/${slide.id}`;
  return (
    <LinkButton variant="secondary" href={href}>
      {t(`action.${kind}`)}
      {name}
    </LinkButton>
  );
}
