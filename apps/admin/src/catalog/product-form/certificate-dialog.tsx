'use client';

import {
  Banner,
  Button,
  CheckboxRow,
  Dialog,
  FileButton,
  Icon,
  Select,
  SkeletonRows,
  TextField,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../../api/client.ts';
import {
  CERT_BASE,
  FILE_TYPES,
  MAX_FILE_BYTES,
  fileSize,
  mediaLabel,
  type CertCreated,
  type CertListItem,
  type CertOptions,
  type CertRecord,
  type CertVersioned,
  type PublishedVariant,
} from './certificate-types.ts';
import { readable } from './types.ts';

export type CertDialogMode =
  { readonly kind: 'new' } | { readonly kind: 'finish'; readonly item: CertListItem };

type Load =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'ready'; readonly options: CertOptions };

type FieldKey =
  'type' | 'issuer' | 'manufacturer' | 'number' | 'issue' | 'expires' | 'covers' | 'file';
type Errors = Partial<Record<FieldKey, string>>;

/** What a failed step tells the person; `after` is a step after the record was created. */
interface Failure {
  readonly stage: 'create' | 'after';
  readonly key: string;
  readonly stale: boolean;
}

const FIELD_ORDER: readonly FieldKey[] = [
  'type',
  'issuer',
  'manufacturer',
  'number',
  'issue',
  'expires',
  'covers',
  'file',
];
const FILE_CODES = new Set([
  'file.too-large',
  'file.unsupported-type',
  'file.unreadable',
  'file.too-many-pages',
  'file.encrypted',
  'file.active-content',
  'file.too-complex',
  'file.inspection-timeout',
  'file.infected',
]);

function failureKey(failure: ApiFailure): string {
  switch (failure.code) {
    case 'validation.failed':
      return 'invalid';
    case 'type.inactive':
    case 'issuer.not-active':
    case 'type.not-found':
      return 'unavailable';
    case 'access.denied':
      return 'denied';
    case 'request.throttled':
      return 'throttled';
    default:
      return 'none';
  }
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      resolve(text.slice(text.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}

export interface CertificateDialogProps {
  readonly open: boolean;
  readonly mode: CertDialogMode;
  readonly productId: string;
  readonly productTitle: string;
  /** The variants of the published revision: all a certificate can name. */
  readonly variants: readonly PublishedVariant[];
  readonly csrfToken: string;
  readonly marketName: string;
  readonly onClose: () => void;
  /** The record exists now (a draft); the list should show it. */
  readonly onCreated: () => void;
  /** The certificate was sent for review. */
  readonly onSent: () => void;
}

/**
 * "Add product certificate" and, for a draft left behind, "Finish product certificate". Send for
 * review runs the whole flow: create, save the draft, upload the document, submit. If a step after
 * the create fails the record stays a draft; the dialog says so and "Try again" resumes from the
 * step that failed, without creating a second record.
 */
export function CertificateDialog({
  open,
  mode,
  productId,
  productTitle,
  variants,
  csrfToken,
  marketName,
  onClose,
  onCreated,
  onSent,
}: CertificateDialogProps) {
  const t = useTranslations('catalog.productForm.certs');
  const tf = useTranslations('catalog.productForm.certs.dialog');
  const finishing = mode.kind === 'finish';
  const body = useRef<HTMLDivElement>(null);

  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [typeId, setTypeId] = useState(finishing ? mode.item.typeId : '');
  const [issuerId, setIssuerId] = useState('');
  const [manufacturer, setManufacturer] = useState('');
  const [number, setNumber] = useState('');
  const [numberSet, setNumberSet] = useState(false);
  const [issueDate, setIssueDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [coverAll, setCoverAll] = useState(true);
  const [picked, setPicked] = useState<readonly string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [attached, setAttached] = useState<{ kind: string; size: string } | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [showSummary, setShowSummary] = useState(false);
  const [focusTick, setFocusTick] = useState(0);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  // The record as the server holds it, which a retry continues instead of starting over.
  const record = useRef<{ id: string | null; version: number; uploaded: File | null }>({
    id: finishing ? mode.item.id : null,
    version: finishing ? mode.item.version : 0,
    uploaded: null,
  });
  // The coverage entries of other products on a draft that was started elsewhere: kept as they are.
  const others = useRef<{ productId: string; variantIds: string[] | null }[]>([]);
  const busy = useRef(false);

  const oneSize = variants.length <= 1;
  const options = load.kind === 'ready' ? load.options : null;
  const type = options?.types.find((item) => item.typeId === typeId);
  const typeName = type?.name ?? (finishing ? (mode.item.typeName ?? null) : null);
  const typeLabel = typeName ?? readable(type?.code ?? (finishing ? mode.item.typeCode : ''));
  const issuers = type?.issuers ?? [];

  function apply(draft: CertRecord): void {
    const d = draft.draft;
    setManufacturer(d.manufacturerName ?? '');
    setIssuerId(d.issuerId ?? '');
    setIssueDate(d.issueDate ?? '');
    setExpiryDate(d.expiryDate ?? '');
    setNumberSet(d.certificateNumberSet);
    setAttached(
      d.documents[0] === undefined
        ? null
        : { kind: mediaLabel(d.documents[0].mediaType), size: fileSize(d.documents[0].byteSize) },
    );
    const mine = d.coverage.filter((entry) => entry.productId === productId);
    const whole = mine.length === 0 || mine.some((entry) => entry.variantId === null);
    setCoverAll(whole);
    setPicked(
      whole
        ? []
        : mine
            .map((entry) => entry.variantId)
            .filter((id): id is string => id !== null && variants.some((v) => v.id === id)),
    );
    const byProduct = new Map<string, string[] | null>();
    for (const entry of d.coverage) {
      if (entry.productId === productId) continue;
      const list = byProduct.get(entry.productId);
      if (entry.variantId === null) byProduct.set(entry.productId, null);
      else if (list !== null) byProduct.set(entry.productId, [...(list ?? []), entry.variantId]);
    }
    others.current = [...byProduct].map(([id, variantIds]) => ({ productId: id, variantIds }));
    record.current = { ...record.current, id: draft.id, version: draft.version };
  }

  useEffect(() => {
    if (!open) return undefined;
    let current = true;
    void (async () => {
      const [optionsResult, recordResult] = await Promise.all([
        callApi<CertOptions>('GET', `${CERT_BASE}/options`),
        mode.kind === 'finish'
          ? callApi<CertRecord>('GET', `${CERT_BASE}/${mode.item.id}`)
          : Promise.resolve(null),
      ]);
      if (!current) return;
      for (const result of [optionsResult, recordResult]) {
        if (result !== null && !result.ok && result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
      }
      if (!optionsResult.ok || (recordResult !== null && !recordResult.ok)) {
        setLoad({ kind: 'failed' });
        return;
      }
      if (recordResult !== null && recordResult.ok) apply(recordResult.body);
      setLoad({ kind: 'ready', options: optionsResult.body });
    })();
    return () => {
      current = false;
    };
    // The dialog loads once per opening; `apply` only reads the props of that opening.
  }, [open]);

  // Focus moves to the first invalid field after a failed check.
  useEffect(() => {
    if (focusTick === 0) return;
    body.current
      ?.querySelector<HTMLElement>('[aria-invalid="true"], [data-invalid="true"]')
      ?.focus();
  }, [focusTick]);

  function validate(): Errors {
    const next: Errors = {};
    if (typeId === '') next.type = tf('error.type');
    if (issuerId === '') next.issuer = tf('error.issuer');
    if (manufacturer.trim() === '') next.manufacturer = tf('error.manufacturer');
    if (number.trim() === '' && !numberSet) next.number = tf('error.number');
    if (type?.requiresExpiry === true && expiryDate === '') next.expires = tf('error.expires');
    else if (issueDate !== '' && expiryDate !== '' && expiryDate <= issueDate) {
      next.expires = tf('error.expires-order');
    }
    if (!oneSize && !coverAll && picked.length === 0) next.covers = tf('error.covers');
    const needsFile = type?.requiresDocument ?? true;
    if (needsFile && file === null && attached === null && record.current.uploaded === null) {
      next.file = tf('error.file');
    }
    return next;
  }

  function coverage(): { productId: string; variantIds: string[] | null }[] {
    const mine = {
      productId,
      variantIds:
        oneSize || coverAll ? null : variants.filter((v) => picked.includes(v.id)).map((v) => v.id),
    };
    return [mine, ...others.current];
  }

  async function reloadRecord(): Promise<void> {
    const id = record.current.id;
    if (id === null) return;
    const result = await callApi<CertRecord>('GET', `${CERT_BASE}/${id}`);
    if (result.ok) {
      apply(result.body);
      setFailure(null);
    } else if (result.failure.status === 401) window.location.assign('/session-ended');
  }

  async function send(): Promise<void> {
    if (busy.current || load.kind !== 'ready') return;
    const found = validate();
    setErrors(found);
    const count = Object.keys(found).length;
    setShowSummary(count >= 3);
    if (count > 0) {
      setFocusTick((value) => value + 1);
      return;
    }
    busy.current = true;
    setSending(true);
    setFailure(null);
    const fail = (stage: Failure['stage'], failed: ApiFailure): void => {
      if (failed.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      const stale = failed.code === 'conflict.stale';
      if (FILE_CODES.has(failed.code)) {
        const key =
          failed.code === 'file.too-large'
            ? 'file-size'
            : failed.code === 'file.unsupported-type'
              ? 'file-type'
              : 'file-rejected';
        setErrors({ file: tf(`error.${key}`) });
        setFocusTick((value) => value + 1);
      } else if (failed.code === 'certificate.expired') {
        setErrors({ expires: tf('error.expired') });
        setFocusTick((value) => value + 1);
      }
      setFailure({ stage, key: stale ? 'stale' : failureKey(failed), stale });
    };
    const finish = () => {
      busy.current = false;
      setSending(false);
    };

    // 1. Create the record (once; a retry continues the one that exists).
    if (record.current.id === null) {
      const created = await callApi<CertCreated>('POST', CERT_BASE, { typeId }, csrfToken);
      if (!created.ok) {
        fail('create', created.failure);
        finish();
        return;
      }
      record.current = {
        ...record.current,
        id: created.body.certificateId,
        version: created.body.version,
      };
      onCreated();
    }
    const id = record.current.id ?? '';

    // 2. Save the draft.
    const saved = await callApi<CertVersioned>(
      'PUT',
      `${CERT_BASE}/${id}/draft`,
      {
        version: record.current.version,
        manufacturerName: manufacturer.trim(),
        issuerId,
        ...(number.trim() === '' ? {} : { certificateNumber: number.trim() }),
        issueDate: issueDate === '' ? null : issueDate,
        expiryDate: expiryDate === '' ? null : expiryDate,
        coverage: coverage(),
      },
      csrfToken,
    );
    if (!saved.ok) {
      fail('after', saved.failure);
      finish();
      return;
    }
    record.current = { ...record.current, version: saved.body.version };

    // 3. Upload the document (a file already uploaded in this dialog is not sent again).
    if (file !== null && record.current.uploaded !== file) {
      let data: string;
      try {
        data = await toBase64(file);
      } catch {
        setErrors({ file: tf('error.file-rejected') });
        setFailure({ stage: 'after', key: 'none', stale: false });
        finish();
        return;
      }
      const uploaded = await callApi<CertVersioned>(
        'POST',
        `${CERT_BASE}/${id}/documents`,
        { version: record.current.version, data },
        csrfToken,
      );
      if (!uploaded.ok) {
        fail('after', uploaded.failure);
        finish();
        return;
      }
      record.current = { ...record.current, version: uploaded.body.version, uploaded: file };
    }

    // 4. Submit for review.
    const submitted = await callApi<CertVersioned>(
      'POST',
      `${CERT_BASE}/${id}/submit`,
      { version: record.current.version },
      csrfToken,
    );
    if (!submitted.ok) {
      fail('after', submitted.failure);
      finish();
      return;
    }
    finish();
    onSent();
  }

  function close(): void {
    if (sending) setConfirmClose(true);
    else onClose();
  }

  function pickFile(files: FileList | null): void {
    const chosen = files?.[0];
    if (chosen === undefined) return;
    if (!FILE_TYPES.includes(chosen.type)) {
      setFile(null);
      setErrors((current) => ({ ...current, file: tf('error.file-type') }));
      return;
    }
    if (chosen.size > MAX_FILE_BYTES) {
      setFile(null);
      setErrors((current) => ({ ...current, file: tf('error.file-size') }));
      return;
    }
    setFile(chosen);
    setErrors((current) => ({ ...current, file: undefined }));
  }

  const noTypes = load.kind === 'ready' && load.options.types.length === 0 && !finishing;
  const issuerHelp =
    typeId === ''
      ? undefined
      : issuers.length === 0
        ? tf('field.issuer-none', { type: typeLabel, market: marketName })
        : tf('field.issuer-hint', { type: typeLabel, market: marketName });
  const messages = FIELD_ORDER.map((key) => errors[key]).filter(
    (message): message is string => message !== undefined,
  );
  const afterCreate = failure?.stage === 'after';
  const requiresExpiry = type?.requiresExpiry === true;

  return (
    <Dialog
      open={open}
      size="form"
      title={tf(finishing ? 'title-finish' : 'title-add')}
      onClose={close}
      actions={
        <>
          <Button variant="secondary" onClick={close}>
            {tf('cancel')}
          </Button>
          {noTypes || load.kind === 'failed' ? null : (
            <Button
              loading={sending}
              disabled={load.kind === 'loading'}
              onClick={() => void send()}
            >
              {sending ? tf('sending') : afterCreate ? tf('try-again') : tf('send')}
            </Button>
          )}
        </>
      }
    >
      <div ref={body} className="flex flex-col gap-4">
        <p className="text-sm text-fg-muted">{tf('subtitle', { title: productTitle })}</p>
        {confirmClose ? (
          <Banner tone="attention">
            <p>{tf('confirm.message')}</p>
            <div className="mt-2 flex flex-wrap gap-3">
              <Button variant="secondary" onClick={() => setConfirmClose(false)}>
                {tf('confirm.keep')}
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setConfirmClose(false);
                  onClose();
                }}
              >
                {tf('confirm.close')}
              </Button>
            </div>
          </Banner>
        ) : null}
        {failure === null ? null : (
          <Banner tone="critical">
            <p>{tf(afterCreate ? 'failed.draft' : 'failed.create')}</p>
            {failure.key === 'none' ? null : <p className="mt-1">{tf(`failed.${failure.key}`)}</p>}
            {failure.stale ? (
              <Button variant="link" onClick={() => void reloadRecord()}>
                {tf('failed.reload')}
              </Button>
            ) : null}
          </Banner>
        )}
        {showSummary && messages.length >= 3 ? (
          <Banner tone="critical">
            <p className="font-semibold">{tf('error.summary', { count: messages.length })}</p>
            <ul className="mt-1 list-disc ps-5">
              {messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          </Banner>
        ) : null}
        {load.kind === 'loading' ? (
          <SkeletonRows label={tf('loading')} rows={4} />
        ) : load.kind === 'failed' ? (
          <Banner tone="critical">{tf('load-failed')}</Banner>
        ) : noTypes ? (
          <Banner tone="info">{tf('no-types', { market: marketName })}</Banner>
        ) : (
          <>
            <Select
              name="typeId"
              label={tf('field.type')}
              help={tf('field.type-hint')}
              placeholder={tf('choose')}
              disabled={finishing || afterCreate || sending}
              value={typeId}
              error={errors.type}
              options={
                finishing && type === undefined
                  ? [{ value: typeId, label: typeLabel }]
                  : (options?.types ?? []).map((item) => ({
                      value: item.typeId,
                      label: item.name ?? readable(item.code),
                    }))
              }
              onChange={(event) => {
                setTypeId(event.target.value);
                setIssuerId('');
              }}
            />
            <Select
              name="issuerId"
              label={tf('field.issuer')}
              {...(issuerHelp === undefined ? {} : { help: issuerHelp })}
              placeholder={tf('choose')}
              disabled={typeId === '' || issuers.length === 0 || sending}
              value={issuerId}
              error={errors.issuer}
              options={issuers.map((issuer) => ({
                value: issuer.issuerId,
                label: issuer.displayName,
              }))}
              onChange={(event) => setIssuerId(event.target.value)}
            />
            <TextField
              name="manufacturerName"
              label={tf('field.manufacturer')}
              help={tf('field.manufacturer-hint')}
              maxLength={200}
              disabled={sending}
              value={manufacturer}
              error={errors.manufacturer}
              onChange={(event) => setManufacturer(event.target.value)}
            />
            <TextField
              name="certificateNumber"
              label={tf(numberSet ? 'field.number-saved' : 'field.number')}
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-sm"
              disabled={sending}
              {...(numberSet ? { placeholder: tf('field.number-placeholder') } : {})}
              value={number}
              error={errors.number}
              onChange={(event) => setNumber(event.target.value)}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                name="issueDate"
                type="date"
                label={tf('field.issue')}
                disabled={sending}
                value={issueDate}
                error={errors.issue}
                onChange={(event) => setIssueDate(event.target.value)}
              />
              <TextField
                name="expiryDate"
                type="date"
                label={tf(requiresExpiry ? 'field.expires-required' : 'field.expires-optional')}
                disabled={sending}
                value={expiryDate}
                error={errors.expires}
                onChange={(event) => setExpiryDate(event.target.value)}
              />
            </div>
            {oneSize ? (
              <div className="flex flex-col gap-1.5">
                <p className="text-sm font-medium text-fg">{tf('field.covers')}</p>
                <p className="text-sm text-fg-secondary">{t('covers.whole')}</p>
              </div>
            ) : (
              <>
                <Select
                  name="covers"
                  label={tf('field.covers')}
                  help={tf('field.covers-hint')}
                  disabled={sending}
                  value={coverAll ? 'all' : 'some'}
                  options={[
                    { value: 'all', label: t('covers.all') },
                    { value: 'some', label: tf('field.covers-some') },
                  ]}
                  onChange={(event) => setCoverAll(event.target.value === 'all')}
                />
                {coverAll ? null : (
                  <fieldset
                    className="flex min-w-0 flex-col gap-1"
                    aria-describedby="cert-variants-help"
                  >
                    <legend className="text-sm font-medium text-fg">{tf('field.variants')}</legend>
                    <p id="cert-variants-help" className="text-sm text-fg-muted">
                      {tf('field.variants-hint')}
                    </p>
                    {variants.length > 8 ? (
                      <div className="flex gap-3">
                        <Button
                          variant="link"
                          onClick={() => setPicked(variants.map((variant) => variant.id))}
                        >
                          {tf('field.select-all')}
                        </Button>
                        <Button variant="link" onClick={() => setPicked([])}>
                          {tf('field.clear')}
                        </Button>
                      </div>
                    ) : null}
                    <div className="max-h-60 overflow-y-auto">
                      {variants.map((variant, index) => (
                        <div key={variant.id}>
                          {variant.group !== '' && variant.group !== variants[index - 1]?.group ? (
                            <p className="pt-2 text-xs font-semibold text-fg-muted">
                              {variant.group}
                            </p>
                          ) : null}
                          <CheckboxRow
                            touch
                            label={variant.label}
                            disabled={sending}
                            checked={picked.includes(variant.id)}
                            {...(errors.covers !== undefined && index === 0
                              ? { 'data-invalid': 'true' }
                              : {})}
                            onChange={(event) =>
                              setPicked(
                                event.target.checked
                                  ? [...picked, variant.id]
                                  : picked.filter((id) => id !== variant.id),
                              )
                            }
                          />
                        </div>
                      ))}
                    </div>
                    {errors.covers === undefined ? null : (
                      <p className="text-sm text-critical-fg">{errors.covers}</p>
                    )}
                  </fieldset>
                )}
              </>
            )}
            <div className="flex flex-col gap-1.5">
              <p id="cert-file-label" className="text-sm font-medium text-fg">
                {tf('field.document')}
              </p>
              <div
                className={`flex items-center gap-3 rounded-md border px-3 py-2 ${
                  errors.file === undefined ? 'border-line-input' : 'border-critical-solid'
                }`}
              >
                <Icon name="file" className="shrink-0 text-icon" />
                <span className="min-w-0 flex-1 break-words text-sm text-fg">
                  {file !== null
                    ? `${file.name} · ${fileSize(file.size)}`
                    : attached !== null
                      ? tf('field.attached', attached)
                      : ''}
                </span>
                {record.current.uploaded !== null && record.current.uploaded === file ? null : (
                  <FileButton
                    accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                    disabled={sending}
                    onFiles={pickFile}
                    aria-labelledby="cert-file-label"
                    aria-describedby={
                      errors.file === undefined
                        ? 'cert-file-help'
                        : 'cert-file-help cert-file-error'
                    }
                    {...(errors.file === undefined ? {} : { 'aria-invalid': true })}
                  >
                    {tf(file !== null || attached !== null ? 'field.replace' : 'field.choose-file')}
                  </FileButton>
                )}
              </div>
              <p id="cert-file-help" className="text-sm text-fg-muted">
                {tf('field.document-hint')}
              </p>
              {errors.file === undefined ? null : (
                <p id="cert-file-error" className="text-sm text-critical-fg">
                  {errors.file}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
