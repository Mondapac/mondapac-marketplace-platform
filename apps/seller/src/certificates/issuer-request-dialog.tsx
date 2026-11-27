'use client';

import { Banner, Button, Dialog, FileButton, Icon, TextField } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { certificateProblemOf } from './errors.ts';
import { postWithProgress, readAsBase64, sizeText } from './upload.ts';
import { ISSUER_REQUEST_NAME_MAX, type CertificateDocumentLimits } from './types.ts';

/**
 * "My issuer isn't listed" (seller certificates design 7.3, CS6): the issuer's name as written on
 * the certificate and one file. The typed name is request text only: it is never put in the
 * Issuer field, and the certificate stays unsubmittable ("Checking your issuer") until an admin
 * adds the issuer and the seller chooses it. Full screen below 640 px.
 */
export function IssuerRequestDialog({
  open,
  typeCode,
  limits,
  csrfToken,
  onClose,
  onSent,
}: {
  readonly open: boolean;
  readonly typeCode: string;
  readonly limits: CertificateDocumentLimits | undefined;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onSent: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const [fileError, setFileError] = useState<string | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const busy = useRef(false);
  const nameField = useRef<HTMLDivElement>(null);
  const values = {
    maxSize: limits === undefined ? '' : sizeText(limits.maxBytes, locale),
    maxPages: limits?.maxPdfPages ?? 0,
  };

  function close() {
    if (busy.current) return;
    setProblem(null);
    setNameError(undefined);
    setFileError(undefined);
    onClose();
  }

  function pick(files: FileList | null) {
    const chosen = files?.[0] ?? null;
    setFileError(undefined);
    if (chosen === null) return;
    if (limits !== undefined && chosen.type !== '' && !limits.mediaTypes.includes(chosen.type)) {
      setFile(null);
      setFileError(t('certification.error.file.type-not-allowed'));
      return;
    }
    if (limits !== undefined && chosen.size > limits.maxBytes) {
      setFile(null);
      setFileError(t('certification.error.file.too-large', values));
      return;
    }
    setFile(chosen);
  }

  async function send() {
    if (busy.current) return;
    const trimmed = name.trim();
    const missingName = trimmed === '';
    setNameError(missingName ? t('certification.form.error.required') : undefined);
    setFileError(file === null ? t('certification.issuer-request.file.required') : undefined);
    if (missingName) nameField.current?.querySelector('input')?.focus();
    if (missingName || file === null) return;
    busy.current = true;
    setSending(true);
    setProblem(null);
    const data = await readAsBase64(file);
    if (data === null) {
      busy.current = false;
      setSending(false);
      setFileError(t('certification.upload.unreadable'));
      return;
    }
    const result = await postWithProgress<{ readonly issuerRequestId: string }>(
      'certification/seller/issuer-requests',
      { typeCode, issuerName: trimmed, data },
      csrfToken,
      () => undefined,
      () => undefined,
    );
    busy.current = false;
    setSending(false);
    if (result.ok) {
      setName('');
      setFile(null);
      onSent();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const found = certificateProblemOf(result.failure);
    if (found.key.startsWith('certification.error.file.')) {
      setFileError(t(found.key, values));
      return;
    }
    if (found.fields['issuerName'] !== undefined) {
      setNameError(t(found.fields['issuerName'], { max: ISSUER_REQUEST_NAME_MAX }));
      return;
    }
    setProblem(found.key);
  }

  return (
    <Dialog
      open={open}
      size="form"
      title={t('certification.issuer-request.title')}
      onClose={close}
      actions={
        <>
          <Button variant="secondary" onClick={close} disabled={sending}>
            {t('certification.action.cancel')}
          </Button>
          <Button
            onClick={() => void send()}
            loading={sending}
            loadingLabel={t('certification.issuer-request.sending')}
          >
            {t('certification.issuer-request.action.send')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Banner tone="info">{t('certification.issuer-request.help')}</Banner>
        {problem === null ? null : (
          <div aria-live="polite">
            <Banner
              tone={problem === 'certification.issuer-request.status.open' ? 'info' : 'critical'}
            >
              {t(problem, values)}
            </Banner>
          </div>
        )}
        <div ref={nameField}>
          <TextField
            label={t('certification.issuer-request.name.label')}
            value={name}
            maxLength={ISSUER_REQUEST_NAME_MAX}
            dir="auto"
            autoComplete="off"
            error={nameError}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-sm font-medium text-fg" id="issuer-request-file-label">
            {t('certification.issuer-request.file.label')}
          </span>
          <div className="flex flex-wrap items-center gap-3">
            <FileButton
              onFiles={pick}
              accept={limits?.mediaTypes.join(',') ?? 'image/jpeg,image/png,application/pdf'}
              aria-labelledby="issuer-request-file-label"
              aria-describedby={fileError === undefined ? undefined : 'issuer-request-file-error'}
            >
              {t('certification.issuer-request.file.choose')}
            </FileButton>
            <span className="min-w-0 truncate text-sm text-fg-secondary" dir="auto">
              {file === null
                ? t('certification.issuer-request.file.none')
                : `${file.name} · ${sizeText(file.size, locale)}`}
            </span>
          </div>
          {fileError === undefined ? null : (
            <p
              id="issuer-request-file-error"
              className="flex items-center gap-1.5 text-sm text-critical-fg"
            >
              <Icon name="alert-circle" className="size-4 shrink-0" />
              {fileError}
            </p>
          )}
        </div>
      </div>
    </Dialog>
  );
}
