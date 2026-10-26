'use client';

import { BackLink, Badge, Tabs } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { STATUS_TONE } from './slide-labels.tsx';
import {
  NEW_SLIDE_PATH,
  SLIDES_PATH,
  isKnownStatus,
  placementPath,
  type SlideDetail,
} from './slide-types.ts';

export type EditorTab = 'content' | 'placement';

/**
 * The top of every tab of the slide editor: back link, name, the live and draft versions and the
 * tab row. A new slide has only the Content tab; the others need a saved slide.
 */
export function SlideEditorHeader({
  slide,
  tab,
}: {
  readonly slide: SlideDetail | null;
  readonly tab: EditorTab;
}) {
  const t = useTranslations('content.slides.editor');
  const tstatus = useTranslations('content.slides.status');
  const status = slide?.status ?? null;
  return (
    <>
      <div className="flex flex-col items-start gap-1">
        <BackLink href={SLIDES_PATH} label={t('back')} />
        <h1 className="break-words text-2xl font-semibold">
          {slide === null ? t('title-new') : slide.internalName}
        </h1>
        {slide === null ? null : (
          <div
            className="flex flex-wrap items-center gap-2"
            aria-label={t('versions')}
            role="group"
          >
            {slide.live !== null || status === 'archived' ? (
              <Badge
                tone={status !== null && isKnownStatus(status) ? STATUS_TONE[status] : 'neutral'}
              >
                {slide.live === null
                  ? tstatus('archived')
                  : t('version', {
                      status:
                        status !== null && isKnownStatus(status)
                          ? tstatus(status)
                          : tstatus('unknown'),
                      version: slide.live.versionNo,
                    })}
              </Badge>
            ) : (
              <Badge tone="neutral">{t('not-live')}</Badge>
            )}
            {slide.draft === null ? null : (
              <Badge tone={slide.pending ? 'attention' : 'neutral'}>
                {t(slide.pending ? 'draft-pending' : 'draft-open', {
                  version: slide.draft.versionNo,
                })}
              </Badge>
            )}
          </div>
        )}
      </div>
      <Tabs
        label={t('tabs')}
        activeId={tab}
        items={
          slide === null
            ? [{ id: 'content', href: NEW_SLIDE_PATH, label: t('tab-content') }]
            : [
                { id: 'content', href: `${SLIDES_PATH}/${slide.id}`, label: t('tab-content') },
                { id: 'placement', href: placementPath(slide.id), label: t('tab-placement') },
              ]
        }
      />
    </>
  );
}
