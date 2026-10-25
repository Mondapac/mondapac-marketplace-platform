'use client';

import { ActionRow, Banner, Button, Card, CheckboxRow, Select, TextField } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { formatMinor } from '../shipping/money.ts';
import { deliveryProblemOf } from './errors.ts';
import {
  checkForm,
  EXAMPLE_QUOTE_MINOR,
  formOf,
  marginOf,
  priceOf,
  type FormField,
  type SettingsForm,
} from './form.ts';
import {
  DELIVERY_SETTINGS_PATH,
  MAX_DAYS,
  METHODS,
  MIN_DAYS,
  WINDOW_CHOICES,
  type DeliverySettings,
  type MarginKind,
  type Method,
} from './types.ts';

const P = 'deliverySettings';
const KINDS: readonly MarginKind[] = ['none', 'percent', 'fixed'];

export function DeliverySettingsPanel({
  initial,
  canManage,
  csrfToken,
}: {
  readonly initial: DeliverySettings;
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [settings, setSettings] = useState(initial);
  const [form, setForm] = useState<SettingsForm>(() => formOf(initial));
  const [invalid, setInvalid] = useState<readonly FormField[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<'saved' | 'reloaded' | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const { currency } = settings;
  const money = (minor: number) => formatMinor(String(minor), currency, locale);
  const errorOf = (field: FormField) =>
    invalid.includes(field) ? t(`${P}.invalid.${field}`) : undefined;
  const edit = (patch: Partial<SettingsForm>) => setForm((current) => ({ ...current, ...patch }));
  const readOnly = !canManage;

  function adopt(next: DeliverySettings) {
    setSettings(next);
    setForm(formOf(next));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current || readOnly) return;
    setNotice(null);
    setProblem(null);
    const checked = checkForm(form, currency);
    if (!checked.ok) {
      setInvalid(checked.invalid);
      return;
    }
    setInvalid([]);
    busy.current = true;
    setPending(true);
    const result = await callApi<DeliverySettings>(
      'PUT',
      DELIVERY_SETTINGS_PATH,
      { ...checked.body, expectedVersion: settings.version },
      csrfToken,
    );
    if (result.ok) {
      adopt(result.body);
      setNotice('saved');
    } else if (result.failure.status === 401) {
      window.location.assign('/session-ended');
    } else {
      const key = deliveryProblemOf(result.failure);
      if (key === 'conflict') {
        // Someone saved first: show what is stored now, so the admin decides again on that.
        const fresh = await callApi<DeliverySettings>('GET', DELIVERY_SETTINGS_PATH);
        if (fresh.ok) {
          adopt(fresh.body);
          setNotice('reloaded');
        } else setProblem(key);
      } else setProblem(key);
    }
    busy.current = false;
    setPending(false);
  }

  const margin = marginOf(form, currency);
  const step = Number(form.roundingStep);
  const example = margin === null ? null : priceOf(EXAMPLE_QUOTE_MINOR, margin, step);

  return (
    <form className="flex flex-col gap-6" onSubmit={(e) => void submit(e)} noValidate>
      {notice === null ? null : <Banner tone="success">{t(`${P}.notice.${notice}`)}</Banner>}
      {problem === null ? null : <Banner tone="critical">{t(`${P}.error.${problem}`)}</Banner>}
      {settings.version === 0 ? <Banner tone="info">{t(`${P}.defaults`)}</Banner> : null}

      <Card title={t(`${P}.methods.title`)}>
        <p className="text-sm text-fg-muted">{t(`${P}.methods.intro`)}</p>
        <div className="flex flex-col gap-3">
          {METHODS.map((method: Method) => (
            <CheckboxRow
              key={method}
              name={`enabled-${method}`}
              label={t(`${P}.method.${method}`)}
              help={t(`${P}.method-help.${method}`)}
              checked={form.enabled[method]}
              disabled={readOnly}
              onChange={(event) =>
                edit({ enabled: { ...form.enabled, [method]: event.target.checked } })
              }
            />
          ))}
        </div>
      </Card>

      <Card title={t(`${P}.cutoff.title`)}>
        <p className="text-sm text-fg-muted">
          {t(`${P}.cutoff.intro`, { zone: settings.marketZone })}
        </p>
        <div className="max-w-xs">
          <TextField
            name="cutoff"
            type="time"
            label={t(`${P}.cutoff.field`)}
            help={t(`${P}.cutoff.help`)}
            value={form.cutoff}
            disabled={readOnly}
            error={errorOf('cutoff')}
            onChange={(event) => edit({ cutoff: event.target.value })}
          />
        </div>
      </Card>

      <Card title={t(`${P}.scheduled.title`)}>
        <p className="text-sm text-fg-muted">{t(`${P}.scheduled.intro`)}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            name="days-ahead"
            label={t(`${P}.scheduled.days`)}
            help={t(`${P}.scheduled.days-help`, { min: MIN_DAYS, max: MAX_DAYS })}
            inputMode="numeric"
            autoComplete="off"
            value={form.daysAhead}
            disabled={readOnly}
            error={errorOf('daysAhead')}
            onChange={(event) => edit({ daysAhead: event.target.value })}
          />
          <Select
            name="window-minutes"
            label={t(`${P}.scheduled.window`)}
            help={t(`${P}.scheduled.window-help`)}
            options={windowOptions(settings.scheduledWindowMinutes, form.windowMinutes).map(
              (minutes) => ({ value: String(minutes), label: t(`${P}.duration`, { minutes }) }),
            )}
            value={form.windowMinutes}
            disabled={readOnly}
            onChange={(event) => edit({ windowMinutes: event.target.value })}
          />
        </div>
      </Card>

      <Card title={t(`${P}.margin.title`)}>
        <p className="text-sm text-fg-muted">{t(`${P}.margin.intro`)}</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Select
            name="margin-kind"
            label={t(`${P}.margin.kind`)}
            options={KINDS.map((kind) => ({ value: kind, label: t(`${P}.margin.kinds.${kind}`) }))}
            value={form.marginKind}
            disabled={readOnly}
            onChange={(event) =>
              edit({ marginKind: event.target.value as MarginKind, marginValue: '' })
            }
          />
          {form.marginKind === 'none' ? null : (
            <TextField
              name="margin-value"
              label={
                form.marginKind === 'percent'
                  ? t(`${P}.margin.percent`)
                  : t(`${P}.margin.fixed`, { currency })
              }
              help={
                form.marginKind === 'percent'
                  ? t(`${P}.margin.percent-help`)
                  : t(`${P}.margin.fixed-help`, { max: money(1_000_000) })
              }
              inputMode="decimal"
              autoComplete="off"
              value={form.marginValue}
              disabled={readOnly}
              error={
                invalid.includes('marginValue')
                  ? t(`${P}.invalid.margin-${form.marginKind}`, { max: money(1_000_000) })
                  : undefined
              }
              onChange={(event) => edit({ marginValue: event.target.value })}
            />
          )}
          <Select
            name="rounding"
            label={t(`${P}.margin.rounding`)}
            help={t(`${P}.margin.rounding-help`)}
            options={settings.roundingSteps.map((value) => ({
              value: String(value),
              label:
                value === 1
                  ? t(`${P}.margin.round-none`)
                  : t(`${P}.margin.round-up`, { step: money(value) }),
            }))}
            value={form.roundingStep}
            disabled={readOnly}
            onChange={(event) => edit({ roundingStep: event.target.value })}
          />
        </div>
        <div className="rounded-md border border-line bg-subtle p-4" aria-live="polite">
          <h3 className="text-sm font-medium text-fg-muted">{t(`${P}.example.title`)}</h3>
          {example === null ? (
            <p className="mt-1">{t(`${P}.example.unavailable`)}</p>
          ) : (
            <p className="mt-1" data-testid="margin-example">
              {t(`${P}.example.line`, {
                quote: money(example.quote),
                total: money(example.total),
                margin: money(example.margin),
              })}
            </p>
          )}
        </div>
      </Card>

      {canManage ? (
        <ActionRow>
          <Button type="submit" loading={pending}>
            {t(`${P}.save`)}
          </Button>
        </ActionRow>
      ) : (
        <p className="text-sm text-fg-muted">{t(`${P}.read-only`)}</p>
      )}
    </form>
  );
}

/** The window lengths on offer; a stored length the list lacks stays selectable. */
function windowOptions(stored: number, current: string): number[] {
  const all = new Set<number>([...WINDOW_CHOICES, stored]);
  if (/^\d+$/.test(current)) all.add(Number(current));
  return [...all].sort((a, b) => a - b);
}
