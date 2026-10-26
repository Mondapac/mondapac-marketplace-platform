import { Badge, Icon, type BadgeTone, type IconName } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { isKnownKind, isKnownStatus, type SlideKind, type SlideStatus } from './slide-types.ts';

export const STATUS_TONE: Record<SlideStatus, BadgeTone> = {
  live: 'success',
  scheduled: 'info',
  pending: 'attention',
  draft: 'attention',
  paused: 'neutral',
  ended: 'neutral',
  archived: 'neutral',
};

/** The status of a slide as a badge; a status this panel does not know reads "Unknown". */
export function SlideStatusBadge({ status }: { readonly status: string }) {
  const t = useTranslations('content.slides.status');
  const known = isKnownStatus(status);
  return (
    <Badge tone={known ? STATUS_TONE[status] : 'neutral'}>{t(known ? status : 'unknown')}</Badge>
  );
}

const KIND_ICON: Record<SlideKind, IconName> = {
  announcement: 'bell',
  promotion: 'tag',
  link: 'link',
};
const KIND_TILE: Record<SlideKind, string> = {
  announcement: 'bg-attention-bg text-attention-fg',
  promotion: 'bg-info-bg text-info-fg',
  link: 'bg-success-bg text-success-fg',
};

/** The place of a slide's picture in a row: a tile coloured and marked by the slide's type. */
export function SlideKindTile({ kind }: { readonly kind: string }) {
  const known = isKnownKind(kind);
  return (
    <span
      aria-hidden="true"
      className={`flex h-8 w-14 shrink-0 items-center justify-center rounded-sm ${known ? KIND_TILE[kind] : 'bg-neutral-bg text-neutral-fg'}`}
    >
      <Icon name={known ? KIND_ICON[kind] : 'layout'} />
    </span>
  );
}

/** The key of a position's message: message keys cannot hold dots. */
export const positionMessageKey = (position: string): string => position.replaceAll('.', '-');

/** The label of a position, or its key when this panel does not know it. */
export function usePositionLabel(): (position: string) => string {
  const t = useTranslations('content.slides.position');
  return (position) =>
    t.has(positionMessageKey(position)) ? t(positionMessageKey(position)) : position;
}
