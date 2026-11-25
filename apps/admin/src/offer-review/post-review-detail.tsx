'use client';

import { Banner, Button, TextAreaField, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { callApi } from '../api/client.ts';
import { formatInstantInZone } from '../shared/format.ts';
import { decisionProblemOf, type DecisionProblem } from './decision-errors.ts';
import { PostReviewChips } from './post-review-chips.tsx';
import { POST_NOTE_MAX, postReviewName, type PostReviewRow } from './post-review-types.ts';
import { SafeText } from './safe-text.tsx';
import { TakeDownDialog } from './take-down-dialog.tsx';
import { typeLabel } from './types.ts';

export type PostDecision = 'approve' | 'take-down';

const noteLength = (text: string): number => [...text.trim()].length;

/**
 * One row of the post-publication review in the decision drawer: the Offer and product, the store,
 * why it is in the list, when it was opened and the Offer's state now, then Approve (closes the
 * row; an optional note kept for admins) and Take down (off sale, Changes needed, with a reason:
 * its own dialog). A decided row shows its decision and, for an admin holding the approve key, the
 * note (read from the row's own route, never from the list). The buttons follow the row's
 * `actions`; every decision is the API's.
 */
export function PostReviewDetail({
  row,
  csrfToken,
  zone,
  canApprove,
  canTakeDown,
  onDecided,
  onReload,
  onDirtyChange,
}: {
  readonly row: PostReviewRow;
  readonly csrfToken: string;
  readonly zone: string;
  /** The admin holds `catalog.product.approve`. */
  readonly canApprove: boolean;
  /** The admin holds `catalog.product.approve` and `catalog.product.delete`. */
  readonly canTakeDown: boolean;
  readonly onDecided: (decided: PostDecision) => void;
  readonly onReload: () => void;
  readonly onDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useTranslations('offer-review.post.detail');
  const te = useTranslations('offer-review.post.error');
  const tr = useTranslations('catalog.review');
  const locale = useLocale();
  const busy = useRef(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<DecisionProblem | null>(null);
  const [takingDown, setTakingDown] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(row.note ?? null);
  const open = row.status === 'open';
  const approvable = open && canApprove && row.actions.approve;
  const takeDownable = open && canTakeDown && row.actions.takeDown;
  const noteTooLong = noteLength(note) > POST_NOTE_MAX;

  useEffect(() => {
    onDirtyChange?.(note !== '');
  }, [note, onDirtyChange]);

  // A decided row's note is read from its own route (the list never carries it).
  useEffect(() => {
    if (open || !canApprove || row.note !== undefined) return;
    let live = true;
    void callApi<PostReviewRow>('GET', `catalog/admin/offer-post-reviews/${row.id}`).then(
      (result) => {
        if (live && result.ok && typeof result.body?.note === 'string') {
          setSavedNote(result.body.note);
        }
      },
    );
    return () => {
      live = false;
    };
  }, [open, canApprove, row.id, row.note]);

  async function approve() {
    if (busy.current || noteTooLong) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const trimmed = note.trim();
    const result = await callApi<unknown>(
      'POST',
      `catalog/admin/offer-post-reviews/${row.id}/approve`,
      trimmed === '' ? { version: row.version } : { version: row.version, note: trimmed },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t('done-approve'));
      onDecided('approve');
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(decisionProblemOf(result.failure));
  }

  const opened = formatInstantInZone(row.openedAt, locale, zone);
  const decidedAt =
    row.decidedAt === null ? null : formatInstantInZone(row.decidedAt, locale, zone);
  const offerStatus = t.has(`offer-status.${row.offer.status}`)
    ? t(`offer-status.${row.offer.status}`)
    : typeLabel(row.offer.status);
  return (
    <div className="flex min-h-full flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h3 className="m-0 text-base font-semibold break-words">
          <SafeText text={postReviewName(row)} />
        </h3>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-fg-muted">{t('seller')}</dt>
          <dd className="m-0 min-w-0 break-words">
            <a
              className="font-medium text-link underline focus-visible:outline-2 focus-visible:outline-focus"
              href={`/sellers/${encodeURIComponent(row.sellerId)}`}
            >
              {row.storeName === null ? t('seller-unnamed') : <SafeText text={row.storeName} />}
            </a>
          </dd>
          <dt className="text-fg-muted">{t('why')}</dt>
          <dd className="m-0">
            <PostReviewChips row={row} />
          </dd>
          {row.samplePercent === null ? null : (
            <>
              <dt className="text-fg-muted">{t('sample-rate')}</dt>
              <dd className="m-0">
                {row.sampleDoubled
                  ? t('sample-rate-doubled', { percent: row.samplePercent })
                  : t('sample-rate-value', { percent: row.samplePercent })}
              </dd>
            </>
          )}
          <dt className="text-fg-muted">{t('opened')}</dt>
          <dd className="m-0">{opened}</dd>
          <dt className="text-fg-muted">{t('sku')}</dt>
          <dd className="m-0 break-all">
            <SafeText text={row.offer.sellerSku} />
          </dd>
          <dt className="text-fg-muted">{t('offer-status-label')}</dt>
          <dd className="m-0">
            {row.offer.listed ? offerStatus : t('offer-unlisted', { status: offerStatus })}
          </dd>
          <dt className="text-fg-muted">{t('version')}</dt>
          <dd className="m-0">{t('version-value', { version: row.version })}</dd>
        </dl>
      </header>

      {open ? (
        <p className="m-0 text-sm text-fg-muted">{t('selling-continues')}</p>
      ) : (
        <Banner tone={row.status === 'taken-down' ? 'critical' : 'success'}>
          {row.status === 'taken-down'
            ? t('decided-taken-down', { at: decidedAt ?? '-' })
            : t('decided-approved', { at: decidedAt ?? '-' })}
        </Banner>
      )}

      {row.decision === null ? null : (
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {row.decision.reasonCode === null ? null : (
            <>
              <dt className="text-fg-muted">{t('decision-reason')}</dt>
              <dd className="m-0">
                {tr.has(`reason.${row.decision.reasonCode}`)
                  ? tr(`reason.${row.decision.reasonCode}`)
                  : row.decision.reasonCode}
              </dd>
            </>
          )}
          {row.status === 'taken-down' ? (
            <>
              <dt className="text-fg-muted">{t('misconduct')}</dt>
              <dd className="m-0">{row.decision.misconduct ? t('misconduct-yes') : t('no')}</dd>
            </>
          ) : null}
        </dl>
      )}
      {savedNote === null || savedNote === '' ? null : (
        <p className="m-0 text-sm break-words">
          <span className="font-medium">{t('note-saved')}</span> <SafeText text={savedNote} />
        </p>
      )}

      {approvable || takeDownable ? (
        <div className="sticky -bottom-4 -mx-4 mt-auto -mb-4 flex flex-col gap-3 border-t border-line bg-surface px-4 py-3 pb-4 sm:-mx-6 sm:px-6">
          {problem === null ? null : (
            <div role="alert">
              <Banner tone="critical">
                {te(problem.key)}
                {problem.reload ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="font-semibold underline focus-visible:outline-2 focus-visible:outline-focus"
                      onClick={onReload}
                    >
                      {te('reload')}
                    </button>
                  </>
                ) : null}
              </Banner>
            </div>
          )}
          {approvable ? (
            <TextAreaField
              name="note"
              label={t('note')}
              help={t('note-help')}
              rows={2}
              value={note}
              disabled={pending}
              error={noteTooLong ? t('note-too-long', { max: POST_NOTE_MAX }) : undefined}
              counter={t('note-counter', { count: noteLength(note), max: POST_NOTE_MAX })}
              onChange={(event) => setNote(event.target.value)}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {approvable ? (
              <Button
                loading={pending}
                disabled={pending || noteTooLong}
                onClick={() => void approve()}
              >
                {t('approve')}
              </Button>
            ) : null}
            {takeDownable ? (
              <Button variant="destructive" disabled={pending} onClick={() => setTakingDown(true)}>
                {t('take-down')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : open && !canApprove ? (
        <p className="m-0 text-sm text-fg-muted">{t('view-only')}</p>
      ) : null}

      {/* Rendered at the document's end, outside the drawer, as the drawer's own confirm is. */}
      {takingDown
        ? createPortal(
            <TakeDownDialog
              row={row}
              csrfToken={csrfToken}
              onClose={() => setTakingDown(false)}
              onDone={() => {
                setTakingDown(false);
                onDecided('take-down');
              }}
              onReload={() => {
                setTakingDown(false);
                onReload();
              }}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
