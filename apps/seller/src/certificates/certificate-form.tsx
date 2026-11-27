'use client';

import {
  Banner,
  Button,
  Dialog,
  FormActionBar,
  Menu,
  SettingCheckbox,
  SettingInput,
  SettingRow,
  SettingSelect,
  SettingTextArea,
  SettingsErrorSummary,
  SettingsPage,
  SettingsSection,
  SettingsViewOnlyBanner,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { certificateProblemOf, type CertificateProblem } from './errors.ts';
import { opensOnForm } from './status.ts';
import { CertificateStatusBadge } from './status-badge.tsx';
import {
  CERTIFICATE_NUMBER_MAX,
  CERTIFICATES_PATH,
  DECLARATION_NOTE_MAX,
  typeName,
  type CertificateDetail,
  type CertificateDraft,
  type CertificateDraftSaved,
  type CertificateSummary,
  type CertificateTypeOption,
} from './types.ts';

/** The draft as the form holds it: text fields as text, so an empty field is ''. */
interface Values {
  readonly issuerId: string;
  readonly certificateNumber: string;
  readonly issueDate: string;
  readonly expiryDate: string;
  readonly selfDeclared: boolean;
  readonly selfDeclarationNote: string;
}

const FIELDS = [
  'issuerId',
  'certificateNumber',
  'issueDate',
  'expiryDate',
  'selfDeclared',
  'selfDeclarationNote',
] as const;

function valuesOf(draft: CertificateDraft): Values {
  return {
    issuerId: draft.issuerId ?? '',
    certificateNumber: draft.certificateNumber ?? '',
    issueDate: draft.issueDate ?? '',
    expiryDate: draft.expiryDate ?? '',
    selfDeclared: draft.selfDeclared === true,
    selfDeclarationNote: draft.selfDeclarationNote ?? '',
  };
}

const orNull = (text: string): string | null => (text.trim() === '' ? null : text.trim());

/** The whole draft for the PUT: the form sends every field, a field the type does not use as null. */
export function draftBody(values: Values, type: CertificateTypeOption): CertificateDraft {
  const self = type.verificationMode === 'SELF_DECLARATION';
  return {
    issuerId: !self && type.requiresIssuerRegistry ? orNull(values.issuerId) : null,
    certificateNumber: self ? null : orNull(values.certificateNumber),
    issueDate: self ? null : orNull(values.issueDate),
    expiryDate: type.requiresExpiry ? orNull(values.expiryDate) : null,
    selfDeclared: self ? values.selfDeclared : null,
    selfDeclarationNote: self ? orNull(values.selfDeclarationNote) : null,
  };
}

/** A zone's place name ("Australia/Brisbane" reads "Brisbane"), for "{zoneName} time". */
export function zonePlace(zone: string): string {
  const place = zone.split('/').pop() ?? zone;
  return place.replace(/_/g, ' ');
}

/**
 * The certificate form (design section 7, CS3): one page with the Details card (the Documents
 * card and Review come with seller certificates PR 3). The header holds the title, the status and
 * Delete draft (in "More" on a phone); Save draft is in the bar at the end, sticky on a phone.
 * Typed text lives only in the page's memory, never in browser storage; leaving with unsaved
 * changes asks first.
 */
export function CertificateForm({
  detail,
  type,
  canManage,
  zone,
  csrfToken,
}: {
  readonly detail: CertificateDetail;
  /** The type's form settings; absent when the type is no longer open (the form is read-only). */
  readonly type: CertificateTypeOption | undefined;
  readonly canManage: boolean;
  readonly zone: string | null;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [certificate, setCertificate] = useState<CertificateSummary>(detail.certificate);
  const [saved, setSaved] = useState<Values>(() => valuesOf(detail.draft));
  const [values, setValues] = useState<Values>(saved);
  const [saving, setSaving] = useState(false);
  const [savedOnce, setSavedOnce] = useState(false);
  const [problem, setProblem] = useState<CertificateProblem | null>(null);
  const [summarySignal, setSummarySignal] = useState(0);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const busy = useRef(false);
  const cancelDelete = useRef<HTMLButtonElement>(null);
  const viewOnlyId = useId();

  const name = typeName(type?.names, certificate.typeCode, locale);
  const title = t('certification.form.page-title', { type: name });
  const self = type?.verificationMode === 'SELF_DECLARATION';
  const editable = canManage && type !== undefined && opensOnForm(certificate);
  const changed = (field: (typeof FIELDS)[number]) => values[field] !== saved[field];
  const dirtyCount = FIELDS.filter(changed).length;
  const dirty = editable && dirtyCount > 0;
  const fieldError = (path: string) => {
    const key = problem?.fields[path];
    return key === undefined ? undefined : t(key, { max: CERTIFICATE_NUMBER_MAX });
  };
  const set = <K extends keyof Values>(field: K, value: Values[K]) =>
    setValues((current) => ({ ...current, [field]: value }));

  function fail(found: CertificateProblem) {
    setProblem(found);
    setSummarySignal((n) => n + 1);
    if (found.then === 'reload') router.refresh();
    if (found.then === 'list') router.push(CERTIFICATES_PATH);
  }

  async function save() {
    if (busy.current || !editable || type === undefined) return;
    busy.current = true;
    setSaving(true);
    setProblem(null);
    const result = await callApi<CertificateDraftSaved>(
      'PUT',
      `certification/seller/certificates/${certificate.certificateId}`,
      draftBody(values, type),
      csrfToken,
    );
    busy.current = false;
    setSaving(false);
    if (result.ok) {
      const next = valuesOf(result.body.draft);
      setCertificate(result.body.certificate);
      setSaved(next);
      setValues(next);
      // "Draft saved" shows beside the button (a status region), so no toast repeats it.
      setSavedOnce(true);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    fail(certificateProblemOf(result.failure));
  }

  async function remove() {
    if (busy.current) return;
    busy.current = true;
    setDeleting(true);
    const result = await callApi<{ readonly deleted: true }>(
      'DELETE',
      `certification/seller/certificates/${certificate.certificateId}`,
      undefined,
      csrfToken,
    );
    busy.current = false;
    setDeleting(false);
    if (result.ok) {
      // Nothing is left to lose: the leave guard must not ask.
      setSaved(values);
      setConfirmDelete(false);
      toast.success(t('certification.draft.deleted'));
      router.push(CERTIFICATES_PATH);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setConfirmDelete(false);
    fail(certificateProblemOf(result.failure));
  }

  const canDelete = canManage && certificate.deletable;
  const actions = canDelete ? (
    <>
      <span className="max-sm:hidden">
        <Button variant="destructive" onClick={() => setConfirmDelete(true)} disabled={saving}>
          {t('certification.draft.delete.action')}
        </Button>
      </span>
      <span className="sm:hidden">
        <Menu
          label={t('certification.form.more')}
          items={[
            {
              id: 'delete',
              label: t('certification.draft.delete.action'),
              tone: 'critical',
              disabled: saving,
              onSelect: () => setConfirmDelete(true),
            },
          ]}
        />
      </span>
    </>
  ) : undefined;

  const problemItems =
    problem === null
      ? []
      : Object.entries(problem.fields).map(([path, key]) => ({
          id: `certificate-${path}`,
          label: fieldLabel(t, path),
          reason: t(key, { max: CERTIFICATE_NUMBER_MAX }),
        }));

  const banners = [
    canManage ? null : (
      <div key="view-only" id={viewOnlyId}>
        <SettingsViewOnlyBanner title={t('settings.view-only.title')}>
          {t('certification.view-only.ask-owner')}
        </SettingsViewOnlyBanner>
      </div>
    ),
    canManage && type === undefined ? (
      <Banner key="type" tone="attention">
        {t('certification.error.type.inactive', { type: name })}
      </Banner>
    ) : null,
    canManage && type !== undefined && !opensOnForm(certificate) ? (
      <Banner key="locked" tone="info">
        {t('certification.form.locked')}
      </Banner>
    ) : null,
    editable && certificate.status.endsWith('changes-needed') ? (
      <Banner key="correct" tone="attention">
        {t('certification.form.correct.banner')}
      </Banner>
    ) : null,
    self && type !== undefined ? (
      <Banner key="claim" tone="info">
        {t('certification.form.claim.banner')}
      </Banner>
    ) : null,
    problem !== null && problemItems.length > 0 ? (
      <SettingsErrorSummary
        key="summary"
        title={t('certification.form.error.summary', { count: problemItems.length })}
        items={problemItems}
        focusSignal={summarySignal}
      />
    ) : null,
    problem !== null && problemItems.length === 0 ? (
      <div key="problem" aria-live="polite">
        <Banner tone={problem.then === 'reload' ? 'attention' : 'critical'}>
          {t(problem.key, { type: name })}
        </Banner>
      </div>
    ) : null,
  ].filter((node) => node !== null);

  const issuers = type?.issuers ?? [];
  const status = dirty
    ? t('certification.form.dirty')
    : savedOnce
      ? t('certification.form.saved')
      : null;

  return (
    <SettingsPage
      title={title}
      statusBadge={<CertificateStatusBadge status={certificate.status} />}
      actions={actions}
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
      onSubmit={() => void save()}
      dirty={dirty}
      dirtyCount={dirtyCount}
      leave={{
        title: t('settings.leave.title'),
        message: t('settings.leave.message', { count: dirtyCount, page: title }),
        stay: t('settings.leave.stay'),
        leave: t('settings.leave.leave'),
      }}
      overlay={
        <Dialog
          open={confirmDelete}
          title={t('certification.draft.delete.title')}
          onClose={() => (deleting ? undefined : setConfirmDelete(false))}
          initialFocus={cancelDelete}
          actions={
            <>
              <Button
                ref={cancelDelete}
                variant="secondary"
                onClick={() => setConfirmDelete(false)}
                disabled={deleting}
              >
                {t('certification.action.cancel')}
              </Button>
              <Button variant="destructive-solid" onClick={() => void remove()} loading={deleting}>
                {t('certification.draft.delete.action')}
              </Button>
            </>
          }
        >
          <p className="text-sm text-fg-secondary">{t('certification.draft.delete.body')}</p>
        </Dialog>
      }
      saveBar={
        editable ? (
          <div className="max-md:sticky max-md:bottom-[calc(var(--mp-size-bottom-bar)+env(safe-area-inset-bottom))] max-md:z-10 max-md:-mx-4 max-md:bg-surface max-md:px-4 max-md:pb-3">
            <FormActionBar status={status === null ? null : <span role="status">{status}</span>}>
              <Button type="submit" loading={saving} loadingLabel={t('certification.form.saving')}>
                {t('certification.form.save-draft')}
              </Button>
            </FormActionBar>
          </div>
        ) : undefined
      }
    >
      <SettingsSection title={t('certification.form.title')}>
        {self ? (
          <>
            <SettingRow
              id="certificate-selfDeclared"
              label={t('certification.form.declaration.label')}
              error={fieldError('selfDeclared')}
              changed={changed('selfDeclared')}
              disabled={!editable}
            >
              <SettingCheckbox
                checked={values.selfDeclared}
                onChange={(event) => set('selfDeclared', event.target.checked)}
                text={t('certification.form.declaration.text', { type: name })}
              />
            </SettingRow>
            <SettingRow
              id="certificate-selfDeclarationNote"
              label={t('certification.form.declaration.note')}
              error={fieldError('selfDeclarationNote')}
              changed={changed('selfDeclarationNote')}
              disabled={!editable}
            >
              <SettingTextArea
                dir="auto"
                rows={4}
                maxLength={DECLARATION_NOTE_MAX}
                value={values.selfDeclarationNote}
                onChange={(event) => set('selfDeclarationNote', event.target.value)}
              />
            </SettingRow>
          </>
        ) : (
          <>
            {type === undefined || type.requiresIssuerRegistry ? (
              <SettingRow
                id="certificate-issuerId"
                label={t('certification.form.issuer.label')}
                help={
                  issuers.length === 0 && type !== undefined
                    ? t('certification.form.issuer.empty')
                    : t('certification.form.issuer.help')
                }
                error={fieldError('issuerId')}
                changed={changed('issuerId')}
                disabled={!editable || issuers.length === 0}
              >
                <SettingSelect
                  value={values.issuerId}
                  placeholder={t('certification.form.issuer.placeholder')}
                  options={issuers.map((issuer) => ({
                    value: issuer.issuerId,
                    label: issuer.displayName,
                  }))}
                  onChange={(event) => set('issuerId', event.target.value)}
                />
              </SettingRow>
            ) : null}
            <SettingRow
              id="certificate-certificateNumber"
              label={t('certification.form.number.label')}
              error={fieldError('certificateNumber')}
              changed={changed('certificateNumber')}
              disabled={!editable}
            >
              <SettingInput
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                maxLength={CERTIFICATE_NUMBER_MAX}
                value={values.certificateNumber}
                onChange={(event) => set('certificateNumber', event.target.value)}
              />
            </SettingRow>
            <SettingRow
              id="certificate-issueDate"
              label={t('certification.form.issue-date.label')}
              error={fieldError('issueDate')}
              changed={changed('issueDate')}
              disabled={!editable}
            >
              <SettingInput
                type="date"
                value={values.issueDate}
                onChange={(event) => set('issueDate', event.target.value)}
              />
            </SettingRow>
          </>
        )}
        {type === undefined || type.requiresExpiry ? (
          <SettingRow
            id="certificate-expiryDate"
            label={t('certification.form.expiry-date.label')}
            help={
              <>
                {t('certification.form.expiry-date.help')}
                {zone === null ? null : (
                  <>
                    {' '}
                    {t('certification.form.zone-line', {
                      zoneName: t('certification.form.zone-time', { place: zonePlace(zone) }),
                    })}
                  </>
                )}
              </>
            }
            error={fieldError('expiryDate')}
            changed={changed('expiryDate')}
            disabled={!editable}
          >
            <SettingInput
              type="date"
              value={values.expiryDate}
              min={values.issueDate === '' ? undefined : values.issueDate}
              onChange={(event) => set('expiryDate', event.target.value)}
            />
          </SettingRow>
        ) : null}
      </SettingsSection>
    </SettingsPage>
  );
}

function fieldLabel(t: (key: string) => string, path: string): string {
  switch (path) {
    case 'issuerId':
      return t('certification.form.issuer.label');
    case 'certificateNumber':
      return t('certification.form.number.label');
    case 'issueDate':
      return t('certification.form.issue-date.label');
    case 'expiryDate':
      return t('certification.form.expiry-date.label');
    case 'selfDeclared':
      return t('certification.form.declaration.label');
    case 'selfDeclarationNote':
      return t('certification.form.declaration.note');
    default:
      return t('certification.form.title');
  }
}
