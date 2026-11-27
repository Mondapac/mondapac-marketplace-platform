'use client';

import {
  Badge,
  Banner,
  Button,
  FormActionBar,
  Icon,
  LinkButton,
  SettingsPage,
  SettingsSection,
  toast,
} from '@mondapac/ui';
import { useFormatter, useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';
import { zonePlace } from './certificate-form.tsx';
import { orderedDocuments } from './documents-card.tsx';
import { certificateProblemOf } from './errors.ts';
import { formatDay } from './format.ts';
import { formPathOf, submitKeyOf } from './status.ts';
import { mediaLabel } from './upload.ts';
import {
  CERTIFICATES_PATH,
  certificatePath,
  typeName,
  type CertificateDetail,
  type CertificateSubmitted,
  type CertificateTypeOption,
} from './types.ts';

/** A row of the review: a field the type uses, with its value or "Missing". */
interface ReviewRow {
  readonly field: string;
  readonly label: string;
  readonly value: ReactNode | null;
  readonly missing: boolean;
  /** The row can be changed on the form (Type cannot). */
  readonly editable: boolean;
}

/**
 * What the API would refuse as `certificate.incomplete`, worked out from the type's form settings
 * (the same rule as the domain's `incompleteFields`): the page names the missing items before the
 * seller presses Submit. The API checks again and its answer wins.
 */
export function missingFields(
  type: CertificateTypeOption,
  detail: CertificateDetail,
): readonly string[] {
  const { draft } = detail;
  const missing: string[] = [];
  if (type.verificationMode === 'SELF_DECLARATION') {
    if (draft.selfDeclared !== true) missing.push('selfDeclared');
  } else {
    const issuerOpen = type.issuers.some((issuer) => issuer.issuerId === draft.issuerId);
    if (type.requiresIssuerRegistry && (draft.issuerId === null || !issuerOpen)) {
      missing.push('issuerId');
    }
    if (draft.certificateNumber === null) missing.push('certificateNumber');
  }
  if (type.requiresExpiry && draft.expiryDate === null) missing.push('expiryDate');
  if (type.requiresDocument && detail.documents.length < 1) missing.push('documents');
  return missing;
}

/**
 * Review and submit (seller certificates design section 8, CS4): every value the seller entered,
 * each with Edit back to its field on the form, and Submit for review. The buttons are only in the
 * bar at the end. While anything is missing Submit stays reachable but unavailable, and the line
 * "Finish {n} items first" links to the first missing item.
 */
export function CertificateReview({
  detail,
  type,
  zone,
  csrfToken,
}: {
  readonly detail: CertificateDetail;
  readonly type: CertificateTypeOption;
  readonly zone: string | null;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [serverMissing, setServerMissing] = useState<readonly string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);
  const { certificate, draft } = detail;
  const id = certificate.certificateId;
  const formPath = formPathOf(certificate);
  const name = typeName(type.names, type.code, locale);
  const self = type.verificationMode === 'SELF_DECLARATION';
  const issuerPending = certificate.status === 'draft-issuer-not-listed';
  const missing = [...new Set([...missingFields(type, detail), ...serverMissing])];
  const day = (value: string | null) =>
    formatDay((date, options) => format.dateTime(date, options), value);
  const zoneName =
    zone === null ? null : t('certification.form.zone-time', { place: zonePlace(zone) });

  const documents = orderedDocuments(detail.documents);
  const documentsValue =
    documents.length === 0 ? null : (
      <ul className="flex flex-col gap-1">
        {documents.map((document, index) => (
          <li key={document.documentId}>
            {[
              t('certification.upload.page', { number: index + 1 }),
              mediaLabel(document.mediaType),
              document.pageCount === null
                ? null
                : t('certification.upload.pages', { count: document.pageCount }),
            ]
              .filter((part): part is string => part !== null)
              .join(' · ')}
          </li>
        ))}
      </ul>
    );

  const issuer = type.issuers.find((item) => item.issuerId === draft.issuerId);
  const expiry = day(draft.expiryDate);
  const rows: ReviewRow[] = [
    {
      field: 'type',
      label: t('certification.review.row.type'),
      value: name,
      missing: false,
      editable: false,
    },
  ];
  if (self) {
    rows.push(
      {
        field: 'selfDeclared',
        label: t('certification.form.declaration.label'),
        value:
          draft.selfDeclared === true
            ? t('certification.form.declaration.text', { type: name })
            : null,
        missing: missing.includes('selfDeclared'),
        editable: true,
      },
      {
        field: 'selfDeclarationNote',
        label: t('certification.form.declaration.note'),
        value:
          draft.selfDeclarationNote === null ? (
            t('certification.list.none')
          ) : (
            <span dir="auto" className="whitespace-pre-wrap">
              {draft.selfDeclarationNote}
            </span>
          ),
        missing: false,
        editable: true,
      },
    );
  } else {
    if (type.requiresIssuerRegistry) {
      rows.push({
        field: 'issuerId',
        label: t('certification.form.issuer.label'),
        value: issuerPending
          ? t('certification.issuer-request.status.open')
          : (issuer?.displayName ?? null),
        missing: missing.includes('issuerId'),
        editable: true,
      });
    }
    rows.push(
      {
        field: 'certificateNumber',
        label: t('certification.form.number.label'),
        value:
          draft.certificateNumber === null ? null : (
            <span dir="ltr">{draft.certificateNumber}</span>
          ),
        missing: missing.includes('certificateNumber'),
        editable: true,
      },
      {
        field: 'issueDate',
        label: t('certification.form.issue-date.label'),
        value: day(draft.issueDate) ?? t('certification.list.none'),
        missing: false,
        editable: true,
      },
    );
  }
  if (type.requiresExpiry) {
    rows.push({
      field: 'expiryDate',
      label: t('certification.form.expiry-date.label'),
      value:
        expiry === null
          ? null
          : zoneName === null
            ? t('certification.review.expiry-plain', { date: expiry })
            : t('certification.review.expiry', { date: expiry, zoneName }),
      missing: missing.includes('expiryDate'),
      editable: true,
    });
  }
  if (type.requiresDocument || documents.length > 0) {
    rows.push({
      field: 'documents',
      label: t('certification.upload.title'),
      value: documentsValue,
      missing: missing.includes('documents'),
      editable: true,
    });
  }

  const blocked = missing.length > 0 || issuerPending;
  const firstMissing = missing[0];

  async function submit() {
    if (busy.current || blocked) return;
    busy.current = true;
    setSubmitting(true);
    setProblem(null);
    const result = await callApi<CertificateSubmitted>(
      'POST',
      `certification/seller/certificates/${id}/submit`,
      undefined,
      csrfToken,
    );
    if (result.ok) {
      toast.success(t('certification.review.submitted'));
      router.push(certificatePath(id));
      router.refresh();
      return;
    }
    busy.current = false;
    setSubmitting(false);
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (result.failure.code === 'certificate.incomplete') {
      setServerMissing((result.failure.details?.fields ?? []).map((field) => field.path));
      return;
    }
    const found = certificateProblemOf(result.failure);
    setProblem(found.key);
    if (found.then === 'reload') router.refresh();
    if (found.then === 'list') router.push(CERTIFICATES_PATH);
  }

  return (
    <SettingsPage
      title={t('certification.review.title')}
      banner={
        <div className="flex flex-col gap-3">
          <Banner tone="info">{t('certification.review.banner')}</Banner>
          {problem === null ? null : (
            <div aria-live="polite">
              <Banner tone="critical">{t(problem, { type: name })}</Banner>
            </div>
          )}
        </div>
      }
      saveBar={
        <div className="max-md:sticky max-md:bottom-[calc(var(--mp-size-bottom-bar)+env(safe-area-inset-bottom))] max-md:z-10 max-md:-mx-4 max-md:bg-surface max-md:px-4 max-md:pb-3">
          <FormActionBar
            status={
              blocked ? (
                <span id="certificate-submit-blocked" className="text-sm text-fg-secondary">
                  {issuerPending ? (
                    t('certification.review.help.issuer-pending')
                  ) : (
                    <Link
                      href={`${formPath}#certificate-${firstMissing ?? ''}`}
                      className="font-medium text-link underline underline-offset-2"
                    >
                      {t('certification.review.help.blocked', { count: missing.length })}
                    </Link>
                  )}
                </span>
              ) : null
            }
          >
            <LinkButton variant="secondary" href={formPath}>
              {t('certification.review.back')}
            </LinkButton>
            <Button
              type="button"
              onClick={() => void submit()}
              loading={submitting}
              loadingLabel={t('certification.review.submitting')}
              softDisabled={blocked}
              aria-describedby={blocked ? 'certificate-submit-blocked' : undefined}
            >
              {t(submitKeyOf(certificate))}
            </Button>
          </FormActionBar>
        </div>
      }
    >
      <SettingsSection title={t('certification.form.title')}>
        <dl className="flex flex-col divide-y divide-line-row">
          {rows.map((row) => (
            <div
              key={row.field}
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 px-5 py-3 sm:grid-cols-[12rem_minmax(0,1fr)_auto]"
            >
              <dt className="text-sm font-medium text-fg-secondary max-sm:col-span-1">
                {row.label}
              </dt>
              <dd className="text-sm text-fg max-sm:col-span-2 max-sm:row-start-2">
                {row.missing || row.value === null ? (
                  <Badge tone="attention">
                    <Icon name="alert-triangle" />
                    {t('certification.review.row.missing')}
                  </Badge>
                ) : (
                  row.value
                )}
              </dd>
              <dd className="text-end max-sm:col-start-2 max-sm:row-start-1">
                {row.editable ? (
                  <Link
                    href={`${formPath}#certificate-${row.field}`}
                    className="text-sm font-medium text-link underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                    aria-label={t('certification.review.edit-named', { field: row.label })}
                  >
                    {t('certification.review.edit')}
                  </Link>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </SettingsSection>
    </SettingsPage>
  );
}
