'use client';

import { Banner, Button, Card, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { createProblemOf, type CreateProblem } from './create-errors.ts';
import type { ProductCreated, ProductOptions } from './types.ts';

/** A code from the API as readable text when no translation names it (`dry-goods` to `Dry goods`). */
export function readable(code: string): string {
  const text = code.replace(/[-_]+/g, ' ').trim();
  return text === '' ? code : text.charAt(0).toUpperCase() + text.slice(1);
}

/** Empty locales are left out: the API takes only the texts the seller wrote. */
export function descriptionOf(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([locale, text]) => [locale, text.trim()] as const)
      .filter(([, text]) => text !== ''),
  );
}

export function CreateForm({
  options,
  csrfToken,
}: {
  readonly options: ProductOptions;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const [typeCode, setTypeCode] = useState('');
  const [conditionCode, setConditionCode] = useState('');
  const [sellerSku, setSellerSku] = useState('');
  const [description, setDescription] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<CreateProblem | null>(null);
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
    const result = await callApi<ProductCreated>(
      'POST',
      'catalog/seller/products',
      { typeCode, sellerSku, conditionCode, description: descriptionOf(description) },
      csrfToken,
    );
    if (result.ok) {
      // Stay busy: the browser is leaving this page.
      window.location.assign(`/products/${result.body.productId}`);
      return;
    }
    busy.current = false;
    setPending(false);
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(createProblemOf(result.failure));
  }

  return (
    <Card>
      <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
        {problem === null ? null : <Banner tone="critical">{t(problem.form)}</Banner>}
        <Select
          name="typeCode"
          label={t('catalog.create.type')}
          value={typeCode}
          placeholder={t('catalog.create.choose')}
          error={fieldError('typeCode')}
          options={options.productTypes.map((code) => ({ value: code, label: readable(code) }))}
          onChange={(event) => setTypeCode(event.target.value)}
        />
        <Select
          name="conditionCode"
          label={t('catalog.create.condition')}
          value={conditionCode}
          placeholder={t('catalog.create.choose')}
          error={fieldError('conditionCode')}
          options={options.conditions.map((code) => ({ value: code, label: readable(code) }))}
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
        {options.locales.supported.map((locale) => (
          <TextField
            key={locale}
            name={`description.${locale}`}
            label={t('catalog.create.description', { locale })}
            optionalLabel={t('catalog.create.optional')}
            value={description[locale] ?? ''}
            error={fieldError(`description.${locale}`)}
            onChange={(event) => setDescription({ ...description, [locale]: event.target.value })}
          />
        ))}
        <div className="flex gap-3">
          <Button type="submit" loading={pending}>
            {pending ? t('catalog.create.creating') : t('catalog.create.submit')}
          </Button>
          <a className="inline-flex items-center font-medium text-link underline" href="/products">
            {t('catalog.create.back')}
          </a>
        </div>
      </form>
    </Card>
  );
}
