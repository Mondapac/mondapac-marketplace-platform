'use client';

import { Banner, Button, Card, TextAreaField } from '@mondapac/ui';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { formatInstant } from '../shared/format.ts';
import type { AdminNote } from './types.ts';

/** The note limit of the API (domain/admin-order-note.ts NOTE_MAX_LENGTH), in code points. */
export const NOTE_MAX_LENGTH = 2000;

type NoteProblem = 'erased' | 'denied' | 'invalid' | 'unknown';

/**
 * Internal notes on the order (order detail decision 3): admins only, never shown to the customer
 * or the seller, and a seller's own notes are not shown here. Notes are added, never edited. The
 * list comes from the page server (null when it did not load); a new note reads the page again.
 */
export function NotesCard({
  orderId,
  notes,
  canWrite,
  csrfToken,
}: {
  readonly orderId: string;
  readonly notes: readonly AdminNote[] | null;
  readonly canWrite: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('orders.notes');
  const locale = useLocale();
  const router = useRouter();
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<NoteProblem | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [added, setAdded] = useState(false);
  const busy = useRef(false);
  const length = [...text.trim()].length;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy.current) return;
    if (length === 0) {
      setError(t('required'));
      return;
    }
    if (length > NOTE_MAX_LENGTH) {
      setError(t('too-long', { max: NOTE_MAX_LENGTH }));
      return;
    }
    busy.current = true;
    setAdded(false);
    setPending(true);
    setProblem(null);
    setError(undefined);
    const result = await callApi<AdminNote>(
      'POST',
      `ordering/admin/orders/${orderId}/notes`,
      { body: text.trim() },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      setText('');
      setAdded(true);
      router.refresh();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const code = result.failure.code;
    if (code === 'validation.failed') {
      const field = result.failure.details?.fields?.[0]?.code;
      setError(
        field === 'format'
          ? t('format')
          : field === 'too-long'
            ? t('too-long', { max: NOTE_MAX_LENGTH })
            : field === 'required'
              ? t('required')
              : t('problem.unknown'),
      );
      return;
    }
    setProblem(
      code === 'ordering.customer-erased'
        ? 'erased'
        : code === 'access.denied'
          ? 'denied'
          : 'unknown',
    );
  }

  return (
    <Card title={t('title')}>
      <p className="text-sm text-fg-muted">{t('intro')}</p>
      {notes === null ? (
        <Banner tone="attention">{t('unavailable')}</Banner>
      ) : notes.length === 0 ? (
        <p className="text-sm text-fg-muted">{t('empty')}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {notes.map((note) => (
            <li key={note.noteId} className="flex min-w-0 flex-col">
              {note.body === null ? (
                <span className="text-fg-muted italic">{t('erased-body')}</span>
              ) : (
                <span className="break-words whitespace-pre-wrap">{note.body}</span>
              )}
              <span className="text-sm text-fg-muted">
                {t('by', {
                  author: note.byYou ? t('you') : note.authorName?.trim() || t('unknown-author'),
                  at: formatInstant(note.createdAt, locale),
                })}
              </span>
            </li>
          ))}
        </ol>
      )}
      {canWrite && notes !== null ? (
        <form className="flex flex-col gap-3" onSubmit={(event) => void submit(event)} noValidate>
          {problem === null ? null : <Banner tone="critical">{t(`problem.${problem}`)}</Banner>}
          <TextAreaField
            label={t('add-label')}
            rows={3}
            value={text}
            disabled={pending}
            error={error}
            counter={`${length} / ${NOTE_MAX_LENGTH}`}
            onChange={(event) => {
              setText(event.target.value);
              setError(undefined);
            }}
          />
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="secondary" loading={pending}>
              {t('add')}
            </Button>
            <span role="status" className="text-sm text-fg-muted">
              {added ? t('added') : ''}
            </span>
          </div>
        </form>
      ) : null}
    </Card>
  );
}
