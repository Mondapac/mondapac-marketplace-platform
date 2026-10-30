'use client';

import {
  Banner,
  Button,
  Dialog,
  SaveBar,
  SettingCheckbox,
  SettingInput,
  SettingRow,
  SettingSelect,
  SettingsConflictBanner,
  SettingsErrorSummary,
  SettingsPage,
  SettingsSection,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { useSettingsChrome } from '../settings/settings-chrome.ts';
import { deliveryProblemOf } from './errors.ts';
import {
  checkForm,
  EXAMPLE_QUOTE_MINOR,
  formOf,
  impactOf,
  marginOf,
  moneyOf,
  priceOf,
  type Checked,
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
/** The row (and so the control) of each field the check can flag, for the error summary links. */
const ROW: Readonly<Record<FormField, string>> = {
  cutoff: 'setting-delivery-cutoff',
  daysAhead: 'setting-delivery-days-ahead',
  marginValue: 'setting-delivery-margin-value',
};
type Body = Extract<Checked, { ok: true }>['body'];

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
  const chrome = useSettingsChrome();
  const [settings, setSettings] = useState(initial);
  const [form, setForm] = useState<SettingsForm>(() => formOf(initial));
  const [invalid, setInvalid] = useState<readonly FormField[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<'reloaded' | null>(null);
  const [pending, setPending] = useState(false);
  const [failedSaves, setFailedSaves] = useState(0);
  const [confirm, setConfirm] = useState<Body | null>(null);
  const busy = useRef(false);
  const { currency } = settings;
  const money = (minor: number) => moneyOf(minor, currency, locale);
  const readOnly = !canManage;

  const baseline = formOf(settings);
  const methodChanged = (method: Method) => form.enabled[method] !== baseline.enabled[method];
  const changed = {
    cutoff: form.cutoff !== baseline.cutoff,
    daysAhead: form.daysAhead !== baseline.daysAhead,
    windowMinutes: form.windowMinutes !== baseline.windowMinutes,
    marginKind: form.marginKind !== baseline.marginKind,
    marginValue: form.marginKind !== 'none' && form.marginValue !== baseline.marginValue,
    roundingStep: form.roundingStep !== baseline.roundingStep,
  };
  const count =
    METHODS.filter(methodChanged).length + Object.values(changed).filter(Boolean).length;
  const dirty = canManage && count > 0;

  const edit = (patch: Partial<SettingsForm>, field?: FormField) => {
    setForm((current) => ({ ...current, ...patch }));
    // Editing a field takes its error away; the next save checks it again.
    if (field !== undefined) setInvalid((current) => current.filter((name) => name !== field));
  };
  const errorOf = (field: FormField) =>
    invalid.includes(field) ? t(`${P}.invalid.${field}`) : undefined;

  function adopt(next: DeliverySettings) {
    setSettings(next);
    setForm(formOf(next));
  }

  function discard() {
    setForm(formOf(settings));
    setInvalid([]);
    setProblem(null);
    setNotice(null);
  }

  function submit() {
    if (busy.current || readOnly) return;
    setNotice(null);
    setProblem(null);
    const checked = checkForm(form, currency);
    if (!checked.ok) {
      setInvalid(checked.invalid);
      setFailedSaves((n) => n + 1);
      return;
    }
    setInvalid([]);
    // A save that changes nothing needs no confirmation; any change is listed first.
    if (impactOf(settings, checked.body, show).length === 0) void save(checked.body);
    else setConfirm(checked.body);
  }

  async function save(body: Body) {
    busy.current = true;
    setPending(true);
    const result = await callApi<DeliverySettings>(
      'PUT',
      DELIVERY_SETTINGS_PATH,
      { ...body, expectedVersion: settings.version },
      csrfToken,
    );
    if (result.ok) {
      adopt(result.body);
      toast.success(t(`${P}.notice.saved`));
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

  const show = { method: (m: Method) => t(`${P}.method.${m}`), money };
  const impacts = confirm === null ? [] : impactOf(settings, confirm, show);
  const margin = marginOf(form, currency);
  const step = Number(form.roundingStep);
  const example = margin === null ? null : priceOf(EXAMPLE_QUOTE_MINOR, margin, step);
  const marginLabel =
    form.marginKind === 'percent' ? t(`${P}.margin.percent`) : t(`${P}.margin.fixed`, { currency });

  const summaryLabel = (field: FormField) =>
    field === 'cutoff'
      ? t(`${P}.cutoff.field`)
      : field === 'daysAhead'
        ? t(`${P}.scheduled.days`)
        : marginLabel;
  const banners = [
    readOnly ? (
      <Banner key="viewer-only" tone="info">
        {t(`${P}.viewer-only`)}
      </Banner>
    ) : null,
    invalid.length === 0 ? null : (
      <SettingsErrorSummary
        key="invalid"
        title={t('settings.errors.title', { count: invalid.length })}
        items={invalid.map((field) => ({ id: ROW[field], label: summaryLabel(field) }))}
        focusSignal={failedSaves}
      />
    ),
    notice === null ? null : (
      <SettingsConflictBanner
        key="conflict"
        title={t(`${P}.conflict.title`)}
        body={t(`${P}.notice.${notice}`)}
      />
    ),
    problem === null ? null : (
      <Banner key="problem" tone="critical">
        {t(`${P}.error.${problem}`)}
      </Banner>
    ),
    settings.version === 0 ? (
      <Banner key="defaults" tone="info">
        {t(`${P}.defaults`)}
      </Banner>
    ) : null,
  ].filter((node) => node !== null);

  return (
    <SettingsPage
      title={t(`${P}.title`)}
      description={t(`${P}.intro`)}
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
      onSubmit={canManage ? submit : undefined}
      dirty={dirty}
      leave={chrome.leave}
      saveBar={
        canManage ? (
          <SaveBar
            {...chrome.saveBar({
              count,
              errorCount: invalid.length,
              saving: pending,
              onDiscard: discard,
            })}
          />
        ) : null
      }
    >
      <SettingsSection title={t(`${P}.methods.title`)} description={t(`${P}.methods.intro`)}>
        {METHODS.map((method: Method) => (
          <SettingRow
            key={method}
            label={t(`${P}.method.${method}`)}
            help={t(`${P}.method-help.${method}`)}
            changed={methodChanged(method)}
            disabled={readOnly}
          >
            <SettingCheckbox
              name={`enabled-${method}`}
              text={form.enabled[method] ? t(`${P}.state.on`) : t(`${P}.state.off`)}
              checked={form.enabled[method]}
              onChange={(event) =>
                edit({ enabled: { ...form.enabled, [method]: event.target.checked } })
              }
            />
          </SettingRow>
        ))}
      </SettingsSection>

      <SettingsSection
        title={t(`${P}.cutoff.title`)}
        description={t(`${P}.cutoff.intro`, { zone: settings.marketZone })}
      >
        <SettingRow
          id={ROW.cutoff}
          label={t(`${P}.cutoff.field`)}
          help={t(`${P}.cutoff.help`)}
          changed={changed.cutoff}
          disabled={readOnly}
          error={errorOf('cutoff')}
        >
          <SettingInput
            name="cutoff"
            type="time"
            className="md:max-w-48"
            value={form.cutoff}
            onChange={(event) => edit({ cutoff: event.target.value }, 'cutoff')}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t(`${P}.scheduled.title`)} description={t(`${P}.scheduled.intro`)}>
        <SettingRow
          id={ROW.daysAhead}
          label={t(`${P}.scheduled.days`)}
          help={t(`${P}.scheduled.days-help`, { min: MIN_DAYS, max: MAX_DAYS })}
          changed={changed.daysAhead}
          disabled={readOnly}
          error={errorOf('daysAhead')}
        >
          <SettingInput
            name="days-ahead"
            inputMode="numeric"
            autoComplete="off"
            className="md:max-w-40"
            value={form.daysAhead}
            onChange={(event) => edit({ daysAhead: event.target.value }, 'daysAhead')}
          />
        </SettingRow>
        <SettingRow
          label={t(`${P}.scheduled.window`)}
          help={t(`${P}.scheduled.window-help`)}
          changed={changed.windowMinutes}
          disabled={readOnly}
        >
          <SettingSelect
            name="window-minutes"
            options={windowOptions(settings.scheduledWindowMinutes, form.windowMinutes).map(
              (minutes) => ({ value: String(minutes), label: t(`${P}.duration`, { minutes }) }),
            )}
            value={form.windowMinutes}
            onChange={(event) => edit({ windowMinutes: event.target.value })}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t(`${P}.margin.title`)} description={t(`${P}.margin.intro`)}>
        <SettingRow label={t(`${P}.margin.kind`)} changed={changed.marginKind} disabled={readOnly}>
          <SettingSelect
            name="margin-kind"
            options={KINDS.map((kind) => ({ value: kind, label: t(`${P}.margin.kinds.${kind}`) }))}
            value={form.marginKind}
            onChange={(event) => {
              edit(
                { marginKind: event.target.value as MarginKind, marginValue: '' },
                'marginValue',
              );
            }}
          />
        </SettingRow>
        {form.marginKind === 'none' ? null : (
          <SettingRow
            id={ROW.marginValue}
            label={marginLabel}
            help={
              form.marginKind === 'percent'
                ? t(`${P}.margin.percent-help`)
                : t(`${P}.margin.fixed-help`, { max: money(1_000_000) })
            }
            changed={changed.marginValue}
            disabled={readOnly}
            error={
              invalid.includes('marginValue')
                ? t(`${P}.invalid.margin-${form.marginKind}`, { max: money(1_000_000) })
                : undefined
            }
          >
            <SettingInput
              name="margin-value"
              inputMode="decimal"
              autoComplete="off"
              className="md:max-w-40"
              value={form.marginValue}
              onChange={(event) => edit({ marginValue: event.target.value }, 'marginValue')}
            />
          </SettingRow>
        )}
        <SettingRow
          label={t(`${P}.margin.rounding`)}
          help={t(`${P}.margin.rounding-help`)}
          changed={changed.roundingStep}
          disabled={readOnly}
        >
          <SettingSelect
            name="rounding"
            options={settings.roundingSteps.map((value) => ({
              value: String(value),
              label:
                value === 1
                  ? t(`${P}.margin.round-none`)
                  : t(`${P}.margin.round-up`, { step: money(value) }),
            }))}
            value={form.roundingStep}
            onChange={(event) => edit({ roundingStep: event.target.value })}
          />
        </SettingRow>
        <div className="px-5 py-4">
          <Banner tone="info" title={t(`${P}.example.title`)}>
            {example === null ? (
              <p>{t(`${P}.example.unavailable`)}</p>
            ) : (
              <p data-testid="margin-example">
                {t(example.margin === 0 ? `${P}.example.line-none` : `${P}.example.line`, {
                  quote: money(example.quote),
                  total: money(example.total),
                  margin: money(example.margin),
                })}
              </p>
            )}
          </Banner>
        </div>
      </SettingsSection>

      <Dialog
        open={confirm !== null}
        title={t(`${P}.confirm.title`)}
        onClose={() => setConfirm(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t(`${P}.confirm.cancel`)}
            </Button>
            <Button
              onClick={() => {
                const body = confirm;
                setConfirm(null);
                if (body !== null) void save(body);
              }}
            >
              {t(`${P}.confirm.go`)}
            </Button>
          </>
        }
      >
        <p className="mb-3">{t(`${P}.confirm.intro`)}</p>
        <ul className="flex flex-col gap-3">
          {impacts.map((impact) => (
            <li key={impact.key + String(impact.values.method ?? '')}>
              <p>{t(`${P}.confirm.line.${impact.key}`, impact.values)}</p>
              <p className="text-sm text-fg-muted">
                <span className="font-medium">{t(`${P}.confirm.sellers`)}: </span>
                {t(`${P}.confirm.seller.${impact.key}`, impact.values)}
              </p>
            </li>
          ))}
        </ul>
      </Dialog>
    </SettingsPage>
  );
}

/** The window lengths on offer; a stored length the list lacks stays selectable. */
function windowOptions(stored: number, current: string): number[] {
  const all = new Set<number>([...WINDOW_CHOICES, stored]);
  if (/^\d+$/.test(current)) all.add(Number(current));
  return [...all].sort((a, b) => a - b);
}
