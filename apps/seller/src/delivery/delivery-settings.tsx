'use client';

import { Banner, Button, Card, Select } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { isStepUpCancelled, useGuardedCall } from '../step-up/step-up.tsx';
import { problemOf, type DeliveryProblem } from './errors.ts';
import {
  CLOCK_TIMES,
  CLOSE_TIMES,
  DELIVERY_DAYS,
  problemsOf,
  type DeliveryDay,
  type DeliverySettingsView,
  type DeliveryTerms,
} from './types.ts';

const EMPTY: DeliveryTerms = { day: 'next-day', from: '08:00', to: '12:00', cutoff: '14:00' };

export function DeliverySettings({
  initial,
  csrfToken,
  canEdit,
}: {
  readonly initial: DeliverySettingsView;
  readonly csrfToken: string;
  readonly canEdit: boolean;
}) {
  const t = useTranslations();
  const guarded = useGuardedCall();
  const [view, setView] = useState(initial);
  const [terms, setTerms] = useState<DeliveryTerms>(initial.delivery ?? EMPTY);
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState<'saved' | 'cleared' | null>(null);
  const [problem, setProblem] = useState<DeliveryProblem | null>(null);
  const busy = useRef(false);

  const fieldError = (path: string): string | undefined => {
    const key = problem?.fields[path];
    return key === undefined ? undefined : t(key);
  };

  /** One write at a time; the answer is the new view, which replaces the screen's copy. */
  async function write(delivery: DeliveryTerms | null) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    setSaved(null);
    const result = await guarded<DeliverySettingsView>(
      'PUT',
      'sellers/store-settings/delivery',
      { expectedVersion: view.version, delivery },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (isStepUpCancelled(result)) return;
    if (result.ok) {
      setView(result.body);
      setTerms(result.body.delivery ?? EMPTY);
      setSaved(delivery === null ? 'cleared' : 'saved');
      return;
    }
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(problemOf(result.failure));
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const found = problemsOf(terms);
    if (Object.keys(found).length > 0) {
      setSaved(null);
      setProblem({ form: 'delivery.validation.summary', fields: found });
      return;
    }
    void write(terms);
  }

  const set = (patch: Partial<DeliveryTerms>) => {
    setTerms({ ...terms, ...patch });
    setSaved(null);
  };
  const times = (list: readonly string[]) => list.map((value) => ({ value, label: value }));
  const sameDay = terms.day === 'same-day';

  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('delivery.intro')}</p>
      {saved === null ? null : <Banner tone="success">{t(`delivery.saved-${saved}`)}</Banner>}
      {problem === null ? null : (
        <Banner tone="critical">
          {t(problem.form)}
          {problem.form === 'delivery.error.stale' ? (
            <>
              {' '}
              <Button variant="link" onClick={() => window.location.reload()}>
                {t('delivery.reload')}
              </Button>
            </>
          ) : null}
        </Banner>
      )}
      {view.delivery === null ? <Banner tone="info">{t('delivery.none')}</Banner> : null}
      <Card title={t('delivery.card-title')}>
        <form
          className="flex max-w-(--mp-size-form-max) flex-col gap-4"
          onSubmit={submit}
          noValidate
        >
          <Select
            name="day"
            label={t('delivery.day')}
            value={terms.day}
            disabled={!canEdit || pending}
            error={fieldError('delivery.day')}
            options={DELIVERY_DAYS.map((value) => ({ value, label: t(`delivery.day-${value}`) }))}
            onChange={(event) => set({ day: event.target.value as DeliveryDay })}
          />
          <fieldset className="flex flex-col gap-4">
            <legend className="mb-1 text-sm font-medium text-fg">{t('delivery.window')}</legend>
            <Select
              name="from"
              label={t('delivery.from')}
              value={terms.from}
              disabled={!canEdit || pending}
              error={fieldError('delivery.from')}
              options={times(CLOCK_TIMES)}
              onChange={(event) => set({ from: event.target.value })}
            />
            <Select
              name="to"
              label={t('delivery.to')}
              value={terms.to}
              disabled={!canEdit || pending}
              error={fieldError('delivery.to')}
              options={times(CLOSE_TIMES)}
              onChange={(event) => set({ to: event.target.value })}
            />
          </fieldset>
          <Select
            name="cutoff"
            label={t('delivery.cutoff')}
            help={t(sameDay ? 'delivery.cutoff-help-same-day' : 'delivery.cutoff-help-next-day')}
            value={terms.cutoff}
            disabled={!canEdit || pending}
            error={fieldError('delivery.cutoff')}
            options={times(CLOCK_TIMES)}
            onChange={(event) => set({ cutoff: event.target.value })}
          />
          <p className="text-sm text-fg-muted">{t('delivery.zone-note')}</p>
          {canEdit ? (
            <div className="flex gap-3">
              <Button type="submit" loading={pending}>
                {t('delivery.save')}
              </Button>
              {view.delivery === null ? null : (
                <Button variant="secondary" onClick={() => void write(null)} disabled={pending}>
                  {t('delivery.clear')}
                </Button>
              )}
            </div>
          ) : null}
        </form>
      </Card>
    </div>
  );
}
