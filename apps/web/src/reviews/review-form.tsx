'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, type FormEvent } from 'react';
import type { ApiResult, FieldProblem } from '../account/customer-api.ts';
import { deleteReview, editReview, submitReview, type SubmittedReview } from './reviews-api.ts';
import type { OwnReview } from './reviews-model.ts';
import { StarInput } from './stars.tsx';

/** The message key (under `reviews.errors`) for a refusal of a review or rating call. */
export function errorKeyOf(result: ApiResult<unknown>): string | null {
  switch (result.kind) {
    case 'ok':
      return null;
    case 'signed-out':
      return 'signed-out';
    case 'throttled':
      return 'rate-limited';
    case 'failed':
      return 'failed';
    case 'invalid':
      switch (result.code) {
        case 'reviews.window-closed':
        case 'reviews.edit-window-closed':
        case 'reviews.not-editable':
        case 'reviews.already-reviewed':
        case 'reviews.already-rated':
        case 'reviews.not-eligible':
        case 'reviews.own-store':
        case 'reviews.disabled':
        case 'reviews.not-found':
          return result.code.slice('reviews.'.length);
        case 'validation.failed':
          return 'check-fields';
        default:
          return 'failed';
      }
  }
}

const fieldError = (fields: readonly FieldProblem[], path: string): boolean =>
  fields.some((field) => field.path === path);

type Phase =
  | { readonly kind: 'editing' }
  | { readonly kind: 'saving' }
  | { readonly kind: 'done'; readonly review: SubmittedReview['review']; readonly outcome: string };

/**
 * The review form of one product: stars (required), a title and text (optional) and "show me as
 * Verified buyer". New or an edit of the buyer's own review. The text goes only to the API.
 */
export function ReviewForm({
  productId,
  productName,
  existing,
  onSaved,
  onCancel,
}: {
  readonly productId: string;
  readonly productName: string;
  readonly existing?: OwnReview | undefined;
  readonly onSaved: (review: OwnReview, outcome: string) => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('reviews.form');
  const te = useTranslations('reviews.errors');
  const id = useId();
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [title, setTitle] = useState(existing?.title ?? '');
  const [body, setBody] = useState(existing?.body ?? '');
  const [anonymous, setAnonymous] = useState(existing?.anonymous ?? false);
  const [phase, setPhase] = useState<Phase>({ kind: 'editing' });
  const [problem, setProblem] = useState<string | null>(null);
  const [fields, setFields] = useState<readonly FieldProblem[]>([]);
  const [missingStars, setMissingStars] = useState(false);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (phase.kind === 'saving') return;
    if (rating < 1) {
      setMissingStars(true);
      return;
    }
    setPhase({ kind: 'saving' });
    setProblem(null);
    setFields([]);
    const input = { rating, title, body, anonymous };
    const result =
      existing === undefined
        ? await submitReview(productId, input)
        : await editReview(existing.id, input);
    const key = errorKeyOf(result);
    if (key !== null || result.kind !== 'ok') {
      setPhase({ kind: 'editing' });
      setProblem(key ?? 'failed');
      setFields(result.kind === 'invalid' ? result.fields : []);
      return;
    }
    const saved: SubmittedReview =
      existing === undefined
        ? (result.value as SubmittedReview)
        : { outcome: 'resubmitted', review: result.value as OwnReview };
    setPhase({ kind: 'done', review: saved.review, outcome: saved.outcome });
    onSaved(saved.review, saved.outcome);
  }

  if (phase.kind === 'done') {
    const note =
      phase.outcome === 'purchase-recorded'
        ? 'recorded'
        : phase.review.status === 'held'
          ? 'held'
          : 'published';
    return (
      <p className="ac-note" role="status">
        {t(`done-${note}`)}
      </p>
    );
  }
  return (
    <form className="rv-form" onSubmit={(event) => void save(event)} noValidate>
      <h3>
        {existing === undefined
          ? t('write-title', { name: productName })
          : t('edit-title', { name: productName })}
      </h3>
      <StarInput
        legend={t('stars')}
        value={rating}
        onChange={(value) => {
          setRating(value);
          setMissingStars(false);
        }}
        optionLabel={(stars) => t('stars-option', { stars })}
        error={missingStars ? t('stars-required') : undefined}
      />
      <div className={fieldError(fields, 'title') ? 'ac-fld bad' : 'ac-fld'}>
        <label htmlFor={`${id}-title`}>{t('title')}</label>
        <input
          id={`${id}-title`}
          value={title}
          autoComplete="off"
          onChange={(event) => setTitle(event.target.value)}
        />
        {fieldError(fields, 'title') ? <small className="err">{t('title-bad')}</small> : null}
      </div>
      <div className={fieldError(fields, 'body') ? 'ac-fld bad' : 'ac-fld'}>
        <label htmlFor={`${id}-body`}>{t('body')}</label>
        <textarea
          id={`${id}-body`}
          className="rv-text"
          rows={5}
          value={body}
          aria-describedby={`${id}-body-hint`}
          onChange={(event) => setBody(event.target.value)}
        />
        <small id={`${id}-body-hint`}>{t('body-hint')}</small>
        {fieldError(fields, 'body') ? <small className="err">{t('body-bad')}</small> : null}
      </div>
      <label className="rv-check">
        <input
          type="checkbox"
          checked={anonymous}
          onChange={(event) => setAnonymous(event.target.checked)}
        />
        <span>
          {t('anonymous')}
          <small>{t('anonymous-hint')}</small>
        </span>
      </label>
      {problem === null ? null : (
        <p className="rv-err" role="alert">
          {te(problem)}
        </p>
      )}
      <div className="ac-acts">
        <button className="btn" type="submit" aria-disabled={phase.kind === 'saving' || undefined}>
          {phase.kind === 'saving' ? t('saving') : existing === undefined ? t('submit') : t('save')}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}

/** "Delete my review", with a confirmation (it is removed from the product page at once). */
export function DeleteReview({
  review,
  onDeleted,
}: {
  readonly review: OwnReview;
  readonly onDeleted: () => void;
}) {
  const t = useTranslations('reviews.delete');
  const te = useTranslations('reviews.errors');
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!asking) {
    return (
      <button className="btn ghost ac-danger" type="button" onClick={() => setAsking(true)}>
        {t('button')}
      </button>
    );
  }
  return (
    <div className="ac-confirm" role="alertdialog" aria-labelledby={`del-${review.id}`}>
      <b id={`del-${review.id}`}>{t('title')}</b>
      <span>{t('body')}</span>
      {problem === null ? null : (
        <span className="rv-err" role="alert">
          {te(problem)}
        </span>
      )}
      <div className="ac-acts">
        <button
          className="btn ghost ac-danger"
          type="button"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (busy) return;
            setBusy(true);
            void deleteReview(review.id).then((result) => {
              setBusy(false);
              const key = errorKeyOf(result);
              if (key === null) onDeleted();
              else setProblem(key);
            });
          }}
        >
          {t('confirm')}
        </button>
        <button className="btn ghost" type="button" onClick={() => setAsking(false)}>
          {t('keep')}
        </button>
      </div>
    </div>
  );
}
