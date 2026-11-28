'use client';

import { Banner, Button, FileButton, Icon, SettingsSection } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react';
import { callApi } from '../api/client.ts';
import { certificateProblemOf } from './errors.ts';
import { mediaLabel, mediaList, postWithProgress, readAsBase64, sizeText } from './upload.ts';
import {
  certificateDocumentPath,
  type CertificateDocument,
  type CertificateDocumentLimits,
  type CertificateDocumentUploaded,
} from './types.ts';

// The Documents card of the certificate form (seller certificates design section 7, CS3). A file
// goes to the server the moment it is chosen; each row has its own state: uploading (a bar and a
// percentage), checking, ready, or "Can't use this file" with the reason. Every change of state is
// announced politely. A refused file is never stored, so it never has Download; a stored file
// downloads as an attachment only (the relay and the API both say so).

type Phase = 'uploading' | 'checking' | 'ready' | 'refused' | 'removing';

interface Row {
  /** A stable key for React: the document id once stored, a local id before. */
  readonly key: string;
  readonly documentId: string | null;
  /** The name of the file the seller chose, on this page only; the server keeps no name. */
  readonly name: string | null;
  readonly mediaType: string | null;
  readonly byteSize: number;
  readonly pageCount: number | null;
  readonly position: number;
  readonly phase: Phase;
  /** 0 to 1 while uploading. */
  readonly progress: number;
  /** Why the file can't be used: a message key. */
  readonly reasonKey: string | null;
}

function rowOf(document: CertificateDocument, name: string | null = null): Row {
  return {
    key: document.documentId,
    documentId: document.documentId,
    name,
    mediaType: document.mediaType,
    byteSize: document.byteSize,
    pageCount: document.pageCount,
    position: document.position,
    phase: 'ready',
    progress: 1,
    reasonKey: null,
  };
}

/** The stored files of the card, in their order: what the review page lists too. */
export function orderedDocuments(
  documents: readonly CertificateDocument[],
): readonly CertificateDocument[] {
  return [...documents].sort((a, b) => a.position - b.position);
}

let localIds = 0;

/** The seller confirmed that this change withdraws the pending submission (API `withdrawPending`). */
export const WITHDRAW_QUERY = '?withdrawPending=true';

export function DocumentsCard({
  certificateId,
  documents,
  limits,
  editable,
  required,
  csrfToken,
  error,
  onBusyChange,
  onDocumentsChange,
  confirmWithdraw,
  onWithdrawn,
}: {
  readonly certificateId: string;
  readonly documents: readonly CertificateDocument[];
  readonly limits: CertificateDocumentLimits | undefined;
  readonly editable: boolean;
  /** The type needs a file before it can be submitted. */
  readonly required: boolean;
  readonly csrfToken: string;
  /** A field error from the form ("Add a file."), shown on the card. */
  readonly error?: string | undefined;
  /** An upload or a removal is under way: the form waits before it reviews. */
  readonly onBusyChange?: (busy: boolean) => void;
  /** The stored files changed (one added or removed). */
  readonly onDocumentsChange?: (documents: readonly CertificateDocument[]) => void;
  /**
   * Set while a submission is under review (design 7.2): adding or removing a file withdraws it,
   * so the card asks first ("Save and withdraw your submission?"); false keeps everything as it is.
   */
  readonly confirmWithdraw?: (() => Promise<boolean>) | undefined;
  /** A change withdrew the pending submission: the form reads the record again. */
  readonly onWithdrawn?: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [rows, setRows] = useState<readonly Row[]>(() =>
    orderedDocuments(documents).map((document) => rowOf(document)),
  );
  const [announcement, setAnnouncement] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const focusPicker = useRef(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const stored = rows.filter((row) => row.documentId !== null && row.phase !== 'refused');
  const inFlight = rows.filter((row) => row.phase === 'uploading' || row.phase === 'checking');
  const busy = inFlight.length > 0 || rows.some((row) => row.phase === 'removing');
  const atLimit = limits !== undefined && stored.length + inFlight.length >= limits.maxFiles;
  const canAdd = editable && !atLimit;

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  // The form and the review page count the stored files; tell the form when the set changes.
  const storedKey = stored.map((row) => row.documentId).join(',');
  const firstKey = useRef(storedKey);
  useEffect(() => {
    if (storedKey === firstKey.current) return;
    firstKey.current = storedKey;
    onDocumentsChange?.(storedOf(rowsRef.current));
  }, [storedKey, onDocumentsChange]);

  // A removed file takes its Remove button with it: focus goes to the way to add another.
  useLayoutEffect(() => {
    if (!focusPicker.current) return;
    focusPicker.current = false;
    input.current?.focus();
  });

  const values = {
    maxSize: limits === undefined ? '' : sizeText(limits.maxBytes, locale),
    maxPages: limits?.maxPdfPages ?? 0,
    maxFiles: limits?.maxFiles ?? 0,
  };

  function update(key: string, change: Partial<Row>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...change } : row)));
  }

  function storedOf(next: readonly Row[]): readonly CertificateDocument[] {
    return next
      .filter((row) => row.documentId !== null && row.phase !== 'refused')
      .map((row) => ({
        documentId: row.documentId ?? '',
        position: row.position,
        mediaType: row.mediaType ?? '',
        byteSize: row.byteSize,
        pageCount: row.pageCount,
        createdAt: '',
      }));
  }

  function rowLabel(row: Row, index: number): string {
    return row.name ?? t('certification.upload.page', { number: index + 1 });
  }

  function announce(name: string, statusKey: string) {
    setAnnouncement(t('certification.upload.announce', { name, status: t(statusKey) }));
  }

  /** The panel's own checks before a byte is sent: the API's kinds and size limit. */
  function refusedBeforeUpload(file: File): string | null {
    if (limits === undefined) return null;
    if (file.type !== '' && !limits.mediaTypes.includes(file.type)) {
      return 'certification.error.file.type-not-allowed';
    }
    if (file.size > limits.maxBytes) return 'certification.error.file.too-large';
    return null;
  }

  async function uploadOne(file: File, replacing: string | null, withdraw: boolean) {
    localIds += 1;
    const key = `local-${localIds}`;
    const row: Row = {
      key,
      documentId: null,
      name: file.name === '' ? null : file.name,
      mediaType: file.type === '' ? null : file.type,
      byteSize: file.size,
      pageCount: null,
      position: Number.MAX_SAFE_INTEGER,
      phase: 'uploading',
      progress: 0,
      reasonKey: null,
    };
    setRows((current) => {
      const index = replacing === null ? -1 : current.findIndex((item) => item.key === replacing);
      if (index < 0) return [...current, row];
      const next = [...current];
      next[index] = row;
      return next;
    });
    const name = row.name ?? t('certification.upload.this-file');
    announce(name, 'certification.upload.status.uploading-short');

    const early = refusedBeforeUpload(file);
    if (early !== null) {
      update(key, { phase: 'refused', reasonKey: early });
      announce(name, 'certification.upload.status.refused');
      return;
    }
    const data = await readAsBase64(file);
    if (data === null) {
      update(key, { phase: 'refused', reasonKey: 'certification.upload.unreadable' });
      announce(name, 'certification.upload.status.refused');
      return;
    }
    const result = await postWithProgress<CertificateDocumentUploaded>(
      `certification/seller/certificates/${certificateId}/documents${withdraw ? WITHDRAW_QUERY : ''}`,
      { data },
      csrfToken,
      (share) => update(key, { progress: share }),
      () => {
        update(key, { phase: 'checking', progress: 1 });
        announce(name, 'certification.upload.status.checking');
      },
    );
    if (result.ok) {
      const stored: Row = { ...rowOf(result.body, row.name), key };
      setRows((current) => current.map((item) => (item.key === key ? stored : item)));
      announce(name, 'certification.upload.status.ready');
      if (result.body.withdrawnSubmissionId !== null) onWithdrawn?.();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const problem = certificateProblemOf(result.failure);
    update(key, { phase: 'refused', reasonKey: problem.key });
    announce(name, 'certification.upload.status.refused');
  }

  async function choose(files: FileList | readonly File[] | null, replacing: string | null = null) {
    if (files === null || !editable) return;
    const list = Array.from(files);
    if (input.current !== null) input.current.value = '';
    if (list.length === 0) return;
    // Under review, the first file withdraws the submission: ask once for the whole choice.
    const withdraw = confirmWithdraw !== undefined;
    if (withdraw && !(await confirmWithdraw())) return;
    setNotice(null);
    const current = rowsRef.current;
    const taken = current.filter(
      (row) =>
        (row.documentId !== null && row.phase !== 'refused') ||
        row.phase === 'uploading' ||
        row.phase === 'checking',
    ).length;
    const room = limits === undefined ? list.length : Math.max(0, limits.maxFiles - taken);
    const accepted = list.slice(0, room);
    if (accepted.length < list.length) setNotice('certification.error.upload.limit');
    accepted.forEach((file, index) => {
      void uploadOne(file, index === 0 ? replacing : null, withdraw);
    });
  }

  async function remove(row: Row, index: number) {
    const name = rowLabel(row, index);
    if (row.documentId === null) {
      // A refused file was never stored: it only leaves the page.
      focusPicker.current = true;
      setRows((current) => current.filter((item) => item.key !== row.key));
      announce(name, 'certification.upload.status.removed');
      return;
    }
    const withdraw = confirmWithdraw !== undefined;
    if (withdraw && !(await confirmWithdraw())) return;
    update(row.key, { phase: 'removing' });
    const result = await callApi<{
      readonly removed: true;
      readonly withdrawnSubmissionId?: string | null;
    }>(
      'DELETE',
      `certification/seller/certificates/${certificateId}/documents/${row.documentId}${withdraw ? WITHDRAW_QUERY : ''}`,
      undefined,
      csrfToken,
    );
    if (result.ok) {
      focusPicker.current = true;
      setRows((current) => current.filter((item) => item.key !== row.key));
      announce(name, 'certification.upload.status.removed');
      if (typeof result.body.withdrawnSubmissionId === 'string') onWithdrawn?.();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    update(row.key, { phase: 'ready' });
    const problem = certificateProblemOf(result.failure);
    setNotice(problem.key);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    if (!canAdd) return;
    void choose(event.dataTransfer.files);
  }

  const help =
    limits === undefined
      ? t('certification.upload.help-plain')
      : t('certification.upload.help', {
          kinds: mediaList(limits.mediaTypes, locale),
          maxSize: values.maxSize,
          maxFiles: limits.maxFiles,
          maxPages: limits.maxPdfPages,
        });
  const accept = limits?.mediaTypes.join(',') ?? 'image/jpeg,image/png,application/pdf';

  return (
    <SettingsSection title={t('certification.upload.title')}>
      <div
        id="certificate-documents"
        tabIndex={-1}
        className="flex flex-col gap-4 px-5 py-4 outline-none"
      >
        <p className="text-sm text-fg-secondary">{help}</p>
        {error === undefined ? null : (
          <p className="flex items-center gap-1.5 text-sm text-critical-fg">
            <Icon name="alert-circle" className="size-4 shrink-0" />
            {error}
          </p>
        )}
        {editable ? (
          <div
            onDragOver={(event) => {
              if (!canAdd) return;
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center text-sm sm:flex-row ${
              dragging ? 'border-accent bg-info-bg' : 'border-line'
            }`}
          >
            <span className="text-fg-secondary max-sm:hidden">
              {t('certification.upload.drop')}
            </span>
            <FileButton
              inputRef={input}
              onFiles={(files) => void choose(files)}
              multiple
              accept={accept}
              disabled={!canAdd}
              aria-describedby={atLimit ? 'certificate-documents-limit' : undefined}
            >
              {t('certification.upload.choose')}
            </FileButton>
          </div>
        ) : null}
        {atLimit && editable ? (
          <p id="certificate-documents-limit" className="text-sm text-fg-secondary">
            {t('certification.error.upload.limit')}
          </p>
        ) : null}
        {notice === null ? null : <Banner tone="attention">{t(notice, values)}</Banner>}
        {rows.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {required ? t('certification.upload.empty-required') : t('certification.upload.empty')}
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
            {rows.map((row, index) => (
              <DocumentRow
                key={row.key}
                row={row}
                label={rowLabel(row, index)}
                certificateId={certificateId}
                editable={editable}
                locale={locale}
                reason={row.reasonKey === null ? null : t(row.reasonKey, values)}
                onRemove={() => void remove(row, index)}
                onReplace={(files) => void choose(files, row.key)}
                accept={accept}
              />
            ))}
          </ul>
        )}
        <p aria-live="polite" role="status" className="sr-only">
          {announcement}
        </p>
      </div>
    </SettingsSection>
  );
}

function DocumentRow({
  row,
  label,
  certificateId,
  editable,
  locale,
  reason,
  onRemove,
  onReplace,
  accept,
}: {
  readonly row: Row;
  readonly label: string;
  readonly certificateId: string;
  readonly editable: boolean;
  readonly locale: string;
  readonly reason: string | null;
  readonly onRemove: () => void;
  readonly onReplace: (files: FileList | null) => void;
  readonly accept: string;
}) {
  const t = useTranslations();
  const refused = row.phase === 'refused';
  const percent = Math.round(row.progress * 100);
  const meta = [
    row.mediaType === null ? null : mediaLabel(row.mediaType),
    row.pageCount === null ? null : t('certification.upload.pages', { count: row.pageCount }),
    row.byteSize > 0 ? sizeText(row.byteSize, locale) : null,
  ].filter((part): part is string => part !== null);
  const percentText = new Intl.NumberFormat(locale, { style: 'percent' }).format(
    Math.min(1, row.progress),
  );

  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Icon
          name={refused ? 'alert-triangle' : 'file'}
          className={`mt-0.5 size-5 shrink-0 ${refused ? 'text-critical-fg' : 'text-fg-muted'}`}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate font-medium text-fg" dir="auto">
            {label}
          </span>
          {meta.length === 0 ? null : (
            <span className="text-xs text-fg-muted">{meta.join(' · ')}</span>
          )}
          {row.phase === 'uploading' ? (
            <div className="flex items-center gap-2">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-label={t('certification.upload.progress', { name: label })}
                className="h-1.5 w-full max-w-60 overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full rounded-full bg-accent" style={{ width: `${percent}%` }} />
              </div>
              <span className="text-xs text-fg-secondary tabular-nums">
                {t('certification.upload.status.uploading', { percent: percentText })}
              </span>
            </div>
          ) : null}
          {row.phase === 'checking' ? (
            <span className="text-xs text-fg-secondary">
              {t('certification.upload.status.checking')}
            </span>
          ) : null}
          {refused ? (
            <span className="text-sm text-critical-fg">
              <span className="font-medium">{t('certification.upload.status.refused')}</span>
              {reason === null ? null : <> {reason}</>}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {row.phase === 'ready' || row.phase === 'removing' ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-success-fg">
            <Icon name="check" className="size-4" />
            {t('certification.upload.status.ready')}
          </span>
        ) : null}
        {row.documentId !== null && !refused ? (
          <a
            href={certificateDocumentPath(certificateId, row.documentId)}
            download
            className="inline-flex h-(--mp-size-control-sm) items-center gap-1 rounded-md px-2 text-sm font-medium text-link hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            aria-label={t('certification.upload.action.download-named', { name: label })}
          >
            <Icon name="download" className="size-4" />
            {t('certification.upload.action.download')}
          </a>
        ) : null}
        {editable && refused ? (
          <FileButton onFiles={onReplace} accept={accept}>
            {t('certification.upload.action.replace')}
          </FileButton>
        ) : null}
        {editable && (row.phase === 'ready' || row.phase === 'removing' || refused) ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={onRemove}
            loading={row.phase === 'removing'}
            aria-label={t('certification.upload.action.remove-named', { name: label })}
          >
            {t('certification.upload.action.remove')}
          </Button>
        ) : null}
      </div>
    </li>
  );
}
