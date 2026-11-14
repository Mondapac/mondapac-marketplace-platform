'use client';

import { Banner, Button, Card, TextAreaField } from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { shortInstant } from '../catalog/format.ts';
import { NOTE_MAX_LENGTH, type SellerNote } from './types.ts';

type NoteProblem = 'erased' | 'denied' | 'gone' | 'invalid' | 'unavailable' | 'unknown';

/**
 * The shop's internal notes on one order: only the shop's team sees them, never the customer.
 * Notes are added, never edited. The list comes from the page server (null when it did not load);
 * a new note reads the page again. The form shows only when the role holds the note key.
 */
export function OrderNotes({
  sellerOrderId,
  notes,
  canWrite,
  csrfToken,
}: {
  readonly sellerOrderId: string;
  readonly notes: readonly SellerNote[] | null;
  readonly canWrite: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('orders.notes');
  const locale = useLocale();
  const zone = useTimeZone();
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
    const result = await callApi<SellerNote>(
      'POST',
      `ordering/seller/orders/${sellerOrderId}/notes`,
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
    const { failure } = result;
    if (failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (failure.code === 'validation.failed') {
      setProblem('invalid');
      return;
    }
    setProblem(
      failure.code === 'ordering.customer-erased'
        ? 'erased'
        : failure.code === 'access.denied'
          ? 'denied'
          : failure.code === 'ordering.seller-order-not-found'
            ? 'gone'
            : failure.status === 503 || failure.status === 0
              ? 'unavailable'
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
                  at: shortInstant(note.createdAt, locale, zone),
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
