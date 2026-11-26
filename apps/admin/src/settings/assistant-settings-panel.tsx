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
  SettingsErrorSummary,
  SettingsViewOnlyBanner,
  useLiveErrors,
  SettingsPage,
  SettingsSection,
  toast,
  useSettingsForm,
  type DataListRow,
  type FieldChange,
  type SaveResult,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useState, type ReactNode } from 'react';
import { shortInstantInZone } from '../shared/format.ts';
import { callApi } from '../api/client.ts';
import { SettingsConflictView } from './conflict-view.tsx';
import { useChangeHistory } from './last-changed.tsx';
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
  REPLY_LANGUAGES,
  RETENTIONS,
  SCOPES,
  SUPPORT_HANDOFFS,
  USER_GROUPS,
  type AssistantSettings,
  type AssistantSettingsAnswer,
} from './assistant-types.ts';

const P = 'settings.assistant';

const rowId = (key: FieldKey) => `setting-assistant-${key}`;

/** The label of each field that can be refused, for the error summary. */
const FIELD_LABEL: Record<FieldKey, string> = {
  audiencePercent: 'audience-percent.label',
  scope: 'scope.label',
  guestMessageLimit: 'guest-limit.label',
  customerMessageLimit: 'customer-limit.label',
  supportHandoff: 'support.label',
  welcomeText: 'welcome.label',
};

/** Form keys typed into a text box: checked when left or on Save, not on the first keystroke. */
const TYPED_KEYS: ReadonlySet<keyof AssistantForm> = new Set<keyof AssistantForm>([
  'audiencePercent',
  'welcomeText',
  'guestMessageLimit',
  'customerMessageLimit',
]);

/** Form keys whose API field has another name (none since the spend caps went, AI Gateway G4d2). */
const FIELD_OF: Partial<Record<keyof AssistantForm, FieldKey>> = {};

type Translate = ReturnType<typeof useTranslations>;

/** The label of each form field, for the Compare list. */
const CHANGE_LABEL: Record<keyof AssistantForm, string> = {
  enabled: 'enabled.label',
  audience: 'audience.label',
  audiencePercent: 'audience-percent.label',
  scope: 'scope.label',
  users: 'users.label',
  guestMessageLimit: 'guest-limit.label',
  customerMessageLimit: 'customer-limit.label',
  retention: 'retention.label',
  replyLanguage: 'language.label',
  supportHandoff: 'support.label',
  basketProposals: 'basket.label',
  welcomeText: 'welcome.label',
};
/** Fields whose value is one of a fixed set, with the message group naming each choice. */
const CHOICE_GROUP: Partial<Record<keyof AssistantForm, string>> = {
  audience: 'audience',
  scope: 'scope',
  users: 'users',
  retention: 'retention',
  replyLanguage: 'language',
  supportHandoff: 'support',
};

/** One value of the form as text for the Compare list. Free text stays text. */
function shownValue(key: keyof AssistantForm, form: AssistantForm, t: Translate): string {
  const value = form[key];
  if (typeof value === 'boolean') return t(`${P}.status.${value ? 'on' : 'off'}`);
  const group = CHOICE_GROUP[key];
  if (group !== undefined) return t(`${P}.${group}.${value}`);
  if (key === 'audiencePercent') {
    return value.trim() === ''
      ? t('settings.conflict.unset')
      : t(`${P}.audience.percent-of`, { percent: value.trim() });
  }
  if (key === 'welcomeText') return value.trim() === '' ? t(`${P}.welcome.default`) : value.trim();
  return value;
}

/** The fields where the draft differs from what is saved, worded for the Compare list. */
function changesOf(
  saved: AssistantSettingsAnswer,
  draft: AssistantForm,
  t: Translate,
): readonly FieldChange[] {
  const baseline = formOf(saved.settings);
  return (Object.keys(baseline) as (keyof AssistantForm)[])
    .filter(
      (key) =>
        draft[key] !== baseline[key] && (key !== 'audiencePercent' || draft.audience === 'percent'),
    )
    .map((key) => ({
      key,
      label: t(`${P}.${CHANGE_LABEL[key]}`),
      saved: shownValue(key, baseline, t),
      yours: shownValue(key, draft, t),
    }));
}

const toDraft = (answer: AssistantSettingsAnswer) => formOf(answer.settings);
const versionOf = (answer: AssistantSettingsAnswer) => answer.version;
async function reload(): Promise<AssistantSettingsAnswer | null> {
  const fresh = await callApi<AssistantSettingsAnswer>('GET', ASSISTANT_SETTINGS_PATH);
  return fresh.ok ? fresh.body : null;
}

/**
 * Whether the server holds the model key. Buyers are served only with it and with a model list for
 * the chat task type (AI Gateway settings); the model tier went in AI Gateway G4d1.
 */
function configured(answer: AssistantSettingsAnswer): boolean {
  return answer.apiKey === 'set';
}

export function AssistantSettingsPanel({
  initial,
  canManage,
  csrfToken,
  zone = 'UTC',
  tabs = null,
  averageCostUsd = null,
}: {
  readonly initial: AssistantSettingsAnswer;
  readonly canManage: boolean;
  readonly csrfToken: string;
  /** The IANA zone of the last automatic switch-off time. */
  readonly zone?: string;
  /** The Settings / Insights tab row, shown under the title. */
  readonly tabs?: ReactNode;
  /** What one conversation cost on average over the last 30 days, in US dollars; null: none yet. */
  readonly averageCostUsd?: number | null;
}) {
  const t = useTranslations();
  // The fields the server refused on the last save (a rule only it knows); the rest is worked out live.
  const [refusedKeys, setRefusedKeys] = useState<readonly FieldKey[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [refusals, setRefusals] = useState(0);
  const settings = useSettingsForm<AssistantSettingsAnswer, AssistantForm>({
    initial,
    toDraft,
    versionOf,
    reload,
    changes: (saved, draft) => changesOf(saved, draft, t),
  });
  const answer = settings.saved;
  const changeHistory = useChangeHistory(answer.lastChanged, 'assistant/admin/settings/history');
  const form = settings.draft;
  const changedKeys = settings.changes.map((change) => change.key);
  const changed = (key: keyof AssistantForm) => changedKeys.includes(key);
  const leave = (key: keyof AssistantForm) => {
    const field = FIELD_OF[key] ?? key;
    if (field in FIELD_LABEL) live.touch(field as FieldKey);
  };
  const checkedNow = settingsOf(form, answer.unavailableOptions);
  const live = useLiveErrors<FieldKey>(checkedNow.ok ? [] : checkedNow.invalid);
  const invalid: readonly FieldKey[] = [
    ...live.shown,
    ...refusedKeys.filter((key) => !live.shown.includes(key)),
  ];
  const set = <K extends keyof AssistantForm>(key: K, value: AssistantForm[K]) => {
    settings.setDraft((current) => ({ ...current, [key]: value }));
    // A choice is final when made, so it is checked at once; a typed field shows its error once
    // it is left (`leave`) or on Save, then re-checks as the user types. A server refusal of the
    // field is old news now.
    const field = FIELD_OF[key] ?? key;
    if (!TYPED_KEYS.has(key) && field in FIELD_LABEL) live.touch(field as FieldKey);
    setRefusedKeys((current) => current.filter((name) => name !== field));
  };
  const errorOf = (key: FieldKey) => (invalid.includes(key) ? t(`${P}.invalid.${key}`) : undefined);

  async function submit() {
    setProblem(null);
    const check = settingsOf(form, answer.unavailableOptions);
    if (!check.ok) {
      live.attempt();
      setProblem('fix');
      return;
    }
    setRefusedKeys([]);
    const result = await settings.run(
      async (expectedVersion): Promise<SaveResult<AssistantSettingsAnswer>> => {
        const reply = await callApi<AssistantSettingsAnswer>(
          'PUT',
          ASSISTANT_SETTINGS_PATH,
          { expectedVersion, settings: check.settings },
          csrfToken,
        );
        if (reply.ok) return { status: 'saved', saved: reply.body };
        if (reply.failure.status === 401) {
          window.location.assign('/session-ended');
        } else if (reply.failure.code === 'assistant.conflict') {
          return { status: 'conflict' };
        } else {
          const refused = refusedFields(reply.failure);
          setRefusedKeys(refused);
          if (refused.length > 0) setRefusals((n) => n + 1);
          setProblem(assistantProblemOf(reply.failure));
        }
        return { status: 'failed' };
      },
    );
    if (result.status === 'saved') {
      live.reset();
      toast.success(t(`${P}.saved`));
    }
    // The re-read failed too: the plain "reload the page" message is all that is left.
    else if (result.status === 'conflict' && result.reloaded === false) setProblem('conflict');
  }

  function discard() {
    settings.discard();
    live.reset();
    setRefusedKeys([]);
    setProblem(null);
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

  const status = <StatusCard answer={answer} zone={zone} averageCostUsd={averageCostUsd} />;
  // The error summary names the fields, so the generic "fix" line is left out.
  const shownProblem = problem === 'fix' ? null : problem;
  // The saved version is the pill beside the title; "last changed by" stays a line under it.
  const versionLabel =
    answer.version === 0
      ? t(`${P}.version-defaults`)
      : t(`${P}.version`, { version: answer.version });
  const banners = [
    tabs === null ? null : <div key="tabs">{tabs}</div>,
    canManage ? null : (
      <SettingsViewOnlyBanner key="read-only" title={t('settings.view-only.title')}>
        {t(`${P}.read-only`)}
      </SettingsViewOnlyBanner>
    ),
    invalid.length === 0 ? null : (
      <SettingsErrorSummary
        key="invalid"
        title={t('settings.errors.title', { count: invalid.length })}
        items={invalid.map((key) => ({
          id: rowId(key),
          label: t(`${P}.${FIELD_LABEL[key]}`),
          reason: errorOf(key),
        }))}
        focusSignal={live.attempts + refusals}
      />
    ),
    settings.theirs === null ? null : (
      <SettingsConflictView
        key="conflict"
        conflictId={settings.conflictId}
        changes={settings.changes}
        winner={settings.theirs.lastChanged}
      />
    ),
    shownProblem === null ? null : (
      <Banner key="problem" tone="critical">
        {t(`${P}.error.${shownProblem}`)}
      </Banner>
    ),
  ].filter((node) => node !== null);
  const banner =
    banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>;
  const frame = {
    title: t(`${P}.title`),
    description: t(`${P}.intro`),
    status: versionLabel,
    ...(changeHistory.line === undefined ? {} : { lastChanged: changeHistory.line }),
    overlay: changeHistory.drawer,
    banner,
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

  return (
    <SettingsPage
      {...frame}
      onSubmit={() => void submit()}
      dirty={changedKeys.length > 0}
      dirtyCount={changedKeys.length}
      leave={{
        title: t('settings.leave.title'),
        message: (info) => t('settings.leave.message', { count: info.count, page: info.page }),
        stay: t('settings.leave.stay'),
        leave: t('settings.leave.leave'),
      }}
      saveBar={
        <SaveBar
          count={changedKeys.length}
          summary={t('settings.bar.summary', { count: changedKeys.length })}
          errorCount={invalid.length}
          errorsSummary={t('settings.bar.errors', { count: invalid.length })}
          saving={settings.saving}
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
          settingId="assistant-enabled"
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
          settingId="assistant-audience"
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
            id={rowId('audiencePercent')}
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
              onBlur={() => leave('audiencePercent')}
            />
          </SettingRow>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t(`${P}.section.answers`)}>
        <SettingRow
          id={rowId('scope')}
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
        <SettingRow
          settingId="assistant-basket-proposals"
          label={t(`${P}.basket.label`)}
          help={t(`${P}.basket.help`)}
          changed={changed('basketProposals')}
        >
          <SettingCheckbox
            name="basketProposals"
            text={form.basketProposals ? t(`${P}.status.on`) : t(`${P}.status.off`)}
            checked={form.basketProposals}
            onChange={(event) => set('basketProposals', event.target.checked)}
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
          id={rowId('welcomeText')}
          settingId="assistant-welcome"
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
            onBlur={() => leave('welcomeText')}
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
          id={rowId('guestMessageLimit')}
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
            onBlur={() => leave('guestMessageLimit')}
          />
        </SettingRow>
        <SettingRow
          id={rowId('customerMessageLimit')}
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
            onBlur={() => leave('customerMessageLimit')}
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
          id={rowId('supportHandoff')}
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

/** What is in force, read-only: the switch, the server's key, and spend. */
function StatusCard({
  answer,
  zone,
  averageCostUsd,
}: {
  readonly answer: AssistantSettingsAnswer;
  readonly zone: string;
  readonly averageCostUsd: number | null;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const { spend } = answer;
  const usd = (amount: number) => t(`${P}.spend.amount`, { amount });
  const usdPrecise = (amount: number) => t(`${P}.spend.amount-precise`, { amount });
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
      label: t(`${P}.status.spend-today`),
      // The caps are the AI Gateway's since G4d2 (its page, G5): only the spend is shown here.
      value: usd(spend.todayMicroUsd / 1_000_000),
    },
    {
      label: t(`${P}.status.spend-month`),
      value: usd(spend.monthMicroUsd / 1_000_000),
    },
    {
      label: t(`${P}.status.conversations-today`),
      value: String(spend.conversationsToday),
    },
    {
      label: t(`${P}.status.cost-per-conversation`),
      value:
        averageCostUsd === null
          ? muted(t(`${P}.status.not-measured`))
          : t(`${P}.status.cost-per-conversation-value`, {
              amount: usdPrecise(averageCostUsd),
            }),
    },
    {
      label: t(`${P}.status.last-auto-off`),
      value:
        spend.lastAutoOff === null
          ? muted(t(`${P}.status.never-auto-off`))
          : t(`${P}.status.auto-off-value`, {
              cap: spend.lastAutoOff.cap,
              when: shortInstantInZone(spend.lastAutoOff.at, locale, zone, true),
            }),
    },
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
    {
      label: t(`${P}.basket.label`),
      value: t(`${P}.status.${settings.basketProposals ? 'on' : 'off'}`),
    },
    { label: t(`${P}.language.label`), value: t(`${P}.language.${settings.replyLanguage}`) },
    { label: t(`${P}.welcome.label`), value: settings.welcomeText },
    { label: t(`${P}.users.label`), value: t(`${P}.users.${settings.users}`) },
    { label: t(`${P}.guest-limit.label`), value: String(settings.guestMessageLimit) },
    { label: t(`${P}.customer-limit.label`), value: String(settings.customerMessageLimit) },
    { label: t(`${P}.retention.label`), value: t(`${P}.retention.${settings.retention}`) },
    { label: t(`${P}.support.label`), value: t(`${P}.support.${settings.supportHandoff}`) },
  ];
}
