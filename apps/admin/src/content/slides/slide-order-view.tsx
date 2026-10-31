'use client';

import {
  Banner,
  Button,
  EmptyState,
  FormActionBar,
  LinkButton,
  LoadError,
  SkeletonRows,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { usePositionLabel } from './slide-labels.tsx';
import { SlideOrderCard, type FocusRequest } from './slide-order-card.tsx';
import { SlideOrderControls } from './slide-order-controls.tsx';
import {
  isReadable,
  move,
  orderBody,
  orderReadPath,
  overLimitFlags,
  positionOf,
  sameOrder,
  saveFailureOf,
  type Direction,
  type OrderEntry,
  type OrderPlace,
  type OrderView,
  type SaveFailure,
} from './slide-order.ts';
import { ORDER_API_PATH, SLIDES_PATH } from './slide-types.ts';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'ready'; readonly view: OrderView };

/** A reload keeps the card on the screen; the first load shows a skeleton. */
const LOADING: Load = { state: 'loading' };

/**
 * The live slides of one position in the order buyers see them. With the edit permission each
 * slide has Move up and Move down, and Save order sends the whole list (it goes live at once, no
 * approval). Without it the list is read-only. Loading, empty, load error, and a list that changed
 * under the admin each have a state.
 */
export function SlideOrderView({
  place,
  canEdit,
  csrfToken,
  zone,
}: {
  readonly place: OrderPlace;
  readonly canEdit: boolean;
  readonly csrfToken: string;
  /** The IANA zone the windows are shown in. */
  readonly zone: string;
}) {
  const t = useTranslations('content.slides.order');
  const tl = useTranslations('load');
  const scopeText = useTranslations('content.slides.placement');
  const locale = useLocale();
  const router = useRouter();
  const positionLabel = usePositionLabel();
  const readable = isReadable(place);
  const [load, setLoad] = useState<Load>(readable ? LOADING : { state: 'failed' });
  const [entries, setEntries] = useState<readonly OrderEntry[]>([]);
  const [baseline, setBaseline] = useState<readonly OrderEntry[]>([]);
  const [problem, setProblem] = useState<SaveFailure | null>(null);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [focus, setFocus] = useState<FocusRequest | null>(null);
  const latest = useRef(0);
  const inFlight = useRef(false);

  const fetchOrder = useCallback(
    async (silent: boolean) => {
      if (!isReadable(place)) return;
      const ticket = ++latest.current;
      if (!silent) setLoad(LOADING);
      const result = await callApi<OrderView>('GET', orderReadPath(place));
      if (ticket !== latest.current) return;
      if (!result.ok) {
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        setLoad({ state: 'failed' });
        return;
      }
      setBaseline(result.body.slides);
      setEntries(result.body.slides);
      setLoad({ state: 'ready', view: result.body });
    },
    [place],
  );

  useEffect(() => {
    void fetchOrder(false);
  }, [fetchOrder]);

  const dirty = !sameOrder(entries, baseline);

  function moveSlide(index: number, direction: Direction) {
    const moved = entries[index];
    const next = move(entries, index, direction);
    if (moved === undefined || next === entries) return;
    setEntries(next);
    setProblem(null);
    setFocus({ id: moved.id, direction, count: (focus?.count ?? 0) + 1 });
    setMessage(
      t('moved', {
        name: moved.internalName,
        place: next.findIndex((entry) => entry.id === moved.id) + 1,
        total: next.length,
      }),
    );
  }

  function discard() {
    setEntries(baseline);
    setProblem(null);
    setMessage('');
  }

  async function save() {
    if (!canEdit || !dirty || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setProblem(null);
    setMessage('');
    try {
      const result = await callApi<unknown>(
        'PUT',
        ORDER_API_PATH,
        orderBody(place, entries),
        csrfToken,
      );
      if (result.ok) {
        // The list is read again, so what is shown is what buyers get, over-limit marks included.
        setBaseline(entries);
        setMessage('');
        toast.success(t('saved'));
        await fetchOrder(true);
        return;
      }
      if (result.failure.status === 401) {
        router.replace('/session-ended');
        return;
      }
      setProblem(saveFailureOf(result.failure));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function reload() {
    setProblem(null);
    setMessage('');
    void fetchOrder(false);
  }

  const definition = positionOf(place.position);
  const title = positionLabel(place.position);
  const flags =
    load.state === 'ready'
      ? dirty
        ? overLimitFlags(entries, load.view.maxActive)
        : entries.map((entry) => entry.overLimit)
      : [];
  const changed = problem === 'mismatch' || problem === 'unknown-slide';

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <SlideOrderControls place={place} />
      {!readable ? <p className="text-sm text-fg-muted">{t('scope-id-needed')}</p> : null}
      {readable && load.state === 'loading' ? <SkeletonRows label={t('loading')} rows={4} /> : null}
      {readable && load.state === 'failed' ? (
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
          message={t('error.load')}
          retryLabel={tl('retry')}
          onRetry={() => void fetchOrder(false)}
        />
      ) : null}
      {load.state === 'ready' && entries.length === 0 ? (
        <EmptyState
          icon="layout"
          title={t('empty-title')}
          body={t('empty-body')}
          action={<LinkButton href={SLIDES_PATH}>{t('empty-action')}</LinkButton>}
        />
      ) : null}
      {load.state === 'ready' && entries.length > 0 ? (
        <>
          {canEdit ? null : <Banner tone="info">{t('read-only')}</Banner>}
          {problem === null ? null : (
            <Banner tone="critical" {...(changed ? { title: t('error.mismatch') } : {})}>
              <p>
                {changed
                  ? problem === 'mismatch'
                    ? t('error.mismatch-body')
                    : t('error.unknown-slide')
                  : t(`error.${problem}`)}
              </p>
              {changed ? (
                <div className="mt-3">
                  <Button variant="secondary" onClick={reload}>
                    {t('error.reload')}
                  </Button>
                </div>
              ) : null}
            </Banner>
          )}
          <SlideOrderCard
            title={title}
            maxActive={load.view.maxActive}
            autoplay={definition?.autoplay ?? false}
            scopeNote={
              place.scope === 'all' || place.scopeId === null
                ? null
                : t('heading-scope', {
                    scope: scopeText(`scope.${place.scope}`),
                    id: place.scopeId,
                  })
            }
            entries={entries}
            overLimit={flags}
            canEdit={canEdit}
            zone={zone}
            locale={locale}
            focus={focus}
            onMove={moveSlide}
            footer={
              <>
                <p className="mb-3 text-xs text-fg-muted">{t('footnote', { zone })}</p>
                {canEdit ? (
                  <FormActionBar
                    status={
                      <>
                        {/* Announces a move for screen readers; the save result is a toast. */}
                        <span role="status" aria-live="polite" className="block">
                          {message}
                        </span>
                        <span className="block">{t('note')}</span>
                      </>
                    }
                  >
                    <Button variant="secondary" disabled={!dirty || pending} onClick={discard}>
                      {t('discard')}
                    </Button>
                    <Button disabled={!dirty} loading={pending} onClick={() => void save()}>
                      {t('save')}
                    </Button>
                  </FormActionBar>
                ) : null}
              </>
            }
          />
        </>
      ) : null}
    </div>
  );
}
