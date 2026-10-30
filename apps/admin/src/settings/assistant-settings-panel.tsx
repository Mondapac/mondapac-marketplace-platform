'use client';

import {
  Badge,
  Banner,
  DataList,
  SaveBar,
  SettingCheckbox,
  SettingInput,
  SettingRow,
  SettingSelect,
  SettingsPage,
  SettingsSection,
  toast,
  type DataListRow,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
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

type Notice = 'reloaded' | null;

/** Form keys whose API field has another name. */
const FIELD_OF: Partial<Record<keyof AssistantForm, FieldKey>> = {
  dailySpendCap: 'dailySpendCapUsdCents',
  monthlySpendCap: 'monthlySpendCapUsdCents',
};

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

  const baseline = formOf(answer.settings);
  const changedKeys = (Object.keys(baseline) as (keyof AssistantForm)[]).filter(
    (key) =>
      form[key] !== baseline[key] && (key !== 'audiencePercent' || form.audience === 'percent'),
  );
  const changed = (key: keyof AssistantForm) => changedKeys.includes(key);
  const set = <K extends keyof AssistantForm>(key: K, value: AssistantForm[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    // Editing a field takes its error away; the next save checks it again.
    const field = FIELD_OF[key] ?? key;
    setInvalid((current) => current.filter((name) => name !== field));
  };
  const errorOf = (key: FieldKey) => (invalid.includes(key) ? t(`${P}.invalid.${key}`) : undefined);

  function adopt(next: AssistantSettingsAnswer) {
    setAnswer(next);
    setForm(formOf(next.settings));
  }

  async function submit() {
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
      toast.success(t(`${P}.saved`));
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

  function discard() {
    setForm(baseline);
    setInvalid([]);
    setProblem(null);
    setNotice(null);
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
  const shownProblem = problem === 'fix' && invalid.length === 0 ? null : problem;
  const lastChanged = {
    text:
      answer.version === 0
        ? t(`${P}.version-defaults`)
        : t(`${P}.version`, { version: answer.version }),
  };
  const banner = (
    <>
      {canManage ? null : <Banner tone="info">{t(`${P}.read-only`)}</Banner>}
      {notice === 'reloaded' ? <Banner tone="attention">{t(`${P}.reloaded`)}</Banner> : null}
      {shownProblem === null ? null : (
        <Banner tone="critical">{t(`${P}.error.${shownProblem}`)}</Banner>
      )}
    </>
  );
  const frame = {
    title: t(`${P}.title`),
    description: t(`${P}.intro`),
    lastChanged,
    banner: <div className="flex flex-col gap-3">{banner}</div>,
  };

  if (!canManage) {
    return (
      <SettingsPage {...frame}>
        {status}
        <SettingsSection title={t(`${P}.summary.title`)}>
          <div className="px-5 py-4">
            <DataList rows={summaryRows(answer.settings, t)} missing={t(`${P}.welcome.default`)} />
          </div>
        </SettingsSection>
      </SettingsPage>
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
    <SettingsPage
      {...frame}
      onSubmit={() => void submit()}
      dirty={changedKeys.length > 0}
      leave={{
        title: t('settings.leave.title'),
        message: t('settings.leave.message'),
        stay: t('settings.leave.stay'),
        leave: t('settings.leave.leave'),
      }}
      saveBar={
        <SaveBar
          count={changedKeys.length}
          summary={t('settings.bar.summary', { count: changedKeys.length })}
          errorCount={invalid.length}
          errorsSummary={t('settings.bar.errors', { count: invalid.length })}
          saving={pending}
          labels={{
            region: t('settings.bar.region'),
            discard: t('settings.bar.discard'),
            save: t('settings.bar.save'),
            saving: t('settings.bar.saving'),
          }}
          onDiscard={discard}
        />
      }
    >
      {status}
      <SettingsSection title={t(`${P}.section.rollout`)}>
        <SettingRow
          label={t(`${P}.enabled.label`)}
          help={t(`${P}.enabled.help`)}
          changed={changed('enabled')}
        >
          <SettingCheckbox
            name="enabled"
            text={form.enabled ? t(`${P}.status.on`) : t(`${P}.status.off`)}
            checked={form.enabled}
            onChange={(event) => set('enabled', event.target.checked)}
          />
        </SettingRow>
        <SettingRow
          label={t(`${P}.audience.label`)}
          help={t(`${P}.audience.help`)}
          changed={changed('audience')}
        >
          <SettingSelect
            name="audience"
            options={options(AUDIENCES, 'audience')}
            value={form.audience}
            onChange={(event) => set('audience', event.target.value as AssistantForm['audience'])}
          />
        </SettingRow>
        {form.audience === 'percent' ? (
          <SettingRow
            label={t(`${P}.audience-percent.label`)}
            help={t(`${P}.audience-percent.help`, BOUNDS.audiencePercent)}
            changed={changed('audiencePercent')}
            error={errorOf('audiencePercent')}
          >
            <SettingInput
              name="audiencePercent"
              inputMode="numeric"
              autoComplete="off"
              className="md:max-w-40"
              value={form.audiencePercent}
              onChange={(event) => set('audiencePercent', event.target.value)}
            />
          </SettingRow>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t(`${P}.section.answers`)}>
        <SettingRow
          label={t(`${P}.scope.label`)}
          help={t(`${P}.scope.help`)}
          changed={changed('scope')}
          error={errorOf('scope')}
        >
          <SettingSelect
            name="scope"
            options={options(SCOPES, 'scope', answer.unavailableOptions.scope)}
            value={form.scope}
            onChange={(event) => set('scope', event.target.value as AssistantForm['scope'])}
          />
        </SettingRow>
        <SettingRow label={t(`${P}.model.label`)} help={tierHelp} changed={changed('modelTier')}>
          <SettingSelect
            name="modelTier"
            options={options(
              MODEL_TIERS,
              'model',
              MODEL_TIERS.filter((tier) => modelOf(answer, tier) === null),
              'not-configured-option',
            )}
            value={form.modelTier}
            onChange={(event) => set('modelTier', event.target.value as AssistantForm['modelTier'])}
          />
        </SettingRow>
        <SettingRow label={t(`${P}.language.label`)} changed={changed('replyLanguage')}>
          <SettingSelect
            name="replyLanguage"
            options={options(REPLY_LANGUAGES, 'language')}
            value={form.replyLanguage}
            onChange={(event) =>
              set('replyLanguage', event.target.value as AssistantForm['replyLanguage'])
            }
          />
        </SettingRow>
        <SettingRow
          label={t(`${P}.welcome.label`)}
          optionalLabel={t(`${P}.optional`)}
          help={t(`${P}.welcome.help`, { max: BOUNDS.welcomeTextLength })}
          changed={changed('welcomeText')}
          error={errorOf('welcomeText')}
        >
          <SettingInput
            name="welcomeText"
            autoComplete="off"
            maxLength={BOUNDS.welcomeTextLength * 2}
            value={form.welcomeText}
            onChange={(event) => set('welcomeText', event.target.value)}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t(`${P}.section.users`)}>
        <SettingRow label={t(`${P}.users.label`)} changed={changed('users')}>
          <SettingSelect
            name="users"
            options={options(USER_GROUPS, 'users')}
            value={form.users}
            onChange={(event) => set('users', event.target.value as AssistantForm['users'])}
          />
        </SettingRow>
        <SettingRow
          label={t(`${P}.guest-limit.label`)}
          help={t(`${P}.limit-help`, BOUNDS.guestMessageLimit)}
          changed={changed('guestMessageLimit')}
          error={errorOf('guestMessageLimit')}
        >
          <SettingInput
            name="guestMessageLimit"
            inputMode="numeric"
            autoComplete="off"
            value={form.guestMessageLimit}
            onChange={(event) => set('guestMessageLimit', event.target.value)}
          />
        </SettingRow>
        <SettingRow
          label={t(`${P}.customer-limit.label`)}
          help={t(`${P}.limit-help`, BOUNDS.customerMessageLimit)}
          changed={changed('customerMessageLimit')}
          error={errorOf('customerMessageLimit')}
        >
          <SettingInput
            name="customerMessageLimit"
            inputMode="numeric"
            autoComplete="off"
            value={form.customerMessageLimit}
            onChange={(event) => set('customerMessageLimit', event.target.value)}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t(`${P}.section.spend`)} description={t(`${P}.spend.intro`)}>
        <SettingRow
          label={t(`${P}.spend.daily`)}
          help={t(`${P}.spend.daily-help`, {
            min: BOUNDS.dailySpendCapUsdCents.min / 100,
            max: BOUNDS.dailySpendCapUsdCents.max / 100,
          })}
          changed={changed('dailySpendCap')}
          error={errorOf('dailySpendCapUsdCents')}
        >
          <SettingInput
            name="dailySpendCap"
            prefix="US$"
            inputMode="decimal"
            autoComplete="off"
            value={form.dailySpendCap}
            onChange={(event) => set('dailySpendCap', event.target.value)}
          />
        </SettingRow>
        <SettingRow
          label={t(`${P}.spend.monthly`)}
          help={t(`${P}.spend.monthly-help`, {
            min: BOUNDS.monthlySpendCapUsdCents.min / 100,
            max: BOUNDS.monthlySpendCapUsdCents.max / 100,
          })}
          changed={changed('monthlySpendCap')}
          error={errorOf('monthlySpendCapUsdCents')}
        >
          <SettingInput
            name="monthlySpendCap"
            prefix="US$"
            inputMode="decimal"
            autoComplete="off"
            value={form.monthlySpendCap}
            onChange={(event) => set('monthlySpendCap', event.target.value)}
          />
        </SettingRow>
      </SettingsSection>

      <SettingsSection title={t(`${P}.section.data`)}>
        <SettingRow
          label={t(`${P}.retention.label`)}
          help={t(`${P}.retention.help`)}
          changed={changed('retention')}
        >
          <SettingSelect
            name="retention"
            options={options(RETENTIONS, 'retention')}
            value={form.retention}
            onChange={(event) => set('retention', event.target.value as AssistantForm['retention'])}
          />
        </SettingRow>
        <SettingRow
          label={t(`${P}.support.label`)}
          help={t(`${P}.support.help`)}
          changed={changed('supportHandoff')}
          error={errorOf('supportHandoff')}
        >
          <SettingSelect
            name="supportHandoff"
            options={options(SUPPORT_HANDOFFS, 'support', answer.unavailableOptions.supportHandoff)}
            value={form.supportHandoff}
            onChange={(event) =>
              set('supportHandoff', event.target.value as AssistantForm['supportHandoff'])
            }
          />
        </SettingRow>
      </SettingsSection>
    </SettingsPage>
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
    <SettingsSection title={t(`${P}.status.title`)}>
      <div className="flex flex-col gap-4 px-5 py-4">
        {answer.settings.enabled && !configured(answer) ? (
          <Banner tone="attention">{t(`${P}.status.not-configured`)}</Banner>
        ) : null}
        <DataList rows={rows} missing={t(`${P}.status.not-measured`)} />
      </div>
    </SettingsSection>
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
