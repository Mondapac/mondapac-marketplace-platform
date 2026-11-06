'use client';

import { BackLink, Banner, Button, Card, LoadError, Select, SkeletonRows } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../../api/client.ts';
import { problemOf, type FormProblem } from './errors.ts';
import { BASE, readable, type ProductCreated, type ProductOptions } from './types.ts';

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly options: ProductOptions };

/** Step one of "Add product": the type. The product is created as a draft and opens for editing. */
export function ProductCreateForm({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations('catalog.productForm');
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [typeCode, setTypeCode] = useState('');
  const [missing, setMissing] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    const result = await callApi<ProductOptions>('GET', `${BASE}/options`);
    if (result.ok) setPhase({ kind: 'ready', options: result.body });
    else if (result.failure.status === 401) window.location.assign('/session-ended');
    else setPhase({ kind: 'failed' });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    if (typeCode === '') {
      setMissing(true);
      return;
    }
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<ProductCreated>('POST', BASE, { typeCode }, csrfToken);
    if (result.ok) {
      // Stay busy: the browser is leaving this page.
      window.location.assign(`/catalog/products/${result.body.productId}/edit`);
      return;
    }
    busy.current = false;
    setPending(false);
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(problemOf(result.failure));
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <BackLink href="/catalog/products" label={t('back')} />
      <div>
        <h1 className="text-2xl font-semibold">{t('create.title')}</h1>
        <p className="text-sm text-fg-muted">{t('create.subtitle')}</p>
      </div>
      {phase.kind === 'loading' ? <SkeletonRows label={t('loading')} rows={3} /> : null}
      {phase.kind === 'failed' ? (
        <LoadError message={t('load-failed')} retryLabel={t('retry')} onRetry={() => void load()} />
      ) : null}
      {phase.kind === 'ready' ? (
        <Card>
          <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
            {problem === null ? null : (
              <Banner tone="critical">{t(`error.${problem.key}`, problem.values)}</Banner>
            )}
            <Select
              name="typeCode"
              label={t('create.type')}
              help={t('create.type-help')}
              value={typeCode}
              placeholder={t('create.choose')}
              error={missing && typeCode === '' ? t('create.type-required') : undefined}
              options={phase.options.productTypes.map((code) => ({
                value: code,
                label: readable(code),
              }))}
              onChange={(event) => {
                setTypeCode(event.target.value);
                setMissing(false);
              }}
            />
            <div className="flex items-center gap-3">
              <Button type="submit" loading={pending}>
                {t('create.submit')}
              </Button>
              <a className="font-medium text-link underline" href="/catalog/products">
                {t('create.cancel')}
              </a>
            </div>
          </form>
        </Card>
      ) : null}
    </div>
  );
}
