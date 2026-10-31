'use client';

import {
  Banner,
  SaveBar,
  SettingInput,
  SettingRow,
  SettingsErrorSummary,
  SettingsPage,
  SettingsSection,
  toast,
  useSettingsForm,
  type SaveResult,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { callApi } from '../api/client.ts';
import { SettingsConflictView } from './conflict-view.tsx';
import { supportProblemOf } from './errors.ts';
import type { SupportContact } from './types.ts';

/** The same rule the API checks: lower-case printable ASCII, one "@", a dotted domain. */
const SHAPE = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const MAX_LENGTH = 254;
const EMAIL_ROW = 'setting-support-email';
const SUPPORT_PATH = 'notifications/admin/support-contact';

const toDraft = (contact: SupportContact) => contact.email ?? '';
const versionOf = (contact: SupportContact) => contact.version;
async function reload(): Promise<SupportContact | null> {
  const fresh = await callApi<SupportContact>('GET', SUPPORT_PATH);
  return fresh.ok ? fresh.body : null;
}

export function SupportEmailCard({
  initial,
  canManage,
  csrfToken,
}: {
  readonly initial: SupportContact;
  readonly canManage: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const [problem, setProblem] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [failedSaves, setFailedSaves] = useState(0);
  const unset = t('settings.conflict.unset');
  const form = useSettingsForm<SupportContact, string>({
    initial,
    toDraft,
    versionOf,
    reload,
    changes: (saved, text) =>
      text === (saved.email ?? '')
        ? []
        : [
            {
              key: 'email',
              label: t('settings.support.field'),
              saved: saved.email ?? unset,
              yours: text.trim() === '' ? unset : text.trim(),
            },
          ],
  });
  const contact = form.saved;
  const text = form.draft;

  const dirty = canManage && form.dirty;
  const count = canManage ? form.count : 0;
  const errorCount = invalid ? 1 : 0;

  function discard() {
    form.discard();
    setInvalid(false);
    setProblem(null);
  }

  async function submit() {
    const email = text.trim().toLowerCase();
    setProblem(null);
    if (email.length > MAX_LENGTH || !SHAPE.test(email)) {
      setInvalid(true);
      setFailedSaves((n) => n + 1);
      return;
    }
    setInvalid(false);
    const result = await form.run(async (expectedVersion): Promise<SaveResult<SupportContact>> => {
      const answer = await callApi<SupportContact>(
        'PUT',
        SUPPORT_PATH,
        { email, expectedVersion },
        csrfToken,
      );
      if (answer.ok) return { status: 'saved', saved: answer.body };
      if (answer.failure.status === 401) window.location.assign('/session-ended');
      else if (supportProblemOf(answer.failure) === 'conflict') return { status: 'conflict' };
      else setProblem(supportProblemOf(answer.failure));
      return { status: 'failed' };
    });
    if (result.status === 'saved') toast.success(t('settings.support.saved'));
    // The re-read failed too: the plain "reload the page" message is all that is left.
    else if (result.status === 'conflict' && result.reloaded === false) setProblem('conflict');
  }

  const banners = [
    canManage ? null : (
      <Banner key="read-only" tone="info">
        {t('settings.support.read-only')}
      </Banner>
    ),
    invalid ? (
      <SettingsErrorSummary
        key="invalid"
        title={t('settings.errors.title', { count: 1 })}
        items={[{ id: EMAIL_ROW, label: t('settings.support.field') }]}
        focusSignal={failedSaves}
      />
    ) : null,
    form.theirs !== null ? (
      <SettingsConflictView key="conflict" conflictId={form.conflictId} changes={form.changes} />
    ) : null,
    contact.email === null ? (
      <Banner key="not-set" tone="attention">
        {t('settings.support.not-set')}
      </Banner>
    ) : null,
    problem === null ? null : (
      <Banner key="problem" tone="critical">
        {t(`settings.support.error.${problem}`)}
      </Banner>
    ),
  ].filter((node) => node !== null);
  const banner =
    banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>;

  return (
    <SettingsPage
      title={t('settings.support.title')}
      description={t('settings.support.intro')}
      banner={banner}
      onSubmit={canManage ? () => void submit() : undefined}
      dirty={dirty}
      dirtyCount={count}
      leave={{
        title: t('settings.leave.title'),
        message: (info) => t('settings.leave.message', { count: info.count, page: info.page }),
        stay: t('settings.leave.stay'),
        leave: t('settings.leave.leave'),
      }}
      saveBar={
        canManage ? (
          <SaveBar
            count={count}
            summary={t('settings.bar.summary', { count })}
            errorCount={errorCount}
            errorsSummary={t('settings.bar.errors', { count: errorCount })}
            saving={form.saving}
            labels={{
              region: t('settings.bar.region'),
              discard: t('settings.bar.discard'),
              save: t('settings.bar.save'),
              saving: t('settings.bar.saving'),
            }}
            onDiscard={discard}
          />
        ) : null
      }
    >
      <SettingsSection title={t('settings.support.section')}>
        {contact.email === null && canManage ? null : (
          <SettingRow label={t('settings.support.current')} plain>
            {contact.email === null ? (
              <p className="break-words text-fg-muted">{t('settings.support.none')}</p>
            ) : (
              <p className="break-words font-semibold text-fg">{contact.email}</p>
            )}
          </SettingRow>
        )}
        {canManage ? (
          <SettingRow
            id={EMAIL_ROW}
            settingId="support-email"
            label={t('settings.support.field')}
            help={t('settings.support.field-help')}
            changed={dirty}
            error={invalid ? t('settings.support.invalid') : undefined}
          >
            <SettingInput
              name="email"
              type="email"
              inputMode="email"
              autoComplete="off"
              maxLength={MAX_LENGTH}
              value={text}
              onChange={(event) => {
                form.setDraft(event.target.value);
                setInvalid(false);
              }}
            />
          </SettingRow>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
