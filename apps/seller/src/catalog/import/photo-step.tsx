'use client';

import { Banner, Button, FileButton, Icon } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { numberFormat } from '../../shared/intl.ts';
import { ImportSection, ImportTiles, Meter } from './import-parts.tsx';
import {
  MAX_PICKED_PHOTOS,
  PHOTO_ACCEPT,
  pickPhotos,
  runPhotoQueue,
  type PhotoItem,
  type PhotoOutcome,
  type PhotoResult,
  type PhotoStop,
  type PickedPhotos,
} from './photo-queue.ts';

// The photo step of a finished or stopped my-products import (catalog design 14c, "Photos"). The
// seller picks photos or a folder; the panel sends each one as its own request, one at a time, and
// stops when the server says too many. The server matches the file name to the rows' Images cell;
// the page never says which product a photo belongs to.

const PROBLEM_LIST_MAX = 50;
const NO_COUNTS: Readonly<Record<PhotoOutcome, number>> = {
  added: 0,
  'not-named': 0,
  already: 0,
  limit: 0,
  refused: 0,
  'product-gone': 0,
};

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'paused'; readonly stop: PhotoStop; readonly resumeAt: number | null }
  | { readonly kind: 'done' };

/** Folder picking is not in React's input types; the attribute is set as the browser reads it. */
const FOLDER_ATTRIBUTES = { webkitdirectory: '' } as Record<string, string>;

export function PhotoStep({
  importId,
  csrfToken,
  now = Date.now,
  minIntervalMs,
}: {
  readonly importId: string;
  readonly csrfToken: string;
  /** The clock, for the wait after a throttle; tests pass their own. */
  readonly now?: () => number;
  /** The least time between two photos; tests pass 0. */
  readonly minIntervalMs?: number;
}) {
  const t = useTranslations('catalog.import.photos');
  const locale = useLocale();
  const number = (value: number) => numberFormat(locale, {}).format(value);
  const [picked, setPicked] = useState<PickedPhotos | null>(null);
  const [queue, setQueue] = useState<readonly PhotoItem[]>([]);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [counts, setCounts] = useState<Readonly<Record<PhotoOutcome, number>>>(NO_COUNTS);
  const [problems, setProblems] = useState<readonly PhotoResult[]>([]);
  const [tick, setTick] = useState(() => now());
  const cancelled = useRef(false);

  const total = picked?.items.length ?? 0;
  const done = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const busy = phase.kind === 'sending';

  // While paused for a throttle, the page counts down to the time the seller can go on.
  const waitingUntil = phase.kind === 'paused' ? phase.resumeAt : null;
  useEffect(() => {
    if (waitingUntil === null) return undefined;
    const timer = setInterval(() => setTick(now()), 1000);
    return () => clearInterval(timer);
  }, [waitingUntil, now]);

  const onPick = (files: FileList | null) => {
    if (files === null || files.length === 0 || busy) return;
    const next = pickPhotos(Array.from(files));
    setPicked(next);
    setQueue(next.items);
    setCounts(NO_COUNTS);
    setProblems([]);
    setPhase({ kind: 'idle' });
  };

  const record = (result: PhotoResult) => {
    setCounts((previous) => ({ ...previous, [result.outcome]: previous[result.outcome] + 1 }));
    if (result.outcome !== 'added') {
      setProblems((previous) =>
        previous.length >= PROBLEM_LIST_MAX ? previous : [...previous, result],
      );
    }
  };

  const run = async (items: readonly PhotoItem[]) => {
    cancelled.current = false;
    setPhase({ kind: 'sending' });
    const end = await runPhotoQueue(items, {
      importId,
      csrfToken,
      onResult: record,
      cancelled: () => cancelled.current,
      now,
      ...(minIntervalMs === undefined ? {} : { minIntervalMs }),
    });
    setQueue(end.remaining);
    if (end.stop === null) {
      setPhase(end.remaining.length === 0 ? { kind: 'done' } : { kind: 'idle' });
      return;
    }
    const resumeAt =
      end.stop.kind === 'throttled' ? now() + end.stop.retryAfterSeconds * 1000 : null;
    setTick(now());
    setPhase({ kind: 'paused', stop: end.stop, resumeAt });
  };

  const waitingMs = phase.kind === 'paused' && phase.resumeAt !== null ? phase.resumeAt - tick : 0;
  // A throttle or an unreachable server leaves the rest to try again; a closed step or a change of
  // access does not.
  const goesOn =
    phase.kind === 'paused' &&
    queue.length > 0 &&
    (phase.stop.kind === 'throttled' || phase.stop.kind === 'unavailable');
  const canContinue = goesOn && waitingMs <= 0;
  const clock = (instant: number) =>
    new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(
      new Date(instant),
    );

  return (
    <ImportSection title={t('title')} sub={t('sub')}>
      <ul className="flex flex-col gap-1 text-sm text-fg-secondary">
        <li>{t('rule-names')}</li>
        <li>{t('rule-limits', { max: 8 })}</li>
        <li>{t('rule-zip')}</li>
      </ul>
      <div className="flex flex-wrap items-center gap-3">
        <FileButton accept={PHOTO_ACCEPT} multiple onFiles={onPick} disabled={busy}>
          {t('choose-photos')}
        </FileButton>
        <FileButton
          accept={PHOTO_ACCEPT}
          multiple
          {...FOLDER_ATTRIBUTES}
          onFiles={onPick}
          disabled={busy}
        >
          {t('choose-folder')}
        </FileButton>
      </div>

      {picked === null ? null : (
        <div className="flex flex-col gap-3">
          <p role="status" className="text-sm text-fg">
            {t('picked', { count: number(total) })}
          </p>
          {picked.notPhotos + picked.sameName + picked.overLimit === 0 ? null : (
            <p className="text-sm text-fg-muted">
              {t('left-out', {
                notPhotos: number(picked.notPhotos),
                sameName: number(picked.sameName),
                overLimit: number(picked.overLimit),
                max: number(MAX_PICKED_PHOTOS),
              })}
            </p>
          )}
        </div>
      )}

      {phase.kind === 'paused' ? (
        <PausedBanner phase={phase} waitingMs={waitingMs} clock={clock} />
      ) : null}

      {busy || done > 0 ? (
        <div className="flex flex-col gap-2">
          <Meter label={t('meter')} value={total === 0 ? 0 : Math.round((done / total) * 100)} />
          <p role="status" className="text-sm font-semibold text-fg">
            {t('progress', { done: number(done), total: number(total) })}
          </p>
        </div>
      ) : null}

      {done > 0 ? (
        <ImportTiles
          tiles={[
            { label: t('tile.added'), value: number(counts.added), tone: 'success' },
            {
              label: t('tile.not-named'),
              value: number(counts['not-named']),
              ...(counts['not-named'] > 0 ? { tone: 'attention' as const } : {}),
            },
            { label: t('tile.already'), value: number(counts.already) },
            {
              label: t('tile.refused'),
              value: number(counts.limit + counts.refused + counts['product-gone']),
              ...(counts.limit + counts.refused + counts['product-gone'] > 0
                ? { tone: 'critical' as const }
                : {}),
            },
          ]}
        />
      ) : null}

      {phase.kind === 'done' && counts.added > 0 ? (
        <Banner tone="success" title={t('done-title', { count: counts.added })}>
          <p>{t('done-body')}</p>
        </Banner>
      ) : null}

      {problems.length === 0 ? null : (
        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg">{t('problems.title')}</h3>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {problems.map((problem, index) => (
              <li
                key={`${problem.name}-${index}`}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-sm"
              >
                <Icon name="file" className="size-4 shrink-0 self-center text-fg-muted" />
                <span className="min-w-0 break-all font-medium text-fg">{problem.name}</span>
                <span className="min-w-0 text-fg-secondary sm:ms-auto">
                  {t(`problems.${problem.outcome}`)}
                </span>
              </li>
            ))}
          </ul>
          {done - counts.added > problems.length ? (
            <p className="text-xs text-fg-muted">
              {t('problems.more', { count: number(done - counts.added - problems.length) })}
            </p>
          ) : null}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-line pt-4">
        {busy ? (
          <Button
            variant="secondary"
            onClick={() => {
              cancelled.current = true;
            }}
          >
            {t('stop')}
          </Button>
        ) : null}
        {goesOn ? (
          <Button disabled={!canContinue} onClick={() => void run(queue)}>
            {t('continue', { count: number(queue.length) })}
          </Button>
        ) : null}
        {phase.kind === 'idle' && queue.length > 0 ? (
          <Button onClick={() => void run(queue)}>
            {done > 0
              ? t('continue', { count: number(queue.length) })
              : t('upload', { count: number(queue.length) })}
          </Button>
        ) : null}
      </div>
    </ImportSection>
  );
}

function PausedBanner({
  phase,
  waitingMs,
  clock,
}: {
  readonly phase: Extract<Phase, { kind: 'paused' }>;
  readonly waitingMs: number;
  readonly clock: (instant: number) => string;
}) {
  const t = useTranslations('catalog.import.photos.paused');
  const { stop } = phase;
  if (stop.kind === 'throttled') {
    const when = phase.resumeAt === null ? '' : clock(phase.resumeAt);
    return (
      <Banner tone="attention" title={t('throttled-title')}>
        <p role="status">
          {waitingMs > 0
            ? t('throttled-wait', { time: when, seconds: Math.ceil(waitingMs / 1000) })
            : t('throttled-ready')}
        </p>
      </Banner>
    );
  }
  return (
    <Banner
      tone={stop.kind === 'unavailable' ? 'attention' : 'critical'}
      title={t(`${stop.kind}-title`)}
    >
      <p>{t(`${stop.kind}-body`)}</p>
    </Banner>
  );
}
