'use client';

import { Banner, Button, CheckboxRow, Dialog, Select, TextAreaField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { CHANGE_REASONS } from '../catalog/types.ts';
import { decisionProblemOf, type DecisionProblem } from './decision-errors.ts';
import { POST_NOTE_MAX, postReviewName, type PostReviewRow } from './post-review-types.ts';

const lengthOf = (text: string): number => [...text.trim()].length;

/**
 * Take a published Offer off sale from the post-publication list: a prepared reason (the Offer
 * change reasons the seller already knows), whether it is misconduct (the seller loses Trusted),
 * and a note of 1 to 2000 characters, then a red confirm. Focus starts on Cancel, so Enter never
 * takes an Offer down. The API decides; a refusal is told here and the dialog stays open.
 */
export function TakeDownDialog({
  row,
  csrfToken,
  onClose,
  onDone,
  onReload,
}: {
  readonly row: PostReviewRow;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** The Offer was taken down. */
  readonly onDone: () => void;
  /** The row changed meanwhile: read it again. */
  readonly onReload: () => void;
}) {
  const t = useTranslations('offer-review.post.take-down');
  const tr = useTranslations('catalog.review');
  const te = useTranslations('offer-review.post.decide-error');
  const tu = useTranslations('offer-review.post');
  const cancel = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  const [reasonCode, setReasonCode] = useState('');
  const [misconduct, setMisconduct] = useState(false);
  const [note, setNote] = useState('');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<DecisionProblem | null>(null);
  const length = lengthOf(note);
  const noteOk = length >= 1 && length <= POST_NOTE_MAX;
  const ready = reasonCode !== '' && noteOk;

  async function submit() {
    setTouched(true);
    if (busy.current || !ready) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<unknown>(
      'POST',
      `catalog/admin/offer-post-reviews/${row.id}/take-down`,
      { version: row.version, reasonCode, misconduct, note: note.trim() },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t(misconduct ? 'done-misconduct' : 'done'));
      onDone();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(decisionProblemOf(result.failure));
  }

  return (
    // The default size: the kit's `form` size stretches to the screen's height from 640 px (its
    // `sm:h-auto` meets the modal's top and bottom insets; a carry for packages/ui).
    <Dialog
      open
      title={t('title')}
      initialFocus={cancel}
      onClose={() => {
        if (!pending) onClose();
      }}
      actions={
        <>
          <Button ref={cancel} variant="secondary" disabled={pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive-solid"
            // The kit's solid red takes white text at 3.6:1 in the dark theme; the critical text
            // colour as the fill (with the surface colour as text) passes 4.5:1 in both themes.
            className="enabled:bg-critical-fg! enabled:text-surface!"
            loading={pending}
            disabled={pending || !ready}
            onClick={() => void submit()}
          >
            {t('confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="m-0 font-medium text-fg wrap-anywhere">
          {t('subject', {
            name: postReviewName(row),
            sku: row.offer.sellerSku,
            seller: row.storeName ?? tu('seller-unnamed'),
          })}
        </p>
        <p className="m-0 text-sm">{t('body')}</p>
        <p className="m-0 text-sm">{t('body-seller')}</p>
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
        <Select
          name="reasonCode"
          label={t('reason')}
          value={reasonCode}
          placeholder={tr('reason.choose')}
          required
          disabled={pending}
          options={CHANGE_REASONS.map((value) => ({ value, label: tr(`reason.${value}`) }))}
          onChange={(event) => setReasonCode(event.target.value)}
        />
        <CheckboxRow
          name="misconduct"
          label={t('misconduct')}
          help={t('misconduct-help')}
          checked={misconduct}
          disabled={pending}
          touch
          onChange={(event) => setMisconduct(event.target.checked)}
        />
        <TextAreaField
          name="note"
          label={t('note')}
          help={t('note-help')}
          rows={3}
          required
          value={note}
          disabled={pending}
          error={
            length > POST_NOTE_MAX
              ? t('note-too-long', { max: POST_NOTE_MAX })
              : touched && length === 0
                ? t('note-required')
                : undefined
          }
          counter={t('note-counter', { count: length, max: POST_NOTE_MAX })}
          onChange={(event) => setNote(event.target.value)}
          onBlur={() => setTouched(true)}
        />
      </div>
    </Dialog>
  );
}
