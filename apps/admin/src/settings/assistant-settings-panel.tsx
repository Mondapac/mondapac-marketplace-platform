'use client';

import {
  Badge,
  Banner,
  Button,
  Card,
  CheckboxRow,
  DataList,
  FormActionBar,
  Select,
  TextField,
  type DataListRow,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import {
  BOUNDS,
  assistantProblemOf,
  formOf,
  refusedFields,
  settingsOf,
  type AssistantForm,
  type FieldKey,
} from './assistant-form.ts';
import {
  ASSISTANT_SETTINGS_PATH,
  AUDIENCES,
  MODEL_TIERS,
  REPLY_LANGUAGES,
  RETENTIONS,
  SCOPES,
  SUPPORT_HANDOFFS,
  USER_GROUPS,
  type AssistantSettings,
  type AssistantSettingsAnswer,
} from './assistant-types.ts';

const P = 'settings.assistant';

type Notice = 'saved' | 'reloaded' | null;

/** The model the server configures for a tier, or null. */
function modelOf(answer: AssistantSettingsAnswer, tier: string): string | null {
  return answer.models.find((model) => model.tier === tier)?.modelId ?? null;
}

/** On, with a key and a model for its tier: the only state in which buyers can be served. */
function configured(answer: AssistantSettingsAnswer): boolean {
  return answer.apiKey === 'set' && modelOf(answer, answer.settings.modelTier) !== null;
}

export function AssistantSettingsPanel({
  initial,
  canManage,
  csrfToken,
}: {
  readonly initial: AssistantSettingsAnswer;
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const [answer, setAnswer] = useState(initial);
  const [form, setForm] = useState<AssistantForm>(() => formOf(initial.settings));
  const [invalid, setInvalid] = useState<readonly FieldKey[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  const set = <K extends keyof AssistantForm>(key: K, value: AssistantForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const errorOf = (key: FieldKey) => (invalid.includes(key) ? t(`${P}.invalid.${key}`) : undefined);

  function adopt(next: AssistantSettingsAnswer) {
    setAnswer(next);
    setForm(formOf(next.settings));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    setNotice(null);
    setProblem(null);
    const check = settingsOf(form, answer.unavailableOptions);
    if (!check.ok) {
      setInvalid(check.invalid);
      setProblem('fix');
      return;
    }
    setInvalid([]);
    busy.current = true;
    setPending(true);
    const result = await callApi<AssistantSettingsAnswer>(
      'PUT',
      ASSISTANT_SETTINGS_PATH,
      { expectedVersion: answer.version, settings: check.settings },
      csrfToken,
    );
    if (result.ok) {
      adopt(result.body);
      setNotice('saved');
    } else if (result.failure.status === 401) {
      window.location.assign('/session-ended');
    } else if (result.failure.code === 'assistant.conflict') {
      // Someone saved first: show what is in force now, so the admin decides again on that.
      const fresh = await callApi<AssistantSettingsAnswer>('GET', ASSISTANT_SETTINGS_PATH);
      if (fresh.ok) {
        adopt(fresh.body);
        setNotice('reloaded');
      } else {
        setProblem('conflict');
      }
    } else {
      setInvalid(refusedFields(result.failure));
      setProblem(assistantProblemOf(result.failure));
    }
    busy.current = false;
    setPending(false);
  }

  const options = <T extends string>(
    values: readonly T[],
    group: string,
    unavailable: readonly string[] = [],
    reason = 'unavailable-option',
  ) =>
    values.map((value) => {
      const name = t(`${P}.${group}.${value as string}`);
      const off = unavailable.includes(value);
      return {
        value,
        label: off ? t(`${P}.${reason}`, { option: name }) : name,
        disabled: off,
      };
    });

  const status = <StatusCard answer={answer} />;

  if (!canManage) {
    return (
      <div className="flex flex-col gap-6">
        {status}
        <Card title={t(`${P}.summary.title`)}>
          <Banner tone="info">{t(`${P}.read-only`)}</Banner>
          <DataList rows={summaryRows(answer.settings, t)} missing={t(`${P}.welcome.default`)} />
        </Card>
      </div>
    );
  }

  const tierHelp = MODEL_TIERS.map((tier) =>
    t(`${P}.model.configured`, {
      tier: t(`${P}.model.${tier}`),
      model: modelOf(answer, tier) ?? t(`${P}.model.none`),
    }),
  )
    .concat(t(`${P}.model.help`))
    .join(' · ');

  return (
    <div className="flex flex-col gap-6">
      {status}
      <form className="flex flex-col gap-6" onSubmit={(e) => void submit(e)} noValidate>
        <Card title={t(`${P}.section.rollout`)}>
          <CheckboxRow
            name="enabled"
            label={t(`${P}.enabled.label`)}
            help={t(`${P}.enabled.help`)}
            checked={form.enabled}
            onChange={(event) => set('enabled', event.target.checked)}
          />
          <Select
            name="audience"
            label={t(`${P}.audience.label`)}
            help={t(`${P}.audience.help`)}
            options={options(AUDIENCES, 'audience')}
            value={form.audience}
            onChange={(event) => set('audience', event.target.value as AssistantForm['audience'])}
          />
          {form.audience === 'percent' ? (
            <TextField
              name="audiencePercent"
              label={t(`${P}.audience-percent.label`)}
              help={t(`${P}.audience-percent.help`, BOUNDS.audiencePercent)}
              inputMode="numeric"
              autoComplete="off"
              className="sm:max-w-40"
              value={form.audiencePercent}
              error={errorOf('audiencePercent')}
              onChange={(event) => set('audiencePercent', event.target.value)}
            />
          ) : null}
        </Card>

        <Card title={t(`${P}.section.answers`)}>
          <Select
            name="scope"
            label={t(`${P}.scope.label`)}
            help={t(`${P}.scope.help`)}
            options={options(SCOPES, 'scope', answer.unavailableOptions.scope)}
            value={form.scope}
            error={errorOf('scope')}
            onChange={(event) => set('scope', event.target.value as AssistantForm['scope'])}
          />
          <Select
            name="modelTier"
            label={t(`${P}.model.label`)}
            help={tierHelp}
            options={options(
              MODEL_TIERS,
              'model',
              MODEL_TIERS.filter((tier) => modelOf(answer, tier) === null),
              'not-configured-option',
            )}
            value={form.modelTier}
            onChange={(event) => set('modelTier', event.target.value as AssistantForm['modelTier'])}
          />
          <Select
            name="replyLanguage"
            label={t(`${P}.language.label`)}
            options={options(REPLY_LANGUAGES, 'language')}
            value={form.replyLanguage}
            onChange={(event) =>
              set('replyLanguage', event.target.value as AssistantForm['replyLanguage'])
            }
          />
          <TextField
            name="welcomeText"
            label={t(`${P}.welcome.label`)}
            optionalLabel={t(`${P}.optional`)}
            help={t(`${P}.welcome.help`, { max: BOUNDS.welcomeTextLength })}
            autoComplete="off"
            maxLength={BOUNDS.welcomeTextLength * 2}
            value={form.welcomeText}
            error={errorOf('welcomeText')}
            onChange={(event) => set('welcomeText', event.target.value)}
          />
        </Card>

        <Card title={t(`${P}.section.users`)}>
          <Select
            name="users"
            label={t(`${P}.users.label`)}
            options={options(USER_GROUPS, 'users')}
            value={form.users}
            onChange={(event) => set('users', event.target.value as AssistantForm['users'])}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="guestMessageLimit"
              label={t(`${P}.guest-limit.label`)}
              help={t(`${P}.limit-help`, BOUNDS.guestMessageLimit)}
              inputMode="numeric"
              autoComplete="off"
              value={form.guestMessageLimit}
              error={errorOf('guestMessageLimit')}
              onChange={(event) => set('guestMessageLimit', event.target.value)}
            />
            <TextField
              name="customerMessageLimit"
              label={t(`${P}.customer-limit.label`)}
              help={t(`${P}.limit-help`, BOUNDS.customerMessageLimit)}
              inputMode="numeric"
              autoComplete="off"
              value={form.customerMessageLimit}
              error={errorOf('customerMessageLimit')}
              onChange={(event) => set('customerMessageLimit', event.target.value)}
            />
          </div>
        </Card>

        <Card title={t(`${P}.section.spend`)}>
          <p className="text-sm text-fg-muted">{t(`${P}.spend.intro`)}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="dailySpendCap"
              label={t(`${P}.spend.daily`)}
              help={t(`${P}.spend.daily-help`, {
                min: BOUNDS.dailySpendCapUsdCents.min / 100,
                max: BOUNDS.dailySpendCapUsdCents.max / 100,
              })}
              prefix="US$"
              inputMode="decimal"
              autoComplete="off"
              value={form.dailySpendCap}
              error={errorOf('dailySpendCapUsdCents')}
              onChange={(event) => set('dailySpendCap', event.target.value)}
            />
            <TextField
              name="monthlySpendCap"
              label={t(`${P}.spend.monthly`)}
              help={t(`${P}.spend.monthly-help`, {
                min: BOUNDS.monthlySpendCapUsdCents.min / 100,
                max: BOUNDS.monthlySpendCapUsdCents.max / 100,
              })}
              prefix="US$"
              inputMode="decimal"
              autoComplete="off"
              value={form.monthlySpendCap}
              error={errorOf('monthlySpendCapUsdCents')}
              onChange={(event) => set('monthlySpendCap', event.target.value)}
            />
          </div>
        </Card>

        <Card title={t(`${P}.section.data`)}>
          <Select
            name="retention"
            label={t(`${P}.retention.label`)}
            help={t(`${P}.retention.help`)}
            options={options(RETENTIONS, 'retention')}
            value={form.retention}
            onChange={(event) => set('retention', event.target.value as AssistantForm['retention'])}
          />
          <Select
            name="supportHandoff"
            label={t(`${P}.support.label`)}
            help={t(`${P}.support.help`)}
            options={options(SUPPORT_HANDOFFS, 'support', answer.unavailableOptions.supportHandoff)}
            value={form.supportHandoff}
            error={errorOf('supportHandoff')}
            onChange={(event) =>
              set('supportHandoff', event.target.value as AssistantForm['supportHandoff'])
            }
          />
        </Card>

        <div className="flex flex-col gap-3">
          {notice === 'saved' ? <Banner tone="success">{t(`${P}.saved`)}</Banner> : null}
          {notice === 'reloaded' ? <Banner tone="attention">{t(`${P}.reloaded`)}</Banner> : null}
          {problem === null ? null : <Banner tone="critical">{t(`${P}.error.${problem}`)}</Banner>}
          <FormActionBar
            status={
              answer.version === 0
                ? t(`${P}.version-defaults`)
                : t(`${P}.version`, { version: answer.version })
            }
          >
            <Button type="submit" loading={pending}>
              {t(`${P}.save`)}
            </Button>
          </FormActionBar>
        </div>
      </form>
    </div>
  );
}

/** What is in force, read-only: the switch, the server's key and model, and spend. */
function StatusCard({ answer }: { readonly answer: AssistantSettingsAnswer }) {
  const t = useTranslations();
  const model = modelOf(answer, answer.settings.modelTier);
  const muted = (text: string) => <span className="text-fg-muted">{text}</span>;
  const rows: DataListRow[] = [
    {
      label: t(`${P}.status.switch`),
      value: answer.settings.enabled ? (
        <Badge tone="success">{t(`${P}.status.on`)}</Badge>
      ) : (
        <Badge tone="neutral">{t(`${P}.status.off`)}</Badge>
      ),
    },
    {
      label: t(`${P}.status.key`),
      value:
        answer.apiKey === 'set' ? (
          <Badge tone="success">{t(`${P}.status.key-set`)}</Badge>
        ) : (
          <Badge tone="attention">{t(`${P}.status.key-not-set`)}</Badge>
        ),
    },
    {
      label: t(`${P}.status.model`),
      value: model === null ? muted(t(`${P}.model.none`)) : <span dir="ltr">{model}</span>,
    },
    { label: t(`${P}.status.spend-today`), value: muted(t(`${P}.status.not-measured`)) },
    { label: t(`${P}.status.spend-month`), value: muted(t(`${P}.status.not-measured`)) },
    { label: t(`${P}.status.conversations-today`), value: muted(t(`${P}.status.not-measured`)) },
    { label: t(`${P}.status.last-auto-off`), value: muted(t(`${P}.status.not-measured`)) },
  ];
  return (
    <Card title={t(`${P}.status.title`)}>
      {answer.settings.enabled && !configured(answer) ? (
        <Banner tone="attention">{t(`${P}.status.not-configured`)}</Banner>
      ) : null}
      <DataList rows={rows} missing={t(`${P}.status.not-measured`)} />
    </Card>
  );
}

/** The settings as label and value rows, for a viewer who may not change them. */
function summaryRows(
  settings: AssistantSettings,
  t: ReturnType<typeof useTranslations>,
): DataListRow[] {
  return [
    {
      label: t(`${P}.audience.label`),
      value:
        settings.audience === 'percent'
          ? t(`${P}.audience.percent-of`, { percent: settings.audiencePercent ?? 0 })
          : t(`${P}.audience.${settings.audience}`),
    },
    { label: t(`${P}.scope.label`), value: t(`${P}.scope.${settings.scope}`) },
    { label: t(`${P}.model.label`), value: t(`${P}.model.${settings.modelTier}`) },
    { label: t(`${P}.language.label`), value: t(`${P}.language.${settings.replyLanguage}`) },
    { label: t(`${P}.welcome.label`), value: settings.welcomeText },
    { label: t(`${P}.users.label`), value: t(`${P}.users.${settings.users}`) },
    { label: t(`${P}.guest-limit.label`), value: String(settings.guestMessageLimit) },
    { label: t(`${P}.customer-limit.label`), value: String(settings.customerMessageLimit) },
    {
      label: t(`${P}.spend.daily`),
      value: t(`${P}.spend.amount`, { amount: settings.dailySpendCapUsdCents / 100 }),
    },
    {
      label: t(`${P}.spend.monthly`),
      value: t(`${P}.spend.amount`, { amount: settings.monthlySpendCapUsdCents / 100 }),
    },
    { label: t(`${P}.retention.label`), value: t(`${P}.retention.${settings.retention}`) },
    { label: t(`${P}.support.label`), value: t(`${P}.support.${settings.supportHandoff}`) },
  ];
}
