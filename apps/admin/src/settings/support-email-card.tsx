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
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { supportProblemOf } from './errors.ts';
import type { SupportContact } from './types.ts';

/** The same rule the API checks: lower-case printable ASCII, one "@", a dotted domain. */
const SHAPE = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/;
const MAX_LENGTH = 254;
const EMAIL_ROW = 'setting-support-email';

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
  const [contact, setContact] = useState(initial);
  const [text, setText] = useState(initial.email ?? '');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [failedSaves, setFailedSaves] = useState(0);
  const busy = useRef(false);

  const dirty = canManage && text !== (contact.email ?? '');
  const count = dirty ? 1 : 0;
  const errorCount = invalid ? 1 : 0;

  function discard() {
    setText(contact.email ?? '');
    setInvalid(false);
    setProblem(null);
  }

  async function submit() {
    if (busy.current) return;
    const email = text.trim().toLowerCase();
    setProblem(null);
    if (email.length > MAX_LENGTH || !SHAPE.test(email)) {
      setInvalid(true);
      setFailedSaves((n) => n + 1);
      return;
    }
    setInvalid(false);
    busy.current = true;
    setPending(true);
    const result = await callApi<SupportContact>(
      'PUT',
      'notifications/admin/support-contact',
      { email, expectedVersion: contact.version },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setContact(result.body);
      setText(result.body.email ?? '');
      toast.success(t('settings.support.saved'));
      return;
    }
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(supportProblemOf(result.failure));
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
      leave={{
        title: t('settings.leave.title'),
        message: t('settings.leave.message'),
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
            saving={pending}
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
                setText(event.target.value);
                setInvalid(false);
              }}
            />
          </SettingRow>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}
