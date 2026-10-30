'use client';

import {
  Banner,
  SaveBar,
  SettingInput,
  SettingRow,
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

  const banner = (
    <>
      {canManage ? null : <Banner tone="info">{t('settings.support.read-only')}</Banner>}
      {contact.email === null ? (
        <Banner tone="attention">{t('settings.support.not-set')}</Banner>
      ) : null}
      {problem === null ? null : (
        <Banner tone="critical">{t(`settings.support.error.${problem}`)}</Banner>
      )}
    </>
  );

  return (
    <SettingsPage
      title={t('settings.support.title')}
      description={t('settings.support.intro')}
      banner={<div className="flex flex-col gap-3">{banner}</div>}
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
