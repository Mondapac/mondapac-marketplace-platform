'use client';

import { Banner, Button, Card, Dialog, SkeletonRows, TextAreaField, toast } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { timeOf } from './format.ts';
import {
  NOTES_WRITE,
  NOTE_MAX,
  type CustomerNote,
  type CustomerNotesPage,
} from './groups-types.ts';

/** The first notes shown (spec: five), then older ones 20 at a time. */
const FIRST = 5;
const PAGE = 20;

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'hidden' }
  | {
      readonly state: 'ready';
      readonly items: readonly CustomerNote[];
      readonly total: number;
      readonly nextCursor: string | null;
    };

/**
 * Internal notes about a customer (customers management phase 2a), on the Overview: newest first,
 * each with its author and time in the admin's zone, the newest five, then 20 at a time with "Show older notes". Plain
 * text, shown as written (never as markup), and never shown to the customer or a seller. Notes
 * are written once and never changed or removed, as order notes. "Add note…" needs
 * `customers.customer-notes.write`.
 */
export function CustomerNotes({
  accountId,
  keys,
  csrfToken,
  zone,
  onAdded,
}: {
  readonly accountId: string;
  readonly keys: ReadonlySet<string>;
  readonly csrfToken: string;
  readonly zone: string;
  /** After a note was added (the activity card shows it). */
  readonly onAdded?: () => void;
}) {
  const t = useTranslations('customers.notes');
  const locale = useLocale();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [more, setMore] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [adding, setAdding] = useState(false);
  const id = encodeURIComponent(accountId);

  const read = useCallback(async () => {
    setLoad({ state: 'loading' });
    const result = await callApi<CustomerNotesPage>(
      'GET',
      `customers/admin/customers/${id}/notes?limit=${FIRST}`,
    );
    if (result.ok) {
      setLoad({ state: 'ready', ...result.body });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    // Spec section 8: a section the admin may not read is hidden, not shown as an error.
    setLoad({ state: result.failure.status === 403 ? 'hidden' : 'failed' });
  }, [id]);

  useEffect(() => {
    void read();
  }, [read]);

  async function older() {
    if (load.state !== 'ready' || load.nextCursor === null) return;
    setMore('loading');
    const result = await callApi<CustomerNotesPage>(
      'GET',
      `customers/admin/customers/${id}/notes?limit=${PAGE}&cursor=${encodeURIComponent(load.nextCursor)}`,
    );
    if (!result.ok) {
      setMore('failed');
      return;
    }
    setMore('idle');
    setLoad((current) =>
      current.state !== 'ready'
        ? current
        : {
            state: 'ready',
            items: [...current.items, ...result.body.items],
            total: result.body.total,
            nextCursor: result.body.nextCursor,
          },
    );
  }

  if (load.state === 'hidden') return null;
  const canWrite = keys.has(NOTES_WRITE);
  const count = load.state === 'ready' ? load.total : null;
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">
          {count === null
            ? t('title')
            : t('title-count', { count: numberFormat(locale, {}).format(count) })}
        </h2>
        {canWrite ? (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            {t('add')}
          </Button>
        ) : null}
      </div>
      {load.state === 'loading' ? (
        <SkeletonRows label={t('loading')} rows={2} />
      ) : load.state === 'failed' ? (
        <Banner tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t('failed')}</span>
            <Button variant="secondary" onClick={() => void read()}>
              {t('retry')}
            </Button>
          </div>
        </Banner>
      ) : load.items.length === 0 ? (
        <p className="text-fg-muted">{t('empty')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          <ol className="flex flex-col divide-y divide-line-row" aria-label={t('list-label')}>
            {load.items.map((note) => (
              <li key={note.noteId} className="flex flex-col gap-1 py-3 first:pt-0">
                <p className="text-sm text-fg-muted">
                  {t('by', {
                    author: note.byYou ? t('you') : (note.authorName ?? t('former-admin')),
                    time: timeOf(note.createdAt, locale, zone),
                  })}
                </p>
                {note.body === null ? (
                  <p className="text-fg-muted italic">{t('erased')}</p>
                ) : (
                  <p className="whitespace-pre-wrap wrap-anywhere">{note.body}</p>
                )}
              </li>
            ))}
          </ol>
          {load.nextCursor === null ? null : (
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="secondary" loading={more === 'loading'} onClick={() => void older()}>
                {t('older')}
              </Button>
              {more === 'failed' ? (
                <span role="alert" className="text-sm text-critical-fg">
                  {t('older-failed')}
                </span>
              ) : null}
            </div>
          )}
        </div>
      )}
      <AddNoteDialog
        open={adding}
        accountId={accountId}
        csrfToken={csrfToken}
        onClose={() => setAdding(false)}
        onAdded={() => {
          void read();
          onAdded?.();
        }}
      />
    </Card>
  );
}

function AddNoteDialog({
  open,
  accountId,
  csrfToken,
  onClose,
  onAdded,
}: {
  readonly open: boolean;
  readonly accountId: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onAdded: () => void;
}) {
  const t = useTranslations('customers.notes');
  const locale = useLocale();
  const [body, setBody] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    if (open) {
      setBody('');
      setFieldError(null);
      setError(null);
    }
  }, [open]);

  async function save() {
    if (busy.current) return;
    const text = body.trim();
    if (text === '') {
      setFieldError(t('error.required'));
      return;
    }
    if (text.length > NOTE_MAX) {
      setFieldError(t('error.long', { max: NOTE_MAX }));
      return;
    }
    busy.current = true;
    setPending(true);
    setError(null);
    const result = await callApi(
      'POST',
      `customers/admin/customers/${encodeURIComponent(accountId)}/notes`,
      { body: text },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t('added'));
      onAdded();
      onClose();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (result.failure.code === 'validation.failed') setFieldError(t('error.invalid'));
    else setError(t(result.failure.status === 403 ? 'error.denied' : 'error.unavailable'));
  }

  const close = () => {
    if (!pending) onClose();
  };
  const used = numberFormat(locale, {}).format(body.length);
  return (
    <Dialog
      open={open}
      title={t('add-title')}
      onClose={close}
      size="form"
      actions={
        <>
          <Button variant="secondary" disabled={pending} onClick={close}>
            {t('cancel')}
          </Button>
          <Button loading={pending} onClick={() => void save()}>
            {t('save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <TextAreaField
          label={t('field')}
          help={t('field-help')}
          value={body}
          maxLength={NOTE_MAX}
          rows={6}
          counter={t('counter', { used, max: numberFormat(locale, {}).format(NOTE_MAX) })}
          error={fieldError ?? undefined}
          onChange={(event) => setBody(event.target.value)}
        />
        {error === null ? null : (
          <p role="alert" className="text-sm text-critical-fg">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
