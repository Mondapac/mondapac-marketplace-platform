'use client';

import { Button, Card, FieldStatus, TextAreaField, relativeTime } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstantInZone } from '../shared/format.ts';
import { isFieldFailure } from './errors.ts';
import { usePersonName } from './request-parts.tsx';
import { BASE, COMMENT_MAX, type ActivityLine } from './types.ts';

const KNOWN = ['applied', 'proposed', 'commented', 'approved', 'rejected', 'withdrawn'] as const;

/**
 * "Activity": the history oldest first (what happened, by whom, when, and the comment or reason
 * as plain text), then the comment box. A comment is allowed in any status and decides nothing.
 */
export function Activity({
  requestId,
  lines,
  accountId,
  csrfToken,
  zone,
  onCommented,
}: {
  readonly requestId: string;
  readonly lines: readonly ActivityLine[];
  readonly accountId: string;
  readonly csrfToken: string;
  readonly zone: string;
  /** The API's own answer for the new comment, to add to the list. */
  readonly onCommented: (line: ActivityLine) => void;
}) {
  const t = useTranslations('system-requests.activity');
  const locale = useLocale();
  const person = usePersonName(accountId);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<'invalid' | 'failed' | null>(null);
  const [announce, setAnnounce] = useState('');
  const inFlight = useRef(false);

  async function send() {
    if (inFlight.current) return;
    const body = text.trim();
    if (body === '' || body.length > COMMENT_MAX) {
      setProblem('invalid');
      return;
    }
    inFlight.current = true;
    setSending(true);
    setProblem(null);
    const result = await callApi<ActivityLine>(
      'POST',
      `${BASE}/requests/${requestId}/comments`,
      { body },
      csrfToken,
    );
    inFlight.current = false;
    setSending(false);
    if (result.ok) {
      setText('');
      setAnnounce(t('added'));
      onCommented(result.body);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setProblem(isFieldFailure(result.failure, 'body') ? 'invalid' : 'failed');
  }

  return (
    <Card title={t('title')}>
      {lines.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('none')}</p>
      ) : (
        <ol className="flex flex-col gap-4">
          {lines.map((line) => {
            const kind = (KNOWN as readonly string[]).includes(line.kind) ? line.kind : 'unknown';
            return (
              <li key={line.id} className="flex flex-col gap-1 text-sm">
                <p>
                  <span className="font-medium text-fg">{person(line.actor, line.actorName)}</span>{' '}
                  <span>{t(`kind.${kind}`)}</span>{' '}
                  <time
                    dateTime={line.at}
                    title={formatInstantInZone(line.at, locale, zone)}
                    className="text-fg-muted"
                  >
                    {relativeTime(line.at, locale)}
                  </time>
                </p>
                {line.body === null || line.body === '' ? null : (
                  <p className="whitespace-pre-wrap break-words text-fg-secondary">{line.body}</p>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <form
        className="flex flex-col gap-2 border-t border-line-row pt-4"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <TextAreaField
          name="comment"
          label={t('label')}
          rows={3}
          maxLength={COMMENT_MAX}
          value={text}
          readOnly={sending}
          counter={t('counter', { count: text.length, max: COMMENT_MAX })}
          error={problem === 'invalid' ? t('error.invalid') : undefined}
          onChange={(event) => {
            setText(event.target.value);
            setProblem(null);
          }}
        />
        {problem === 'failed' ? (
          <FieldStatus tone="critical">{t('error.failed')}</FieldStatus>
        ) : null}
        <div>
          <Button type="submit" variant="secondary" loading={sending}>
            {t('submit')}
          </Button>
        </div>
        <p aria-live="polite" className="sr-only">
          {announce}
        </p>
      </form>
    </Card>
  );
}
