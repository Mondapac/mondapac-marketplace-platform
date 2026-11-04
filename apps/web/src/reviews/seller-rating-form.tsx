'use client';

import { useTranslations } from 'next-intl';
import { useId, useState, type FormEvent } from 'react';
import { rateSellerOrder, REASONS, type ArrivalReason } from './reviews-api.ts';
import { errorKeyOf } from './review-form.tsx';
import { StarInput } from './stars.tsx';

type YesNo = 'yes' | 'no' | '';

function YesNoField({
  legend,
  value,
  onChange,
  error,
}: {
  readonly legend: string;
  readonly value: YesNo;
  readonly onChange: (value: YesNo) => void;
  readonly error: boolean;
}) {
  const t = useTranslations('reviews.seller-form');
  const name = useId();
  return (
    <fieldset className={error ? 'rv-pick bad' : 'rv-pick'}>
      <legend>{legend}</legend>
      <div className="rv-yn">
        {(['yes', 'no'] as const).map((answer) => (
          <label key={answer}>
            <input
              type="radio"
              name={name}
              value={answer}
              checked={value === answer}
              onChange={() => onChange(answer)}
            />
            <span>{t(answer)}</span>
          </label>
        ))}
      </div>
      {error ? (
        <small className="err" role="alert">
          {t('answer-required')}
        </small>
      ) : null}
    </fieldset>
  );
}

/**
 * The seller rating of one delivered seller order: satisfaction (1 to 5), "was it as described?",
 * "did it arrive in good shape?" and, when it did not, an optional reason only the seller and the
 * platform see. Timeliness is never asked: it comes from the delivery record.
 */
export function SellerRatingForm({
  sellerOrderId,
  sellerName,
  onSaved,
  onCancel,
}: {
  readonly sellerOrderId: string;
  readonly sellerName: string;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('reviews.seller-form');
  const te = useTranslations('reviews.errors');
  const id = useId();
  const [satisfaction, setSatisfaction] = useState(0);
  const [asDescribed, setAsDescribed] = useState<YesNo>('');
  const [arrivedOk, setArrivedOk] = useState<YesNo>('');
  const [reason, setReason] = useState<ArrivalReason | ''>('');
  const [missing, setMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (satisfaction < 1 || asDescribed === '' || arrivedOk === '') {
      setMissing(true);
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await rateSellerOrder(sellerOrderId, {
      satisfaction,
      asDescribed: asDescribed === 'yes',
      arrivedOk: arrivedOk === 'yes',
      reasonCode: reason === '' ? null : reason,
    });
    setBusy(false);
    const key = errorKeyOf(result);
    if (key !== null) {
      setProblem(key);
      return;
    }
    setDone(true);
    onSaved();
  }

  if (done) {
    return (
      <p className="ac-note" role="status">
        {t('done')}
      </p>
    );
  }
  return (
    <form className="rv-form" onSubmit={(event) => void save(event)} noValidate>
      <h3>{t('title', { seller: sellerName })}</h3>
      <StarInput
        legend={t('satisfaction')}
        value={satisfaction}
        onChange={setSatisfaction}
        optionLabel={(stars) => t('stars-option', { stars })}
        error={missing && satisfaction < 1 ? t('answer-required') : undefined}
      />
      <YesNoField
        legend={t('as-described')}
        value={asDescribed}
        onChange={setAsDescribed}
        error={missing && asDescribed === ''}
      />
      <YesNoField
        legend={t('arrived-ok')}
        value={arrivedOk}
        onChange={setArrivedOk}
        error={missing && arrivedOk === ''}
      />
      {arrivedOk === 'no' ? (
        <div className="ac-fld">
          <label htmlFor={`${id}-reason`}>{t('reason')}</label>
          <select
            id={`${id}-reason`}
            className="rv-select"
            value={reason}
            onChange={(event) => setReason(event.target.value as ArrivalReason | '')}
          >
            <option value="">{t('reason-none')}</option>
            {REASONS.map((code) => (
              <option key={code} value={code}>
                {t(`reasons.${code}`)}
              </option>
            ))}
          </select>
          <small>{t('reason-hint')}</small>
        </div>
      ) : null}
      {problem === null ? null : (
        <p className="rv-err" role="alert">
          {te(problem)}
        </p>
      )}
      <div className="ac-acts">
        <button className="btn" type="submit" aria-disabled={busy || undefined}>
          {busy ? t('saving') : t('submit')}
        </button>
        <button className="btn ghost" type="button" onClick={onCancel}>
          {t('cancel')}
        </button>
      </div>
    </form>
  );
}
