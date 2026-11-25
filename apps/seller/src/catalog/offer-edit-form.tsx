'use client';

import {
  Banner,
  Card,
  SaveBar,
  Select,
  TextField,
  toast,
  useUnsavedChangesGuard,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { callApi } from '../api/client.ts';
import { readable } from './format.ts';
import { offerEditProblemOf } from './offer-edit-errors.ts';
import type { OfferView, ProductOptions } from './types.ts';

/** Empty locales are left out: the API takes only the texts the seller wrote. */
function descriptionOf(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values)
      .map(([locale, text]) => [locale, text.trim()] as const)
      .filter(([, text]) => text !== ''),
  );
}

/** The whole description to send: edited locales replace the old text, others are kept as they were. */
export function descriptionWith(
  stored: Readonly<Record<string, string>>,
  edited: Readonly<Record<string, string>>,
  locales: readonly string[],
): Record<string, string> {
  const kept = Object.fromEntries(Object.entries(stored).filter(([k]) => !locales.includes(k)));
  return { ...kept, ...descriptionOf(edited) };
}

/** How the goods are handled (`PUT catalog/seller/offers/:id/handling`), in the API's order. */
export const HANDLINGS = ['SEALED_ORIGINAL', 'REPACKED', 'PREPARED', 'FRESH'] as const;

interface OfferFields {
  readonly conditionCode: string;
  /** Empty while the offer has none recorded. */
  readonly handling: string;
  readonly sellerSku: string;
  readonly description: Readonly<Record<string, string>>;
}

function fieldsOf(offer: OfferView, locales: readonly string[]): OfferFields {
  return {
    conditionCode: offer.conditionCode,
    handling: offer.handling ?? '',
    sellerSku: offer.sellerSku,
    description: Object.fromEntries(
      locales.map((locale) => [locale, offer.description[locale] ?? '']),
    ),
  };
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
  const [saved, setSaved] = useState<OfferFields>(() => fieldsOf(offer, locales));
  const [conditionCode, setConditionCode] = useState(saved.conditionCode);
  const [handling, setHandling] = useState(saved.handling);
  const [sellerSku, setSellerSku] = useState(saved.sellerSku);
  const [description, setDescription] = useState<Record<string, string>>(saved.description);
  const [leaving, setLeaving] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<ReturnType<typeof offerEditProblemOf> | null>(null);
  const busy = useRef(false);
  const current: OfferFields = { conditionCode, handling, sellerSku, description };
  const dirty = JSON.stringify(current) !== JSON.stringify(saved);
  const guard = useUnsavedChangesGuard(
    dirty && !leaving,
    {
      title: t('settings.leave.title'),
      message: (info) => t('settings.leave.message', { count: info.count, page: info.page }),
      stay: t('settings.leave.stay'),
      leave: t('settings.leave.leave'),
    },
    { count: 1, page: t('catalog.offer-edit.title') },
  );

  function discard() {
    setConditionCode(saved.conditionCode);
    setHandling(saved.handling);
    setSellerSku(saved.sellerSku);
    setDescription(saved.description);
    setProblem(null);
  }

  function fieldError(path: string): string | undefined {
    const key = problem?.fields[path];
    return key === undefined ? undefined : t(key);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || !dirty) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    // The offer's own fields and its handling are two routes; only what changed is sent.
    let reached = saved;
    let attestationWithdrawn = false;
    const offerChanged =
      conditionCode !== saved.conditionCode ||
      sellerSku !== saved.sellerSku ||
      JSON.stringify(description) !== JSON.stringify(saved.description);
    let result: Awaited<ReturnType<typeof callApi>> = { ok: true, status: 200, body: null };
    if (offerChanged) {
      result = await callApi<{ changedFields: readonly string[] }>(
        'PUT',
        `catalog/seller/offers/${offer.offerId}`,
        {
          sellerSku,
          conditionCode,
          description: descriptionWith(offer.description, description, locales),
        },
        csrfToken,
      );
      if (result.ok) reached = { ...current, handling: saved.handling };
    }
    if (result.ok && handling !== saved.handling && handling !== '') {
      result = await callApi<{ changedFields: readonly string[] }>(
        'PUT',
        `catalog/seller/offers/${offer.offerId}/handling`,
        { handling },
        csrfToken,
      );
      if (result.ok) {
        reached = { ...reached, handling };
        // Away from Sealed original the recorded attestation goes with it: the seller is told.
        const body = result.body as { changedFields?: readonly string[] } | null;
        if (body?.changedFields?.includes('attestation') === true) attestationWithdrawn = true;
      }
    }
    busy.current = false;
    setPending(false);
    // What the server took is now the saved state: the bar hides when nothing else is left.
    setSaved(reached);
    if (result.ok) {
      toast.success(t('catalog.offer-edit.saved'));
      if (attestationWithdrawn) toast.info(t('catalog.offer-edit.attestation-withdrawn'));
    } else if (result.failure.status === 401) {
      flushSync(() => setLeaving(true));
      window.location.assign('/session-ended');
    } else setProblem(offerEditProblemOf(result.failure));
  }

  const conditions = options.conditions.includes(conditionCode)
    ? options.conditions
    : [conditionCode, ...options.conditions];
  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <Card>
        {problem === null ? null : <Banner tone="critical">{t(problem.form)}</Banner>}
        <Select
          name="conditionCode"
          label={t('catalog.create.condition')}
          value={conditionCode}
          error={fieldError('conditionCode')}
          options={conditions.map((code) => ({ value: code, label: readable(code) }))}
          onChange={(event) => setConditionCode(event.target.value)}
        />
        <Select
          name="handling"
          label={t('catalog.offer.handling')}
          help={t('catalog.offer-edit.handling-help')}
          value={handling}
          placeholder={t('catalog.offer-edit.handling-choose')}
          error={fieldError('handling')}
          options={HANDLINGS.map((code) => ({
            value: code,
            label: t(`catalog.offer.handling-value.${code}`),
          }))}
          onChange={(event) => setHandling(event.target.value)}
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
        <div>
          <a
            className="inline-flex items-center font-medium text-link underline"
            href={`/offers/${offer.offerId}`}
          >
            {t('catalog.offer-edit.back')}
          </a>
        </div>
      </Card>
      <SaveBar
        count={dirty ? 1 : 0}
        summary={t('settings.bar.summary', { count: 1 })}
        saving={pending}
        aboveBottomBar
        labels={{
          region: t('settings.bar.region'),
          discard: t('settings.bar.discard'),
          save: t('catalog.offer-edit.save'),
          // The page keeps its own verb while it saves; the button shows the spinner.
          saving: t('catalog.offer-edit.save'),
        }}
        onDiscard={discard}
      />
      {dirty ? guard.dialog : null}
    </form>
  );
}
