'use client';

import { Banner, Button, Card, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { descriptionOf, readable } from './create-form.tsx';
import { offerEditProblemOf } from './offer-edit-errors.ts';
import type { OfferView, ProductOptions } from './types.ts';

/** The whole description to send: edited locales replace the old text, others are kept as they were. */
export function descriptionWith(
  stored: Readonly<Record<string, string>>,
  edited: Readonly<Record<string, string>>,
  locales: readonly string[],
): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(stored).filter(([k]) => !locales.includes(k)));
  return { ...kept, ...descriptionOf(edited) };
}

export function OfferEditForm({
  offer,
  options,
  csrfToken,
}: {
  readonly offer: OfferView;
  readonly options: ProductOptions;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const locales = options.locales.supported;
  const [conditionCode, setConditionCode] = useState(offer.conditionCode);
  const [sellerSku, setSellerSku] = useState(offer.sellerSku);
  const [description, setDescription] = useState<Record<string, string>>(() =>
    Object.fromEntries(locales.map((locale) => [locale, offer.description[locale] ?? ''])),
  );
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [problem, setProblem] = useState<ReturnType<typeof offerEditProblemOf> | null>(null);
  const busy = useRef(false);

  function fieldError(path: string): string | undefined {
    const key = problem?.fields[path];
    return key === undefined ? undefined : t(key);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    setSaved(false);
    const result = await callApi<{ changedFields: readonly string[] }>(
      'PUT',
      `catalog/seller/offers/${offer.offerId}`,
      {
        sellerSku,
        conditionCode,
        description: descriptionWith(offer.description, description, locales),
      },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) setSaved(true);
    else if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(offerEditProblemOf(result.failure));
  }

  const conditions = options.conditions.includes(conditionCode)
    ? options.conditions
    : [conditionCode, ...options.conditions];
  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
        {saved ? <Banner tone="success">{t('catalog.offer-edit.saved')}</Banner> : null}
        {problem === null ? null : <Banner tone="critical">{t(problem.form)}</Banner>}
        <Select
          name="conditionCode"
          label={t('catalog.create.condition')}
          value={conditionCode}
          error={fieldError('conditionCode')}
          options={conditions.map((code) => ({ value: code, label: readable(code) }))}
          onChange={(event) => setConditionCode(event.target.value)}
        />
        <TextField
          name="sellerSku"
          label={t('catalog.create.sku')}
          help={t('catalog.create.sku-help')}
          value={sellerSku}
          error={fieldError('sellerSku')}
          onChange={(event) => setSellerSku(event.target.value)}
        />
        {locales.map((locale) => (
          <TextField
            key={locale}
            name={`description.${locale}`}
            label={t('catalog.create.description', { locale })}
            optionalLabel={t('catalog.create.optional')}
            value={description[locale] ?? ''}
            error={fieldError(`description.${locale}`) ?? fieldError('description')}
            onChange={(event) => setDescription({ ...description, [locale]: event.target.value })}
          />
        ))}
        <div className="flex gap-3">
          <Button type="submit" loading={pending}>
            {t('catalog.offer-edit.save')}
          </Button>
          <a
            className="inline-flex items-center font-medium text-link underline"
            href={`/offers/${offer.offerId}`}
          >
            {t('catalog.offer-edit.back')}
          </a>
        </div>
      </form>
    </Card>
  );
}
