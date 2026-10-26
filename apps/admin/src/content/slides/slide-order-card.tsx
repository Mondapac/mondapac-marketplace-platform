'use client';

import { Badge, Icon } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, type ReactNode } from 'react';
import { shortDateInZone, shortInstantInZone } from '../../shared/format.ts';
import { canMove, type Direction, type OrderEntry } from './slide-order.ts';

/** Which move button should hold focus after a move; `count` makes a repeat request new. */
export interface FocusRequest {
  readonly id: string;
  readonly direction: Direction;
  readonly count: number;
}

const MOVE =
  'inline-flex size-(--mp-size-control) shrink-0 items-center justify-center rounded-md border border-line-control bg-surface text-fg hover:bg-muted focus-visible:outline-2 focus-visible:outline-focus disabled:cursor-not-allowed disabled:text-fg-muted disabled:hover:bg-surface';

/**
 * The slides of one position in the order buyers see them: a number, the name with its status,
 * the live window and, with the edit permission, the two move buttons. Pinned slides stay first
 * and have no working buttons. A line marks the first live slide that is over the limit.
 */
export function SlideOrderCard({
  title,
  maxActive,
  autoplay,
  scopeNote,
  entries,
  overLimit,
  canEdit,
  zone,
  locale,
  focus,
  onMove,
  footer,
}: {
  /** The position's name, the card heading. */
  readonly title: string;
  readonly maxActive: number;
  readonly autoplay: boolean;
  /** "Category: <id>", when the position is shown for one item only. */
  readonly scopeNote: string | null;
  readonly entries: readonly OrderEntry[];
  /** Per entry, in the same order: whether it waits for a free place. */
  readonly overLimit: readonly boolean[];
  readonly canEdit: boolean;
  readonly zone: string;
  readonly locale: string;
  readonly focus: FocusRequest | null;
  readonly onMove: (index: number, direction: Direction) => void;
  /** The note and buttons under the list. */
  readonly footer: ReactNode;
}) {
  const t = useTranslations('content.slides.order');
  const list = useRef<HTMLOListElement>(null);
  const firstOver = overLimit.indexOf(true);

  useEffect(() => {
    if (focus === null) return;
    const find = (direction: Direction) =>
      list.current?.querySelector<HTMLButtonElement>(
        `button[data-move="${direction}"][data-slide="${focus.id}"]`,
      );
    const wanted = find(focus.direction);
    // A slide that reached an end has that button disabled: focus the other one.
    (wanted?.disabled === false ? wanted : find(focus.direction === 'up' ? 'down' : 'up'))?.focus();
  }, [focus]);

  return (
    <section aria-labelledby="order-heading" className="rounded-lg border border-line bg-surface">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-line-row px-4 py-3">
        <div className="min-w-0">
          <h2 id="order-heading" className="break-words text-base font-semibold">
            {title}
          </h2>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-secondary">
            <span>{t('max', { max: maxActive })}</span>
            {autoplay ? <span>{t('autoplay')}</span> : null}
            {scopeNote === null ? null : <span className="min-w-0 break-all">{scopeNote}</span>}
          </p>
        </div>
        <span className="text-xs text-fg-muted">{t('pinned-note')}</span>
      </div>
      <ol ref={list} aria-label={t('list', { position: title })} className="m-0 list-none p-0">
        {entries.map((entry, index) => (
          <OrderRow
            key={entry.id}
            entry={entry}
            index={index}
            divider={index === firstOver}
            canEdit={canEdit}
            up={canMove(entries, index, 'up')}
            down={canMove(entries, index, 'down')}
            zone={zone}
            locale={locale}
            onMove={onMove}
          />
        ))}
      </ol>
      <div className="px-4 py-3">{footer}</div>
    </section>
  );
}

function OrderRow({
  entry,
  index,
  divider,
  canEdit,
  up,
  down,
  zone,
  locale,
  onMove,
}: {
  readonly entry: OrderEntry;
  readonly index: number;
  /** The "over the limit" line goes before this row. */
  readonly divider: boolean;
  readonly canEdit: boolean;
  readonly up: boolean;
  readonly down: boolean;
  readonly zone: string;
  readonly locale: string;
  readonly onMove: (index: number, direction: Direction) => void;
}) {
  const t = useTranslations('content.slides.order');
  const status = useTranslations('content.slides.status');
  return (
    <>
      {divider ? (
        <li className="flex items-center gap-2 border-b border-line-row bg-attention-bg px-4 py-2 text-xs text-attention-fg">
          <Icon name="clock" />
          <span className="min-w-0">{t('over-limit')}</span>
        </li>
      ) : null}
      <li className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-b border-line-row px-4 py-3 md:grid-cols-[1.5rem_minmax(0,1fr)_16rem_auto]">
        <span className="col-start-1 row-start-1 text-center font-semibold text-fg-secondary">
          {index + 1}
        </span>
        <div className="col-start-2 row-start-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-words font-medium">{entry.internalName}</span>
          {entry.status === 'live' ? (
            <Badge tone="success">{status('live')}</Badge>
          ) : (
            <Badge tone="info">
              {t('from', { date: shortDateInZone(entry.startsAt, locale, zone) })}
            </Badge>
          )}
          {entry.pinned ? (
            <span className="inline-flex items-center gap-1 text-xs text-fg-secondary">
              <Icon name="pin" />
              {t('pinned')}
            </span>
          ) : null}
        </div>
        <span className="col-start-2 row-start-2 min-w-0 text-xs text-fg-muted md:col-start-3 md:row-start-1">
          {t('window', {
            from: shortInstantInZone(entry.startsAt, locale, zone),
            to: shortInstantInZone(entry.endsAt, locale, zone),
          })}
        </span>
        {canEdit ? (
          <div className="col-start-3 row-span-2 row-start-1 flex gap-2 md:col-start-4 md:row-span-1">
            <button
              type="button"
              data-move="up"
              data-slide={entry.id}
              disabled={!up}
              aria-label={t('move-up', { name: entry.internalName })}
              onClick={() => onMove(index, 'up')}
              className={MOVE}
            >
              <Icon name="chevron-up" />
            </button>
            <button
              type="button"
              data-move="down"
              data-slide={entry.id}
              disabled={!down}
              aria-label={t('move-down', { name: entry.internalName })}
              onClick={() => onMove(index, 'down')}
              className={MOVE}
            >
              <Icon name="chevron-down" />
            </button>
          </div>
        ) : null}
      </li>
    </>
  );
}
