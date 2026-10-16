'use client';

import { ActionRow, Banner, Button, Card, TextField } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { feeProblemOf } from './errors.ts';
import { formatMinor, inputOf, minorOf } from './money.ts';
import type { FlatFee } from './types.ts';

/** The most a flat fee can be, in minor units (the database CHECK). */
const MAX_MINOR = 100000;

export function FlatFeeCard({
  initial,
  canManage,
  csrfToken,
}: {
  readonly initial: FlatFee;
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [fee, setFee] = useState(initial);
  const [text, setText] = useState(
    initial.amount === null ? '' : inputOf(initial.amount, initial.currency),
  );
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  const busy = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    const minor = minorOf(text, fee.currency);
    setSaved(false);
    setProblem(null);
    if (minor === null || minor > MAX_MINOR) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    busy.current = true;
    setPending(true);
    const result = await callApi<FlatFee>(
      'PUT',
      `shipping/admin/sellers/${fee.sellerId}/flat-fee`,
      { amount: minor },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setFee(result.body);
      setText(inputOf(result.body.amount ?? '0', result.body.currency));
      setSaved(true);
      return;
    }
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(feeProblemOf(result.failure));
  }

  const max = formatMinor(String(MAX_MINOR), fee.currency, locale);
  return (
    <Card title={t('shipping.title')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">{t('shipping.intro')}</p>
        {fee.amount === null ? (
          <Banner tone="attention">{t('shipping.not-set')}</Banner>
        ) : (
          <p>
            <span className="text-fg-muted">{t('shipping.current')}: </span>
            <strong>{formatMinor(fee.amount, fee.currency, locale)}</strong>
          </p>
        )}
        {saved ? <Banner tone="success">{t('shipping.saved')}</Banner> : null}
        {problem === null ? null : (
          <Banner tone="critical">{t(`shipping.error.${problem}`)}</Banner>
        )}
        {canManage ? (
          <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} noValidate>
            <TextField
              name="amount"
              label={t('shipping.field', { currency: fee.currency })}
              help={t('shipping.field-help', { max })}
              inputMode="decimal"
              value={text}
              error={invalid ? t('shipping.invalid', { max }) : undefined}
              onChange={(event) => setText(event.target.value)}
            />
            <ActionRow>
              <Button type="submit" loading={pending}>
                {t('shipping.save')}
              </Button>
            </ActionRow>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
