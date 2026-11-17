'use client';

import { Banner, Button, CheckboxRow, Dialog, Select, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import {
  addSizesProblemOf,
  KNOWN_ISSUES,
  type AddSizesDone,
  type AddSizesProblem,
} from './add-sizes.ts';
import { pickLabel } from './draft-content.ts';
import type { FormField } from './types.ts';
import { axisCandidates } from './variant-grid.ts';

const omit = (map: Record<string, string>, key: string): Record<string, string> =>
  Object.fromEntries(Object.entries(map).filter(([code]) => code !== key));

/**
 * "Add sizes" (variants V9d, catalog design 4.2a): turns a Simple product into a product with
 * sizes, once and never back. The seller picks one or two types it varies on and which value the
 * product it already is has for each. A waiting revision is set aside only when the seller says so.
 */
export function AddSizesDialog({
  open,
  productId,
  version,
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
  /** The product version the page read; null when the read did not carry one. */
  readonly version: number | null;
  readonly fields: readonly FormField[];
  readonly maxAxes: number;
  /** A revision waits for review: Add sizes sets it aside. */
  readonly waiting: boolean;
  readonly defaultLocale: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
  /** The product changed somewhere else: the page reads it again. */
  readonly onStale: () => void;
}) {
  const t = useTranslations('catalog.addSizes');
  const candidates = axisCandidates(fields);
  const [axes, setAxes] = useState<string[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [agreed, setAgreed] = useState(false);
  // The server found a revision the page did not know about: the same warning is then shown.
  const [lateWaiting, setLateWaiting] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<AddSizesProblem | null>(null);
  const busy = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const noteId = useId();

  const mustAgree = waiting || lateWaiting;
  const nameOf = (field: FormField) => pickLabel(field.names, defaultLocale, field.code);
  const ready =
    version !== null &&
    axes.length >= 1 &&
    axes.every((axis) => (values[axis] ?? '') !== '') &&
    (!mustAgree || agreed);

  // Why the confirm button is off, when the dialog does not already say so with a banner.
  const note =
    pending || version === null
      ? undefined
      : axes.length === 0
        ? t('note-types')
        : axes.some((axis) => (values[axis] ?? '') === '')
          ? t('note-values')
          : mustAgree && !agreed
            ? t('note-agree')
            : undefined;

  function toggle(code: string, on: boolean) {
    setAxes(
      candidates
        .map((field) => field.code)
        .filter((item) => (item === code ? on : axes.includes(item))),
    );
    if (!on) setValues((current) => omit(current, code));
  }

  async function confirm() {
    if (busy.current || !ready || version === null) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<AddSizesDone>(
      'POST',
      `catalog/seller/products/${productId}/add-sizes`,
      {
        version,
        axes,
        optionValues: Object.fromEntries(axes.map((axis) => [axis, values[axis] ?? ''])),
        replacePending: mustAgree && agreed,
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
    if (failed.pendingExists) {
      setLateWaiting(true);
      setAgreed(false);
    }
    setProblem(failed);
  }

  return (
    <Dialog
      open={open}
      title={t('title')}
      onClose={onClose}
      initialFocus={cancel}
      {...(note === undefined ? {} : { actionsNote: <span id={noteId}>{note}</span> })}
      actions={
        <>
          <Button ref={cancel} variant="secondary" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            loading={pending}
            disabled={!ready || pending}
            aria-describedby={note === undefined ? undefined : noteId}
            onClick={() => void confirm()}
          >
            {t('confirm')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p>{t('intro')}</p>
        <Banner tone="attention">{t('permanent')}</Banner>
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
        {version === null ? <Banner tone="critical">{t('error.stale')}</Banner> : null}
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
                  label={t('value-of', { type: nameOf(field).toLocaleLowerCase(defaultLocale) })}
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
