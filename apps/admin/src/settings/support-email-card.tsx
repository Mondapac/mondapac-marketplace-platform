'use client';

import { Banner, Button, Card, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { supportProblemOf } from './errors.ts';
import type { SupportContact } from './types.ts';

/** Same plain shape the API checks: one "@", a dotted domain, no spaces. */
const SHAPE = /^[^@\s,;<>()[\]\\"]+@[^@\s,;<>()[\]\\"]+\.[^@\s,;<>()[\]\\".]+$/;
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
  const [saved, setSaved] = useState(false);
  const busy = useRef(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    const email = text.trim();
    setSaved(false);
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
      { email },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setContact(result.body);
      setText(result.body.email ?? '');
      setSaved(true);
      return;
    }
    if (result.failure.status === 401) window.location.assign('/session-ended');
    else setProblem(supportProblemOf(result.failure));
  }

  return (
    <Card title={t('settings.support.title')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">{t('settings.support.intro')}</p>
        {contact.email === null ? (
          <Banner tone="attention">{t('settings.support.not-set')}</Banner>
        ) : (
          <p className="break-words">
            <span className="text-fg-muted">{t('settings.support.current')}: </span>
            <strong>{contact.email}</strong>
          </p>
        )}
        {saved ? <Banner tone="success">{t('settings.support.saved')}</Banner> : null}
        {problem === null ? null : (
          <Banner tone="critical">{t(`settings.support.error.${problem}`)}</Banner>
        )}
        {canManage ? (
          <form className="flex flex-col gap-3" onSubmit={(e) => void submit(e)} noValidate>
            <TextField
              name="email"
              type="email"
              label={t('settings.support.field')}
              help={t('settings.support.field-help')}
              inputMode="email"
              autoComplete="off"
              maxLength={MAX_LENGTH}
              value={text}
              error={invalid ? t('settings.support.invalid') : undefined}
              onChange={(event) => setText(event.target.value)}
            />
            <div>
              <Button type="submit" loading={pending}>
                {t('settings.support.save')}
              </Button>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
