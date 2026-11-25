'use client';

import { Badge, Banner, Button, Select, TextAreaField, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstantInZone } from '../shared/format.ts';
import { CHANGE_REASONS } from '../catalog/types.ts';
import { ChangeDiff } from './diff-view.tsx';
import { decisionProblemOf, type DecisionProblem } from './decision-errors.ts';
import { ReasonChips } from './reason-chips.tsx';
import { StandingSummary } from './standing-summary.tsx';
import { STANDING_VIEW_PERMISSIONS, standingOf, standingPath, type Standing } from './standing.ts';
import {
  NOTE_MAX,
  changeName,
  firstName,
  typeLabel,
  type ChangeRow,
  type FirstRow,
} from './types.ts';

export type Subject =
  | { readonly kind: 'first'; readonly row: FirstRow }
  | { readonly kind: 'edit'; readonly row: ChangeRow };

export type Decision = 'approve' | 'request-changes' | 'reject';

export const subjectId = (subject: Subject): string =>
  subject.kind === 'first' ? subject.row.offerId : subject.row.changeId;
export const subjectName = (subject: Subject): string =>
  subject.kind === 'first' ? firstName(subject.row) : changeName(subject.row);

const noteLength = (text: string): number => [...text.trim()].length;

/**
 * What one held Offer is and the decision on it: the product and seller, why it waits, what the
 * seller wrote (a first publication) or the Live | Proposed diff (an edit), the seller's standing,
 * and the decision bar. The drawer and the deep-link page both show this. A note of 1 to 2000
 * characters is required to request changes or reject an edit and optional on approval; a first
 * publication is sent back with one prepared reason instead. Every decision is the API's: a
 * refusal is told here, never worked around.
 */
export function ReviewDetail({
  subject,
  csrfToken,
  zone,
  canDecide,
  viewerKeys,
  onDecided,
  onReload,
  onDirtyChange,
  layout = 'drawer',
}: {
  readonly subject: Subject;
  /** `drawer` has the panel's side padding to bleed the sticky bar through; `page` has none. */
  readonly layout?: 'drawer' | 'page';
  readonly csrfToken: string;
  readonly zone: string;
  /** The admin holds `catalog.product.approve`; without it no decision button shows. */
  readonly canDecide: boolean;
  /** The admin's permission keys, for the optional standing read. */
  readonly viewerKeys: readonly string[];
  /** The decision was made; the list leaves the row and opens the next. */
  readonly onDecided: (decided: Decision) => void;
  /** The row changed meanwhile: read it again. */
  readonly onReload: () => void;
  /** Something is typed that closing would lose. */
  readonly onDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useTranslations('offer-review.detail');
  const td = useTranslations('offer-review.decide');
  const tr = useTranslations('catalog.review');
  const th = useTranslations('offer-review.handling');
  const locale = useLocale();
  const edit = subject.kind === 'edit';
  const id = subjectId(subject);
  const busy = useRef(false);
  const [note, setNote] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState<Decision | null>(null);
  const [problem, setProblem] = useState<DecisionProblem | null>(null);
  const [standing, setStanding] = useState<Standing | null>(null);
  const sellerId = subject.row.sellerId;
  const canSeeStanding = STANDING_VIEW_PERMISSIONS.every((key) => viewerKeys.includes(key));

  useEffect(() => {
    onDirtyChange?.(note !== '' || reasonCode !== '');
  }, [note, reasonCode, onDirtyChange]);

  useEffect(() => {
    setStanding(null);
    if (!canSeeStanding) return;
    let live = true;
    void callApi<unknown>('GET', standingPath(sellerId)).then((result) => {
      if (live && result.ok) setStanding(standingOf(result.body));
    });
    return () => {
      live = false;
    };
  }, [sellerId, canSeeStanding]);

  const row = subject.row;
  const status = edit ? (row as ChangeRow).status : 'pending';
  const decided = status !== 'pending';
  const allowed = (action: Decision) => canDecide && !decided && row.actions.includes(action);
  const trimmed = note.trim();
  const noteOk = noteLength(note) >= 1 && noteLength(note) <= NOTE_MAX;
  const noteTooLong = noteLength(note) > NOTE_MAX;
  const sellerFirst = subject.kind === 'first';
  const ready = (action: Decision): boolean =>
    pending === null &&
    (action === 'approve' ? !noteTooLong : sellerFirst ? reasonCode !== '' : noteOk);

  async function decide(action: Decision) {
    if (busy.current || !ready(action)) return;
    busy.current = true;
    setPending(action);
    setProblem(null);
    const result = edit
      ? await callApi<unknown>(
          'POST',
          `catalog/admin/offer-changes/${id}/${action}`,
          // Approve takes an optional note; the other two a required one.
          action === 'approve' && trimmed === '' ? {} : { note: trimmed },
          csrfToken,
        )
      : await callApi<unknown>(
          'POST',
          `catalog/admin/offers/${id}/${action}`,
          action === 'approve'
            ? { version: (row as FirstRow).version }
            : { version: (row as FirstRow).version, reasonCode },
          csrfToken,
        );
    busy.current = false;
    setPending(null);
    if (result.ok) {
      toast.success(td(`done.${action}`));
      onDecided(action);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(decisionProblemOf(result.failure));
    setTouched(true);
  }

  const supersededCause = edit ? (row as ChangeRow).supersededCause : null;
  const noteRequiredError =
    touched && !sellerFirst && edit && !noteOk && trimmed === ''
      ? td('note-required')
      : noteTooLong
        ? td('note-too-long', { max: NOTE_MAX })
        : undefined;

  const submitted =
    row.submittedAt === null ? null : formatInstantInZone(row.submittedAt, locale, zone);
  const first = subject.kind === 'first' ? subject.row : null;
  const change = subject.kind === 'edit' ? subject.row : null;
  const description =
    first === null ? [] : Object.entries(first.description).filter(([, v]) => v !== '');
  return (
    <div className="flex min-h-full flex-col gap-4">
      <header className="flex flex-col gap-2">
        <h3 className="m-0 text-base font-semibold break-words">{subjectName(subject)}</h3>
        <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-fg-muted">{t('seller')}</dt>
          <dd className="m-0 min-w-0 break-words">
            <a
              className="font-medium text-link underline focus-visible:outline-2 focus-visible:outline-focus"
              href={`/sellers/${sellerId}`}
            >
              {row.storeName ?? t('seller-unnamed')}
            </a>
          </dd>
          <dt className="text-fg-muted">{t('why')}</dt>
          <dd className="m-0">
            <ReasonChips reasons={first?.reasons ?? change?.reasons ?? []} />
          </dd>
          <dt className="text-fg-muted">{t('submitted')}</dt>
          <dd className="m-0">{submitted ?? '-'}</dd>
          {first !== null ? (
            <>
              <dt className="text-fg-muted">{t('version')}</dt>
              <dd className="m-0">{t('version-value', { version: first.version })}</dd>
            </>
          ) : change !== null ? (
            <>
              <dt className="text-fg-muted">{t('version')}</dt>
              <dd className="m-0">
                {change.offer === null
                  ? t('base-version', { base: change.baseOfferVersion })
                  : t('base-version-now', {
                      base: change.baseOfferVersion,
                      now: change.offer.version,
                    })}
              </dd>
            </>
          ) : null}
        </dl>
      </header>

      {decided ? (
        <Banner tone="attention">
          {status === 'superseded'
            ? td('superseded', { cause: td(`cause.${supersededCause ?? 'unknown'}`) })
            : td('decided', { status: td(`status.${status}`) })}
        </Banner>
      ) : null}

      {first !== null ? (
        <section className="flex flex-col gap-3" aria-label={t('content')}>
          <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
            <dt className="text-fg-muted">{t('sku')}</dt>
            <dd className="m-0 break-all">{first.sellerSku}</dd>
            <dt className="text-fg-muted">{t('condition')}</dt>
            <dd className="m-0">{first.conditionCode}</dd>
            <dt className="text-fg-muted">{t('handling')}</dt>
            <dd className="m-0">
              {first.handling === null ? t('handling-missing') : th(first.handling)}
            </dd>
            <dt className="text-fg-muted">{t('tags')}</dt>
            <dd className="m-0">
              {first.tagTypes.length === 0 ? (
                t('no-tags')
              ) : (
                <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
                  {first.tagTypes.map((code) => (
                    <li key={code}>
                      <Badge tone="info">{typeLabel(code)}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
          <div className="rounded-md bg-muted p-3">
            <h4 className="m-0 mb-1 text-sm font-medium">{t('description')}</h4>
            {description.length === 0 ? (
              <p className="m-0 text-fg-muted">{tr('field.no-description')}</p>
            ) : (
              description.map(([code, text]) => (
                <p key={code} className="m-0 break-words whitespace-pre-line">
                  <span className="me-2 text-fg-muted">{code}</span>
                  {text}
                </p>
              ))
            )}
          </div>
        </section>
      ) : change !== null ? (
        <ChangeDiff change={change} />
      ) : null}

      {canSeeStanding && standing !== null ? (
        <section aria-label={t('standing')} className="rounded-md border border-line p-3">
          <h4 className="m-0 mb-2 text-sm font-medium">{t('standing')}</h4>
          <StandingSummary standing={standing} zone={zone} />
        </section>
      ) : null}

      {change?.decisionNote ? (
        <p className="m-0 text-sm">
          <span className="font-medium">{t('decision-note')}</span> {change.decisionNote}
        </p>
      ) : null}

      {canDecide ? (
        <div
          className={`sticky bottom-0 mt-auto flex flex-col gap-3 border-t border-line bg-surface py-3 ${layout === 'drawer' ? '-mx-4 px-4 sm:-mx-6 sm:px-6' : ''}`}
        >
          {problem === null ? null : (
            <div role="alert">
              <Banner tone="critical">
                {td(`error.${problem.key}`)}
                {problem.reload ? (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="font-semibold underline focus-visible:outline-2 focus-visible:outline-focus"
                      onClick={onReload}
                    >
                      {td('reload')}
                    </button>
                  </>
                ) : null}
              </Banner>
            </div>
          )}
          {decided ? null : sellerFirst ? (
            allowed('request-changes') ? (
              <Select
                name="reasonCode"
                label={td('reason')}
                value={reasonCode}
                placeholder={tr('reason.choose')}
                disabled={pending !== null}
                options={CHANGE_REASONS.map((value) => ({ value, label: tr(`reason.${value}`) }))}
                onChange={(event) => setReasonCode(event.target.value)}
              />
            ) : null
          ) : (
            <TextAreaField
              name="note"
              label={td('note')}
              help={td('note-help')}
              rows={3}
              value={note}
              disabled={pending !== null}
              error={noteRequiredError}
              counter={td('note-counter', { count: noteLength(note), max: NOTE_MAX })}
              onChange={(event) => setNote(event.target.value)}
              onBlur={() => setTouched(true)}
            />
          )}
          <div className="flex flex-wrap items-center gap-2">
            {allowed('approve') ? (
              <Button
                loading={pending === 'approve'}
                disabled={!ready('approve') || (pending !== null && pending !== 'approve')}
                onClick={() => void decide('approve')}
              >
                {td('approve')}
              </Button>
            ) : null}
            {allowed('request-changes') ? (
              <Button
                variant="secondary"
                loading={pending === 'request-changes'}
                disabled={
                  !ready('request-changes') || (pending !== null && pending !== 'request-changes')
                }
                onClick={() => void decide('request-changes')}
              >
                {td('request-changes')}
              </Button>
            ) : null}
            {edit && allowed('reject') ? (
              <Button
                variant="destructive"
                loading={pending === 'reject'}
                disabled={!ready('reject') || (pending !== null && pending !== 'reject')}
                onClick={() => void decide('reject')}
              >
                {td('reject')}
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="m-0 text-sm text-fg-muted">{td('view-only')}</p>
      )}
    </div>
  );
}
