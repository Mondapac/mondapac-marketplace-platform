import { CARD_TABLE, LinkButton } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { shortInstantInZone } from '../../shared/format.ts';
import { SlideKindTile, SlideStatusBadge, usePositionLabel } from './slide-labels.tsx';
import {
  SLIDE_EDIT_PERMISSION,
  SLIDES_PATH,
  canReview,
  isKnownKind,
  type SlideSummary,
} from './slide-types.ts';

/**
 * The slides of the Market: thumbnail tile, name with a short line, type, positions, live window,
 * status and one action. Below 1024 px every row is a card (the shared CARD_TABLE).
 */
export function SlidesTable({
  rows,
  permissionKeys,
  zone,
}: {
  readonly rows: readonly SlideSummary[];
  readonly permissionKeys: readonly string[];
  /** The IANA zone the window is shown in. */
  readonly zone: string;
}) {
  const t = useTranslations('content.slides.list');
  const kinds = useTranslations('content.slides.kind');
  const locale = useLocale();
  const positionLabel = usePositionLabel();
  const canEdit = permissionKeys.includes(SLIDE_EDIT_PERMISSION);
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={`${CARD_TABLE.table} lg:min-w-240 lg:table-fixed`}>
        <caption className="sr-only">{t('caption')}</caption>
        <colgroup className="max-lg:hidden">
          <col />
          <col className="w-32" />
          <col className="w-44" />
          <col className="w-40" />
          <col className="w-44" />
          <col className="w-28" />
        </colgroup>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('col.slide')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('col.type')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('col.positions')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('col.window')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('col.status')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('col.actions')}
            </th>
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.map((slide) => {
            const href = `${SLIDES_PATH}/${slide.id}`;
            const review = canReview(permissionKeys, slide.status);
            const action = review ? 'review' : canEdit ? 'edit' : 'view';
            const sublines = [
              slide.pinned ? t('pinned') : null,
              slide.sponsored ? t('sponsored') : null,
              slide.hasDraft ? t('draft-changes') : null,
              slide.positions.length === 0 ? t('not-placed') : null,
            ].filter((line): line is string => line !== null);
            return (
              <tr key={slide.id} className={CARD_TABLE.row}>
                <td className={CARD_TABLE.cell}>
                  <div className="flex min-w-0 items-center gap-3">
                    <SlideKindTile kind={slide.kind} />
                    <div className="min-w-0">
                      <a className="break-words font-medium text-link underline" href={href}>
                        {slide.internalName}
                      </a>
                      {sublines.length === 0 ? null : (
                        <p className="text-xs text-fg-muted">{sublines.join(' · ')}</p>
                      )}
                    </div>
                  </div>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.type')}>
                  {isKnownKind(slide.kind) ? kinds(slide.kind) : slide.kind}
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.positions')}>
                  {slide.positions.length === 0 ? (
                    <span className="text-fg-muted">{t('no-position')}</span>
                  ) : (
                    <ul className="flex min-w-0 flex-wrap gap-1">
                      {slide.positions.map((position) => (
                        <li
                          key={position}
                          className="rounded-sm border border-line px-1.5 py-0.5 text-xs text-fg-secondary"
                        >
                          {positionLabel(position)}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.window')}>
                  <span className="text-xs">
                    {t('window', {
                      from: shortInstantInZone(slide.startsAt, locale, zone),
                      to: shortInstantInZone(slide.endsAt, locale, zone),
                    })}
                  </span>
                </td>
                <td className={CARD_TABLE.corner}>
                  <SlideStatusBadge status={slide.status} />
                </td>
                <td className={`${CARD_TABLE.cell} max-lg:col-span-2 max-lg:pt-1`}>
                  <LinkButton variant="secondary" href={href}>
                    {t(`action.${action}`)}
                    <span className="sr-only"> {slide.internalName}</span>
                  </LinkButton>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
