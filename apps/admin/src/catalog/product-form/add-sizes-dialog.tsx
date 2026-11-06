'use client';

import { Banner, Button, CheckboxRow, Dialog, Select, SkeletonRows, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import {
  addSizesProblemOf,
  axisCandidates,
  currentCountOf,
  KNOWN_ISSUES,
  type AddSizesDone,
  type AddSizesImpact,
  type AddSizesProblem,
} from './add-sizes.ts';
import { pickLabel } from './draft-content.ts';
import { BASE, type FormField } from './types.ts';

type Impact =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly version: number; readonly count: number };

const omit = (map: Record<string, string>, key: string): Record<string, string> =>
  Object.fromEntries(Object.entries(map).filter(([code]) => code !== key));

/**
 * "Add sizes" for a platform product (variants V9d, catalog design 4.2a). Opening the dialog reads
 * how many offers of other sellers would go off sale (those sellers can't sell products with
 * sizes); the admin confirms that number. If it changed meanwhile the new number is shown and the
 * admin confirms again.
 */
export function AddSizesDialog({
  open,
  productId,
  fields,
  maxAxes,
  waiting,
  defaultLocale,
  csrfToken,
  onClose,
  onDone,
  onStale,
}: {
  readonly open: boolean;
  readonly productId: string;
  readonly fields: readonly FormField[];
  readonly maxAxes: number;
  /** A revision waits for review: Add sizes sets it aside. */
  readonly waiting: boolean;
  readonly defaultLocale: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onStale: () => void;
}) {
  const t = useTranslations('catalog.productForm.addSizes');
  const candidates = axisCandidates(fields);
  const [impact, setImpact] = useState<Impact>({ kind: 'loading' });
  const [axes, setAxes] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [agreed, setAgreed] = useState(false);
  const [lateWaiting, setLateWaiting] = useState(false);
  // The count changed since the admin saw it: the new one must be confirmed again.
  const [changedFrom, setChangedFrom] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<AddSizesProblem | null>(null);
  const busy = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    setImpact({ kind: 'loading' });
    void callApi<AddSizesImpact>('GET', `${BASE}/${productId}/add-sizes-impact`).then((result) => {
      if (!current) return;
      if (result.ok) {
        setImpact({
          kind: 'ready',
          version: result.body.version,
          count: result.body.offOfferCount,
        });
      } else if (result.failure.status === 401) window.location.assign('/session-ended');
      else {
        setImpact({ kind: 'failed' });
        setProblem(addSizesProblemOf(result.failure));
      }
    });
    return () => {
      current = false;
    };
  }, [open, productId]);

  const mustAgree = waiting || lateWaiting;
  const nameOf = (field: FormField) => pickLabel(field.names, defaultLocale, field.code);
  const ready =
    impact.kind === 'ready' &&
    axes.length >= 1 &&
    axes.every((axis) => (values[axis] ?? '') !== '') &&
    (!mustAgree || agreed);

  function toggle(code: string, on: boolean) {
    setAxes(
      candidates
        .map((field) => field.code)
        .filter((item) => (item === code ? on : axes.includes(item))),
    );
    if (!on) setValues((current) => omit(current, code));
  }

  async function confirm() {
    if (busy.current || !ready || impact.kind !== 'ready') return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<AddSizesDone>(
      'POST',
      `${BASE}/${productId}/add-sizes`,
      {
        version: impact.version,
        axes,
        optionValues: Object.fromEntries(axes.map((axis) => [axis, values[axis] ?? ''])),
        replacePending: mustAgree && agreed,
        offOfferCount: impact.count,
      },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t('done'));
      onDone();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const failed = addSizesProblemOf(result.failure);
    const now = currentCountOf(result.failure);
    if (failed.name === 'count-changed' && now !== null) {
      // Show the new number and ask again; nothing is sent until the admin confirms it.
      setChangedFrom(impact.count);
      setImpact({ ...impact, count: now });
    } else if (failed.pendingExists) {
      setLateWaiting(true);
      setAgreed(false);
    }
    setProblem(failed);
  }

  const count = impact.kind === 'ready' ? impact.count : 0;

  return (
    <Dialog
      open={open}
      title={t('title')}
      onClose={onClose}
      initialFocus={cancel}
      actions={
        <>
          <Button ref={cancel} variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button loading={pending} disabled={!ready || pending} onClick={() => void confirm()}>
            {t(changedFrom === null ? 'confirm' : 'confirm-again')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p>{t('intro')}</p>
        <Banner tone="attention">{t('permanent')}</Banner>
        {impact.kind === 'loading' ? <SkeletonRows label={t('loading')} rows={1} /> : null}
        {impact.kind === 'failed' ? <Banner tone="critical">{t('impact-failed')}</Banner> : null}
        {impact.kind === 'ready' && count > 0 ? (
          <Banner tone="attention">
            <p>{t('off-sale', { count })}</p>
            {changedFrom !== null ? (
              <p className="mt-1 font-medium">
                {t('count-changed', { before: changedFrom, count })}
              </p>
            ) : null}
          </Banner>
        ) : null}
        {impact.kind === 'ready' && count === 0 ? (
          <p className="text-sm text-fg-muted">{t('off-sale-none')}</p>
        ) : null}
        {mustAgree ? (
          <Banner tone="attention">
            <p>{t('waiting')}</p>
            <CheckboxRow
              name="replacePending"
              label={t('waiting-agree')}
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
            />
          </Banner>
        ) : null}
        <section className="flex flex-col gap-2">
          <h3 className="font-medium">{t('step-types')}</h3>
          <p className="text-sm text-fg-muted">{t('types-help', { max: maxAxes })}</p>
          {candidates.map((field) => (
            <CheckboxRow
              key={field.code}
              name={`axis.${field.code}`}
              label={nameOf(field)}
              checked={axes.includes(field.code)}
              disabled={!axes.includes(field.code) && axes.length >= maxAxes}
              onChange={(event) => toggle(field.code, event.target.checked)}
            />
          ))}
        </section>
        {axes.length === 0 ? null : (
          <section className="flex flex-col gap-3">
            <h3 className="font-medium">{t('step-values')}</h3>
            <p className="text-sm text-fg-muted">{t('values-help')}</p>
            {axes.map((axis) => {
              const field = candidates.find((item) => item.code === axis);
              if (field === undefined) return null;
              return (
                <Select
                  key={axis}
                  name={`value.${axis}`}
                  label={t('value-of', { type: nameOf(field) })}
                  placeholder={t('choose')}
                  options={field.options.map((option) => ({
                    value: option.code,
                    label: pickLabel(option.labels, defaultLocale, option.code),
                  }))}
                  value={values[axis] ?? ''}
                  onChange={(event) => setValues({ ...values, [axis]: event.target.value })}
                />
              );
            })}
          </section>
        )}
        {problem === null ? null : (
          <Banner tone="critical">
            <p>{t(`error.${problem.name}`, problem.values)}</p>
            {problem.issues.length > 0 ? (
              <ul className="mt-1 list-disc ps-5 text-sm">
                {problem.issues.map((issue) => (
                  <li key={`${issue.path}:${issue.code}`}>
                    {KNOWN_ISSUES.has(issue.code)
                      ? t(`issue.${issue.code}`)
                      : `${issue.path}: ${issue.code}`}
                  </li>
                ))}
              </ul>
            ) : null}
            {problem.reload ? (
              <Button variant="link" onClick={onStale}>
                {t('reload')}
              </Button>
            ) : null}
          </Banner>
        )}
      </div>
    </Dialog>
  );
}
